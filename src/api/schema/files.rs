//! The project's files, for a client that shows them.
//!
//! Read-only on purpose: the agent is the only writer, and a browser tab is not
//! where a file should change. Everything here is scoped to one pane's working
//! directory, and the handlers refuse any path that resolves outside it.

use serde::{Deserialize, Serialize};

/// Which pane's project to read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, Default)]
pub struct FilesListParams {
    pub pane_id: String,
    /// Directory to list, relative to the pane's project root. Absent lists the
    /// root itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// One entry in a directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FileEntryInfo {
    /// The entry's own name, as shown.
    pub name: String,
    /// Path relative to the project root, with `/` separators.
    pub path: String,
    /// `file` or `dir`.
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FilesListResult {
    /// The project root these paths are relative to.
    pub root: String,
    /// The directory that was listed, relative to the root (empty at the root).
    pub path: String,
    pub entries: Vec<FileEntryInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, Default)]
pub struct FilesReadParams {
    pub pane_id: String,
    /// File to read, relative to the project root.
    pub path: String,
    /// Largest file worth reading, in bytes. Defaults to the handler's cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FilesReadResult {
    pub path: String,
    /// The file's text, empty when `binary` or `too_large`.
    pub content: String,
    /// True when the file was longer than the cap and `content` is a prefix.
    pub truncated: bool,
    /// True when the file holds NUL bytes, so it is not text.
    pub binary: bool,
    /// True when the file was larger than the cap outright.
    pub too_large: bool,
    /// Size on disk, for the reader's context.
    pub size: u64,
}

/// The project's git status, as the file tree marks it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, Default)]
pub struct GitStatusParams {
    pub pane_id: String,
}

/// One changed file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GitChangedFileInfo {
    /// Path relative to the project root, with `/` separators.
    pub path: String,
    /// `modified`, `added`, `deleted`, `renamed`, or `untracked`.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GitStatusResult {
    /// False when the project is not inside a git repository — the ordinary
    /// case for a scratch directory, not an error.
    pub available: bool,
    /// The repository's root, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
    /// The checked-out branch, when one is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Changed files that live inside the project root, each path relative to it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<GitChangedFileInfo>,
}
