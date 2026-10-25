use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

pub const CHUNK_LIMIT: usize = 64 * 1024;
pub const HISTORY_LIMIT: usize = 2 * 1024 * 1024;
pub const BATCH_WINDOW: Duration = Duration::from_millis(12);
pub const KILL_GRACE: Duration = Duration::from_secs(3);
const READ_BUFFER: usize = 16 * 1024;
const DRAIN_LIMIT: Duration = Duration::from_millis(500);

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
    sink: Option<Sink>,
}

impl Output {
    fn push(&mut self, chunk: Vec<u8>) {
        self.history.extend(chunk.iter().copied());
        let excess = self.history.len().saturating_sub(HISTORY_LIMIT);
        if excess > 0 {
            self.history.drain(..excess);
        }
        if let Some(sink) = &self.sink {
            if !sink(chunk) {
                self.sink = None;
            }
        }
    }
}

pub struct Pty {
    pid: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
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

fn read_loop(mut reader: Box<dyn Read + Send>, sender: mpsc::Sender<Vec<u8>>) {
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
    pub fn spawn<F>(spec: &PtySpec, on_exit: F) -> std::io::Result<Self>
    where
        F: FnOnce(Option<i32>) + Send + 'static,
    {
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
        let reader = pair.master.try_clone_reader().map_err(io_error)?;
        let writer = pair.master.take_writer().map_err(io_error)?;
        let killer = child.clone_killer();

        let output = Arc::new(Mutex::new(Output::default()));
        let exit = Arc::new(Mutex::new(None));
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || read_loop(reader, sender));
        let pumped = Arc::clone(&output);
        let drained = Arc::new(AtomicBool::new(false));
        let done = Arc::clone(&drained);
        thread::spawn(move || pump(receiver, pumped, done));
        let finished = Arc::clone(&exit);
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
            let deadline = Instant::now() + DRAIN_LIMIT;
            while !drained.load(Ordering::SeqCst) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            *lock(&finished) = Some(code);
            on_exit(code);
        });

        Ok(Self {
            pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            output,
            exit,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn exit_code(&self) -> Option<Option<i32>> {
        *lock(&self.exit)
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
        if !self.alive() {
            return;
        }
        if !self.signal_group(Signal::Hangup) {
            let _ = lock(&self.killer).kill();
            return;
        }
        let pty = Arc::clone(self);
        thread::spawn(move || {
            let deadline = Instant::now() + grace;
            while pty.alive() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
            }
            if pty.alive() {
                pty.signal_group(Signal::Kill);
            }
        });
    }

    pub fn wait_exit(&self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while self.alive() {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(25));
        }
        true
    }

    #[cfg(unix)]
    fn signal_group(&self, signal: Signal) -> bool {
        let Some(pid) = self.pid.and_then(|pid| libc::pid_t::try_from(pid).ok()).filter(|pid| *pid > 1) else {
            return false;
        };
        let number = match signal {
            Signal::Hangup => libc::SIGHUP,
            Signal::Kill => libc::SIGKILL,
        };
        unsafe { libc::killpg(pid, number) == 0 }
    }

    #[cfg(not(unix))]
    fn signal_group(&self, signal: Signal) -> bool {
        let _ = signal;
        lock(&self.killer).kill().is_ok()
    }
}

#[derive(Debug, Clone, Copy)]
enum Signal {
    Hangup,
    Kill,
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
        let pty = Pty::spawn(&shell("read line; echo got:$line"), exited(sender)).expect("spawn");
        let seen = collector(&pty);
        pty.write(b"hola\r").expect("write");
        assert!(wait_for(&seen, "got:hola"));
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)).expect("exit"), Some(0));
        assert!(!pty.alive());
    }

    #[test]
    fn resizing_reaches_the_terminal() {
        let (sender, _receiver) = mpsc::channel();
        let pty = Pty::spawn(&shell("read line; stty size"), exited(sender)).expect("spawn");
        let seen = collector(&pty);
        pty.resize(100, 40).expect("resize");
        pty.write(b"\r").expect("write");
        assert!(wait_for(&seen, "40 100"));
    }

    #[test]
    fn a_late_attach_replays_the_history() {
        let (sender, receiver) = mpsc::channel();
        let pty = Pty::spawn(&shell("echo first-line"), exited(sender)).expect("spawn");
        receiver.recv_timeout(Duration::from_secs(5)).expect("exit");
        thread::sleep(Duration::from_millis(100));
        let seen = collector(&pty);
        assert!(String::from_utf8_lossy(&lock(&seen)).contains("first-line"));
    }

    #[test]
    fn the_history_keeps_only_the_last_two_megabytes() {
        let mut output = Output::default();
        output.push(vec![b'a'; HISTORY_LIMIT]);
        output.push(vec![b'b'; 10]);
        assert_eq!(output.history.len(), HISTORY_LIMIT);
        assert_eq!(output.history.back(), Some(&b'b'));
        assert_eq!(output.history.front(), Some(&b'a'));
    }

    #[test]
    fn large_output_arrives_in_bounded_chunks() {
        let (sender, receiver) = mpsc::channel();
        let pty = Pty::spawn(&shell("head -c 300000 /dev/zero | tr '\\0' x; echo; echo done-now"), exited(sender))
            .expect("spawn");
        let seen = collector(&pty);
        assert!(wait_for(&seen, "done-now"));
        receiver.recv_timeout(Duration::from_secs(5)).expect("exit");
    }

    #[test]
    fn killing_takes_down_the_whole_tree() {
        let (sender, receiver) = mpsc::channel();
        let pty = Arc::new(Pty::spawn(&shell("sleep 30 & echo child:$!; wait"), exited(sender)).expect("spawn"));
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
    fn a_process_that_ignores_hangup_is_killed_after_the_grace() {
        let (sender, receiver) = mpsc::channel();
        let pty = Arc::new(Pty::spawn(&shell("trap '' HUP; echo ready; while :; do sleep 1; done"), exited(sender)).expect("spawn"));
        let seen = collector(&pty);
        assert!(wait_for(&seen, "ready"));
        let started = Instant::now();
        pty.kill_tree(Duration::from_millis(300));
        receiver.recv_timeout(Duration::from_secs(5)).expect("exit");
        assert!(started.elapsed() >= Duration::from_millis(250));
        assert!(!pty.alive());
    }
}
