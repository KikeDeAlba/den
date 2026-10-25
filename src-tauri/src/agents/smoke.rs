use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::model::{self, SessionListing, SpawnRequest};
use super::pty::Pty;
use super::{lock, pty_env, spec_for};

const DEADLINE: Duration = Duration::from_secs(25);

fn fake_agent(node: &str, bita: &str) -> String {
    format!(
        r#"#!/bin/sh
[ -n "$BITA_WRAPPER_ID" ] || exit 0
ARGS="$*"
printf '%s\n' "$@" > "$PWD/args.$SMOKE_TAG"
env | sort > "$PWD/env.$SMOKE_TAG"
SID="sess-$$"
while [ $# -gt 0 ]; do if [ "$1" = "--resume" ]; then SID="$2"; fi; shift; done
printf '%s\n' '{{"type":"user","message":{{"role":"user","content":"Add an export command"}}}}' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"On it."}}]}}}}' > "$PWD/transcript-$SID.jsonl"
hook() {{
  printf '{{"session_id":"%s","transcript_path":"%s/transcript-%s.jsonl","cwd":"%s","source":"%s","reason":"prompt_input_exit"}}' \
    "$SID" "$PWD" "$SID" "$PWD" "$2" | "{node}" "{bita}" hook "$1"
}}
hook session-start startup
echo "fake-agent:$ARGS"
if [ "$SMOKE_MODE" = "hang" ]; then
  sleep 300 &
  echo "child:$!"
  wait
fi
read line
echo "bye:$line"
hook session-end other
"#
    )
}

struct Smoke {
    root: PathBuf,
    database: PathBuf,
    bin: [OsString; 2],
    fake: PathBuf,
}

struct Running {
    pty: Arc<Pty>,
    seen: Arc<Mutex<Vec<u8>>>,
    exit: Receiver<Option<i32>>,
    wrapper: String,
}

impl Smoke {
    fn new(tag: &str) -> Option<Self> {
        let script = std::env::var_os("DEN_AGENT_SMOKE_BITA")?;
        let node =
            std::env::var_os("DEN_AGENT_SMOKE_NODE").unwrap_or_else(|| OsString::from("node"));
        let root = std::fs::canonicalize(std::env::temp_dir())
            .expect("temp")
            .join(format!("den-agent-smoke-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("home")).expect("root");
        let fake = root.join("fake-claude");
        let node_text = node.to_string_lossy().into_owned();
        let which = std::process::Command::new("sh")
            .args(["-c", &format!("command -v '{node_text}'")])
            .output()
            .expect("which");
        let node_path = String::from_utf8_lossy(&which.stdout).trim().to_string();
        std::fs::write(&fake, fake_agent(&node_path, &script.to_string_lossy())).expect("fake");
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        Some(Self {
            database: root.join("bita.db"),
            root,
            bin: [node, script],
            fake,
        })
    }

    fn command(&self, args: &[&str]) -> std::process::Output {
        std::process::Command::new(&self.bin[0])
            .arg(&self.bin[1])
            .args(args)
            .arg("--db-path")
            .arg(&self.database)
            .env("HOME", self.root.join("home"))
            .env("BITA_DB_PATH", &self.database)
            .env("BITA_CONFIG_PATH", self.root.join("config.json"))
            .env("KIT_NO_EVENTS", "1")
            .env("KIT_REGISTRY_DIR", self.root.join("registry"))
            .output()
            .expect("bita command")
    }

    fn add_project(&self, name: &str) -> i64 {
        let added = self.command(&["project", "add", name, "--json"]);
        assert!(
            added.status.success(),
            "{}",
            String::from_utf8_lossy(&added.stdout)
        );
        let text = String::from_utf8_lossy(&added.stdout).into_owned();
        let value: serde_json::Value =
            serde_json::from_str(text.trim().lines().last().unwrap_or_default()).expect("json");
        value["data"]["id"]
            .as_i64()
            .unwrap_or_else(|| panic!("no project id: {text}"))
    }

    fn raw_rows(&self, open_only: bool) -> Vec<serde_json::Value> {
        let mut args = vec!["sessions", "ls", "--all", "--json"];
        if open_only {
            args.insert(2, "--open");
        }
        let listed = self.command(&args);
        let text = String::from_utf8_lossy(&listed.stdout).into_owned();
        let value: serde_json::Value =
            serde_json::from_str(text.trim().lines().last().unwrap_or_default())
                .unwrap_or_else(|error| panic!("{error}: {text}"));
        value["data"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| panic!("no data: {text}"))
    }

    fn rows(&self, open_only: bool) -> Vec<SessionListing> {
        self.raw_rows(open_only)
            .into_iter()
            .map(|row| {
                serde_json::from_value(row.clone()).unwrap_or_else(|error| panic!("{error}: {row}"))
            })
            .collect()
    }

    fn spawn(
        &self,
        request: &SpawnRequest,
        extra: &[(&str, &str)],
        inherited: Vec<(OsString, OsString)>,
    ) -> Running {
        let mut spec = spec_for(&self.bin, &self.database, request, 80, 24).expect("spec");
        spec.env = pty_env(&self.bin, inherited);
        spec.env
            .retain(|(key, _)| key != "HOME" && !key.to_string_lossy().starts_with("BITA_"));
        let wrapper = format!(
            "w{}",
            WRAPPERS.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        let mut push = |key: &str, value: OsString| spec.env.push((key.into(), value));
        push("HOME", self.root.join("home").into_os_string());
        push(
            "BITA_HARNESS_BIN_CLAUDE",
            self.fake.clone().into_os_string(),
        );
        push("BITA_DB_PATH", self.database.clone().into_os_string());
        push(
            "BITA_CONFIG_PATH",
            self.root.join("config.json").into_os_string(),
        );
        push("KIT_NO_EVENTS", "1".into());
        push(
            "KIT_REGISTRY_DIR",
            self.root.join("registry").into_os_string(),
        );
        push("SMOKE_TAG", wrapper.clone().into());
        for (key, value) in extra {
            push(key, (*value).into());
        }
        let (sender, exit) = std::sync::mpsc::channel();
        let pty = Arc::new(Pty::spawn(&spec).expect("spawn"));
        pty.watch(move |code| {
            let _ = sender.send(code);
        });
        let seen = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&seen);
        pty.attach(Box::new(move |chunk| {
            lock(&target).extend(chunk);
            true
        }));
        Running {
            pty,
            seen,
            exit,
            wrapper,
        }
    }

    fn request(&self, project: Option<&str>) -> SpawnRequest {
        SpawnRequest {
            harness: Some("claude".into()),
            project: project.map(str::to_string),
            cwd: Some(self.root.to_string_lossy().into_owned()),
            ..SpawnRequest::default()
        }
    }

    fn read(&self, name: &str, wrapper: &str) -> String {
        std::fs::read_to_string(self.root.join(format!("{name}.{wrapper}"))).unwrap_or_default()
    }
}

impl Drop for Smoke {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

static WRAPPERS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

impl Drop for Running {
    fn drop(&mut self) {
        self.pty.terminate(Duration::from_millis(500));
    }
}

impl Running {
    fn output(&self) -> String {
        String::from_utf8_lossy(&lock(&self.seen)).into_owned()
    }

    fn wait_for(&self, needle: &str) -> String {
        let deadline = Instant::now() + DEADLINE;
        while !self.output().contains(needle) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        let output = self.output();
        assert!(output.contains(needle), "missing {needle}: {output}");
        output
    }

    fn linked(&self, smoke: &Smoke) -> SessionListing {
        let pid = self.pty.pid().expect("pid");
        let deadline = Instant::now() + DEADLINE;
        loop {
            if let Some(row) = model::linked(&smoke.rows(true), pid).cloned() {
                return row;
            }
            assert!(
                Instant::now() < deadline,
                "no open row for pid {pid}: {}",
                self.output()
            );
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn finish(&self) {
        self.pty.write(b"listo\r").expect("write");
        let code = self.exit.recv_timeout(DEADLINE).expect("exit");
        assert_eq!(code, Some(0), "{}", self.output());
        assert!(self.output().contains("bye:listo"));
    }
}

fn row_by_id(rows: &[SessionListing], id: i64) -> &SessionListing {
    rows.iter()
        .find(|row| row.id == id)
        .unwrap_or_else(|| panic!("row {id} is gone"))
}

fn process_gone(pid: i32) -> bool {
    unsafe {
        libc::kill(pid, 0) == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

fn real_path() -> (OsString, OsString) {
    ("PATH".into(), std::env::var_os("PATH").unwrap_or_default())
}

#[test]
fn the_prompt_and_a_named_project_arrive_and_the_session_links_and_resumes() {
    let Some(smoke) = Smoke::new("named") else {
        return;
    };
    smoke.add_project("Smoke");
    let mut request = smoke.request(Some("Smoke"));
    request.prompt = Some("--hola mundo".into());
    let first = smoke.spawn(&request, &[], vec![real_path()]);
    first.wait_for("fake-agent:");
    let args = smoke.read("args", &first.wrapper);
    assert!(args.lines().any(|line| line == "--hola mundo"), "{args}");
    let row = first.linked(&smoke);
    assert_eq!(row.harness, "claude");
    assert_eq!(row.entry.as_ref().and_then(|entry| entry.project_name.as_deref()), Some("Smoke"));
    first.finish();
    let closed = smoke.rows(false);
    let ended = row_by_id(&closed, row.id);
    assert!(!ended.open && ended.resumable, "{ended:?}");

    let mut again = smoke.request(None);
    again.harness = None;
    again.resume_session = Some(row.id);
    let second = smoke.spawn(&again, &[], vec![real_path()]);
    second.wait_for("--resume");
    let resumed = smoke.read("args", &second.wrapper);
    let lines: Vec<&str> = resumed.lines().collect();
    let at = lines
        .iter()
        .position(|line| *line == "--resume")
        .expect("--resume");
    assert_eq!(lines.get(at + 1).copied(), ended.session_id.as_deref());
    let reopened = second.linked(&smoke);
    assert_ne!(reopened.id, row.id);
    second.finish();
}

#[test]
fn a_numeric_project_id_reaches_bita_as_the_project_flag() {
    let Some(smoke) = Smoke::new("numeric") else {
        return;
    };
    let id = smoke.add_project("ById");
    let running = smoke.spawn(
        &smoke.request(Some(&id.to_string())),
        &[],
        vec![real_path()],
    );
    running.wait_for("fake-agent:");
    let row = running.linked(&smoke);
    assert_eq!(row.entry.as_ref().and_then(|entry| entry.project_id), Some(id));
    running.finish();
}

fn raw_for_pid(smoke: &Smoke, running: &Running, open_only: bool) -> serde_json::Value {
    let pid = i64::from(running.pty.pid().expect("pid"));
    let deadline = Instant::now() + DEADLINE;
    loop {
        let found = smoke
            .raw_rows(open_only)
            .into_iter()
            .find(|row| row["wrapperPid"] == pid);
        if let Some(row) = found {
            return row;
        }
        assert!(
            Instant::now() < deadline,
            "no row for pid {pid}: {}",
            running.output()
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn a_session_without_a_timer_links_by_pid_and_resumes() {
    let Some(smoke) = Smoke::new("timerless") else {
        return;
    };
    let first = smoke.spawn(&smoke.request(Some("0")), &[], vec![real_path()]);
    first.wait_for("fake-agent:");
    let row = raw_for_pid(&smoke, &first, true);
    assert!(row["entry"].is_null() && row["entryId"].is_null(), "{row}");
    let id = row["id"].as_i64().expect("id");
    first.finish();
    let ended = smoke
        .raw_rows(false)
        .into_iter()
        .find(|candidate| candidate["id"] == id)
        .expect("row");
    assert!(
        ended["open"] == false && ended["resumable"] == true,
        "{ended}"
    );

    let mut again = smoke.request(Some("0"));
    again.harness = None;
    again.resume_session = Some(id);
    let second = smoke.spawn(&again, &[], vec![real_path()]);
    second.wait_for("--resume");
    let reopened = raw_for_pid(&smoke, &second, true);
    assert_ne!(reopened["id"].as_i64(), Some(id));
    assert_eq!(reopened["sessionId"], ended["sessionId"]);
    second.finish();
}

#[test]
fn a_row_without_a_timer_deserializes_into_the_listing_model() {
    let Some(smoke) = Smoke::new("timerless-model") else {
        return;
    };
    let running = smoke.spawn(&smoke.request(Some("0")), &[], vec![real_path()]);
    running.wait_for("fake-agent:");
    let pid = i64::from(running.pty.pid().expect("pid"));
    let linked = running.linked(&smoke);
    assert_eq!(linked.wrapper_pid, pid);
    assert_eq!((linked.entry_id, linked.entry.clone()), (None, None));
    running.finish();
}

#[test]
fn killing_the_session_ends_the_tree_and_bita_closes_it() {
    let Some(smoke) = Smoke::new("kill") else {
        return;
    };
    smoke.add_project("Smoke");
    let running = smoke.spawn(
        &smoke.request(Some("Smoke")),
        &[("SMOKE_MODE", "hang")],
        vec![real_path()],
    );
    let output = running.wait_for("child:");
    let child: i32 = output
        .split("child:")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|text| text.parse().ok())
        .expect("child pid");
    let row = running.linked(&smoke);
    running.pty.kill_tree(Duration::from_secs(3));
    running.exit.recv_timeout(DEADLINE).expect("exit");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !process_gone(child) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(process_gone(child), "grandchild {child} survived");
    let rows = smoke.rows(false);
    let ended = row_by_id(&rows, row.id);
    assert!(!ended.open, "{ended:?}");
}

#[test]
fn the_child_never_sees_loader_node_or_den_variables() {
    let Some(smoke) = Smoke::new("env") else {
        return;
    };
    let inherited: Vec<(OsString, OsString)> = [
        ("DYLD_INSERT_LIBRARIES", "/tmp/x.dylib"),
        ("DYLD_LIBRARY_PATH", "/tmp"),
        ("LD_PRELOAD", "/tmp/x.so"),
        ("NODE_OPTIONS", "--require /tmp/x.js"),
        ("DEN_AGENT_HOOK", "/tmp/hook"),
        ("DEN_SECRET", "x"),
        ("TAURI_ENV", "x"),
        ("WEBKIT_DISABLE", "1"),
        ("UNRELATED_SECRET", "x"),
        ("ANTHROPIC_API_KEY", "key"),
        ("HTTPS_PROXY", "http://proxy:3128"),
    ]
    .into_iter()
    .map(|(key, value)| (OsString::from(key), OsString::from(value)))
    .chain([real_path()])
    .collect();
    let running = smoke.spawn(&smoke.request(Some("0")), &[], inherited);
    running.wait_for("fake-agent:");
    let env = smoke.read("env", &running.wrapper);
    for blocked in [
        "DYLD_",
        "LD_PRELOAD",
        "NODE_OPTIONS",
        "DEN_",
        "TAURI_",
        "WEBKIT_",
        "UNRELATED_SECRET",
    ] {
        assert!(
            !env.lines().any(|line| line.starts_with(blocked)),
            "{blocked} leaked:\n{env}"
        );
    }
    for kept in [
        "ANTHROPIC_API_KEY=key",
        "HTTPS_PROXY=http://proxy:3128",
        "TERM=xterm-256color",
        "COLORTERM=truecolor",
    ] {
        assert!(
            env.lines().any(|line| line == kept),
            "{kept} missing:\n{env}"
        );
    }
    running.finish();
}
