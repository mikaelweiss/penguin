use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher as _};
use tauri::{Emitter, Manager};

use crate::review::{git_line, is_git};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    kind: String,
    ignored: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    kind: String,
    text: String,
    bytes: u64,
}

/// The deepest ancestor that exists, resolved, with the missing tail put back. A path that
/// does not exist yet still has to prove it stays inside the root.
fn settle(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(up), Some(name)) => settle(up).join(name),
        _ => path.to_path_buf(),
    }
}

/// The absolute path of a root relative entry, refused when it leaves the root.
fn inside(root: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let base = PathBuf::from(root);
    let base = base
        .canonicalize()
        .map_err(|cause| format!("{root} cannot be read: {cause}"))?;
    let target = settle(&base.join(relative));
    if !target.starts_with(&base) {
        return Err(format!("{relative} is outside the project"));
    }
    Ok((base, target))
}

fn slashed(path: &Path) -> String {
    path.components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Which of these root relative paths git considers ignored. A repository is not required.
/// Outside one nothing is ignored.
fn check_ignore(root: &Path, paths: &[String]) -> HashSet<String> {
    let none = HashSet::new();
    if paths.is_empty() || !is_git(&crate::text_of(root.to_path_buf())) {
        return none;
    }
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "--stdin", "-z", "--no-index"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return none;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let fed = paths.join("\0");
        let _ = stdin.write_all(fed.as_bytes());
        let _ = stdin.write_all(b"\0");
    }
    let Ok(done) = child.wait_with_output() else {
        return none;
    };
    // Exit 0 means the printed paths are ignored, 1 means none are. Anything else is
    // treated as none rather than failing the listing.
    if done.status.code() != Some(0) {
        return none;
    }
    String::from_utf8_lossy(&done.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| path.to_string())
        .collect()
}

/// One directory's entries. dir is root relative. "" is the root itself.
#[tauri::command]
pub async fn list_files(root: String, dir: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || listing(&root, &dir))
        .await
        .map_err(|cause| cause.to_string())?
}

fn listing(root: &str, dir: &str) -> Result<Vec<FileEntry>, String> {
    let (base, target) = inside(root, dir)?;
    let read = std::fs::read_dir(&target).map_err(|cause| cause.to_string())?;
    let mut entries = Vec::new();
    for found in read.flatten() {
        let name = found.file_name().to_string_lossy().into_owned();
        // opencode reads entries without following them and keeps only plain files and
        // directories, so a symlink is never listed and never has to be expanded.
        let Ok(kind) = found.file_type() else {
            continue;
        };
        if !kind.is_dir() && !kind.is_file() {
            continue;
        }
        let folder = kind.is_dir();
        let Ok(relative) = found.path().strip_prefix(&base).map(slashed) else {
            continue;
        };
        entries.push(FileEntry {
            name,
            path: if folder { format!("{relative}/") } else { relative },
            kind: if folder { "directory".into() } else { "file".into() },
            ignored: false,
        });
    }
    let asked: Vec<String> = entries.iter().map(|entry| entry.path.clone()).collect();
    let ignored = check_ignore(&base, &asked);
    for entry in &mut entries {
        entry.ignored = entry.name == ".git" || ignored.contains(&entry.path);
    }
    entries.sort_by(|a, b| {
        let folder = (b.kind == "directory").cmp(&(a.kind == "directory"));
        folder
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// One file's text. path is root relative.
#[tauri::command]
pub async fn read_file(root: String, path: String) -> Result<FileContent, String> {
    tauri::async_runtime::spawn_blocking(move || contents(&root, &path))
        .await
        .map_err(|cause| cause.to_string())?
}

fn contents(root: &str, path: &str) -> Result<FileContent, String> {
    let (_, target) = inside(root, path)?;
    let missing = FileContent { kind: "missing".into(), text: String::new(), bytes: 0 };
    let Ok(about) = std::fs::metadata(&target) else {
        return Ok(missing);
    };
    if !about.is_file() {
        return Ok(missing);
    }
    let bytes = about.len();
    if bytes > MAX_FILE_BYTES {
        return Ok(FileContent { kind: "large".into(), text: String::new(), bytes });
    }
    let raw = std::fs::read(&target).map_err(|cause| cause.to_string())?;
    let binary = FileContent { kind: "binary".into(), text: String::new(), bytes };
    if raw.contains(&0) {
        return Ok(binary);
    }
    // Verbatim: trimming would shift every line number in the viewer.
    match String::from_utf8(raw) {
        Ok(text) => Ok(FileContent { kind: "text".into(), text, bytes }),
        Err(_) => Ok(binary),
    }
}

const NAME_BONUS: i64 = 1000;
const START_BONUS: i64 = 200;
const RUN_BONUS: i64 = 20;

/// A case insensitive subsequence match, scored so a basename hit on a short path wins.
fn score(path: &str, query: &str) -> Option<i64> {
    let hay: Vec<char> = path.to_lowercase().chars().collect();
    let need: Vec<char> = query.to_lowercase().chars().collect();
    if need.is_empty() {
        return None;
    }
    let mut hit = Vec::with_capacity(need.len());
    let mut at = 0;
    for want in &need {
        let found = at + hay[at..].iter().position(|char| char == want)?;
        hit.push(found);
        at = found + 1;
    }
    let name = hay.iter().rposition(|char| *char == '/').map_or(0, |at| at + 1);
    let runs = hit.windows(2).filter(|pair| pair[1] == pair[0] + 1).count() as i64;
    let spread = (hit[hit.len() - 1] - hit[0]) as i64;
    let mut score = runs * RUN_BONUS - hay.len() as i64 - spread;
    if hit[0] >= name {
        score += NAME_BONUS;
    }
    if hit[0] == name {
        score += START_BONUS;
    }
    Some(score)
}

/// The files under root whose path matches query, best first. Root relative, forward slashes.
#[tauri::command]
pub async fn search_files(root: String, query: String, limit: u32) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || matches(&root, &query, limit as usize))
        .await
        .map_err(|cause| cause.to_string())?
}

fn matches(root: &str, query: &str, limit: usize) -> Result<Vec<String>, String> {
    if query.trim().is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let base = PathBuf::from(root)
        .canonicalize()
        .map_err(|cause| format!("{root} cannot be read: {cause}"))?;
    let mut found: Vec<(i64, String)> = Vec::new();
    let walk = ignore::WalkBuilder::new(&base)
        .hidden(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build();
    for entry in walk.flatten() {
        if entry.file_type().is_none_or(|kind| !kind.is_file()) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(&base).map(slashed) else {
            continue;
        };
        if let Some(score) = score(&relative, query) {
            found.push((score, relative));
        }
    }
    found.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.len().cmp(&b.1.len()))
            .then_with(|| a.1.cmp(&b.1))
    });
    Ok(found.into_iter().take(limit).map(|(_, path)| path).collect())
}

const FILES_CHANGED: &str = "files-changed";
/// How long the tree must be quiet before one event goes out.
const SETTLE: Duration = Duration::from_millis(150);
/// The longest a burst can hold the event back.
const BURST: Duration = Duration::from_millis(750);
/// Past this many paths the panel re-reads everything instead.
const MAX_PATHS: usize = 512;

/// Folders opencode's watcher skips, matched per path segment. Its "desktop" entry is
/// omitted: penguin's app lives in apps/desktop.
const NOISE_FOLDERS: &[&str] = &[
    "node_modules",
    "bower_components",
    ".pnpm-store",
    "vendor",
    ".npm",
    "dist",
    "build",
    "out",
    ".next",
    "target",
    "bin",
    "obj",
    ".svn",
    ".hg",
    ".vscode",
    ".idea",
    ".turbo",
    ".output",
    ".sst",
    ".cache",
    ".webkit-cache",
    "__pycache__",
    ".pytest_cache",
    "mypy_cache",
    ".history",
    ".gradle",
    "logs",
    "tmp",
    "temp",
    "coverage",
    ".nyc_output",
];

const NOISE_NAMES: &[&str] = &[".DS_Store", "Thumbs.db"];
const NOISE_SUFFIXES: &[&str] = &[".swp", ".swo", ".pyc", ".log"];

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesChanged {
    root: String,
    paths: Vec<String>,
    overflow: bool,
    git: bool,
}

pub struct Watch {
    root: String,
    #[allow(dead_code)]
    watcher: notify::RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

/// At most one watch exists at a time, and only the command touches it, so the debounce
/// thread never has to agree with anyone about which root it belongs to.
pub struct WatchState(pub Mutex<Option<Watch>>);

/// Watches one root recursively. A second call replaces the first watch, and None stops
/// watching altogether.
#[tauri::command]
pub async fn watch_files(app: tauri::AppHandle, root: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || swap(&app, root))
        .await
        .map_err(|cause| cause.to_string())?
}

fn swap(app: &tauri::AppHandle, root: Option<String>) -> Result<(), String> {
    let state = app.state::<WatchState>();
    let mut held = state.0.lock().map_err(|cause| cause.to_string())?;
    let wanted = root.filter(|root| !root.is_empty());
    if let Some(current) = held.as_ref() {
        if wanted.as_deref() == Some(current.root.as_str()) {
            return Ok(());
        }
    }
    if let Some(old) = held.take() {
        old.stop.store(true, Ordering::Relaxed);
    }
    let Some(root) = wanted else {
        return Ok(());
    };
    *held = Some(start(app.clone(), root)?);
    Ok(())
}

fn start(app: tauri::AppHandle, root: String) -> Result<Watch, String> {
    let (send, receive): (Sender<PathBuf>, Receiver<PathBuf>) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            for path in event.paths {
                let _ = send.send(path);
            }
        }
    })
    .map_err(|cause| cause.to_string())?;
    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|cause| cause.to_string())?;
    let filter = Filter::of(&root);
    // A git directory that cannot be watched costs the panel its commit signal, not its
    // file signal, so the root watch stands on its own.
    for dir in &filter.watch {
        let _ = watcher.watch(dir, RecursiveMode::Recursive);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let held = stop.clone();
    let named = root.clone();
    std::thread::spawn(move || {
        pump(&receive, &filter, &held, &mut |batch| {
            emit(&app, &named, batch)
        })
    });
    Ok(Watch { root, watcher, stop })
}

/// A path and its resolved form, when they differ. notify reports one or the other.
fn both(path: PathBuf) -> Vec<PathBuf> {
    match path.canonicalize() {
        Ok(real) if real != path => vec![real, path],
        _ => vec![path],
    }
}

/// Where this root keeps HEAD, the index, and refs. A linked worktree keeps its own gitdir
/// and the shared refs under the main checkout, outside the tree being watched.
fn git_dirs(root: &str) -> Vec<PathBuf> {
    let own = git_line(root, &["rev-parse", "--absolute-git-dir"]);
    let common = git_line(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    let mut dirs: Vec<PathBuf> = Vec::new();
    for found in [own, common].into_iter().flatten() {
        let dir = PathBuf::from(found);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// Which watched tree a raw event path belongs to, and how to read it.
struct Filter {
    /// The working root, resolved and raw.
    roots: Vec<PathBuf>,
    /// Git directories outside the root, the most specific first, resolved and raw.
    git: Vec<PathBuf>,
    /// The ones notify is handed, without those already covered by another.
    watch: Vec<PathBuf>,
}

impl Filter {
    fn of(root: &str) -> Filter {
        let roots = both(PathBuf::from(root));
        let outside: Vec<PathBuf> = git_dirs(root)
            .into_iter()
            .filter(|dir| under(&roots, dir).is_none())
            .collect();
        let watch = outside
            .iter()
            .filter(|dir| {
                !outside
                    .iter()
                    .any(|other| other != *dir && dir.starts_with(other))
            })
            .cloned()
            .collect();
        let git = outside.into_iter().flat_map(both).collect();
        Filter { roots, git, watch }
    }
}

fn under(roots: &[PathBuf], path: &Path) -> Option<String> {
    roots
        .iter()
        .find_map(|root| path.strip_prefix(root).ok())
        .map(slashed)
}

enum Sifted {
    Skip,
    Git,
    Path(String),
}

/// What one raw path contributes to the batch. Git's own churn is loud, so only the parts
/// that mean the base or the change list moved are kept, and then as a flag, not a path.
fn sift(filter: &Filter, path: &Path) -> Sifted {
    if let Some(relative) = under(&filter.roots, path) {
        if relative.is_empty() {
            return Sifted::Skip;
        }
        let tail = relative.strip_prefix(".git/");
        if relative == ".git" || tail.is_some() {
            return git_signal(tail.unwrap_or(""));
        }
        if noisy(&relative) {
            return Sifted::Skip;
        }
        return Sifted::Path(relative);
    }
    match under(&filter.git, path) {
        Some(relative) => git_signal(&relative),
        None => Sifted::Skip,
    }
}

/// A path inside a git directory counts only when the base or the change list moved.
/// Objects, reflogs, and every .lock file are churn from those same commands.
fn git_signal(relative: &str) -> Sifted {
    let name = relative.rsplit('/').next().unwrap_or("");
    if name.ends_with(".lock") {
        return Sifted::Skip;
    }
    let top = !relative.contains('/');
    let moved = relative == "index"
        || relative == "packed-refs"
        || relative.starts_with("refs/")
        || (top && name.ends_with("HEAD"));
    if moved { Sifted::Git } else { Sifted::Skip }
}

fn noisy(relative: &str) -> bool {
    if relative.split('/').any(|part| NOISE_FOLDERS.contains(&part)) {
        return true;
    }
    let name = relative.rsplit('/').next().unwrap_or("");
    NOISE_NAMES.contains(&name) || NOISE_SUFFIXES.iter().any(|end| name.ends_with(end))
}

struct Batch {
    paths: Vec<String>,
    overflow: bool,
    git: bool,
}

fn pump(
    receive: &Receiver<PathBuf>,
    filter: &Filter,
    stop: &AtomicBool,
    out: &mut impl FnMut(Batch),
) {
    let mut batch: HashSet<String> = HashSet::new();
    let mut git = false;
    let mut opened: Option<Instant> = None;
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let quiet = match receive.recv_timeout(SETTLE) {
            Ok(path) => {
                match sift(filter, &path) {
                    Sifted::Skip => {}
                    Sifted::Git => git = true,
                    Sifted::Path(relative) => {
                        batch.insert(relative);
                    }
                }
                if opened.is_none() && (git || !batch.is_empty()) {
                    opened = Some(Instant::now());
                }
                opened.is_some_and(|since| since.elapsed() >= BURST)
            }
            Err(RecvTimeoutError::Timeout) => true,
            Err(RecvTimeoutError::Disconnected) => {
                if !stop.load(Ordering::Relaxed) {
                    flush(&mut batch, &mut git, out);
                }
                return;
            }
        };
        if quiet {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            flush(&mut batch, &mut git, out);
            opened = None;
        }
    }
}

fn flush(batch: &mut HashSet<String>, git: &mut bool, out: &mut impl FnMut(Batch)) {
    if batch.is_empty() && !*git {
        return;
    }
    let overflow = batch.len() > MAX_PATHS;
    let mut paths: Vec<String> = if overflow { Vec::new() } else { batch.iter().cloned().collect() };
    paths.sort();
    batch.clear();
    out(Batch { paths, overflow, git: *git });
    *git = false;
}

fn emit(app: &tauri::AppHandle, root: &str, batch: Batch) {
    let _ = app.emit(
        FILES_CHANGED,
        FilesChanged {
            root: root.to_string(),
            paths: batch.paths,
            overflow: batch.overflow,
            git: batch.git,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::git;
    use crate::text_of;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("penguin-files-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn repo(name: &str) -> PathBuf {
        let dir = temp(name);
        git(&text_of(dir.clone()), &["init", "-q", "-b", "main"]).unwrap();
        dir
    }

    fn list(dir: &Path, at: &str) -> Vec<FileEntry> {
        tauri::async_runtime::block_on(list_files(text_of(dir.to_path_buf()), at.into())).unwrap()
    }

    fn read(dir: &Path, at: &str) -> FileContent {
        tauri::async_runtime::block_on(read_file(text_of(dir.to_path_buf()), at.into())).unwrap()
    }

    #[test]
    fn a_listing_is_directories_first_then_names() {
        let dir = temp("order");
        for name in ["zebra.txt", "Beta.txt", "alpha.txt"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        for name in ["zoo", "aviary"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        let names: Vec<String> = list(&dir, "").into_iter().map(|entry| entry.name).collect();
        assert_eq!(names, ["aviary", "zoo", "alpha.txt", "Beta.txt", "zebra.txt"]);
    }

    #[test]
    fn a_directory_entry_ends_in_a_slash_and_a_file_does_not() {
        let dir = temp("slash");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("one.txt"), "x").unwrap();
        let entries = list(&dir, "");
        let folder = entries.iter().find(|entry| entry.name == "src").unwrap();
        let file = entries.iter().find(|entry| entry.name == "one.txt").unwrap();
        assert_eq!(folder.path, "src/");
        assert_eq!(folder.kind, "directory");
        assert_eq!(file.path, "one.txt");
        assert_eq!(file.kind, "file");
    }

    #[test]
    fn a_nested_listing_answers_with_root_relative_paths() {
        let dir = temp("nested");
        std::fs::create_dir_all(dir.join("src").join("deep")).unwrap();
        std::fs::write(dir.join("src").join("one.txt"), "x").unwrap();
        let entries = list(&dir, "src");
        let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, ["src/deep/", "src/one.txt"]);
    }

    #[test]
    fn an_ignored_file_and_the_git_directory_are_marked_ignored() {
        let dir = repo("ignored");
        std::fs::write(dir.join(".gitignore"), "hidden.txt\nbuild/\n").unwrap();
        std::fs::write(dir.join("hidden.txt"), "x").unwrap();
        std::fs::write(dir.join("shown.txt"), "x").unwrap();
        std::fs::create_dir_all(dir.join("build")).unwrap();
        let entries = list(&dir, "");
        let ignored = |name: &str| {
            entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap_or_else(|| panic!("{name} is missing"))
                .ignored
        };
        assert!(ignored(".git"));
        assert!(ignored("hidden.txt"));
        assert!(ignored("build"));
        assert!(!ignored("shown.txt"));
        assert!(!ignored(".gitignore"));
    }

    #[test]
    fn a_path_that_leaves_the_root_is_refused() {
        let dir = temp("escape");
        let outside = temp("escape-target");
        std::fs::write(outside.join("secret.txt"), "no\n").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("out")).unwrap();

        let root = text_of(dir.clone());
        assert!(listing(&root, "..").is_err());
        assert!(contents(&root, "../escape-target/secret.txt").is_err());
        assert!(contents(&root, &text_of(outside.join("secret.txt"))).is_err());
        assert!(listing(&root, "out").is_err());
        assert!(contents(&root, "out/secret.txt").is_err());
    }

    #[test]
    fn a_symlink_is_left_out_of_the_listing() {
        let dir = temp("symlink");
        let outside = temp("symlink-target");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("one.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("out")).unwrap();
        std::os::unix::fs::symlink(dir.join("one.txt"), dir.join("two.txt")).unwrap();
        let names: Vec<String> = list(&dir, "").into_iter().map(|entry| entry.name).collect();
        assert_eq!(names, ["src", "one.txt"]);
    }

    #[test]
    fn a_text_file_reads_verbatim_including_its_leading_blank_line() {
        let dir = temp("verbatim");
        std::fs::write(dir.join("one.txt"), "\n one \n\n").unwrap();
        let found = read(&dir, "one.txt");
        assert_eq!(found.kind, "text");
        assert_eq!(found.text, "\n one \n\n");
        assert_eq!(found.bytes, 8);
    }

    #[test]
    fn a_file_with_a_nul_byte_reads_as_binary() {
        let dir = temp("nul");
        std::fs::write(dir.join("shape.bin"), [b'a', 0, b'b']).unwrap();
        let found = read(&dir, "shape.bin");
        assert_eq!(found.kind, "binary");
        assert_eq!(found.text, "");
        assert_eq!(found.bytes, 3);
    }

    #[test]
    fn a_file_that_is_not_utf_eight_reads_as_binary() {
        let dir = temp("latin");
        std::fs::write(dir.join("one.txt"), [0xff, 0xfe, b'a']).unwrap();
        assert_eq!(read(&dir, "one.txt").kind, "binary");
    }

    #[test]
    fn a_file_over_the_cap_reads_as_large() {
        let dir = temp("large");
        std::fs::write(dir.join("big.txt"), vec![b'a'; MAX_FILE_BYTES as usize + 1]).unwrap();
        let found = read(&dir, "big.txt");
        assert_eq!(found.kind, "large");
        assert_eq!(found.text, "");
        assert_eq!(found.bytes, MAX_FILE_BYTES + 1);
    }

    #[test]
    fn a_missing_file_reads_as_missing_rather_than_failing() {
        let dir = temp("gone");
        let found = read(&dir, "never.txt");
        assert_eq!(found.kind, "missing");
        assert_eq!(found.bytes, 0);
    }

    fn search(dir: &Path, query: &str, limit: u32) -> Vec<String> {
        tauri::async_runtime::block_on(search_files(
            text_of(dir.to_path_buf()),
            query.into(),
            limit,
        ))
        .unwrap()
    }

    #[test]
    fn search_puts_the_shortest_basename_match_first() {
        let dir = temp("search");
        std::fs::create_dir_all(dir.join("src").join("deep").join("nested")).unwrap();
        std::fs::create_dir_all(dir.join("apple")).unwrap();
        std::fs::write(dir.join("src").join("app.ts"), "x").unwrap();
        std::fs::write(dir.join("src").join("deep").join("nested").join("app.ts"), "x").unwrap();
        std::fs::write(dir.join("apple").join("thing.ts"), "x").unwrap();

        let found = search(&dir, "app", 10);
        assert_eq!(
            found,
            [
                "src/app.ts",
                "src/deep/nested/app.ts",
                "apple/thing.ts"
            ]
        );
        assert_eq!(search(&dir, "app", 1), ["src/app.ts"]);
    }

    #[test]
    fn search_matches_letters_out_of_order_but_never_out_of_sequence() {
        let dir = temp("subsequence");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("file-browser.tsx"), "x").unwrap();
        assert_eq!(search(&dir, "fbrow", 10), ["src/file-browser.tsx"]);
        assert!(search(&dir, "browsf", 10).is_empty());
        assert!(search(&dir, "", 10).is_empty());
    }

    #[test]
    fn search_skips_ignored_files_and_the_git_directory() {
        let dir = repo("search-ignored");
        std::fs::write(dir.join(".gitignore"), "build/\n").unwrap();
        std::fs::create_dir_all(dir.join("build")).unwrap();
        std::fs::write(dir.join("build").join("app.ts"), "x").unwrap();
        std::fs::write(dir.join("app.ts"), "x").unwrap();
        assert_eq!(search(&dir, "app", 10), ["app.ts"]);
        assert!(search(&dir, "HEAD", 10).is_empty());
    }

    fn watching(root: &Path, git: &[&Path]) -> Filter {
        Filter {
            roots: vec![root.to_path_buf()],
            git: git.iter().map(|dir| dir.to_path_buf()).collect(),
            watch: Vec::new(),
        }
    }

    fn sifted(filter: &Filter, path: PathBuf) -> Sifted {
        sift(filter, &path)
    }

    #[test]
    fn only_the_git_files_that_move_the_base_count_as_the_git_signal() {
        let root = PathBuf::from("/work/repo");
        let filter = watching(&root, &[]);
        let at = |tail: &str| sifted(&filter, root.join(tail));
        assert!(matches!(at(".git/objects/ab/cdef"), Sifted::Skip));
        assert!(matches!(at(".git/index.lock"), Sifted::Skip));
        assert!(matches!(at(".git/refs/heads/main.lock"), Sifted::Skip));
        assert!(matches!(at(".git/logs/HEAD"), Sifted::Skip));
        assert!(matches!(at(".git/COMMIT_EDITMSG"), Sifted::Skip));
        assert!(matches!(at(".git/HEAD"), Sifted::Git));
        assert!(matches!(at(".git/ORIG_HEAD"), Sifted::Git));
        assert!(matches!(at(".git/index"), Sifted::Git));
        assert!(matches!(at(".git/packed-refs"), Sifted::Git));
        assert!(matches!(at(".git/refs/heads/main"), Sifted::Git));
    }

    #[test]
    fn a_noisy_folder_is_skipped_and_a_plain_path_comes_through() {
        let root = PathBuf::from("/work/repo");
        let filter = watching(&root, &[]);
        let at = |tail: &str| sifted(&filter, root.join(tail));
        assert!(matches!(at("node_modules/react/index.js"), Sifted::Skip));
        assert!(matches!(at("apps/desktop/target/debug/penguin"), Sifted::Skip));
        assert!(matches!(at("src/notes.log"), Sifted::Skip));
        assert!(matches!(at("src/.DS_Store"), Sifted::Skip));
        assert!(matches!(at(".gitignore"), Sifted::Path(found) if found == ".gitignore"));
        assert!(matches!(at("src/app.ts"), Sifted::Path(found) if found == "src/app.ts"));
        assert!(matches!(sifted(&filter, root.clone()), Sifted::Skip));
        assert!(matches!(sifted(&filter, PathBuf::from("/elsewhere/app.ts")), Sifted::Skip));
    }

    #[test]
    fn a_worktrees_own_git_directory_reads_as_the_git_signal() {
        let root = PathBuf::from("/work/side");
        let own = PathBuf::from("/work/main/.git/worktrees/side");
        let common = PathBuf::from("/work/main/.git");
        let filter = watching(&root, &[&own, &common]);
        assert!(matches!(sifted(&filter, own.join("HEAD")), Sifted::Git));
        assert!(matches!(sifted(&filter, own.join("index")), Sifted::Git));
        assert!(matches!(sifted(&filter, own.join("index.lock")), Sifted::Skip));
        assert!(matches!(sifted(&filter, common.join("refs/heads/work")), Sifted::Git));
        assert!(matches!(sifted(&filter, common.join("objects/ab/cdef")), Sifted::Skip));
    }

    #[test]
    fn a_plain_checkout_keeps_its_git_directory_inside_the_root() {
        let dir = repo("watch-plain");
        let filter = Filter::of(&text_of(dir.clone()));
        assert!(filter.git.is_empty());
        assert!(filter.watch.is_empty());
        assert!(matches!(sift(&filter, &dir.join(".git").join("HEAD")), Sifted::Git));
    }

    #[test]
    fn a_linked_worktree_watches_the_git_directories_that_sit_outside_it() {
        let main = repo("watch-worktree");
        let path = text_of(main.clone());
        for args in [
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "test"],
        ] {
            git(&path, &args).unwrap();
        }
        std::fs::write(main.join("kept.txt"), "one\n").unwrap();
        git(&path, &["add", "-A"]).unwrap();
        git(&path, &["commit", "-qm", "first"]).unwrap();
        let side = temp("watch-worktree-side");
        git(&path, &["worktree", "add", "-q", "-b", "work", &text_of(side.clone())]).unwrap();

        let filter = Filter::of(&text_of(side.clone()));
        assert!(!filter.watch.is_empty());
        let own = filter.git.first().unwrap().clone();
        let common = main.join(".git").canonicalize().unwrap();
        assert!(matches!(sift(&filter, &own.join("index")), Sifted::Git));
        assert!(matches!(sift(&filter, &own.join("HEAD")), Sifted::Git));
        assert!(matches!(sift(&filter, &own.join("index.lock")), Sifted::Skip));
        assert!(matches!(sift(&filter, &common.join("refs").join("heads").join("work")), Sifted::Git));
        assert!(matches!(sift(&filter, &common.join("objects").join("ab").join("cd")), Sifted::Skip));
    }

    #[test]
    fn a_root_outside_git_watches_nothing_extra() {
        let dir = temp("watch-bare");
        let filter = Filter::of(&text_of(dir.clone()));
        assert!(filter.git.is_empty());
        assert!(filter.watch.is_empty());
    }

    fn drained(stop: Arc<AtomicBool>, filter: Filter) -> (Sender<PathBuf>, Arc<Mutex<Vec<Batch>>>, std::thread::JoinHandle<()>) {
        let (send, receive) = mpsc::channel::<PathBuf>();
        let seen: Arc<Mutex<Vec<Batch>>> = Arc::new(Mutex::new(Vec::new()));
        let kept = seen.clone();
        let thread = std::thread::spawn(move || {
            pump(&receive, &filter, &stop, &mut |batch| {
                kept.lock().unwrap().push(batch)
            })
        });
        (send, seen, thread)
    }

    #[test]
    fn a_burst_emits_once_and_nothing_more_after_the_watch_stops() {
        let root = PathBuf::from("/work/repo");
        let stop = Arc::new(AtomicBool::new(false));
        let (send, seen, thread) = drained(stop.clone(), watching(&root, &[]));

        for tail in ["a.ts", "b.ts", "a.ts", "node_modules/react.js", ".git/HEAD"] {
            send.send(root.join(tail)).unwrap();
        }
        std::thread::sleep(SETTLE * 4);
        {
            let found = seen.lock().unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].paths, ["a.ts", "b.ts"]);
            assert!(found[0].git);
            assert!(!found[0].overflow);
        }

        stop.store(true, Ordering::Relaxed);
        let _ = send.send(root.join("c.ts"));
        drop(send);
        thread.join().unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_quiet_gap_splits_two_bursts() {
        let root = PathBuf::from("/work/repo");
        let stop = Arc::new(AtomicBool::new(false));
        let (send, seen, thread) = drained(stop.clone(), watching(&root, &[]));

        send.send(root.join("a.ts")).unwrap();
        std::thread::sleep(SETTLE * 4);
        send.send(root.join("b.ts")).unwrap();
        std::thread::sleep(SETTLE * 4);

        stop.store(true, Ordering::Relaxed);
        drop(send);
        thread.join().unwrap();
        let found = seen.lock().unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].paths, ["a.ts"]);
        assert_eq!(found[1].paths, ["b.ts"]);
    }

    #[test]
    fn more_paths_than_the_cap_overflow_into_an_empty_list() {
        let root = PathBuf::from("/work/repo");
        let stop = Arc::new(AtomicBool::new(false));
        let (send, seen, thread) = drained(stop.clone(), watching(&root, &[]));

        for at in 0..MAX_PATHS + 1 {
            send.send(root.join(format!("file-{at}.ts"))).unwrap();
        }
        std::thread::sleep(SETTLE * 4);
        stop.store(true, Ordering::Relaxed);
        drop(send);
        thread.join().unwrap();

        let found = seen.lock().unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].overflow);
        assert!(found[0].paths.is_empty());
    }
}
