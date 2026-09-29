//! The project's files: listing a directory, reading one file, and the git
//! status a client marks the tree with.
//!
//! Read-only by construction. The agent writes; a browser tab only looks. Every
//! path is resolved against one pane's project root and refused when it leaves
//! that root, so a request cannot reach the rest of the machine.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::responses::{encode_error, encode_success};
use super::App;
use crate::api::schema::{
    FileEntryInfo, FilesListParams, FilesListResult, FilesReadParams, FilesReadResult,
    GitChangedFileInfo, GitStatusParams, GitStatusResult, ResponseResult,
};

/// Directories never worth walking: build output, dependency stores, and
/// version-control internals. The list follows ZCode's built-in ignore set with
/// the Rust ecosystem's own entries (target, .cargo caches) added.
const IGNORED_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "bower_components",
    "jspm_packages",
    "target",
    "dist",
    "build",
    "out",
    "__pycache__",
    ".venv",
    "venv",
    "site-packages",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".gradle",
    ".idea",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".cache",
    "coverage",
    "htmlcov",
    "lcov-report",
    "cmakefiles",
    "pods",
    "deriveddata",
    "storybook-static",
    "playwright-report",
    "test-results",
    "allure-results",
    "allure-report",
    "cdk.out",
    "eggs",
    "pip-wheel-metadata",
    "wheels",
];

/// Directories whose names are a prefix pattern rather than an exact name.
const IGNORED_DIRECTORY_PREFIXES: &[&str] = &["cmake-build-", "bazel-"];

/// Largest file the reader will return, unless the request asks for less.
const DEFAULT_MAX_READ_BYTES: u64 = 256 * 1024;
/// Hard ceiling on the same, so a client cannot ask for a whole disk image.
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
/// How long one git invocation may take before it is killed.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// A refusal with the code the client should see.
struct ApiFailure {
    code: &'static str,
    message: String,
}

impl ApiFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// True when a directory's own name keeps it out of the tree.
fn is_ignored_directory(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IGNORED_DIRECTORIES.iter().any(|ignored| lower == *ignored)
        || IGNORED_DIRECTORY_PREFIXES
            .iter()
            .any(|prefix| lower.starts_with(prefix))
        || lower.ends_with(".egg-info")
        || lower.ends_with(".dist-info")
}

/// The project root for a pane: its working directory, or the workspace's
/// identity directory when the pane has none yet.
impl App {
    fn project_root_for_pane(&self, pane_id: &str) -> Result<PathBuf, ApiFailure> {
        let Some((ws_idx, id)) = self.parse_pane_id(pane_id) else {
            return Err(ApiFailure::new("pane_not_found", "no such pane"));
        };
        if let Some(cwd) = self.follow_cwd_for_pane_in_workspace(ws_idx, id) {
            if cwd.is_dir() {
                return Ok(crate::worktree::canonical_or_original(&cwd));
            }
        }
        let fallback = self
            .state
            .workspaces
            .get(ws_idx)
            .and_then(|workspace| workspace.resolved_identity_cwd())
            .filter(|path| path.is_dir());
        match fallback {
            Some(root) => Ok(crate::worktree::canonical_or_original(&root)),
            None => Err(ApiFailure::new(
                "project_root_unavailable",
                "the pane's project directory does not exist",
            )),
        }
    }
}

/// Resolves a request's relative path inside `root`.
///
/// Absolute paths, `..` components, and symlinks that point outside are all
/// refused: the tree is the project, not the machine. The canonicalized result
/// is checked against the canonicalized root, which is what makes the guard
/// hold for a symlinked subdirectory too.
fn resolve_within_root(root: &Path, relative: &str) -> Result<PathBuf, ApiFailure> {
    let relative = relative.trim();
    let candidate = if relative.is_empty() || relative == "." {
        root.to_path_buf()
    } else {
        let requested = Path::new(relative);
        if requested.is_absolute() {
            return Err(ApiFailure::new(
                "invalid_request",
                "path must be relative to the project root",
            ));
        }
        if requested
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(ApiFailure::new(
                "path_outside_workspace",
                "path may not leave the project root",
            ));
        }
        root.join(requested)
    };
    let resolved = crate::worktree::canonical_or_original(&candidate);
    if !resolved.starts_with(root) {
        return Err(ApiFailure::new(
            "path_outside_workspace",
            "path resolves outside the project root",
        ));
    }
    Ok(resolved)
}

/// A path relative to `root`, with `/` separators, or None when it is outside.
fn relative_to_root(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let text = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/");
    Some(text)
}

/// Whether a path names a binary by its first bytes.
///
/// NUL is the tell git itself uses: text files do not carry one, and a file
/// that does would render as garbage in a browser.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

impl App {
    pub(super) fn handle_files_list(&mut self, id: String, params: FilesListParams) -> String {
        let root = match self.project_root_for_pane(&params.pane_id) {
            Ok(root) => root,
            Err(err) => return encode_error(id, err.code, err.message),
        };
        let relative = params.path.unwrap_or_default();
        let directory = match resolve_within_root(&root, &relative) {
            Ok(path) => path,
            Err(err) => return encode_error(id, err.code, err.message),
        };
        if !directory.is_dir() {
            return encode_error(id, "not_a_directory", "path is not a directory");
        }
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(err) => {
                return encode_error(
                    id,
                    "list_failed",
                    format!("could not read directory: {err}"),
                )
            }
        };

        let mut items: Vec<(bool, String, FileEntryInfo)> = Vec::new();
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let path = entry.path();
            let is_directory = path.is_dir();
            if is_directory && is_ignored_directory(&name) {
                continue;
            }
            let Some(item_path) = relative_to_root(&root, &path) else {
                continue;
            };
            // Directories sort first, then names case-insensitively.
            let sort_name = name.to_lowercase();
            items.push((
                !is_directory,
                sort_name,
                FileEntryInfo {
                    name,
                    path: item_path,
                    kind: if is_directory { "dir" } else { "file" }.to_string(),
                },
            ));
        }
        items.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| left.2.name.cmp(&right.2.name))
        });

        encode_success(
            id,
            ResponseResult::FilesList {
                files: FilesListResult {
                    root: root.display().to_string(),
                    path: relative_to_root(&root, &directory).unwrap_or_default(),
                    entries: items.into_iter().map(|(_, _, entry)| entry).collect(),
                },
            },
        )
    }

    pub(super) fn handle_files_read(&mut self, id: String, params: FilesReadParams) -> String {
        let root = match self.project_root_for_pane(&params.pane_id) {
            Ok(root) => root,
            Err(err) => return encode_error(id, err.code, err.message),
        };
        let file = match resolve_within_root(&root, &params.path) {
            Ok(path) => path,
            Err(err) => return encode_error(id, err.code, err.message),
        };
        let Some(relative) = relative_to_root(&root, &file) else {
            return encode_error(
                id,
                "path_outside_workspace",
                "path is outside the project root",
            );
        };
        let metadata = match std::fs::metadata(&file) {
            Ok(metadata) => metadata,
            Err(err) => {
                return encode_error(id, "read_failed", format!("could not stat file: {err}"))
            }
        };
        if !metadata.is_file() {
            return encode_error(id, "not_a_file", "path is not a file");
        }
        let size = metadata.len();
        let cap = params
            .max_bytes
            .unwrap_or(DEFAULT_MAX_READ_BYTES)
            .min(MAX_READ_BYTES);
        if size > cap {
            return encode_success(
                id,
                ResponseResult::FilesRead {
                    file: FilesReadResult {
                        path: relative,
                        content: String::new(),
                        truncated: false,
                        binary: false,
                        too_large: true,
                        size,
                    },
                },
            );
        }
        let bytes = match std::fs::read(&file) {
            Ok(bytes) => bytes,
            Err(err) => {
                return encode_error(id, "read_failed", format!("could not read file: {err}"))
            }
        };
        if looks_binary(&bytes) {
            return encode_success(
                id,
                ResponseResult::FilesRead {
                    file: FilesReadResult {
                        path: relative,
                        content: String::new(),
                        truncated: false,
                        binary: true,
                        too_large: false,
                        size,
                    },
                },
            );
        }
        // A file that is not valid UTF-8 is shown lossily rather than refused:
        // the reader wants to see what is there, and every ill-formed byte
        // becomes the replacement character.
        encode_success(
            id,
            ResponseResult::FilesRead {
                file: FilesReadResult {
                    path: relative,
                    content: String::from_utf8_lossy(&bytes).into_owned(),
                    truncated: false,
                    binary: false,
                    too_large: false,
                    size,
                },
            },
        )
    }

    pub(super) fn handle_git_status(&mut self, id: String, params: GitStatusParams) -> String {
        let root = match self.project_root_for_pane(&params.pane_id) {
            Ok(root) => root,
            Err(err) => return encode_error(id, err.code, err.message),
        };
        let Some(repo_root) = run_git(&root, &["rev-parse", "--show-toplevel"])
            .map(|output| PathBuf::from(output.trim()))
            .filter(|path| !path.as_os_str().is_empty())
        else {
            // Not a repository is the ordinary case for a scratch directory.
            return encode_success(
                id,
                ResponseResult::GitStatus {
                    status: GitStatusResult {
                        available: false,
                        repo_root: None,
                        branch: None,
                        files: Vec::new(),
                    },
                },
            );
        };
        let branch = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|output| output.trim().to_string())
            .filter(|branch| !branch.is_empty() && branch != "HEAD");
        let Some(porcelain) = run_git(
            &root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        ) else {
            return encode_error(id, "git_status_failed", "git status did not answer");
        };

        let repo_root = crate::worktree::canonical_or_original(&repo_root);
        let mut files = Vec::new();
        for (status, path) in parse_porcelain(&porcelain) {
            // The tree is rooted at the pane's project directory, which may be a
            // subdirectory of the repository: the repository path is rebased
            // onto it, and anything outside the tree is left out.
            let absolute = crate::worktree::canonical_or_original(&repo_root.join(&path));
            let Some(relative) = relative_to_root(&root, &absolute) else {
                continue;
            };
            files.push(GitChangedFileInfo {
                path: relative,
                status,
            });
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));

        encode_success(
            id,
            ResponseResult::GitStatus {
                status: GitStatusResult {
                    available: true,
                    repo_root: Some(repo_root.display().to_string()),
                    branch,
                    files,
                },
            },
        )
    }
}

/// Runs one git command in `cwd`, returning its stdout on success.
///
/// Bounded by `GIT_TIMEOUT`: this is a long-lived server, and a git call that
/// waits on a lock or a network mount must not hold a request open forever.
fn run_git(cwd: &Path, args: &[&str]) -> Option<String> {
    use std::process::{Command, Stdio};

    let mut child = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + GIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    String::from_utf8(output.stdout).ok()
}

/// The changed files in `git status --porcelain=v1 -z` output.
///
/// The `-z` form separates records with NUL and, for a rename, emits the new
/// path and then the old one as its own record; the old path is consumed here
/// so it does not surface as a second file.
fn parse_porcelain(output: &str) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut records = output.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let (code, path) = record.split_at(3);
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        let mut chars = code.chars();
        let index = chars.next().unwrap_or(' ');
        let worktree = chars.next().unwrap_or(' ');
        let renamed = index == 'R' || worktree == 'R';
        if renamed {
            // The record that follows a rename is its original path.
            let _ = records.next();
        }
        let status = if index == '?' || worktree == '?' {
            "untracked"
        } else if index == 'A' || worktree == 'A' {
            "added"
        } else if index == 'D' || worktree == 'D' {
            "deleted"
        } else if renamed {
            "renamed"
        } else {
            "modified"
        };
        files.push((status.to_string(), path.to_string()));
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignored_directories_cover_build_output_and_prefixes() {
        for name in [
            ".git",
            "node_modules",
            "target",
            "dist",
            "__pycache__",
            ".venv",
        ] {
            assert!(is_ignored_directory(name), "{name} should be ignored");
        }
        assert!(is_ignored_directory("cmake-build-debug"));
        assert!(is_ignored_directory("bazel-out"));
        assert!(is_ignored_directory("foo.egg-info"));
        assert!(
            is_ignored_directory("NODE_MODULES"),
            "case is not significant"
        );
        assert!(!is_ignored_directory("src"));
        assert!(
            !is_ignored_directory("targets"),
            "only the exact name is ignored"
        );
    }

    #[test]
    fn resolve_within_root_refuses_traversal_and_absolute_paths() {
        let root = std::env::temp_dir();
        let root = crate::worktree::canonical_or_original(&root);
        assert!(resolve_within_root(&root, "sub/file.txt").is_ok());
        assert_eq!(
            resolve_within_root(&root, "../etc/passwd")
                .unwrap_err()
                .code,
            "path_outside_workspace"
        );
        assert_eq!(
            resolve_within_root(&root, "/etc/passwd").unwrap_err().code,
            "invalid_request"
        );
    }

    #[test]
    fn binary_detection_keys_on_nul_bytes() {
        assert!(!looks_binary(b"fn main() {}\n"));
        assert!(looks_binary(b"PK\x03\x04\x00\x01"));
    }

    #[test]
    fn porcelain_parsing_maps_codes_and_skips_rename_sources() {
        // Modified in the worktree, an added file, an untracked one.
        let output = " M src/main.rs\0A  new.rs\0?? notes.txt\0";
        let files = parse_porcelain(output);
        assert_eq!(
            files,
            vec![
                ("modified".to_string(), "src/main.rs".to_string()),
                ("added".to_string(), "new.rs".to_string()),
                ("untracked".to_string(), "notes.txt".to_string()),
            ]
        );

        // A rename carries its old path as the next record, which is consumed.
        let renamed = "R  new-name.rs\0old-name.rs\0 D gone.rs\0";
        let files = parse_porcelain(renamed);
        assert_eq!(
            files.len(),
            2,
            "the rename's source is not a second file: {files:?}"
        );
        assert_eq!(files[0].0, "renamed");
        assert_eq!(files[0].1, "new-name.rs");
        assert_eq!(files[1], ("deleted".to_string(), "gone.rs".to_string()));
    }
}
