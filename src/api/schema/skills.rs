//! The agent skills installed on this machine, for a client that offers them.
//!
//! Read-only on purpose: installing or editing a skill belongs to the agent's
//! own tooling (`npx skills` and friends), not to a browser tab. A skill is a
//! directory with a `SKILL.md`; its frontmatter carries the name and the
//! description an agent matches on, which is all a picker needs.

use serde::{Deserialize, Serialize};

/// Which pane's agent to read skills for. The detected agent decides which
/// skill directories apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, Default)]
pub struct SkillsListParams {
    pub pane_id: String,
}

/// One installed skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SkillInfo {
    /// The name an agent recognises, from the frontmatter when it has one and
    /// from the directory otherwise.
    pub name: String,
    /// What the skill does, from the frontmatter; empty when absent.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// `user` for skills installed in the home directory, `project` for ones
    /// inside the pane's project.
    pub source: String,
    /// The skills directory the skill was found in, absolute.
    pub dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SkillsListResult {
    /// False when the pane's agent has no skill system at all, so a client can
    /// say why the list is empty instead of showing a bare panel.
    pub available: bool,
    pub skills: Vec<SkillInfo>,
}

/// The text of one skill, for a reader that shows what a skill does before
/// invoking it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, Default)]
pub struct SkillsReadParams {
    pub pane_id: String,
    /// The skill's name, as `skills.list` reported it.
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SkillsReadResult {
    pub name: String,
    /// The `SKILL.md` path on disk, for the reader's context.
    pub path: String,
    /// The file's text, empty when `truncated`.
    pub content: String,
    /// True when the file was longer than the cap and `content` is a prefix.
    pub truncated: bool,
    /// Size on disk, for the reader's context.
    pub size: u64,
}
