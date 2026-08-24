use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::path::BaseDirectory;
use tauri::Manager;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RunUpdate {
    id: String,
    text: String,
    offset: u64,
    alive: bool,
}

fn runs_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    match std::env::var("XDG_STATE_HOME") {
        Ok(base) if !base.is_empty() => Some(PathBuf::from(base).join("penguin").join("runs")),
        _ => app
            .path()
            .home_dir()
            .ok()
            .map(|home| home.join(".local").join("state").join("penguin").join("runs")),
    }
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

fn update(id: String, path: PathBuf, from: u64) -> Option<RunUpdate> {
    let mut file = File::open(&path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = if from > len { 0 } else { from };
    let mut text = String::new();
    file.seek(SeekFrom::Start(from)).ok()?;
    file.read_to_string(&mut text).ok()?;
    Some(RunUpdate {
        id,
        text,
        offset: len,
        alive: head_pid(&path).is_some_and(pid_alive),
    })
}

/// Every run's new run.jsonl bytes since the caller's offset. A run whose folder is gone drops out.
#[tauri::command]
fn read_runs(app: tauri::AppHandle, offsets: HashMap<String, u64>) -> Vec<RunUpdate> {
    let Some(dir) = runs_dir(&app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok()?;
            let path = entry.path().join("run.jsonl");
            let from = offsets.get(&id).copied().unwrap_or(0);
            update(id, path, from)
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

fn append_line(dir: &PathBuf, entry: &serde_json::Value) -> std::io::Result<()> {
    let mut file = File::options()
        .create(true)
        .append(true)
        .open(dir.join("inbox.jsonl"))?;
    writeln!(file, "{entry}")
}

/// One line onto a run's inbox. The engine reads `{"answer": ...}` and `{"message": "..."}` from it.
#[tauri::command]
fn append_inbox(app: tauri::AppHandle, id: String, entry: serde_json::Value) -> Result<(), String> {
    let dir = runs_dir(&app)
        .and_then(|runs| run_folder(runs, &id))
        .ok_or_else(|| format!("no inbox for {id}"))?;
    append_line(&dir, &entry).map_err(|cause| cause.to_string())
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

fn text_of(path: PathBuf) -> String {
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
    let stamp = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
        .replace(':', "-");
    let pid = std::process::id();
    let mut id = format!("{stamp}-{pid}");
    let mut extra = 2;
    while runs.join(&id).exists() {
        id = format!("{stamp}-{pid}-{extra}");
        extra += 1;
    }
    std::fs::create_dir(runs.join(&id)).map_err(|cause| cause.to_string())?;
    Ok(id)
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
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = engine(&app)?;
        let runs = runs_dir(&app).ok_or("no runs directory")?;
        let id = claim_id(&runs)?;
        let folder = runs.join(&id);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_runs,
            append_inbox,
            read_dirs,
            write_dirs,
            project_root,
            describe,
            start_run
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
    fn reads_the_whole_file_from_zero() {
        let dir = temp("whole");
        let path = run_file(&dir, std::process::id() as i32, &["{\"a\":1}"]);
        let update = update("r".into(), path, 0).unwrap();
        assert_eq!(update.text.lines().count(), 2);
        assert_eq!(update.offset, update.text.len() as u64);
    }

    #[test]
    fn reads_only_what_grew() {
        let dir = temp("grew");
        let path = run_file(&dir, std::process::id() as i32, &[]);
        let first = update("r".into(), path.clone(), 0).unwrap();

        writeln!(
            File::options().append(true).open(&path).unwrap(),
            "{{\"outcome\":null}}"
        )
        .unwrap();

        let second = update("r".into(), path, first.offset).unwrap();
        assert_eq!(second.text, "{\"outcome\":null}\n");
    }

    #[test]
    fn rereads_a_file_that_shrank() {
        let dir = temp("shrank");
        let path = run_file(&dir, std::process::id() as i32, &["{\"a\":1}", "{\"a\":2}"]);
        let update = update("r".into(), path, 9_000).unwrap();
        assert_eq!(update.text.lines().count(), 3);
    }

    #[test]
    fn a_live_pid_is_alive_and_a_missing_one_is_not() {
        let dir = temp("alive");
        let mine = run_file(&dir, std::process::id() as i32, &[]);
        assert!(update("r".into(), mine, 0).unwrap().alive);

        let gone = temp("dead");
        let path = run_file(&gone, 0x7FFF_FFFE, &[]);
        assert!(!update("r".into(), path, 0).unwrap().alive);
    }

    #[test]
    fn a_folder_without_a_run_file_drops_out() {
        let dir = temp("empty");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(update("r".into(), dir.join("run.jsonl"), 0).is_none());
    }

    #[test]
    fn an_inbox_line_lands_as_its_own_json_line() {
        let dir = temp("inbox");
        std::fs::create_dir_all(&dir).unwrap();
        append_line(&dir, &serde_json::json!({ "answer": "yes" })).unwrap();
        append_line(&dir, &serde_json::json!({ "message": "stop" })).unwrap();

        let text = std::fs::read_to_string(dir.join("inbox.jsonl")).unwrap();
        assert_eq!(text, "{\"answer\":\"yes\"}\n{\"message\":\"stop\"}\n");
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
    fn two_ids_claimed_together_get_their_own_folders() {
        let runs = temp("claim");
        let first = claim_id(&runs).unwrap();
        let second = claim_id(&runs).unwrap();
        assert_ne!(first, second);
        assert!(runs.join(&first).is_dir());
        assert!(runs.join(&second).is_dir());
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
    fn an_id_that_leaves_the_runs_directory_is_refused() {
        let runs = temp("runs");
        assert!(run_folder(runs.clone(), "..").is_none());
        assert!(run_folder(runs.clone(), "../elsewhere").is_none());
        assert!(run_folder(runs.clone(), "").is_none());
        assert_eq!(run_folder(runs.clone(), "a-run"), Some(runs.join("a-run")));
    }
}
