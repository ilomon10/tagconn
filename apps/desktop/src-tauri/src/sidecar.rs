//! Spawns and monitors the Node supervisor sidecar and relays JSON-RPC over its stdin/stdout
//! (contract: packages/shared/src/desktop.ts). All logic lives in the supervisor; this is plumbing.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

const STDERR_TAIL: usize = 200;
/// An instance that ran this long counts as healthy again: a later crash gets a fresh relaunch.
const STABLE_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcErr {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl RpcErr {
    pub fn new(code: &str, message: impl Into<String>, hint: Option<&str>) -> Self {
        Self { code: code.into(), message: message.into(), hint: hint.map(Into::into) }
    }
    fn down(message: impl Into<String>) -> Self {
        Self::new("sidecar_down", message, Some("Use Retry in the app, or restart it."))
    }
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcErr>>>;

#[derive(Default)]
struct State {
    stdin: Option<ChildStdin>,
    child: Option<Child>,
    pending: Pending,
    /// Bumped per spawn so a stale monitor thread never acts for a newer instance.
    generation: u64,
    relaunched: bool,
    down: Option<String>,
    quitting: bool,
}

pub struct Sidecar {
    app: AppHandle,
    state: Mutex<State>,
    next_id: AtomicU64,
    stderr_tail: Mutex<VecDeque<String>>,
}

pub type SharedSidecar = Arc<Sidecar>;

struct LaunchCmd {
    program: PathBuf,
    args: Vec<String>,
    /// TAGCONN_BUNDLE_DIR: set only for the packaged app; dev runs use the supervisor's repo-layout fallback.
    bundle: Option<PathBuf>,
}

/// Splits `TAGCONN_SUPERVISOR_CMD` on whitespace ("node /path/x.js"); quoting is not supported on purpose.
#[cfg(debug_assertions)]
fn parse_override(cmd: &str) -> Option<LaunchCmd> {
    let mut parts = cmd.split_whitespace().map(String::from);
    let program = parts.next()?;
    Some(LaunchCmd { program: program.into(), args: parts.collect(), bundle: None })
}

/// Returns (bundle root, supervisor.js). The root is the resource dir, or `resources/` inside it
/// depending on how the bundler laid the files out.
fn bundled_supervisor(res: &Path) -> Option<(PathBuf, PathBuf)> {
    [res.to_path_buf(), res.join("resources")].into_iter().map(|root| (root.join("supervisor/supervisor.js"), root)).find(|(js, _)| valid_supervisor(js)).map(|(js, root)| (root, js))
}

/// A real supervisor bundle, not the tiny placeholder that packaging leaves behind (which would
/// otherwise be picked over a good build): over 1 KB and it speaks the RPC (`pair.mint`).
fn valid_supervisor(js: &Path) -> bool {
    std::fs::metadata(js).map(|m| m.len() > 1024).unwrap_or(false) && std::fs::read_to_string(js).map(|t| t.contains("pair.mint")).unwrap_or(false)
}

fn resolve_command(app: &AppHandle) -> Result<LaunchCmd, String> {
    // Debug builds only: in a release build an env var must not be able to pick what the app executes.
    #[cfg(debug_assertions)]
    if let Ok(cmd) = std::env::var("TAGCONN_SUPERVISOR_CMD") {
        return parse_override(&cmd).ok_or_else(|| "TAGCONN_SUPERVISOR_CMD is empty".to_string());
    }
    // Dev: the workspace build of apps/supervisor wins over any staged bundle (which may be a stale stub).
    #[cfg(debug_assertions)]
    {
        let js = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../supervisor/dist/supervisor.js");
        if valid_supervisor(&js) {
            return Ok(LaunchCmd { program: "node".into(), args: vec![js.to_string_lossy().into_owned()], bundle: None });
        }
    }
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    // Prod: the bundled node (tauri externalBin) sits next to the app executable, named `node`.
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled_node = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(node_name))).filter(|p| p.is_file());
    if let (Some(node), Some((root, js))) = (bundled_node, bundled_supervisor(&res)) {
        return Ok(LaunchCmd { program: node, args: vec![js.to_string_lossy().into_owned()], bundle: Some(root) });
    }
    if cfg!(debug_assertions) {
        return Err("apps/supervisor/dist/supervisor.js is missing or invalid. Run `pnpm --filter @tagconn/supervisor build`, or set TAGCONN_SUPERVISOR_CMD.".into());
    }
    Err("The bundled service manager is missing: the install is incomplete.".into())
}

impl Sidecar {
    pub fn new(app: AppHandle) -> SharedSidecar {
        Arc::new(Sidecar { app, state: Mutex::new(State::default()), next_id: AtomicU64::new(1), stderr_tail: Mutex::new(VecDeque::new()) })
    }

    pub fn tail(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap().iter().cloned().collect()
    }

    pub fn down_reason(&self) -> Option<String> {
        self.state.lock().unwrap().down.clone()
    }

    fn push_tail(&self, line: String) {
        let mut t = self.stderr_tail.lock().unwrap();
        if t.len() >= STDERR_TAIL {
            t.pop_front();
        }
        t.push_back(line);
    }

    /// Starts the sidecar (Err = why it could not). Any previous instance must already be gone.
    pub fn spawn(self: &Arc<Self>) -> Result<(), String> {
        let launch = resolve_command(&self.app)?;
        let mut cmd = Command::new(&launch.program);
        cmd.args(&launch.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Own the working directory (not the launch cwd, which may be a repo or a writable shared folder).
        let data = self.app.path().app_data_dir().map_err(|e| format!("no app data dir: {e}"))?;
        std::fs::create_dir_all(&data).map_err(|e| format!("Could not create {}: {e}", data.display()))?;
        cmd.current_dir(&data);
        if let Some(dir) = &launch.bundle {
            cmd.env("TAGCONN_BUNDLE_DIR", dir);
        }
        cmd.env("TAGCONN_APP_VERSION", self.app.package_info().version.to_string());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", launch.program.display()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let generation = {
            let mut st = self.state.lock().unwrap();
            st.generation += 1;
            st.stdin = Some(stdin);
            st.child = Some(child);
            st.down = None;
            st.generation
        };
        self.push_tail(format!("[desktop] started {} {}", launch.program.display(), launch.args.join(" ")));

        let me = Arc::clone(self);
        std::thread::spawn(move || me.read_stdout(stdout));
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[supervisor] {line}");
                me.push_tail(line);
            }
        });
        let me = Arc::clone(self);
        std::thread::spawn(move || me.monitor(generation));
        Ok(())
    }

    fn read_stdout(&self, out: impl std::io::Read) {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                self.push_tail(format!("[stdout] {line}"));
                continue;
            };
            if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                let outcome = if msg.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(msg.get("error").and_then(|e| serde_json::from_value(e.clone()).ok()).unwrap_or_else(|| RpcErr::new("internal", "Malformed error from the service manager.", None)))
                };
                if let Some(tx) = self.state.lock().unwrap().pending.remove(&id) {
                    let _ = tx.send(outcome);
                }
            } else if msg.get("method").is_some() {
                let _ = self.app.emit("desktop://notify", msg);
            }
        }
    }

    /// Waits for the process to exit, then fails in-flight calls and relaunches once (or reports it down).
    fn monitor(self: Arc<Self>, generation: u64) {
        let started = Instant::now();
        let status = loop {
            {
                let mut st = self.state.lock().unwrap();
                if st.generation != generation {
                    return;
                }
                match st.child.as_mut().map(Child::try_wait) {
                    Some(Ok(Some(s))) => break Ok(s),
                    Some(Err(e)) => break Err(e),
                    None => return,
                    _ => {}
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        let reason = match status {
            Ok(s) => format!("The service manager exited ({s})."),
            Err(e) => format!("Lost the service manager: {e}"),
        };
        let (quitting, relaunch) = {
            let mut st = self.state.lock().unwrap();
            if st.generation != generation {
                return;
            }
            st.stdin = None;
            st.child = None;
            for (_, tx) in st.pending.drain() {
                let _ = tx.send(Err(RpcErr::down(reason.clone())));
            }
            if started.elapsed() >= STABLE_AFTER {
                st.relaunched = false;
            }
            let relaunch = !st.quitting && !st.relaunched;
            if relaunch {
                st.relaunched = true;
            }
            (st.quitting, relaunch)
        };
        if quitting {
            return;
        }
        self.push_tail(format!("[desktop] {reason}"));
        if relaunch {
            self.push_tail("[desktop] relaunching once".into());
            match self.spawn() {
                Ok(()) => {
                    let _ = self.app.emit("desktop://sidecar-up", ());
                    // The old supervisor's services died with it: tell the UI so it can offer Start again.
                    let _ = self.app.emit("desktop://sidecar-relaunched", ());
                    return;
                }
                Err(e) => self.mark_down(format!("{reason} Relaunch failed: {e}")),
            }
        } else {
            self.mark_down(reason);
        }
    }

    fn mark_down(&self, reason: String) {
        self.state.lock().unwrap().down = Some(reason.clone());
        let _ = self.app.emit("desktop://sidecar-down", json!({ "reason": reason, "logs": self.tail() }));
    }

    /// The UI's Retry: a clean start with a fresh relaunch budget.
    pub fn retry(self: &Arc<Self>) -> Result<(), String> {
        self.kill();
        {
            let mut st = self.state.lock().unwrap();
            st.relaunched = false;
            st.quitting = false;
        }
        match self.spawn() {
            Ok(()) => {
                let _ = self.app.emit("desktop://sidecar-up", ());
                Ok(())
            }
            Err(e) => {
                self.mark_down(e.clone());
                Err(e)
            }
        }
    }

    /// One request/response with a timeout. The reply arrives via the stdout reader thread.
    pub async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcErr> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut st = self.state.lock().unwrap();
            let reason = st.down.clone().unwrap_or_else(|| "The service manager is not running.".into());
            let Some(stdin) = st.stdin.as_mut() else { return Err(RpcErr::down(reason)) };
            let line = json!({ "id": id, "method": method, "params": params }).to_string();
            if let Err(e) = writeln!(stdin, "{line}").and_then(|_| stdin.flush()) {
                return Err(RpcErr::down(format!("Could not talk to the service manager: {e}")));
            }
            st.pending.insert(id, tx);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(RpcErr::down("The service manager stopped before answering.")),
            Err(_) => {
                self.state.lock().unwrap().pending.remove(&id);
                Err(RpcErr::new("internal", format!("{method} timed out after {}s.", timeout.as_secs()), Some("Check the logs; the service manager may be stuck.")))
            }
        }
    }

    /// Timeout per method: starting/stopping a service or installing hooks can legitimately take a while.
    pub fn timeout_for(method: &str) -> Duration {
        Duration::from_secs(if method.starts_with("service.") || method.starts_with("setup.") { 120 } else { 30 })
    }

    pub fn call_blocking(&self, method: &str, params: Value) -> Result<Value, RpcErr> {
        tauri::async_runtime::block_on(self.call(method, params, Self::timeout_for(method)))
    }

    /// Hard kill. The supervisor kills its own children on a clean stop; use `shutdown` first when quitting.
    pub fn kill(&self) {
        let mut st = self.state.lock().unwrap();
        st.generation += 1; // silences the monitor for this instance
        st.stdin = None;
        if let Some(mut c) = st.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        for (_, tx) in st.pending.drain() {
            let _ = tx.send(Err(RpcErr::down("The service manager was stopped.")));
        }
    }

    /// Quit path: stop the services over RPC, close stdin (the supervisor then stops anything left and exits 0),
    /// wait for it, and only kill it after a timeout.
    pub fn shutdown(&self) {
        {
            self.state.lock().unwrap().quitting = true;
        }
        if self.state.lock().unwrap().stdin.is_some() {
            for id in ["server", "runner", "docker"] {
                let _ = self.call_blocking("service.stop", json!({ "id": id }));
            }
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        self.state.lock().unwrap().stdin = None; // EOF on the supervisor's stdin
        while Instant::now() < deadline {
            {
                let mut st = self.state.lock().unwrap();
                match st.child.as_mut().map(Child::try_wait) {
                    Some(Ok(None)) => {}
                    _ => return,
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        self.kill();
    }
}
