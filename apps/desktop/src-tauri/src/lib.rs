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
    /// Whole lines past `offset` were left behind when the budget ran out.
    more: bool,
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

#[cfg(windows)]
fn pid_alive(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if handle.is_null() {
        return false;
    }
    let mut code = 0u32;
    let queried = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
    unsafe { CloseHandle(handle) };
    queried && code == STILL_ACTIVE as u32
}

#[cfg(not(any(unix, windows)))]
fn pid_alive(_pid: i32) -> bool {
    // A run is only paused once its process is proven gone, and this platform cannot prove it.
    true
}

/// The process behind the run's latest segment, from the pid file the engine writes beside run.jsonl.
fn run_pid(dir: &Path) -> Option<i32> {
    std::fs::read_to_string(dir.join("pid"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

#[cfg(target_os = "macos")]
fn process_argv(pid: i32) -> Option<String> {
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let width = name.len() as u32;
    let mut size: libc::size_t = 0;
    let asked = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            width,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if asked != 0 || size == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size];
    let read = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            width,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return None;
    }
    buffer.truncate(size);
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

#[cfg(target_os = "linux")]
fn process_argv(pid: i32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(String::from_utf8_lossy(&raw).into_owned())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_argv(_pid: i32) -> Option<String> {
    None
}

/// A process that has ended and is waiting to be collected by whoever started it. Its pid still
/// answers, so the run behind it would read as one still going. The kernel keeps no process
/// information for one, which is what separates it from a process that is simply not ours.
#[cfg(target_os = "macos")]
fn spent(pid: i32) -> bool {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            std::ptr::from_mut(&mut info).cast(),
            size,
        )
    };
    read != size || info.pbi_status == libc::SZOMB
}

#[cfg(target_os = "linux")]
fn spent(pid: i32) -> bool {
    let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // The command field is parenthesised and can hold spaces, so the state is what follows the last one.
    let Some(end) = text.rfind(')') else {
        return false;
    };
    text[end + 1..].trim_start().starts_with('Z')
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn spent(_pid: i32) -> bool {
    false
}

/// Whether the process at `pid` is this run's, from the job its command line carries. Pids are
/// reused, so a run folder left behind can name a process that has nothing to do with it, and
/// signalling that one would kill a stranger's work. A command line nobody can read proves
/// nothing either way, and a run is held to be alive until it is proven otherwise.
fn owns_run(pid: i32, id: &str) -> bool {
    match process_argv(pid) {
        None => true,
        Some(argv) => argv.contains(&format!("\"id\":\"{id}\"")),
    }
}

fn run_id(dir: &Path) -> Option<&str> {
    dir.file_name().and_then(|name| name.to_str())
}

/// The run's own live process, or none once it is gone.
fn live_pid(dir: &Path) -> Option<i32> {
    let pid = run_pid(dir)?;
    let id = run_id(dir)?;
    if pid_alive(pid) && !spent(pid) && owns_run(pid, id) {
        Some(pid)
    } else {
        None
    }
}

fn run_alive(dir: &Path) -> bool {
    live_pid(dir).is_some()
}

/// The same cut of a run file as the engine's `core/segments.ts`.
fn is_head(entry: &serde_json::Value) -> bool {
    entry.get("call").is_none()
        && entry.get("run").is_some()
        && entry.get("workflow").is_some()
        && entry.get("params").is_some()
}

fn is_closing(entry: &serde_json::Value) -> bool {
    entry.get("call").is_none()
        && (entry.get("outcome").is_some()
            || entry.get("threw").is_some()
            || entry.get("paused").is_some()
            || entry.get("stopped") == Some(&serde_json::Value::Bool(true)))
}

/// How the run's latest segment ended, none while its process has not ended it.
fn closing_note(path: &Path) -> Option<serde_json::Value> {
    let file = File::open(path).ok()?;
    let mut closing = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if is_head(&entry) {
            closing = None;
        } else if is_closing(&entry) {
            closing = Some(entry);
        }
    }
    closing
}

/// How the run was started, from its first line.
fn head(path: &Path) -> Option<serde_json::Value> {
    let mut line = String::new();
    BufReader::new(File::open(path).ok()?)
        .read_line(&mut line)
        .ok()?;
    serde_json::from_str(&line).ok()
}

/// Where the run works, from its first head line.
fn head_cwd(path: &Path) -> Option<PathBuf> {
    head(path)?.get("cwd")?.as_str().map(PathBuf::from)
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
    let mut more = true;
    while bytes.len() < budget {
        line.clear();
        reader.read_until(b'\n', &mut line).ok()?;
        if line.last() != Some(&b'\n') {
            more = false;
            break;
        }
        bytes.extend_from_slice(&line);
    }
    let text = String::from_utf8(bytes).ok()?;
    Some(RunUpdate {
        id,
        offset: from + text.len() as u64,
        text,
        alive: path.parent().is_some_and(run_alive),
        more,
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

/// What a run said on stderr. A run that died before its own file could say why left it only here.
#[tauri::command]
fn read_run_log(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let dir = runs_dir(&app)
        .and_then(|runs| run_folder(runs, &id))
        .ok_or_else(|| format!("no run named {id}"))?;
    Ok(start_log(&dir))
}

#[cfg(unix)]
fn signal_run(pid: i32, signal: i32) -> bool {
    // A run the app started leads its own group, so this reaches the agents it spawned with it.
    if unsafe { libc::killpg(pid, signal) } == 0 {
        return true;
    }
    // A run started by hand shares its shell's group, which must never be signalled.
    unsafe { libc::kill(pid, signal) == 0 }
}

#[cfg(not(unix))]
fn signal_run(_pid: i32, _signal: i32) -> bool {
    false
}

#[cfg(unix)]
const STOP: i32 = libc::SIGTERM;
#[cfg(unix)]
const PAUSE: i32 = libc::SIGINT;
#[cfg(unix)]
const KILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
const STOP: i32 = 15;
#[cfg(not(unix))]
const PAUSE: i32 = 2;
#[cfg(not(unix))]
const KILL: i32 = 9;

/// How long a run gets to end itself, write its own note, and take its agents with it.
const GRACE: Duration = Duration::from_secs(5);

/// How long the kernel gets to clear a run that had to be killed.
const AFTER_KILL: Duration = Duration::from_millis(500);

/// How often a run is looked at again while it is going.
const STEP: Duration = Duration::from_millis(50);

fn gone(folder: &Path, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if !run_alive(folder) {
            return true;
        }
        std::thread::sleep(STEP);
    }
    !run_alive(folder)
}

/// Ends a run's process for good: it is asked, given a grace period to leave on its own terms, then
/// killed. True once nothing of the run is left running, which is the only thing that counts as
/// stopped. A run nobody could kill is reported, never passed off as ended.
fn reaped(folder: &Path) -> bool {
    let Some(pid) = live_pid(folder) else {
        return true;
    };
    signal_run(pid, STOP);
    if gone(folder, GRACE) {
        return true;
    }
    signal_run(pid, KILL);
    gone(folder, AFTER_KILL)
}

/// Ends a run and leaves its file closed. The note goes on only once the process is gone: a note
/// must never stand on a file something is still writing, and a run that ends itself writes its own.
/// A pause is the one closing note a stop writes over: a parked run has work left, and a stop that
/// left the pause standing would leave it parked in the window with nothing able to end it.
fn close_run(folder: &Path) -> Result<(), String> {
    if !reaped(folder) {
        return Err("its process would not end".to_string());
    }
    let file = folder.join("run.jsonl");
    if !file.exists() {
        return Ok(());
    }
    if closing_note(&file).is_some_and(|note| note.get("paused").is_none()) {
        return Ok(());
    }
    let note = serde_json::json!({ "at": stamp(), "stopped": true });
    append_line(&file, &note).map_err(|cause| cause.to_string())
}

/// A run and every run it spawned, outermost first, read from the run folders rather than from
/// what a window happens to be drawing. A tree the frontend has not finished reading, or does not
/// show at all, still holds processes, and a stop that cannot see them leaves them running.
fn descendants(runs: &Path, id: &str) -> Vec<String> {
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(runs) {
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let parent = head(&entry.path().join("run.jsonl"))
                .and_then(|head| head.get("parent")?.as_str().map(str::to_string));
            let Some(parent) = parent else {
                continue;
            };
            children.entry(parent).or_default().push(name);
        }
    }
    let mut found = vec![id.to_string()];
    let mut at = 0;
    while at < found.len() {
        if let Some(next) = children.remove(&found[at]) {
            let mut ordered = next;
            ordered.sort();
            found.extend(ordered);
        }
        at += 1;
    }
    found
}

/// One signal to each run. Callers pass a run and every run inside it, outermost first.
fn signal_runs(
    app: &tauri::AppHandle,
    ids: Vec<String>,
    signal: i32,
    verb: &str,
) -> Result<(), String> {
    let runs = runs_dir(app).ok_or("no runs directory")?;
    let mut missed = Vec::new();
    for id in ids {
        let Some(folder) = run_folder(runs.clone(), &id) else {
            missed.push(id);
            continue;
        };
        // A run that already left, or never wrote a pid file, has nothing to signal.
        match live_pid(&folder) {
            None => {}
            Some(pid) if signal_run(pid, signal) => {}
            Some(_) => missed.push(id),
        }
    }
    if missed.is_empty() {
        return Ok(());
    }
    Err(format!("could not {verb} {}", missed.join(", ")))
}

/// Ends each run named and every run inside it, and does not return until their processes are gone.
/// The caller names the runs it means; what they spawned is found here, from the run folders.
/// A run is ended by what it is doing, never by what its file says it did: a file can say a run
/// closed while its process works on, and that run has to stay reachable.
#[tauri::command]
async fn stop_runs(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runs = runs_dir(&app).ok_or("no runs directory")?;
        let mut missed = Vec::new();
        for id in ids {
            for each in descendants(&runs, &id) {
                let Some(folder) = run_folder(runs.clone(), &each) else {
                    missed.push(each);
                    continue;
                };
                if !folder.exists() {
                    continue;
                }
                if close_run(&folder).is_err() {
                    missed.push(each);
                }
            }
        }
        if missed.is_empty() {
            return Ok(());
        }
        Err(format!("could not stop {}", missed.join(", ")))
    })
    .await
    .map_err(|cause| cause.to_string())?
}

/// SIGINT to each run and to every run inside it: each writes its paused note and ends, to be
/// resumed later. A run left going while the tree around it parks would work on alone.
#[tauri::command]
fn pause_runs(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    let runs = runs_dir(&app).ok_or("no runs directory")?;
    let all = ids.iter().flat_map(|id| descendants(&runs, id)).collect();
    signal_runs(&app, all, PAUSE, "pause")
}

/// How often the app looks for a run whose file ended while its process kept working.
const SWEEP: Duration = Duration::from_secs(5);

/// How long a closed run's process has to leave on its own before the app ends it. A run writes
/// its outcome a moment before it exits, and that moment is not an orphan.
const ORPHANED_AFTER: i64 = 30;

fn settled_long_ago(note: &serde_json::Value) -> bool {
    let Some(at) = note.get("at").and_then(|at| at.as_str()) else {
        return true;
    };
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(at) else {
        return true;
    };
    chrono::Utc::now().signed_duration_since(at).num_seconds() > ORPHANED_AFTER
}

/// A run whose file says it ended while its process works on is an orphan: every action in the
/// window reads that file, so nothing there can reach it, and it goes on spawning work nobody
/// asked for. Watching for that from outside is what holds when the watch inside a run cannot:
/// an older build that never had one, or a process too wedged to run it.
fn sweep_orphans(runs: &Path) {
    let Ok(entries) = std::fs::read_dir(runs) else {
        return;
    };
    for entry in entries.flatten() {
        let folder = entry.path();
        // Reading a run file costs more than asking after a pid, and most runs left here ended long ago.
        if !run_alive(&folder) {
            continue;
        }
        let file = folder.join("run.jsonl");
        let Some(note) = closing_note(&file) else {
            continue;
        };
        if !settled_long_ago(&note) {
            continue;
        }
        if reaped(&folder) {
            let _ = append_line(&file, &serde_json::json!({ "at": stamp(), "orphan": true }));
        }
    }
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

/// The quality gates a project lists, under ~/.penguin by the name of the repository a run
/// resolves from dir. Machine-local on purpose: nothing penguin keeps sits in the checkout.
fn gates_file(home: &Path, dir: String) -> PathBuf {
    let root = PathBuf::from(project_root(dir));
    let name = root
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "project".into());
    home.join("gates").join(name)
}

fn gates_home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    penguin_home(app).ok_or_else(|| "no home folder to keep the gates in".to_string())
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
fn read_gates_in(home: &Path, dir: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(gates_file(home, dir)) {
        Ok(text) => Ok(Some(text)),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(cause.to_string()),
    }
}

fn write_gates_in(home: &Path, dir: String, text: String) -> Result<(), String> {
    let file = gates_file(home, dir);
    let folder = file.parent().ok_or("the gate file has no folder")?;
    std::fs::create_dir_all(folder).map_err(|cause| cause.to_string())?;
    std::fs::write(&file, ended(&text)).map_err(|cause| cause.to_string())
}

#[tauri::command]
fn read_gates(app: tauri::AppHandle, dir: String) -> Result<Option<String>, String> {
    read_gates_in(&gates_home(&app)?, dir)
}

#[tauri::command]
fn write_gates(app: tauri::AppHandle, dir: String, text: String) -> Result<(), String> {
    write_gates_in(&gates_home(&app)?, dir, text)
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
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<&'a str>,
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
                Some(folder) => reaped(&folder) && std::fs::remove_dir_all(&folder).is_ok(),
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

/// The seconds a run gets to write its first line before the app stops waiting on it.
const START_WAIT: Duration = Duration::from_secs(10);

/// Spawns the engine's run process on a job, detached, its stderr in the folder's start log.
fn launch(engine: &Engine, folder: &Path, job: &str, dir: &Path) -> Result<Child, String> {
    let log = folder.join("start.log");
    let mut command = Command::new(&engine.bun);
    command
        .arg(engine.dir.join("src").join("child.ts"))
        .arg(job)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(File::create(&log).map_err(|cause| cause.to_string())?);
    detach(&mut command);
    command
        .spawn()
        .map_err(|cause| format!("{} could not run: {cause}", engine.bun.display()))
}

/// A run the app started stays the app's child until someone waits on it, and a child nobody waits
/// on lingers in the process table after it ends, where every check for a live run would find it.
fn reap(mut child: Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

/// Waits until the run process shows it is going, or has died, or START_WAIT is up.
fn settled(
    child: &mut Child,
    going: impl Fn() -> bool,
    name: &str,
    folder: &Path,
) -> Result<(), String> {
    let deadline = Instant::now() + START_WAIT;
    while Instant::now() < deadline {
        if going() {
            return Ok(());
        }
        if matches!(child.try_wait(), Ok(Some(_))) {
            return Err(died(name, &folder.join("start.log")));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

/// Starts a workflow as its own detached run, settling once the run file it will stream from exists.
#[tauri::command]
async fn start_run(
    app: tauri::AppHandle,
    file: String,
    params: serde_json::Value,
    dir: String,
    id: Option<String>,
    agent: Option<String>,
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
            agent: agent.as_deref(),
        })
        .map_err(|cause| cause.to_string())?;

        let mut child = launch(&engine, &folder, &job, Path::new(&dir))?;
        let run_file = folder.join("run.jsonl");
        let started = settled(&mut child, || run_file.exists(), &file, &folder);
        reap(child);
        started?;
        Ok(id)
    })
    .await
    .map_err(|cause| cause.to_string())?
}

/// Starts a parked run again in its own folder. The engine reads what to run from the run file.
/// `only_paused` is for a timer, which must not undo a stop or restart a run that went on
/// without it: the run's latest note has to be a pause.
#[tauri::command]
async fn resume_run(app: tauri::AppHandle, id: String, only_paused: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = engine(&app)?;
        let runs = runs_dir(&app).ok_or("no runs directory")?;
        let folder = run_folder(runs, &id).ok_or_else(|| format!("no run named {id}"))?;
        let file = folder.join("run.jsonl");
        if !file.exists() {
            return Err(format!("{id} has no run to resume"));
        }
        let closing = closing_note(&file);
        if closing.is_none() && run_alive(&folder) {
            return Err(format!("{id} is still running"));
        }
        if only_paused && !closing.is_some_and(|note| note.get("paused").is_some()) {
            return Err(format!("{id} is not paused"));
        }
        let before = run_pid(&folder);
        let dir = head_cwd(&file)
            .filter(|dir| dir.is_dir())
            .unwrap_or_else(|| folder.clone());
        let job = serde_json::json!({ "id": id, "resume": true }).to_string();
        let mut child = launch(&engine, &folder, &job, &dir)?;
        let started = settled(&mut child, || run_pid(&folder) != before, &id, &folder);
        reap(child);
        started
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

            let sweeping = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(SWEEP);
                if let Some(runs) = runs_dir(&sweeping) {
                    sweep_orphans(&runs);
                }
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
            pause_runs,
            resume_run,
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
        std::fs::write(dir.join("pid"), pid.to_string()).unwrap();
        let path = dir.join("run.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            "{{\"run\":\"r\",\"workflow\":\"w.ts\",\"params\":{{}}}}"
        )
        .unwrap();
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

    fn named(dir: &Path) -> String {
        run_id(dir).unwrap().to_string()
    }

    /// A process that carries the run's job on its command line, the way a run's own process does.
    fn working(id: &str, deaf: bool) -> Child {
        let held = if deaf { "trap '' TERM; " } else { "" };
        Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("{held}sleep 30"))
            .arg(format!("{{\"id\":\"{id}\"}}"))
            .spawn()
            .unwrap()
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
        assert!(first.more);

        let second = update("r".into(), path.clone(), first.offset, 9).unwrap();
        assert_eq!(second.text, "{\"a\":1}\n{\"a\":2}\n");
        assert!(second.more);

        let rest = update("r".into(), path.clone(), second.offset, READ_BUDGET).unwrap();
        assert_eq!(rest.text, "{\"a\":3}\n");
        assert!(!rest.more);

        let spent = update("r".into(), path, 0, 0).unwrap();
        assert_eq!(spent.text, "");
        assert!(spent.more);
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
        let mut child = working(&named(&dir), false);
        let mine = run_file(&dir, child.id() as i32, &[]);
        assert!(update("r".into(), mine, 0, READ_BUDGET).unwrap().alive);
        let _ = child.kill();
        let _ = child.wait();

        let gone = temp("dead");
        let path = run_file(&gone, 0x7FFF_FFFE, &[]);
        assert!(!update("r".into(), path, 0, READ_BUDGET).unwrap().alive);

        let unwritten = temp("unwritten");
        std::fs::create_dir_all(&unwritten).unwrap();
        std::fs::write(unwritten.join("run.jsonl"), "{\"run\":\"r\"}\n").unwrap();
        assert!(
            !update("r".into(), unwritten.join("run.jsonl"), 0, READ_BUDGET)
                .unwrap()
                .alive
        );
    }

    #[test]
    fn a_folder_without_a_run_file_drops_out() {
        let dir = temp("empty");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(update("r".into(), dir.join("run.jsonl"), 0, READ_BUDGET).is_none());
    }

    #[test]
    fn a_pid_that_came_back_to_another_process_is_not_the_run() {
        let dir = temp("reused");
        let mut stranger = working("someone-elses-run", false);
        run_file(&dir, stranger.id() as i32, &[]);

        assert!(!run_alive(&dir));

        let _ = stranger.kill();
        let _ = stranger.wait();
    }

    #[test]
    fn a_stop_ends_a_run_that_will_not_take_the_hint_and_closes_its_file() {
        let dir = temp("wedged");
        let mut child = working(&named(&dir), true);
        let path = run_file(&dir, child.id() as i32, &[]);
        assert!(run_alive(&dir));

        close_run(&dir).unwrap();

        assert!(!run_alive(&dir));
        assert_eq!(
            closing_note(&path).unwrap().get("stopped"),
            Some(&serde_json::Value::Bool(true))
        );
        let _ = child.wait();
    }

    #[test]
    fn a_stop_closes_a_parked_run_without_touching_a_file_that_already_closed() {
        let parked = temp("parked");
        let path = run_file(&parked, 0x7FFF_FFFE, &[]);
        close_run(&parked).unwrap();
        assert_eq!(
            closing_note(&path).unwrap().get("stopped"),
            Some(&serde_json::Value::Bool(true))
        );

        let done = temp("done");
        let ended = run_file(&done, 0x7FFF_FFFE, &["{\"at\":\"t2\",\"outcome\":null}"]);
        close_run(&done).unwrap();
        assert_eq!(std::fs::read_to_string(ended).unwrap().lines().count(), 2);
    }

    #[test]
    fn a_stop_ends_a_run_that_a_pause_left_parked() {
        let paused = temp("paused");
        let path = run_file(
            &paused,
            0x7FFF_FFFE,
            &["{\"at\":\"t2\",\"paused\":{\"by\":\"user\"}}"],
        );

        close_run(&paused).unwrap();

        assert_eq!(
            closing_note(&path).unwrap().get("stopped"),
            Some(&serde_json::Value::Bool(true))
        );
    }

    #[test]
    fn a_stop_reaches_every_run_the_named_one_spawned() {
        let runs = temp("tree");
        for (id, parent) in [
            ("root", None),
            ("root-c1", Some("root")),
            ("root-c1-c1", Some("root-c1")),
            ("root-c2", Some("root")),
            ("elsewhere", None),
        ] {
            let dir = runs.join(id);
            std::fs::create_dir_all(&dir).unwrap();
            let head = match parent {
                Some(parent) => format!(
                    "{{\"run\":\"{id}\",\"workflow\":\"w.ts\",\"params\":{{}},\"parent\":\"{parent}\"}}"
                ),
                None => format!("{{\"run\":\"{id}\",\"workflow\":\"w.ts\",\"params\":{{}}}}"),
            };
            std::fs::write(dir.join("run.jsonl"), format!("{head}\n")).unwrap();
        }

        assert_eq!(
            descendants(&runs, "root"),
            vec!["root", "root-c1", "root-c2", "root-c1-c1"]
        );
    }

    #[test]
    fn a_run_whose_file_closed_while_its_process_worked_on_is_ended_and_said_so() {
        let runs = temp("orphans");
        let dir = runs.join("orphan");
        let mut child = working("orphan", false);
        let path = run_file(&dir, child.id() as i32, &["{\"at\":\"2020-01-01T00:00:00.000Z\",\"stopped\":true}"]);

        sweep_orphans(&runs);

        assert!(!run_alive(&dir));
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.lines().last().unwrap().contains("\"orphan\":true"));
        let _ = child.wait();
    }

    #[test]
    fn a_run_that_just_wrote_its_outcome_is_left_to_leave_on_its_own() {
        let runs = temp("settling");
        let dir = runs.join("settling");
        let mut child = working("settling", false);
        let note = serde_json::json!({ "at": stamp(), "outcome": null }).to_string();
        run_file(&dir, child.id() as i32, &[note.as_str()]);

        sweep_orphans(&runs);

        assert!(run_alive(&dir));
        let _ = child.kill();
        let _ = child.wait();
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
        let home = temp("gates-none-home");
        let dir = temp("gates-none");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_gates_in(&home, text_of(dir)).unwrap(), None);
    }

    #[test]
    fn a_written_gate_file_ends_in_one_newline() {
        let home = temp("gates-newline-home");
        let dir = temp("gates-newline");
        std::fs::create_dir_all(&dir).unwrap();
        let at = text_of(dir);
        write_gates_in(&home, at.clone(), "bun run check".into()).unwrap();
        assert_eq!(read_gates_in(&home, at.clone()).unwrap().unwrap(), "bun run check\n");
        write_gates_in(&home, at.clone(), "bun run check\n".into()).unwrap();
        assert_eq!(read_gates_in(&home, at).unwrap().unwrap(), "bun run check\n");
    }

    #[test]
    fn gates_live_under_home_by_the_repository_name_and_never_in_the_checkout() {
        let home = temp("gates-home");
        let repo = temp("gates-main");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        write_gates_in(&home, text_of(repo.clone()), "bun test".into()).unwrap();
        let name = repo.file_name().unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("gates").join(name)).unwrap(),
            "bun test\n"
        );
        assert!(!repo.join(".penguin").exists());
    }

    #[test]
    fn a_worktree_shares_the_gates_of_the_repository_it_was_cut_from() {
        let home = temp("gates-side-home");
        let repo = temp("gates-shared-main");
        std::fs::create_dir_all(repo.join(".git").join("worktrees").join("side")).unwrap();
        let tree = temp("gates-side");
        std::fs::create_dir_all(&tree).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("side");
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        write_gates_in(&home, text_of(tree.clone()), "bun test".into()).unwrap();
        let name = repo.file_name().unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("gates").join(name)).unwrap(),
            "bun test\n"
        );
        assert_eq!(read_gates_in(&home, text_of(tree)).unwrap().unwrap(), "bun test\n");
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

