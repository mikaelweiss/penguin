use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

mod browser;
mod files;
mod review;
mod servers;

use tauri::path::BaseDirectory;
use tauri::window::Color;
use tauri::{Emitter, Manager, Theme};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RunUpdate {
    id: String,
    text: String,
    offset: u64,
    alive: bool,
}

fn state_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    match std::env::var("XDG_STATE_HOME") {
        Ok(base) if !base.is_empty() => Some(PathBuf::from(base).join("penguin")),
        _ => app
            .path()
            .home_dir()
            .ok()
            .map(|home| home.join(".local").join("state").join("penguin")),
    }
}

fn runs_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    state_dir(app).map(|state| state.join("runs"))
}

#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    // Signal 0 asks the kernel whether the process is still there.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(not(unix))]
fn pid_alive(_pid: i32) -> bool {
    // A run is only crashed once its process is proven gone, and this platform cannot prove it.
    true
}

fn head_pid(path: &PathBuf) -> Option<i32> {
    let mut line = String::new();
    BufReader::new(File::open(path).ok()?).read_line(&mut line).ok()?;
    let head: serde_json::Value = serde_json::from_str(&line).ok()?;
    head.get("pid")?.as_i64().map(|pid| pid as i32)
}

/// The most run text one read hands the frontend. A runaway run file arrives over many polls
/// instead of stalling the window on one.
const READ_BUDGET: usize = 4 << 20;

/// Whole lines from `from`, up to about `budget` bytes. The offset lands after the last line
/// read, so a half written line waits for the next read and a long line always makes progress.
fn update(id: String, path: PathBuf, from: u64, budget: usize) -> Option<RunUpdate> {
    let mut file = File::open(&path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = if from > len { 0 } else { from };
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut line = Vec::new();
    while bytes.len() < budget {
        line.clear();
        reader.read_until(b'\n', &mut line).ok()?;
        if line.last() != Some(&b'\n') {
            break;
        }
        bytes.extend_from_slice(&line);
    }
    let text = String::from_utf8(bytes).ok()?;
    Some(RunUpdate {
        id,
        offset: from + text.len() as u64,
        text,
        alive: head_pid(&path).is_some_and(pid_alive),
    })
}

/// Every run's new run.jsonl lines since the caller's offset, within one read's budget.
/// A run whose folder is gone drops out.
#[tauri::command]
fn read_runs(app: tauri::AppHandle, offsets: HashMap<String, u64>) -> Vec<RunUpdate> {
    let Some(dir) = runs_dir(&app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut budget = READ_BUDGET;
    entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok()?;
            let path = entry.path().join("run.jsonl");
            let from = offsets.get(&id).copied().unwrap_or(0);
            let found = update(id, path, from, budget)?;
            budget = budget.saturating_sub(found.text.len());
            Some(found)
        })
        .collect()
}

/// A run id names one folder under the runs directory. Anything else is refused.
fn run_folder(runs: PathBuf, id: &str) -> Option<PathBuf> {
    if id.is_empty() || id.starts_with('.') || id.contains(std::path::is_separator) {
        return None;
    }
    Some(runs.join(id))
}

/// The instant format every run file line carries.
fn stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn append_line(path: &Path, entry: &serde_json::Value) -> std::io::Result<()> {
    let mut file = File::options().create(true).append(true).open(path)?;
    writeln!(file, "{entry}")
}

/// One line onto a run's inbox. The engine reads `{"answer": ...}` and `{"message": "..."}` from it.
#[tauri::command]
fn append_inbox(app: tauri::AppHandle, id: String, entry: serde_json::Value) -> Result<(), String> {
    let dir = runs_dir(&app)
        .and_then(|runs| run_folder(runs, &id))
        .ok_or_else(|| format!("no inbox for {id}"))?;
    append_line(&dir.join("inbox.jsonl"), &entry).map_err(|cause| cause.to_string())
}

/// A `{"name": ...}` note on the run's own file. The newest one is the run's name.
#[tauri::command]
fn rename_run(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    let dir = runs_dir(&app)
        .and_then(|runs| run_folder(runs, &id))
        .ok_or_else(|| format!("no run named {id}"))?;
    let note = serde_json::json!({ "at": stamp(), "name": name });
    append_line(&dir.join("run.jsonl"), &note).map_err(|cause| cause.to_string())
}

/// A name the directory does not hold yet, so a second paste of `image.png` keeps both.
fn free_name(dir: &Path, name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or("file");
    let stem = Path::new(base)
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or("file");
    let extension = Path::new(base).extension().and_then(|part| part.to_str());
    let mut candidate = base.to_string();
    let mut taken = 0;
    while dir.join(&candidate).exists() {
        taken += 1;
        candidate = match extension {
            Some(extension) => format!("{stem}-{taken}.{extension}"),
            None => format!("{stem}-{taken}"),
        };
    }
    candidate
}

/// A pasted file has no path yet, so its bytes land in the run's `files/` directory.
#[tauri::command]
fn write_run_file(
    app: tauri::AppHandle,
    id: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let dir = runs_dir(&app)
        .and_then(|runs| run_folder(runs, &id))
        .ok_or_else(|| format!("no run named {id}"))?
        .join("files");
    std::fs::create_dir_all(&dir).map_err(|cause| cause.to_string())?;
    let path = dir.join(free_name(&dir, &name));
    std::fs::write(&path, bytes).map_err(|cause| cause.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// The bytes behind an attachment, so a dropped image can draw a thumbnail.
#[tauri::command]
fn read_attachment(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|cause| cause.to_string())
}

/// A run's stderr. A run the app did not start wrote none, which is not a failure to report.
fn start_log(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("start.log")).unwrap_or_default()
}

/// What a run said on stderr. A run that crashed before its own file says why left it only here.
#[tauri::command]
fn read_run_log(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let dir = runs_dir(&app)
        .and_then(|runs| run_folder(runs, &id))
        .ok_or_else(|| format!("no run named {id}"))?;
    Ok(start_log(&dir))
}

#[cfg(unix)]
fn signal_run(pid: i32) -> bool {
    // A run the app started leads its own group, so this reaches the agents it spawned with it.
    if unsafe { libc::killpg(pid, libc::SIGTERM) } == 0 {
        return true;
    }
    // A run started by hand shares its shell's group, which must never be signalled.
    unsafe { libc::kill(pid, libc::SIGTERM) == 0 }
}

#[cfg(not(unix))]
fn signal_run(_pid: i32) -> bool {
    false
}

/// SIGTERM to each run. Callers pass a run and every run inside it, outermost first.
#[tauri::command]
fn stop_runs(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    let runs = runs_dir(&app).ok_or("no runs directory")?;
    let mut missed = Vec::new();
    for id in ids {
        let pid = run_folder(runs.clone(), &id)
            .map(|dir| dir.join("run.jsonl"))
            .as_ref()
            .and_then(head_pid);
        match pid {
            // A run that already left has nothing to stop.
            Some(pid) if !pid_alive(pid) => {}
            Some(pid) if signal_run(pid) => {}
            _ => missed.push(id),
        }
    }
    if missed.is_empty() {
        return Ok(());
    }
    Err(format!("could not stop {}", missed.join(", ")))
}

/// ~/.penguin, the folder the engine reads its config from.
fn penguin_home(app: &tauri::AppHandle) -> Option<PathBuf> {
    match std::env::var("PENGUIN_HOME") {
        Ok(base) if !base.is_empty() => Some(PathBuf::from(base)),
        _ => app.path().home_dir().ok().map(|home| home.join(".penguin")),
    }
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    penguin_home(app)
        .map(|home| home.join("config"))
        .ok_or_else(|| "no home folder to read the config from".to_string())
}

/// Splits "key value" the way the engine's reader does. A line without a space is not a setting.
fn setting_of(line: &str) -> Option<(&str, &str)> {
    let text = line.trim();
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    let split = text.find(char::is_whitespace)?;
    Some((&text[..split], text[split..].trim()))
}

/// ~/.penguin/config, the settings the engine and the app share.
#[tauri::command]
fn read_config(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let file = config_file(&app)?;
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(HashMap::new());
    };
    Ok(text
        .lines()
        .filter_map(setting_of)
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect())
}

/// The config with one setting changed, every comment and other line kept. An empty value drops it.
fn rewrite(text: &str, key: &str, value: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    let line = format!("{key} {value}");
    let mut written = false;
    for old in text.lines() {
        match setting_of(old) {
            Some((found, _)) if found == key => {
                if !written && !value.is_empty() {
                    lines.push(&line);
                    written = true;
                }
            }
            _ => lines.push(old),
        }
    }
    if !written && !value.is_empty() {
        lines.push(&line);
    }
    if lines.is_empty() {
        return String::new();
    }
    format!("{}\n", lines.join("\n"))
}

/// One setting, rewritten in place so comments and every other line survive. An empty value drops it.
#[tauri::command]
fn write_config(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let file = config_file(&app)?;
    let text = std::fs::read_to_string(&file).unwrap_or_default();
    let home = file.parent().ok_or("the config file has no folder")?;
    std::fs::create_dir_all(home).map_err(|cause| cause.to_string())?;
    std::fs::write(&file, rewrite(&text, &key, &value)).map_err(|cause| cause.to_string())
}

/// A secret name names one keychain account and one epoch file. Anything else is refused.
fn secret_name(name: &str) -> Option<&str> {
    let fine = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    fine.then_some(name)
}

/// Credentials go to the engine's own bun, which puts them in the OS keystore.
/// The value travels over stdin, never through a file or an argv. The epoch
/// file tells every paused run to read the item again.
#[tauri::command]
async fn store_auth_secret(
    app: tauri::AppHandle,
    name: String,
    value: serde_json::Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = secret_name(&name).ok_or("not a secret name")?.to_string();
        let saved_at = stamp();
        let mut held = value;
        held.as_object_mut()
            .ok_or("a secret is a JSON object")?
            .insert("savedAt".into(), serde_json::Value::String(saved_at.clone()));

        let engine = engine(&app)?;
        let mut child = Command::new(&engine.bun)
            .arg(engine.dir.join("src").join("store-secret.ts"))
            .arg(&name)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|cause| format!("{} could not run: {cause}", engine.bun.display()))?;
        {
            let mut stdin = child.stdin.take().ok_or("the secret writer took no stdin")?;
            stdin
                .write_all(held.to_string().as_bytes())
                .map_err(|cause| cause.to_string())?;
        }
        let done = child.wait_with_output().map_err(|cause| cause.to_string())?;
        if !done.status.success() {
            let said = String::from_utf8_lossy(&done.stderr).trim().to_string();
            return Err(if said.is_empty() {
                "the keystore write failed".into()
            } else {
                said
            });
        }

        let dir = state_dir(&app).ok_or("no state directory")?.join("auth");
        std::fs::create_dir_all(&dir).map_err(|cause| cause.to_string())?;
        std::fs::write(dir.join(&name), saved_at).map_err(|cause| cause.to_string())
    })
    .await
    .map_err(|cause| cause.to_string())?
}

fn dirs_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|cause| cause.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|cause| cause.to_string())?;
    Ok(dir.join("directories.json"))
}

/// The project folders the user added. App-only state, so it lives beside the theme, not in the runs.
#[tauri::command]
fn read_dirs(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let file = dirs_file(&app)?;
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&text).map_err(|cause| cause.to_string())
}

#[tauri::command]
fn write_dirs(app: tauri::AppHandle, dirs: Vec<String>) -> Result<(), String> {
    let file = dirs_file(&app)?;
    let text = serde_json::to_string(&dirs).map_err(|cause| cause.to_string())?;
    std::fs::write(&file, text).map_err(|cause| cause.to_string())
}

fn hidden_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|cause| cause.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|cause| cause.to_string())?;
    Ok(dir.join("hidden.json"))
}

/// Each project root the user hid, against the instant it was hidden. Runs older than it stay out.
#[tauri::command]
fn read_hidden(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let file = hidden_file(&app)?;
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(HashMap::new());
    };
    serde_json::from_str(&text).map_err(|cause| cause.to_string())
}

#[tauri::command]
fn write_hidden(app: tauri::AppHandle, hidden: HashMap<String, String>) -> Result<(), String> {
    let file = hidden_file(&app)?;
    let text = serde_json::to_string(&hidden).map_err(|cause| cause.to_string())?;
    std::fs::write(&file, text).map_err(|cause| cause.to_string())
}

fn browser_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|cause| cause.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|cause| cause.to_string())?;
    Ok(dir.join("browser.json"))
}

/// Each run's browser tabs, against the run id. App-only state, so it lives beside the theme.
/// The shape is the frontend's; this only carries it across a quit.
#[tauri::command]
fn read_browser(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let file = browser_file(&app)?;
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(serde_json::json!({}));
    };
    Ok(serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({})))
}

#[tauri::command]
fn write_browser(app: tauri::AppHandle, tabs: serde_json::Value) -> Result<(), String> {
    let file = browser_file(&app)?;
    let text = serde_json::to_string(&tabs).map_err(|cause| cause.to_string())?;
    std::fs::write(&file, text).map_err(|cause| cause.to_string())
}

fn panels_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|cause| cause.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|cause| cause.to_string())?;
    Ok(dir.join("panels.json"))
}

fn panels_at(file: &Path) -> serde_json::Value {
    let Ok(text) = std::fs::read_to_string(file) else {
        return serde_json::json!({});
    };
    serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}))
}

/// Written beside the file and renamed over it, so a crash mid-write cannot leave every
/// run's layout truncated.
fn write_panels_at(file: &Path, panels: &serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string(panels).map_err(|cause| cause.to_string())?;
    let staged = file.with_extension("json.tmp");
    std::fs::write(&staged, text).map_err(|cause| cause.to_string())?;
    std::fs::rename(&staged, file).map_err(|cause| cause.to_string())
}

/// Every run's panel layout and open tabs, plus the one global block. The shape is the
/// frontend's. This only carries it across a quit.
#[tauri::command]
fn read_panels(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    Ok(panels_at(&panels_file(&app)?))
}

#[tauri::command]
fn write_panels(app: tauri::AppHandle, panels: serde_json::Value) -> Result<(), String> {
    write_panels_at(&panels_file(&app)?, &panels)
}

/// The git project's root, walking up from dir. A folder outside any repository is its own root.
#[tauri::command]
fn project_root(dir: String) -> String {
    let start = PathBuf::from(&dir);
    let start = start.canonicalize().unwrap_or(start);
    let mut walk = start.as_path();
    loop {
        let marker = walk.join(".git");
        if marker.exists() {
            return text_of(root_of(walk, &marker));
        }
        match walk.parent() {
            Some(up) if up != walk => walk = up,
            _ => return text_of(start.clone()),
        }
    }
}

/// The quality gates a project lists, in the project root a run resolves from dir.
fn gates_file(dir: String) -> PathBuf {
    PathBuf::from(project_root(dir))
        .join(".penguin")
        .join("gates")
}

/// A gate is a whole line, so the last one needs its newline to stay one.
fn ended(text: &str) -> String {
    if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    }
}

/// The gate file as a person wrote it, none when the project has no file yet.
#[tauri::command]
fn read_gates(dir: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(gates_file(dir)) {
        Ok(text) => Ok(Some(text)),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(cause.to_string()),
    }
}

#[tauri::command]
fn write_gates(dir: String, text: String) -> Result<(), String> {
    let file = gates_file(dir);
    let home = file.parent().ok_or("the gate file has no folder")?;
    std::fs::create_dir_all(home).map_err(|cause| cause.to_string())?;
    std::fs::write(&file, ended(&text)).map_err(|cause| cause.to_string())
}

pub(crate) fn text_of(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// A worktree's .git is a file pointing into the main repository's .git; that repository is the root.
fn root_of(dir: &Path, marker: &Path) -> PathBuf {
    if marker.is_dir() {
        return dir.to_path_buf();
    }
    let Ok(text) = std::fs::read_to_string(marker) else {
        return dir.to_path_buf();
    };
    let Some(linked) = text.lines().find_map(|line| line.strip_prefix("gitdir:")) else {
        return dir.to_path_buf();
    };
    let resolved = dir.join(linked.trim());
    let resolved = resolved.canonicalize().unwrap_or(resolved);
    let inside = format!("{sep}.git{sep}", sep = std::path::MAIN_SEPARATOR);
    let text = resolved.to_string_lossy().into_owned();
    match text.rfind(&inside) {
        Some(split) => PathBuf::from(&text[..split]),
        None => dir.to_path_buf(),
    }
}

struct Engine {
    bun: PathBuf,
    dir: PathBuf,
}

/// The engine the app runs. A debug build reads the workspace, so an edit lands without staging.
fn engine_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let bundled = app.path().resolve("engine", BaseDirectory::Resource).ok();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/engine");
    let order = if cfg!(debug_assertions) {
        [Some(source), bundled]
    } else {
        [bundled, Some(source)]
    };
    order
        .into_iter()
        .flatten()
        .find(|dir| dir.join("src").join("child.ts").exists())
}

fn engine(app: &tauri::AppHandle) -> Result<Engine, String> {
    let dir = engine_dir(app).ok_or("no engine to run, so nothing can start")?;
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|next_to| next_to.join("bun")))
        .filter(|bun| bun.exists());
    Ok(Engine {
        bun: beside.unwrap_or_else(|| PathBuf::from("bun")),
        dir,
    })
}

/// Everything the catalogs hold for one folder, exactly as the engine's describe entry prints it.
#[tauri::command]
async fn describe(app: tauri::AppHandle, dir: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = engine(&app)?;
        let output = Command::new(&engine.bun)
            .arg(engine.dir.join("src").join("describe.ts"))
            .arg(&dir)
            .current_dir(&dir)
            .output()
            .map_err(|cause| format!("{} could not run: {cause}", engine.bun.display()))?;
        if !output.status.success() {
            let said = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if said.is_empty() {
                "the engine printed nothing".into()
            } else {
                said
            });
        }
        serde_json::from_slice(&output.stdout).map_err(|cause| cause.to_string())
    })
    .await
    .map_err(|cause| cause.to_string())?
}

#[derive(serde::Serialize)]
struct Job<'a> {
    file: &'a str,
    params: &'a serde_json::Value,
    cwd: &'a str,
    id: &'a str,
}

/// A fresh run id, its folder claimed under the runs directory the way the engine claims one.
fn claim_id(runs: &Path) -> Result<String, String> {
    std::fs::create_dir_all(runs).map_err(|cause| cause.to_string())?;
    let claimed = stamp().replace(':', "-");
    let pid = std::process::id();
    let mut id = format!("{claimed}-{pid}");
    let mut extra = 2;
    while runs.join(&id).exists() {
        id = format!("{claimed}-{pid}-{extra}");
        extra += 1;
    }
    std::fs::create_dir(runs.join(&id)).map_err(|cause| cause.to_string())?;
    Ok(id)
}

/// A run folder before the run exists, so a pasted file has somewhere to land.
#[tauri::command]
fn claim_run(app: tauri::AppHandle) -> Result<String, String> {
    let runs = runs_dir(&app).ok_or("no runs directory")?;
    claim_id(&runs)
}

/// A claimed folder the dialog never started. One holding a run file is left alone.
fn discard(folder: &Path) -> std::io::Result<()> {
    if !folder.exists() || folder.join("run.jsonl").exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(folder)
}

/// Drops a folder claimed for a run that never started.
#[tauri::command]
fn discard_run(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let folder = runs_dir(&app)
        .and_then(|runs| run_folder(runs, &id))
        .ok_or_else(|| format!("no run named {id}"))?;
    discard(&folder).map_err(|cause| cause.to_string())
}

/// A run still writing would put its file back, so the folder goes only once the process has left.
fn leaves(folder: &Path) -> bool {
    let file = folder.join("run.jsonl");
    let Some(pid) = head_pid(&file) else {
        return true;
    };
    for _ in 0..40 {
        if !pid_alive(pid) {
            return true;
        }
        signal_run(pid);
        std::thread::sleep(Duration::from_millis(50));
    }
    !pid_alive(pid)
}

/// Drops the run folders for good, so the projects they name stop reappearing in the sidebar.
#[tauri::command]
async fn forget_runs(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runs = runs_dir(&app).ok_or("no runs directory")?;
        let mut missed = Vec::new();
        for id in ids {
            let folder = run_folder(runs.clone(), &id);
            let gone = match folder {
                Some(folder) if !folder.exists() => true,
                Some(folder) => leaves(&folder) && std::fs::remove_dir_all(&folder).is_ok(),
                None => false,
            };
            if !gone {
                missed.push(id);
            }
        }
        if missed.is_empty() {
            return Ok(());
        }
        Err(format!("could not forget {}", missed.join(", ")))
    })
    .await
    .map_err(|cause| cause.to_string())?
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // Its own session, so the run outlives the app and stops as one process group.
    unsafe {
        command.pre_exec(|| match libc::setsid() {
            -1 => Err(std::io::Error::last_os_error()),
            _ => Ok(()),
        });
    }
}

#[cfg(not(unix))]
fn detach(_command: &mut Command) {}

/// The seconds a run gets to write its first line before start_run stops waiting on it.
const START_WAIT: Duration = Duration::from_secs(10);

/// Starts a workflow as its own detached run, settling once the run file it will stream from exists.
#[tauri::command]
async fn start_run(
    app: tauri::AppHandle,
    file: String,
    params: serde_json::Value,
    dir: String,
    id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = engine(&app)?;
        let runs = runs_dir(&app).ok_or("no runs directory")?;
        let (id, folder) = match id {
            Some(claimed) => {
                let folder = run_folder(runs, &claimed)
                    .ok_or_else(|| format!("no run named {claimed}"))?;
                std::fs::create_dir_all(&folder).map_err(|cause| cause.to_string())?;
                (claimed, folder)
            }
            None => {
                let fresh = claim_id(&runs)?;
                let folder = runs.join(&fresh);
                (fresh, folder)
            }
        };
        let job = serde_json::to_string(&Job {
            file: &file,
            params: &params,
            cwd: &dir,
            id: &id,
        })
        .map_err(|cause| cause.to_string())?;

        let log = folder.join("start.log");
        let mut command = Command::new(&engine.bun);
        command
            .arg(engine.dir.join("src").join("child.ts"))
            .arg(&job)
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(File::create(&log).map_err(|cause| cause.to_string())?);
        detach(&mut command);
        let mut child = command
            .spawn()
            .map_err(|cause| format!("{} could not run: {cause}", engine.bun.display()))?;

        let run_file = folder.join("run.jsonl");
        let deadline = Instant::now() + START_WAIT;
        while Instant::now() < deadline {
            if run_file.exists() {
                return Ok(id);
            }
            if matches!(child.try_wait(), Ok(Some(_))) {
                return Err(died(&file, &log));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Ok(id)
    })
    .await
    .map_err(|cause| cause.to_string())?
}

/// The running pty host. Its piped stdin doubles as the shutdown signal:
/// dropping the child, or the app exiting, closes the pipe and the host quits.
struct TerminalHost {
    child: Child,
    port: u16,
}

struct TerminalHostState(Mutex<Option<TerminalHost>>);

/// The pty host's port, spawning the host on the bundled bun the first time.
#[tauri::command]
async fn terminal_host(app: tauri::AppHandle) -> Result<u16, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<TerminalHostState>();
        let mut held = state.0.lock().map_err(|_| "the terminal host state is poisoned")?;
        if let Some(host) = held.as_mut() {
            if matches!(host.child.try_wait(), Ok(None)) {
                return Ok(host.port);
            }
        }
        let engine = engine(&app)?;
        let mut child = Command::new(&engine.bun)
            .arg(engine.dir.join("src").join("terminal-host.ts"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|cause| format!("{} could not run: {cause}", engine.bun.display()))?;
        let stdout = child.stdout.take().ok_or("the terminal host has no stdout")?;
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .map_err(|cause| cause.to_string())?;
        let port = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|said| said.get("port").and_then(serde_json::Value::as_u64))
            .ok_or_else(|| {
                let mut said = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut said);
                }
                match said.trim() {
                    "" => "the terminal host printed no port".to_string(),
                    problem => problem.to_string(),
                }
            })?;
        *held = Some(TerminalHost {
            child,
            port: port as u16,
        });
        Ok(port as u16)
    })
    .await
    .map_err(|cause| cause.to_string())?
}

fn died(file: &str, log: &Path) -> String {
    let name = Path::new(file)
        .file_name()
        .map_or_else(|| file.to_string(), |name| name.to_string_lossy().into_owned());
    let said = std::fs::read_to_string(log).unwrap_or_default();
    match said.trim() {
        "" => format!("{name} died before it wrote anything"),
        problem => problem.to_string(),
    }
}

/// Carries the run id of the notification that was clicked.
const NEEDS_YOU_CLICK: &str = "needs-you-click";

/// The notification's one action. Nothing waits on a notification that carries no button, so
/// without this the click never comes back. XDG fires this id for a body click too.
const OPEN_ACTION: &str = "default";

fn opens_the_run(response: &notify_rust::NotificationResponse) -> bool {
    match response {
        notify_rust::NotificationResponse::Action(key) => key == OPEN_ACTION,
        clicked => clicked.is_default_action(),
    }
}

/// A sound choice under the name this platform's notifier knows it by. `None` stays silent.
#[cfg(target_os = "macos")]
fn sound_name(choice: &str) -> Option<&'static str> {
    Some(match choice {
        "ping" => "Ping",
        "pop" => "Pop",
        "sonar" => "Submarine",
        "none" => return None,
        _ => "Glass",
    })
}

#[cfg(target_os = "windows")]
fn sound_name(choice: &str) -> Option<&'static str> {
    Some(match choice {
        "ping" => "SMS",
        "pop" => "Mail",
        "sonar" => "Reminder",
        "none" => return None,
        _ => "IM",
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn sound_name(choice: &str) -> Option<&'static str> {
    Some(match choice {
        "ping" => "message",
        "pop" => "message-new-email",
        "sonar" => "complete",
        "none" => return None,
        _ => "bell",
    })
}

#[cfg(target_os = "macos")]
fn play(name: &str) {
    let _ = Command::new("afplay")
        .arg(format!("/System/Library/Sounds/{name}.aiff"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(all(unix, not(target_os = "macos")))]
fn play(name: &str) {
    let _ = Command::new("canberra-gtk-play")
        .args(["-i", name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(target_os = "windows")]
fn play(_name: &str) {
    // A toast sound is reachable only through a toast, so Windows hears its choice on the notice.
}

/// The sound alone, so picking one in settings is something you hear.
#[tauri::command]
fn play_sound(sound: String) {
    let Some(name) = sound_name(&sound) else {
        return;
    };
    std::thread::spawn(move || play(name));
}

/// Posts a notification for a waiting run. Its thread lives until the person acts on the
/// notification or clears it, because macOS only sends one while something waits on the response.
#[tauri::command]
fn notify_needs_you(app: tauri::AppHandle, id: String, title: String, body: String, sound: String) {
    std::thread::spawn(move || {
        let mut notice = notify_rust::Notification::new();
        notice.summary(&title).body(&body).action(OPEN_ACTION, "Show");
        if let Some(name) = sound_name(&sound) {
            notice.sound_name(name);
        }
        let sent = notice.show();
        if let Ok(handle) = sent {
            let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                if opens_the_run(response) {
                    let _ = app.emit(NEEDS_YOU_CLICK, &id);
                }
            });
        }
    });
}

/// Matches `--background` in `packages/ui/src/styles/globals.css`.
const LIGHT_BACKGROUND: Color = Color(0xff, 0xff, 0xff, 0xff);
const DARK_BACKGROUND: Color = Color(0x0a, 0x0a, 0x0a, 0xff);

/// The longest the window stays hidden when the frontend never asks to be shown.
const SHOW_DEADLINE: Duration = Duration::from_millis(3000);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            let background = match window.theme() {
                Ok(Theme::Dark) => DARK_BACKGROUND,
                _ => LIGHT_BACKGROUND,
            };
            window.set_background_color(Some(background))?;

            #[cfg(target_os = "macos")]
            {
                // Dev has no bundle of its own, so the notification goes out under Terminal's.
                let sender = if tauri::is_dev() {
                    "com.apple.Terminal"
                } else {
                    app.config().identifier.as_str()
                };
                let _ = notify_rust::set_application(sender);
            }

            let waiting = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_DEADLINE);
                let _ = waiting.show();
            });

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(TerminalHostState(Mutex::new(None)))
        .manage(files::WatchState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            read_runs,
            append_inbox,
            read_dirs,
            write_dirs,
            read_hidden,
            write_hidden,
            project_root,
            read_gates,
            write_gates,
            describe,
            claim_run,
            discard_run,
            forget_runs,
            start_run,
            rename_run,
            write_run_file,
            read_attachment,
            read_run_log,
            stop_runs,
            read_config,
            write_config,
            store_auth_secret,
            terminal_host,
            notify_needs_you,
            play_sound,
            read_browser,
            write_browser,
            read_panels,
            write_panels,
            review::review_root,
            review::git_changes,
            files::list_files,
            files::read_file,
            files::search_files,
            files::watch_files,
            servers::local_servers,
            browser::browser_reset,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_focus,
            browser::browser_close,
            browser::browser_navigate,
            browser::browser_reload,
            browser::browser_back,
            browser::browser_forward
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_file(dir: &std::path::Path, pid: i32, lines: &[&str]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("run.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{{\"run\":\"r\",\"pid\":{pid},\"workflow\":\"w.ts\",\"params\":{{}}}}").unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        path
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("penguin-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_missing_panel_file_reads_as_an_empty_layout() {
        let dir = temp("panels-none");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(panels_at(&dir.join("panels.json")), serde_json::json!({}));
    }

    #[test]
    fn a_corrupt_panel_file_reads_as_an_empty_layout() {
        let dir = temp("panels-corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("panels.json");
        std::fs::write(&file, "{\"global\": {\"sidebarOpen\"").unwrap();
        assert_eq!(panels_at(&file), serde_json::json!({}));
    }

    #[test]
    fn a_panel_write_replaces_the_whole_file_and_leaves_no_scratch_behind() {
        let dir = temp("panels-write");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("panels.json");
        write_panels_at(&file, &serde_json::json!({ "runs": { "a": { "base": "auto" } } })).unwrap();
        write_panels_at(&file, &serde_json::json!({ "runs": { "b": { "base": "head" } } })).unwrap();
        assert_eq!(
            panels_at(&file),
            serde_json::json!({ "runs": { "b": { "base": "head" } } })
        );
        assert!(!dir.join("panels.json.tmp").exists());
    }

    #[test]
    fn the_notification_body_and_its_button_both_open_the_run() {
        use notify_rust::{CloseReason, NotificationResponse};

        assert!(opens_the_run(&NotificationResponse::Default));
        assert!(opens_the_run(&NotificationResponse::Action(OPEN_ACTION.into())));
        assert!(!opens_the_run(&NotificationResponse::Action("snooze".into())));
        assert!(!opens_the_run(&NotificationResponse::Closed(CloseReason::Expired)));
    }

    #[test]
    fn a_setting_is_rewritten_where_it_already_sat() {
        let text = "# mine\nagent claude\nworktrees /tmp/w\n";
        assert_eq!(rewrite(text, "agent", "codex"), "# mine\nagent codex\nworktrees /tmp/w\n");
    }

    #[test]
    fn a_setting_the_config_lacks_lands_at_the_end() {
        assert_eq!(rewrite("agent claude\n", "worktrees", "/tmp/w"), "agent claude\nworktrees /tmp/w\n");
    }

    #[test]
    fn an_empty_value_drops_the_line() {
        assert_eq!(rewrite("# mine\nagent claude\n", "agent", ""), "# mine\n");
    }

    #[test]
    fn a_repeated_key_is_left_with_one_line() {
        assert_eq!(rewrite("agent claude\nagent codex\n", "agent", "gemini"), "agent gemini\n");
    }

    #[test]
    fn reads_the_whole_file_from_zero() {
        let dir = temp("whole");
        let path = run_file(&dir, std::process::id() as i32, &["{\"a\":1}"]);
        let update = update("r".into(), path, 0, READ_BUDGET).unwrap();
        assert_eq!(update.text.lines().count(), 2);
        assert_eq!(update.offset, update.text.len() as u64);
    }

    #[test]
    fn reads_only_what_grew() {
        let dir = temp("grew");
        let path = run_file(&dir, std::process::id() as i32, &[]);
        let first = update("r".into(), path.clone(), 0, READ_BUDGET).unwrap();

        writeln!(
            File::options().append(true).open(&path).unwrap(),
            "{{\"outcome\":null}}"
        )
        .unwrap();

        let second = update("r".into(), path, first.offset, READ_BUDGET).unwrap();
        assert_eq!(second.text, "{\"outcome\":null}\n");
    }

    #[test]
    fn a_big_file_arrives_in_whole_lines_over_several_reads() {
        let dir = temp("budget");
        let path = run_file(&dir, std::process::id() as i32, &["{\"a\":1}", "{\"a\":2}", "{\"a\":3}"]);
        let first = update("r".into(), path.clone(), 0, 1).unwrap();
        assert_eq!(first.text.lines().count(), 1);
        assert!(first.text.ends_with('\n'));

        let second = update("r".into(), path.clone(), first.offset, 9).unwrap();
        assert_eq!(second.text, "{\"a\":1}\n{\"a\":2}\n");

        let rest = update("r".into(), path, second.offset, READ_BUDGET).unwrap();
        assert_eq!(rest.text, "{\"a\":3}\n");
    }

    #[test]
    fn a_half_written_line_waits_for_the_next_read() {
        let dir = temp("half");
        let path = run_file(&dir, std::process::id() as i32, &[]);
        let mut file = File::options().append(true).open(&path).unwrap();
        write!(file, "{{\"a\":").unwrap();
        let first = update("r".into(), path.clone(), 0, READ_BUDGET).unwrap();
        assert_eq!(first.text.lines().count(), 1);

        writeln!(file, "1}}").unwrap();
        let second = update("r".into(), path, first.offset, READ_BUDGET).unwrap();
        assert_eq!(second.text, "{\"a\":1}\n");
    }

    #[test]
    fn rereads_a_file_that_shrank() {
        let dir = temp("shrank");
        let path = run_file(&dir, std::process::id() as i32, &["{\"a\":1}", "{\"a\":2}"]);
        let update = update("r".into(), path, 9_000, READ_BUDGET).unwrap();
        assert_eq!(update.text.lines().count(), 3);
    }

    #[test]
    fn a_live_pid_is_alive_and_a_missing_one_is_not() {
        let dir = temp("alive");
        let mine = run_file(&dir, std::process::id() as i32, &[]);
        assert!(update("r".into(), mine, 0, READ_BUDGET).unwrap().alive);

        let gone = temp("dead");
        let path = run_file(&gone, 0x7FFF_FFFE, &[]);
        assert!(!update("r".into(), path, 0, READ_BUDGET).unwrap().alive);
    }

    #[test]
    fn a_folder_without_a_run_file_drops_out() {
        let dir = temp("empty");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(update("r".into(), dir.join("run.jsonl"), 0, READ_BUDGET).is_none());
    }

    #[test]
    fn an_inbox_line_lands_as_its_own_json_line() {
        let dir = temp("inbox");
        std::fs::create_dir_all(&dir).unwrap();
        let inbox = dir.join("inbox.jsonl");
        append_line(&inbox, &serde_json::json!({ "answer": "yes" })).unwrap();
        append_line(&inbox, &serde_json::json!({ "message": "stop" })).unwrap();

        let text = std::fs::read_to_string(inbox).unwrap();
        assert_eq!(text, "{\"answer\":\"yes\"}\n{\"message\":\"stop\"}\n");
    }

    #[test]
    fn a_name_note_lands_on_the_run_file_after_what_it_held() {
        let dir = temp("rename");
        let path = run_file(&dir, std::process::id() as i32, &[]);
        append_line(&path, &serde_json::json!({ "at": stamp(), "name": "ship it" })).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let last: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
        assert_eq!(last["name"], "ship it");
        assert_eq!(text.lines().count(), 2);
    }

    #[test]
    fn a_second_paste_of_one_name_keeps_both_files() {
        let dir = temp("files");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_name(&dir, "image.png"), "image.png");

        std::fs::write(dir.join("image.png"), b"one").unwrap();
        assert_eq!(free_name(&dir, "image.png"), "image-1.png");

        std::fs::write(dir.join("image-1.png"), b"two").unwrap();
        assert_eq!(free_name(&dir, "image.png"), "image-2.png");
    }

    #[test]
    fn a_pasted_name_cannot_reach_out_of_the_run() {
        let dir = temp("escape");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_name(&dir, "../../etc/passwd"), "passwd");
    }

    fn real(path: &Path) -> String {
        text_of(path.canonicalize().unwrap())
    }

    #[test]
    fn a_folder_outside_a_repository_is_its_own_root() {
        let dir = temp("loose").join("deep");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(project_root(text_of(dir.clone())), real(&dir));
    }

    #[test]
    fn a_folder_inside_a_repository_is_the_repository() {
        let repo = temp("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let deep = repo.join("packages").join("engine");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(project_root(text_of(deep)), real(&repo));
    }

    #[test]
    fn a_worktree_is_the_repository_it_was_cut_from() {
        let repo = temp("main");
        std::fs::create_dir_all(repo.join(".git").join("worktrees").join("side")).unwrap();
        let tree = temp("side");
        std::fs::create_dir_all(&tree).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("side");
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        assert_eq!(project_root(text_of(tree)), real(&repo));
    }

    #[test]
    fn a_project_with_no_gate_file_reads_as_none() {
        let dir = temp("gates-none");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_gates(text_of(dir)).unwrap(), None);
    }

    #[test]
    fn a_written_gate_file_ends_in_one_newline() {
        let dir = temp("gates-newline");
        std::fs::create_dir_all(&dir).unwrap();
        let at = text_of(dir);
        write_gates(at.clone(), "bun run check".into()).unwrap();
        assert_eq!(read_gates(at.clone()).unwrap().unwrap(), "bun run check\n");
        write_gates(at.clone(), "bun run check\n".into()).unwrap();
        assert_eq!(read_gates(at).unwrap().unwrap(), "bun run check\n");
    }

    #[test]
    fn a_worktree_keeps_its_gates_in_the_repository_it_was_cut_from() {
        let repo = temp("gates-main");
        std::fs::create_dir_all(repo.join(".git").join("worktrees").join("side")).unwrap();
        let tree = temp("gates-side");
        std::fs::create_dir_all(&tree).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("side");
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        write_gates(text_of(tree.clone()), "bun test".into()).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.join(".penguin").join("gates")).unwrap(),
            "bun test\n"
        );
        assert_eq!(read_gates(text_of(tree)).unwrap().unwrap(), "bun test\n");
    }

    #[test]
    fn two_ids_claimed_together_get_their_own_folders() {
        let runs = temp("claim");
        let first = claim_id(&runs).unwrap();
        let second = claim_id(&runs).unwrap();
        assert_ne!(first, second);
        assert!(runs.join(&first).is_dir());
        assert!(runs.join(&second).is_dir());
    }

    #[test]
    fn a_claimed_folder_that_never_ran_is_dropped() {
        let dir = temp("claimed");
        std::fs::create_dir_all(dir.join("files")).unwrap();
        std::fs::write(dir.join("files").join("image.png"), b"one").unwrap();
        discard(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn a_folder_holding_a_run_survives_a_discard() {
        let dir = temp("started");
        run_file(&dir, std::process::id() as i32, &[]);
        discard(&dir).unwrap();
        assert!(dir.join("run.jsonl").exists());
    }

    #[test]
    fn discarding_a_folder_that_is_gone_is_no_trouble() {
        assert!(discard(&temp("never")).is_ok());
    }

    #[test]
    fn a_run_that_wrote_nothing_reports_what_its_log_holds() {
        let dir = temp("died");
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("start.log");
        std::fs::write(&log, "").unwrap();
        assert_eq!(died("/a/b/ship.ts", &log), "ship.ts died before it wrote anything");
        std::fs::write(&log, "  cannot find module\n").unwrap();
        assert_eq!(died("/a/b/ship.ts", &log), "cannot find module");
    }

    #[test]
    fn a_run_without_a_start_log_reports_nothing() {
        let dir = temp("log");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(start_log(&dir), "");

        std::fs::write(dir.join("start.log"), "bun: out of memory\n").unwrap();
        assert_eq!(start_log(&dir), "bun: out of memory\n");
    }

    #[test]
    fn only_none_is_silent_and_anything_unknown_falls_back() {
        assert_eq!(sound_name("none"), None);
        assert!(sound_name("ping").is_some());
        assert_eq!(sound_name("nonsense"), sound_name("chime"));
    }

    #[test]
    fn a_secret_name_is_plain_or_refused() {
        assert_eq!(secret_name("jira"), Some("jira"));
        assert_eq!(secret_name("jira-2"), Some("jira-2"));
        assert_eq!(secret_name(""), None);
        assert_eq!(secret_name("../jira"), None);
        assert_eq!(secret_name("Jira token"), None);
    }

    #[test]
    fn an_id_that_leaves_the_runs_directory_is_refused() {
        let runs = temp("runs");
        assert!(run_folder(runs.clone(), "..").is_none());
        assert!(run_folder(runs.clone(), "../elsewhere").is_none());
        assert!(run_folder(runs.clone(), "").is_none());
        assert_eq!(run_folder(runs.clone(), "a-run"), Some(runs.join("a-run")));
    }
}
