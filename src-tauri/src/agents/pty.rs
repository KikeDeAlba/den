use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};

use super::scan::Scanner;

pub const CHUNK_LIMIT: usize = 64 * 1024;
pub const HISTORY_LIMIT: usize = 2 * 1024 * 1024;
pub const BATCH_WINDOW: Duration = Duration::from_millis(12);
pub const HISTORY_SLACK: usize = 256 * 1024;
pub const KILL_GRACE: Duration = Duration::from_secs(3);
pub const QUEUE_DEPTH: usize = 64;
const READ_BUFFER: usize = 16 * 1024;
const MARK_SPACING: u64 = 1024;
pub const KILL_SETTLE: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(20);
const DRAIN_LIMIT: Duration = Duration::from_millis(500);
pub const ORPHAN_GRACE: Duration = Duration::from_secs(1);

pub type Sink = Box<dyn Fn(Vec<u8>) -> bool + Send>;

#[derive(Debug, Clone)]
pub struct PtySpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(OsString, OsString)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Default)]
struct Output {
    history: VecDeque<u8>,
    start: u64,
    marks: VecDeque<u64>,
    safe: VecDeque<u64>,
    scanner: Scanner,
    sink: Option<Sink>,
}

impl Output {
    fn push(&mut self, chunk: Vec<u8>) {
        let base = self.start + self.history.len() as u64;
        for (index, byte) in chunk.iter().enumerate() {
            let ground = self.scanner.at_ground();
            if ground && !is_continuation(*byte) {
                let point = base + index as u64;
                if self.safe.back().is_none_or(|last| point - last >= MARK_SPACING) {
                    self.safe.push_back(point);
                }
            }
            self.scanner.feed(*byte);
            if ground && *byte == b'\n' {
                let mark = base + index as u64 + 1;
                if self.marks.back().is_none_or(|last| mark - last >= MARK_SPACING) {
                    self.marks.push_back(mark);
                }
            }
        }
        self.history.extend(chunk.iter().copied());
        self.trim();
        if let Some(sink) = &self.sink {
            if !sink(chunk) {
                self.sink = None;
            }
        }
    }

    fn trim(&mut self) {
        let excess = self.history.len().saturating_sub(HISTORY_LIMIT);
        if excess == 0 {
            return;
        }
        let target = self.start + excess as u64;
        while self.marks.front().is_some_and(|mark| *mark < target) {
            self.marks.pop_front();
        }
        while self.safe.front().is_some_and(|point| *point < target) {
            self.safe.pop_front();
        }
        let end = self.start + self.history.len() as u64;
        let cut = match self.marks.front().copied().filter(|mark| *mark <= end) {
            Some(mark) if mark - self.start <= (excess + HISTORY_SLACK) as u64 => mark,
            _ if excess > HISTORY_SLACK => match self.safe.front().copied().filter(|point| *point < end) {
                Some(point) => point,
                None => {
                    let mut cut = target;
                    while cut < end && is_continuation(self.history[(cut - self.start) as usize]) {
                        cut += 1;
                    }
                    cut
                }
            },
            _ => return,
        };
        self.history.drain(..(cut - self.start) as usize);
        self.start = cut;
    }

    fn bracketed(&self) -> bool {
        self.scanner.bracketed()
    }
}

fn is_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

pub struct Pty {
    pid: Option<u32>,
    group: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    drained: Arc<AtomicBool>,
    output: Arc<Mutex<Output>>,
    exit: Arc<Mutex<Option<Option<i32>>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn io_error(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

pub fn chunks(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.chunks(CHUNK_LIMIT)
}

fn batch(receiver: &mpsc::Receiver<Vec<u8>>, first: Vec<u8>) -> (Vec<u8>, bool) {
    let mut pending = first;
    let deadline = Instant::now() + BATCH_WINDOW;
    while pending.len() < CHUNK_LIMIT {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match receiver.recv_timeout(left) {
            Ok(more) => pending.extend(more),
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => return (pending, true),
        }
    }
    (pending, false)
}

fn pump(receiver: mpsc::Receiver<Vec<u8>>, output: Arc<Mutex<Output>>, drained: Arc<AtomicBool>) {
    while let Ok(first) = receiver.recv() {
        let (pending, closed) = batch(&receiver, first);
        let mut state = lock(&output);
        for piece in chunks(&pending) {
            state.push(piece.to_vec());
        }
        drop(state);
        if closed {
            break;
        }
    }
    drained.store(true, Ordering::SeqCst);
}

fn read_loop(mut reader: Box<dyn Read + Send>, sender: mpsc::SyncSender<Vec<u8>>) {
    let mut buffer = vec![0u8; READ_BUFFER];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if sender.send(buffer[..read].to_vec()).is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

impl Pty {
    pub fn spawn(spec: &PtySpec) -> std::io::Result<Self> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: spec.rows.max(1),
                cols: spec.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(io_error)?;
        let mut command = CommandBuilder::new(&spec.program);
        command.env_clear();
        command.args(&spec.args);
        if let Some(cwd) = &spec.cwd {
            command.cwd(cwd);
        }
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let mut child = pair.slave.spawn_command(command).map_err(io_error)?;
        drop(pair.slave);
        let pid = child.process_id();
        let group = pid.filter(|pid| leads_group(*pid));
        let handles = pair
            .master
            .try_clone_reader()
            .and_then(|reader| Ok((reader, pair.master.take_writer()?)))
            .map_err(io_error);
        let (reader, writer) = match handles {
            Ok(handles) => handles,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let killer = child.clone_killer();

        let output = Arc::new(Mutex::new(Output::default()));
        let exit = Arc::new(Mutex::new(None));
        let (sender, receiver) = mpsc::sync_channel(QUEUE_DEPTH);
        thread::spawn(move || read_loop(reader, sender));
        let pumped = Arc::clone(&output);
        let drained = Arc::new(AtomicBool::new(false));
        let done = Arc::clone(&drained);
        thread::spawn(move || pump(receiver, pumped, done));

        Ok(Self {
            pid,
            group,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            child: Mutex::new(Some(child)),
            drained,
            output,
            exit,
        })
    }

    pub fn watch<F>(&self, on_exit: F)
    where
        F: FnOnce(Option<i32>) + Send + 'static,
    {
        let Some(mut child) = lock(&self.child).take() else {
            return;
        };
        let drained = Arc::clone(&self.drained);
        let finished = Arc::clone(&self.exit);
        let group = self.group;
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
            if let Some(group) = group {
                end_orphans(group, ORPHAN_GRACE);
            }
            let deadline = Instant::now() + DRAIN_LIMIT;
            while !drained.load(Ordering::SeqCst) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            *lock(&finished) = Some(code);
            on_exit(code);
        });
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn exit_code(&self) -> Option<Option<i32>> {
        *lock(&self.exit)
    }

    pub fn bracketed(&self) -> bool {
        lock(&self.output).bracketed()
    }

    pub fn alive(&self) -> bool {
        self.exit_code().is_none()
    }

    pub fn attach(&self, sink: Sink) {
        let mut state = lock(&self.output);
        let history: Vec<u8> = state.history.iter().copied().collect();
        for piece in chunks(&history) {
            if !sink(piece.to_vec()) {
                state.sink = None;
                return;
            }
        }
        state.sink = Some(sink);
    }

    pub fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut writer = lock(&self.writer);
        writer.write_all(bytes)?;
        writer.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        lock(&self.master)
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(io_error)
    }

    pub fn kill_tree(self: &Arc<Self>, grace: Duration) {
        let pty = Arc::clone(self);
        thread::spawn(move || pty.terminate(grace));
    }

    pub fn terminate(&self, grace: Duration) {
        if !self.alive() {
            return;
        }
        let Some(group) = self.group.filter(|group| signal_group(*group, Signal::Hangup)) else {
            let _ = lock(&self.killer).kill();
            self.wait_exit(KILL_SETTLE);
            return;
        };
        let deadline = Instant::now() + grace;
        while group_exists(group) && Instant::now() < deadline {
            thread::sleep(POLL);
        }
        if group_exists(group) {
            signal_group(group, Signal::Kill);
        }
        let settle = Instant::now() + KILL_SETTLE;
        while (group_exists(group) || self.alive()) && Instant::now() < settle {
            thread::sleep(POLL);
        }
    }

    pub fn wait_exit(&self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while self.alive() {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(POLL);
        }
        true
    }
}

fn end_orphans(group: u32, grace: Duration) {
    if !group_exists(group) || !signal_group(group, Signal::Hangup) {
        return;
    }
    let deadline = Instant::now() + grace;
    while group_exists(group) && Instant::now() < deadline {
        thread::sleep(POLL);
    }
    if group_exists(group) {
        signal_group(group, Signal::Kill);
    }
}

#[derive(Debug, Clone, Copy)]
enum Signal {
    Hangup,
    Kill,
}

#[cfg(unix)]
fn group_id(pid: u32) -> Option<libc::pid_t> {
    libc::pid_t::try_from(pid).ok().filter(|pid| *pid > 1)
}

#[cfg(unix)]
fn leads_group(pid: u32) -> bool {
    group_id(pid).is_some_and(|pid| unsafe { libc::getpgid(pid) } == pid)
}

#[cfg(unix)]
fn signal_group(group: u32, signal: Signal) -> bool {
    let Some(group) = group_id(group) else {
        return false;
    };
    let number = match signal {
        Signal::Hangup => libc::SIGHUP,
        Signal::Kill => libc::SIGKILL,
    };
    unsafe { libc::killpg(group, number) == 0 }
}

#[cfg(unix)]
fn group_exists(group: u32) -> bool {
    group_id(group).is_some_and(|group| unsafe { libc::killpg(group, 0) } == 0)
}

#[cfg(not(unix))]
fn leads_group(_pid: u32) -> bool {
    false
}

#[cfg(not(unix))]
fn signal_group(_group: u32, _signal: Signal) -> bool {
    false
}

#[cfg(not(unix))]
fn group_exists(_group: u32) -> bool {
    false
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::Sender;

    fn shell(script: &str) -> PtySpec {
        PtySpec {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), script.into()],
            cwd: None,
            env: vec![("TERM".into(), "xterm-256color".into()), ("PATH".into(), "/usr/bin:/bin".into())],
            cols: 80,
            rows: 24,
        }
    }

    fn started<F: FnOnce(Option<i32>) + Send + 'static>(spec: &PtySpec, on_exit: F) -> std::io::Result<Pty> {
        let pty = Pty::spawn(spec)?;
        pty.watch(on_exit);
        Ok(pty)
    }

    #[test]
    fn an_instant_exit_is_reported_only_once_someone_watches() {
        let pty = Pty::spawn(&shell("exit 3")).expect("spawn");
        thread::sleep(Duration::from_millis(200));
        assert!(pty.alive());
        let (sender, receiver) = mpsc::channel();
        pty.watch(exited(sender));
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)).expect("exit"), Some(3));
        assert_eq!(pty.exit_code(), Some(Some(3)));
    }

    fn collector(pty: &Pty) -> Arc<Mutex<Vec<u8>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&seen);
        pty.attach(Box::new(move |chunk| {
            assert!(chunk.len() <= CHUNK_LIMIT);
            lock(&target).extend(chunk);
            true
        }));
        seen
    }

    fn wait_for(seen: &Arc<Mutex<Vec<u8>>>, needle: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if String::from_utf8_lossy(&lock(seen)).contains(needle) {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn exited(sender: Sender<Option<i32>>) -> impl FnOnce(Option<i32>) + Send + 'static {
        move |code| {
            let _ = sender.send(code);
        }
    }

    fn gone(pid: libc::pid_t) -> bool {
        unsafe { libc::kill(pid, 0) != 0 }
    }

    #[test]
    fn echoes_what_it_is_sent() {
        let (sender, receiver) = mpsc::channel();
        let pty = started(&shell("read line; echo got:$line"), exited(sender)).expect("spawn");
        let seen = collector(&pty);
        pty.write(b"hola\r").expect("write");
        assert!(wait_for(&seen, "got:hola"));
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)).expect("exit"), Some(0));
        assert!(!pty.alive());
    }

    #[test]
    fn the_bracketed_paste_mode_follows_the_program() {
        let (sender, _receiver) = mpsc::channel();
        let pty = started(&shell("printf '\\033[?2004hon\\n'; read line; printf '\\033[?2004loff\\n'; read line"), exited(sender))
            .expect("spawn");
        let seen = collector(&pty);
        assert!(wait_for(&seen, "on"));
        assert!(pty.bracketed());
        pty.write(b"\r").expect("write");
        assert!(wait_for(&seen, "off"));
        assert!(!pty.bracketed());
        pty.write(b"\r").expect("write");
    }

    #[test]
    fn resizing_reaches_the_terminal() {
        let (sender, _receiver) = mpsc::channel();
        let pty = started(&shell("read line; stty size"), exited(sender)).expect("spawn");
        let seen = collector(&pty);
        pty.resize(100, 40).expect("resize");
        pty.write(b"\r").expect("write");
        assert!(wait_for(&seen, "40 100"));
    }

    #[test]
    fn a_late_attach_replays_the_history() {
        let (sender, receiver) = mpsc::channel();
        let pty = started(&shell("echo first-line"), exited(sender)).expect("spawn");
        receiver.recv_timeout(Duration::from_secs(5)).expect("exit");
        thread::sleep(Duration::from_millis(100));
        let seen = collector(&pty);
        assert!(String::from_utf8_lossy(&lock(&seen)).contains("first-line"));
    }

    fn line_block(letter: u8, size: usize) -> Vec<u8> {
        let mut block = Vec::with_capacity(size);
        while block.len() < size {
            block.extend(std::iter::repeat_n(letter, 99));
            block.push(b'\n');
        }
        block.truncate(size);
        block
    }

    #[test]
    fn the_history_keeps_about_the_last_two_megabytes_from_a_line_start() {
        let mut output = Output::default();
        output.push(line_block(b'a', HISTORY_LIMIT));
        output.push(line_block(b'b', 4050));
        assert!(output.history.len() <= HISTORY_LIMIT);
        assert!(output.history.len() >= HISTORY_LIMIT - 2 * MARK_SPACING as usize);
        assert_eq!(output.history.front(), Some(&b'a'));
        assert_eq!(output.history.back(), Some(&b'b'));
        let replayed: Vec<u8> = output.history.iter().copied().collect();
        assert!(replayed.starts_with(&[b'a'; 99]));
    }

    #[test]
    fn the_history_is_never_cut_inside_an_escape_sequence() {
        let mut output = Output::default();
        let mut chunk = Vec::new();
        while chunk.len() < HISTORY_LIMIT + 50_000 {
            chunk.extend_from_slice(b"\x1b]8;;https://example.com/\nnot-a-line\x1b\\link\x1b]8;;\x1b\\ \x1b[38;5;208mcolor\x1b[0m\n");
        }
        output.push(chunk);
        let replayed: Vec<u8> = output.history.iter().copied().collect();
        assert!(replayed.starts_with(b"\x1b]8;;https://"), "{:?}", String::from_utf8_lossy(&replayed[..40]));
        let mut scanner = Scanner::default();
        for byte in &replayed {
            scanner.feed(*byte);
        }
        assert!(scanner.at_ground());
    }

    #[test]
    fn output_without_lines_is_never_cut_inside_an_escape_sequence() {
        let url = "x".repeat(700);
        let unit = format!("\x1b]8;;https://example.com/{url}\x1b\\link\x1b]8;;\x1b\\ \x1b[38;5;208mcolor\x1b[0m é ");
        let mut chunk = Vec::new();
        while chunk.len() < HISTORY_LIMIT + HISTORY_SLACK + 50_000 {
            chunk.extend_from_slice(unit.as_bytes());
        }
        let mut output = Output::default();
        output.push(chunk.clone());
        let cut = usize::try_from(output.start).expect("start");
        assert!(cut > 0);
        assert!(output.history.len() <= HISTORY_LIMIT);
        let mut scanner = Scanner::default();
        for byte in &chunk[..cut] {
            scanner.feed(*byte);
        }
        assert!(scanner.at_ground(), "cut at {cut} lands inside a sequence");
        assert!(!is_continuation(chunk[cut]));
    }

    #[test]
    fn output_without_lines_is_bounded_and_cut_on_a_character_boundary() {
        let mut output = Output::default();
        let text = "é".repeat(HISTORY_LIMIT);
        output.push(text.into_bytes());
        assert!(output.history.len() <= HISTORY_LIMIT + HISTORY_SLACK);
        assert!(!is_continuation(*output.history.front().expect("front")));
    }

    #[test]
    fn a_stalled_consumer_pauses_the_program() {
        const TOTAL: usize = 32 * 1024 * 1024;
        let (sender, receiver) = mpsc::channel();
        let pty = started(&shell(&format!("read go; head -c {TOTAL} /dev/zero | tr '\\0' x; echo; echo done-now")), exited(sender))
            .expect("spawn");
        let (open_gate, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let received = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&received);
        pty.attach(Box::new(move |chunk| {
            let _ = lock(&gate).recv();
            counted.fetch_add(chunk.iter().filter(|byte| **byte == b'x').count(), Ordering::SeqCst);
            true
        }));
        pty.write(b"\r").expect("write");
        thread::sleep(Duration::from_millis(1500));
        assert!(pty.alive(), "the program wrote everything while nobody consumed");
        assert_eq!(received.load(Ordering::SeqCst), 0);
        drop(open_gate);
        assert_eq!(receiver.recv_timeout(Duration::from_secs(20)).expect("exit"), Some(0));
        assert_eq!(received.load(Ordering::SeqCst), TOTAL);
    }

    #[test]
    fn large_output_arrives_in_bounded_chunks() {
        let (sender, receiver) = mpsc::channel();
        let pty = started(&shell("head -c 300000 /dev/zero | tr '\\0' x; echo; echo done-now"), exited(sender))
            .expect("spawn");
        let seen = collector(&pty);
        assert!(wait_for(&seen, "done-now"));
        receiver.recv_timeout(Duration::from_secs(5)).expect("exit");
    }

    #[test]
    fn killing_takes_down_the_whole_tree() {
        let (sender, receiver) = mpsc::channel();
        let pty = Arc::new(started(&shell("sleep 30 & echo child:$!; wait"), exited(sender)).expect("spawn"));
        let seen = collector(&pty);
        assert!(wait_for(&seen, "child:"));
        let text = String::from_utf8_lossy(&lock(&seen)).into_owned();
        let child: libc::pid_t = text
            .split("child:")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|pid| pid.parse().ok())
            .expect("child pid");
        pty.kill_tree(Duration::from_secs(3));
        receiver.recv_timeout(Duration::from_secs(5)).expect("exit");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !gone(child) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(gone(child));
    }

    #[test]
    fn the_session_leads_its_own_process_group() {
        let (sender, _receiver) = mpsc::channel();
        let pty = started(&shell("read line"), exited(sender)).expect("spawn");
        assert_eq!(pty.group, pty.pid());
        assert!(pty.group.is_some());
        pty.terminate(Duration::from_millis(200));
        assert!(!pty.alive());
    }

    #[test]
    fn a_child_that_outlives_the_leader_is_still_killed() {
        let (sender, receiver) = mpsc::channel();
        let pty = started(&shell("sh -c \"trap '' HUP; exec sleep 30\" & echo child:$!; wait"), exited(sender)).expect("spawn");
        let seen = collector(&pty);
        assert!(wait_for(&seen, "child:"));
        let text = String::from_utf8_lossy(&lock(&seen)).into_owned();
        let child: libc::pid_t = text
            .split("child:")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|pid| pid.parse().ok())
            .expect("child pid");
        thread::sleep(Duration::from_millis(100));
        pty.terminate(Duration::from_millis(300));
        receiver.recv_timeout(Duration::from_secs(5)).expect("exit");
        assert!(gone(child));
    }

    fn child_pid(text: &str) -> libc::pid_t {
        text.split("child:")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|pid| pid.parse().ok())
            .expect("child pid")
    }

    fn gone_within(pid: libc::pid_t, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while !gone(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        gone(pid)
    }

    #[test]
    fn a_background_job_that_ignores_hangup_is_killed_after_the_leader_exits() {
        let (sender, receiver) = mpsc::channel();
        let pty = started(
            &shell("sh -c \"trap '' HUP; echo child:$$; exec sleep 30\" & read line; exit 0"),
            exited(sender),
        )
        .expect("spawn");
        let seen = collector(&pty);
        assert!(wait_for(&seen, "child:"));
        let child = child_pid(&String::from_utf8_lossy(&lock(&seen)));
        thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        pty.write(b"\r").expect("write");
        receiver.recv_timeout(Duration::from_secs(5)).expect("exit");
        assert!(started.elapsed() >= ORPHAN_GRACE - Duration::from_millis(100));
        assert!(gone_within(child, Duration::from_secs(2)), "background job {child} survived its leader");
    }

    #[test]
    fn a_process_that_ignores_hangup_is_killed_after_the_grace() {
        let (sender, receiver) = mpsc::channel();
        let pty = Arc::new(started(&shell("trap '' HUP; echo ready; while :; do sleep 1; done"), exited(sender)).expect("spawn"));
        let seen = collector(&pty);
        assert!(wait_for(&seen, "ready"));
        let started = Instant::now();
        pty.kill_tree(Duration::from_millis(300));
        receiver.recv_timeout(Duration::from_secs(5)).expect("exit");
        assert!(started.elapsed() >= Duration::from_millis(250));
        assert!(!pty.alive());
    }
}
