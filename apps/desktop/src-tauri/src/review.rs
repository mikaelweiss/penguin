use std::collections::HashMap;
use std::process::{Command, Stdio};

/// Flags every git call carries. `core.quotepath=false` is what keeps a non-ASCII
/// file name unquoted, so neither side has to unquote one.
const CFG: [&str; 11] = [
    "--no-optional-locks",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.longpaths=true",
    "-c",
    "core.symlinks=true",
    "-c",
    "core.quotepath=false",
];

/// Whole file context, so "show all lines" is a client side toggle with no refetch.
const PATCH_CONTEXT: &str = "--unified=2147483647";
const MAX_FILE_PATCH_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOTAL_PATCH_BYTES: usize = 10 * 1024 * 1024;

/// Which commit the review measures from.
#[derive(serde::Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum BaseChoice {
    /// What the run itself would pick: a worktree forks from origin's default
    /// branch, anything else measures from HEAD.
    Auto,
    Head,
    /// The merge base with origin's default branch, whatever the checkout is.
    Branch,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRoot {
    root: String,
    git: bool,
    default_branch: Option<String>,
}

#[derive(serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    file: String,
    status: String,
    additions: u32,
    deletions: u32,
    patch: String,
    binary: bool,
    truncated: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChanges {
    git: bool,
    base: String,
    rev: String,
    files: Vec<FileChange>,
    truncated: bool,
}

pub(crate) fn git(dir: &str, args: &[&str]) -> Option<(i32, String)> {
    let done = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(CFG)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let code = done.status.code()?;
    Some((code, String::from_utf8_lossy(&done.stdout).into_owned()))
}

pub(crate) fn git_line(dir: &str, args: &[&str]) -> Option<String> {
    let (code, out) = git(dir, args)?;
    if code != 0 {
        return None;
    }
    let line = out.trim().to_string();
    if line.is_empty() { None } else { Some(line) }
}

/// True when dir is a linked worktree, whose own gitdir sits inside the repository's common one.
fn is_worktree(dir: &str) -> bool {
    let own = git_line(dir, &["rev-parse", "--absolute-git-dir"]);
    let common = git_line(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    match (own, common) {
        (Some(own), Some(common)) => own != common,
        _ => false,
    }
}

/// What origin calls default, as a remote ref. An unset origin/HEAD answers none, never a guess.
fn default_branch(dir: &str) -> Option<String> {
    git_line(dir, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
}

pub(crate) fn is_git(dir: &str) -> bool {
    git_line(dir, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true")
}

/// The work tree a run reviews, and what the base picker can offer for it.
#[tauri::command]
pub fn review_root(dir: String) -> ReviewRoot {
    let toplevel = git_line(&dir, &["rev-parse", "--show-toplevel"]);
    let root = toplevel.unwrap_or_else(|| {
        let start = std::path::PathBuf::from(&dir);
        crate::text_of(start.canonicalize().unwrap_or(start))
    });
    ReviewRoot {
        git: is_git(&dir),
        default_branch: default_branch(&dir),
        root,
    }
}

/// Every file that differs from the base, with its stat and its patch.
#[tauri::command]
pub async fn git_changes(root: String, base: BaseChoice) -> Result<GitChanges, String> {
    tauri::async_runtime::spawn_blocking(move || changes(&root, base))
        .await
        .map_err(|cause| cause.to_string())
}

struct Item {
    file: String,
    code: String,
    status: String,
}

struct Stat {
    additions: u32,
    deletions: u32,
    binary: bool,
}

/// opencode's `kind`: the porcelain code decides, and an unmerged path reads as modified.
fn kind(code: &str) -> String {
    let status = if code == "??" {
        "added"
    } else if code.contains('U') {
        "modified"
    } else if code.contains('A') && !code.contains('D') {
        "added"
    } else if code.contains('D') && !code.contains('A') {
        "deleted"
    } else {
        "modified"
    };
    status.to_string()
}

fn records(text: &str) -> Vec<&str> {
    text.split('\0').filter(|part| !part.is_empty()).collect()
}

fn status_items(root: &str) -> Vec<Item> {
    let Some((_, out)) = git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--no-renames",
            "-z",
            "--",
            ".",
        ],
    ) else {
        return Vec::new();
    };
    records(&out)
        .into_iter()
        .filter(|entry| entry.len() > 3)
        .map(|entry| {
            let code = entry[..2].to_string();
            Item {
                status: kind(&code),
                code,
                file: entry[3..].to_string(),
            }
        })
        .collect()
}

fn diff_items(root: &str, rev: &str) -> Vec<Item> {
    let Some((_, out)) = git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--name-status",
            "-z",
            rev,
            "--",
            ".",
        ],
    ) else {
        return Vec::new();
    };
    let parts = records(&out);
    parts
        .chunks(2)
        .filter_map(|pair| match pair {
            [code, file] => Some(Item {
                status: kind(code),
                code: (*code).to_string(),
                file: (*file).to_string(),
            }),
            _ => None,
        })
        .collect()
}

fn count(value: &str) -> (u32, bool) {
    if value == "-" {
        return (0, true);
    }
    (value.parse().unwrap_or(0), false)
}

fn diff_stats(root: &str, rev: &str) -> HashMap<String, Stat> {
    let Some((_, out)) = git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--numstat",
            "-z",
            rev,
            "--",
            ".",
        ],
    ) else {
        return HashMap::new();
    };
    let mut stats = HashMap::new();
    for entry in records(&out) {
        let mut fields = entry.splitn(3, '\t');
        let (Some(adds), Some(dels), Some(file)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (additions, one) = count(adds);
        let (deletions, two) = count(dels);
        stats.insert(
            file.to_string(),
            Stat {
                additions,
                deletions,
                binary: one && two,
            },
        );
    }
    stats
}

/// A file git does not know yet is diffed against nothing, which is how it gets a stat.
fn untracked_stat(root: &str, file: &str) -> Stat {
    let Some((_, out)) = git(
        root,
        &["diff", "--no-index", "--numstat", "--", "/dev/null", file],
    ) else {
        return Stat { additions: 0, deletions: 0, binary: false };
    };
    let mut fields = out.splitn(3, '\t');
    let (Some(adds), Some(dels)) = (fields.next(), fields.next()) else {
        return Stat { additions: 0, deletions: 0, binary: false };
    };
    let (additions, one) = count(adds);
    let (deletions, two) = count(dels);
    Stat { additions, deletions, binary: one && two }
}

fn untracked_patch(root: &str, file: &str) -> String {
    git(
        root,
        &[
            "diff",
            "--no-index",
            "--patch",
            "--no-ext-diff",
            "--no-renames",
            PATCH_CONTEXT,
            "--",
            "/dev/null",
            file,
        ],
    )
    .map(|(_, out)| out)
    .unwrap_or_default()
}

fn from_diff_path(value: Option<&str>) -> Option<String> {
    let value = value?.split('\t').next()?;
    if value.is_empty() || value == "/dev/null" {
        return None;
    }
    let bare = value
        .strip_prefix("a/")
        .or_else(|| value.strip_prefix("b/"))
        .unwrap_or(value);
    Some(bare.to_string())
}

fn file_of_chunk(chunk: &str) -> Option<String> {
    let next = chunk.lines().find_map(|line| line.strip_prefix("+++ "));
    let before = chunk.lines().find_map(|line| line.strip_prefix("--- "));
    if let Some(file) = from_diff_path(next).or_else(|| from_diff_path(before)) {
        return Some(file);
    }
    let header = chunk.lines().next()?.strip_prefix("diff --git ")?;
    let split = header.find(" b/")?;
    from_diff_path(Some(&header[split + 1..]))
}

fn split_patch(text: &str) -> Vec<&str> {
    let marker = "diff --git ";
    let mut starts = Vec::new();
    let mut at = 0;
    while let Some(found) = text[at..].find(marker) {
        let start = at + found;
        if start == 0 || text.as_bytes()[start - 1] == b'\n' {
            starts.push(start);
        }
        at = start + marker.len();
    }
    starts
        .iter()
        .enumerate()
        .map(|(index, start)| {
            let end = starts.get(index + 1).copied().unwrap_or(text.len());
            &text[*start..end]
        })
        .collect()
}

/// One patch for the whole tree, cut back into one chunk per file.
fn tracked_patches(root: &str, rev: &str, order: &[&Item]) -> HashMap<String, String> {
    let Some((_, out)) = git(
        root,
        &[
            "diff",
            "--patch",
            "--no-ext-diff",
            "--no-renames",
            PATCH_CONTEXT,
            rev,
            "--",
            ".",
        ],
    ) else {
        return HashMap::new();
    };
    let mut patches: HashMap<String, String> = HashMap::new();
    for (index, chunk) in split_patch(&out).into_iter().enumerate() {
        let Some(file) = file_of_chunk(chunk).or_else(|| order.get(index).map(|item| item.file.clone()))
        else {
            continue;
        };
        patches.entry(file).or_default().push_str(chunk);
    }
    patches
}

struct Against {
    rev: String,
    label: String,
}

fn merge_base(root: &str, branch: &str) -> Option<String> {
    git_line(root, &["merge-base", branch, "HEAD"])
}

fn against(root: &str, base: BaseChoice) -> Against {
    let head = Against { rev: "HEAD".into(), label: "HEAD".into() };
    let forked = |branch: String| {
        merge_base(root, &branch).map(|rev| Against { rev, label: branch })
    };
    match base {
        BaseChoice::Head => head,
        BaseChoice::Auto => {
            if !is_worktree(root) {
                return head;
            }
            default_branch(root).and_then(forked).unwrap_or(head)
        }
        BaseChoice::Branch => default_branch(root).and_then(forked).unwrap_or(head),
    }
}

fn changes(root: &str, base: BaseChoice) -> GitChanges {
    if !is_git(root) {
        return GitChanges {
            git: false,
            base: String::new(),
            rev: String::new(),
            files: Vec::new(),
            truncated: false,
        };
    }
    let has_head = git(root, &["rev-parse", "--verify", "HEAD"]).is_some_and(|(code, _)| code == 0);
    let against = against(root, base);
    let rev = if has_head { against.rev } else { String::new() };

    let mut items: Vec<Item> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if rev.is_empty() {
        for item in status_items(root) {
            if seen.insert(item.file.clone()) {
                items.push(item);
            }
        }
    } else {
        for item in diff_items(root, &rev) {
            if seen.insert(item.file.clone()) {
                items.push(item);
            }
        }
        for item in status_items(root) {
            if item.code == "??" && seen.insert(item.file.clone()) {
                items.push(item);
            }
        }
    }
    items.sort_by(|a, b| a.file.cmp(&b.file));

    let stats = if rev.is_empty() { HashMap::new() } else { diff_stats(root, &rev) };
    let tracked: Vec<&Item> = items
        .iter()
        .filter(|item| !rev.is_empty() && item.code != "??")
        .collect();
    let mut patches = if tracked.is_empty() {
        HashMap::new()
    } else {
        tracked_patches(root, &rev, &tracked)
    };

    let mut files = Vec::with_capacity(items.len());
    let mut total = 0usize;
    let mut truncated = false;
    for item in &items {
        let loose = rev.is_empty() || item.code == "??";
        let stat = match stats.get(&item.file) {
            Some(stat) => Stat { additions: stat.additions, deletions: stat.deletions, binary: stat.binary },
            None if loose => untracked_stat(root, &item.file),
            None => Stat { additions: 0, deletions: 0, binary: false },
        };
        let patch = if stat.binary {
            String::new()
        } else if loose {
            untracked_patch(root, &item.file)
        } else {
            patches.remove(&item.file).unwrap_or_default()
        };
        let over = !stat.binary
            && (patch.len() > MAX_FILE_PATCH_BYTES || total + patch.len() > MAX_TOTAL_PATCH_BYTES);
        if over {
            truncated = true;
        } else {
            total += patch.len();
        }
        files.push(FileChange {
            file: item.file.clone(),
            status: item.status.clone(),
            additions: stat.additions,
            deletions: stat.deletions,
            patch: if over { String::new() } else { patch },
            binary: stat.binary,
            truncated: over,
        });
    }

    GitChanges { git: true, base: against.label, rev, files, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text_of;
    use std::path::{Path, PathBuf};

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("penguin-review-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn repo(name: &str) -> PathBuf {
        let dir = temp(name);
        std::fs::create_dir_all(&dir).unwrap();
        let path = text_of(dir.clone());
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "test"],
        ] {
            git(&path, &args).unwrap();
        }
        std::fs::write(dir.join("kept.txt"), "one\ntwo\n").unwrap();
        git(&path, &["add", "-A"]).unwrap();
        git(&path, &["commit", "-qm", "first"]).unwrap();
        dir
    }

    /// A bare clone stands in for origin, so origin/HEAD names a default branch to fork from.
    fn forked(name: &str) -> (PathBuf, PathBuf) {
        let dir = repo(name);
        let path = text_of(dir.clone());
        let remote = temp(&format!("{name}-origin"));
        git(&path, &["clone", "-q", "--bare", ".", &text_of(remote.clone())]).unwrap();
        git(&path, &["remote", "add", "origin", &text_of(remote)]).unwrap();
        git(&path, &["fetch", "-q", "origin"]).unwrap();
        git(&path, &["remote", "set-head", "origin", "main"]).unwrap();
        let side = temp(&format!("{name}-side"));
        git(&path, &["worktree", "add", "-q", "-b", "work", &text_of(side.clone())]).unwrap();
        (dir, side)
    }

    fn read(dir: &Path, base: BaseChoice) -> GitChanges {
        tauri::async_runtime::block_on(git_changes(text_of(dir.to_path_buf()), base)).unwrap()
    }

    fn only<'a>(found: &'a GitChanges, file: &str) -> &'a FileChange {
        found
            .files
            .iter()
            .find(|change| change.file == file)
            .unwrap_or_else(|| panic!("{file} is missing from {:?}", found.files))
    }

    fn real(path: &Path) -> String {
        text_of(path.canonicalize().unwrap())
    }

    #[test]
    fn a_folder_outside_any_repository_has_nothing_to_review() {
        let dir = temp("plain");
        std::fs::create_dir_all(&dir).unwrap();
        let found = read(&dir, BaseChoice::Auto);
        assert!(!found.git);
        assert!(found.files.is_empty());
        let root = review_root(text_of(dir.clone()));
        assert!(!root.git);
        assert_eq!(root.root, real(&dir));
    }

    #[test]
    fn a_clean_checkout_has_no_changed_files() {
        let dir = repo("clean");
        let found = read(&dir, BaseChoice::Auto);
        assert_eq!(found.base, "HEAD");
        assert!(found.files.is_empty());
    }

    #[test]
    fn an_edit_and_an_untracked_file_both_reach_the_list() {
        let dir = repo("dirty");
        std::fs::write(dir.join("kept.txt"), "one\nthree\n").unwrap();
        std::fs::write(dir.join("fresh.txt"), "new\n").unwrap();
        let found = read(&dir, BaseChoice::Auto);
        let kept = only(&found, "kept.txt");
        let fresh = only(&found, "fresh.txt");
        assert_eq!(kept.status, "modified");
        assert_eq!(fresh.status, "added");
        assert!(kept.patch.contains("+three"), "{}", kept.patch);
        assert!(fresh.patch.contains("+new"), "{}", fresh.patch);
    }

    #[test]
    fn an_ignored_file_stays_out_of_the_list() {
        let dir = repo("ignored");
        std::fs::write(dir.join(".gitignore"), "hidden.txt\n").unwrap();
        std::fs::write(dir.join("hidden.txt"), "secret\n").unwrap();
        let found = read(&dir, BaseChoice::Auto);
        let listed: Vec<&str> = found.files.iter().map(|change| change.file.as_str()).collect();
        assert_eq!(listed, vec![".gitignore"]);
    }

    #[test]
    fn a_commit_in_the_checkout_is_left_out_because_head_moved_with_it() {
        let dir = repo("committed");
        std::fs::write(dir.join("kept.txt"), "one\nthree\n").unwrap();
        git(&text_of(dir.clone()), &["commit", "-qam", "second"]).unwrap();
        assert!(read(&dir, BaseChoice::Auto).files.is_empty());
    }

    #[test]
    fn a_worktree_reads_from_where_it_forked() {
        let (_, side) = forked("fork");
        let branch = text_of(side.clone());
        std::fs::write(side.join("kept.txt"), "one\nthree\n").unwrap();
        git(&branch, &["commit", "-qam", "on the branch"]).unwrap();
        std::fs::write(side.join("kept.txt"), "one\nfour\n").unwrap();

        let found = read(&side, BaseChoice::Auto);
        assert_eq!(found.base, "origin/main");
        let kept = only(&found, "kept.txt");
        // The commit and the edit on top of it both measure from the fork, not from HEAD.
        assert!(kept.patch.contains("+four"), "{}", kept.patch);
        assert!(!kept.patch.contains("+three"), "{}", kept.patch);
        assert!(kept.patch.contains("-two"), "{}", kept.patch);
    }

    #[test]
    fn head_measures_from_head_even_in_a_worktree() {
        let (_, side) = forked("head");
        let branch = text_of(side.clone());
        std::fs::write(side.join("kept.txt"), "one\nthree\n").unwrap();
        git(&branch, &["commit", "-qam", "on the branch"]).unwrap();
        std::fs::write(side.join("kept.txt"), "one\nfour\n").unwrap();

        let found = read(&side, BaseChoice::Head);
        assert_eq!(found.base, "HEAD");
        let kept = only(&found, "kept.txt");
        assert!(kept.patch.contains("-three"), "{}", kept.patch);
        assert!(kept.patch.contains("+four"), "{}", kept.patch);
    }

    #[test]
    fn a_plain_checkout_measures_from_head_even_when_the_branch_base_is_asked_for() {
        let dir = repo("plain-branch");
        std::fs::write(dir.join("kept.txt"), "one\nthree\n").unwrap();
        let found = read(&dir, BaseChoice::Branch);
        assert_eq!(found.base, "HEAD");
        assert_eq!(found.rev, "HEAD");
        assert!(only(&found, "kept.txt").patch.contains("+three"));
    }

    #[test]
    fn a_repository_with_no_commit_lists_everything_as_added() {
        let dir = temp("fresh");
        std::fs::create_dir_all(&dir).unwrap();
        let path = text_of(dir.clone());
        git(&path, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(dir.join("one.txt"), "one\n").unwrap();
        std::fs::write(dir.join("two.txt"), "two\n").unwrap();
        let found = read(&dir, BaseChoice::Auto);
        assert_eq!(found.rev, "");
        assert_eq!(found.files.len(), 2);
        assert!(found.files.iter().all(|change| change.status == "added"));
        assert!(only(&found, "one.txt").patch.contains("+one"));
    }

    #[test]
    fn stats_come_back_per_file() {
        let dir = repo("stats");
        std::fs::write(dir.join("kept.txt"), "one\nthree\nfour\n").unwrap();
        let found = read(&dir, BaseChoice::Auto);
        let kept = only(&found, "kept.txt");
        assert_eq!((kept.additions, kept.deletions), (2, 1));
    }

    #[test]
    fn a_deleted_file_keeps_its_deletions() {
        let dir = repo("deleted");
        std::fs::remove_file(dir.join("kept.txt")).unwrap();
        let found = read(&dir, BaseChoice::Auto);
        let kept = only(&found, "kept.txt");
        assert_eq!(kept.status, "deleted");
        assert_eq!((kept.additions, kept.deletions), (0, 2));
        assert!(kept.patch.contains("-two"), "{}", kept.patch);
    }

    #[test]
    fn a_rename_reads_as_a_deletion_and_an_addition() {
        let dir = repo("renamed");
        std::fs::rename(dir.join("kept.txt"), dir.join("moved.txt")).unwrap();
        let found = read(&dir, BaseChoice::Auto);
        assert_eq!(only(&found, "kept.txt").status, "deleted");
        let moved = only(&found, "moved.txt");
        assert_eq!(moved.status, "added");
        assert!(moved.patch.contains("+one"), "{}", moved.patch);
    }

    #[test]
    fn a_binary_file_is_marked_and_carries_no_patch() {
        let dir = repo("binary");
        let path = text_of(dir.clone());
        std::fs::write(dir.join("shape.bin"), [0u8, 1, 2, 0, 3]).unwrap();
        git(&path, &["add", "-A"]).unwrap();
        git(&path, &["commit", "-qm", "shape"]).unwrap();
        std::fs::write(dir.join("shape.bin"), [0u8, 9, 9, 0, 4]).unwrap();
        let found = read(&dir, BaseChoice::Auto);
        let shape = only(&found, "shape.bin");
        assert!(shape.binary);
        assert_eq!(shape.patch, "");
        assert!(!shape.truncated);
        assert_eq!((shape.additions, shape.deletions), (0, 0));
    }

    #[test]
    fn a_subfolder_reviews_the_whole_checkout() {
        let dir = repo("subfolder");
        let deep = dir.join("packages").join("engine");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(review_root(text_of(deep)).root, real(&dir));
    }

    #[test]
    fn review_root_of_a_worktree_is_the_worktree_not_the_main_checkout() {
        let (main, side) = forked("root");
        let root = review_root(text_of(side.clone()));
        assert_eq!(root.root, real(&side));
        assert_ne!(root.root, real(&main));
        assert!(root.git);
        assert_eq!(root.default_branch.as_deref(), Some("origin/main"));
    }
}
