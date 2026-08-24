use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_runs])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
}
