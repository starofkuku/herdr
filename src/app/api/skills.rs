//! The agent skills installed on this machine, for a client that offers them
//! as one-tap invocations.
//!
//! A skill is a directory with a `SKILL.md`, laid out by the open skills
//! ecosystem (`npx skills` and friends): each agent keeps its own skills
//! directory under the home directory, a project may add some beside its code,
//! and `~/.agents/skills` is the shared cross-agent location. Which of those
//! apply is decided by the pane's detected agent. Everything here is
//! read-only: installing a skill is the agent tooling's job.

use std::path::{Path, PathBuf};

use super::responses::{encode_error, encode_success};
use super::App;
use crate::api::schema::{
    ResponseResult, SkillInfo, SkillsListParams, SkillsListResult, SkillsReadParams,
    SkillsReadResult,
};

/// The server's home directory, where user-level skills live.
fn skills_home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()) {
            return Some(PathBuf::from(profile));
        }
    }
    None
}

/// Largest skill file returned, matching the project file reader's cap.
const MAX_READ_BYTES: u64 = 256 * 1024;
/// Skill directories a single pane may hold before the walk stops early.
const MAX_SKILLS: usize = 200;

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

/// The agent-specific skills directory names an agent keeps under the home
/// directory and inside a project. `None` for agents with no skill system of
/// their own — they only see the shared `.agents` locations.
fn agent_skill_dir(agent: crate::detect::Agent) -> Option<(&'static str, Option<&'static str>)> {
    match agent {
        crate::detect::Agent::Claude => Some((".claude", Some(".claude"))),
        crate::detect::Agent::Codex => Some((".codex", Some(".codex"))),
        // Pi reads user-level skills only; it has no project-level convention.
        crate::detect::Agent::Pi | crate::detect::Agent::Omp => Some((".pi/agent", None)),
        _ => None,
    }
}

/// Which agents have no skill system at all, so the panel can say why it is
/// empty rather than look broken. The shared `.agents` locations still count
/// as available for every agent: an ecosystem skill is agent-agnostic.
fn agent_has_skill_system(agent: Option<crate::detect::Agent>) -> bool {
    match agent {
        Some(known) => agent_skill_dir(known).is_some(),
        None => true,
    }
}

/// The skill directories that apply to one pane, most specific first. The
/// order is the dedup priority: a project skill overrides a user one, and an
/// agent's own directory overrides the shared `.agents` location.
fn skill_directories(
    agent: Option<crate::detect::Agent>,
    home: &Path,
    project: Option<&Path>,
) -> Vec<(PathBuf, &'static str)> {
    let mut dirs = Vec::new();
    let specific = agent.and_then(agent_skill_dir);
    if let Some((user_dir, project_dir)) = specific {
        if let Some(project_dir) = project_dir {
            if let Some(project) = project {
                dirs.push((project.join(project_dir).join("skills"), "project"));
            }
        }
        dirs.push((home.join(user_dir).join("skills"), "user"));
    }
    if let Some(project) = project {
        dirs.push((project.join(".agents").join("skills"), "project"));
    }
    dirs.push((home.join(".agents").join("skills"), "user"));
    dirs
}

/// Reads `name:` and `description:` out of a SKILL.md's frontmatter. Only the
/// flat two-field shape is recognised — a skill that folds its description
/// over several YAML lines still shows its first one, which is enough for a
/// picker.
fn parse_skill_metadata(text: &str) -> (Option<String>, String) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, String::new());
    }
    let mut name = None;
    let mut description = String::new();
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.trim() == "---" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("name:") {
            if name.is_none() {
                name = Some(unquote_yaml_scalar(value));
            }
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            if description.is_empty() {
                description = unquote_yaml_scalar(value);
            }
        }
    }
    (name, description)
}

/// Strips the quoting YAML allows around a plain scalar.
fn unquote_yaml_scalar(value: &str) -> String {
    let trimmed = value.trim();
    let unquoted = if (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
        || (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    unquoted.trim().to_string()
}

/// Every skill in one skills directory.
fn collect_from_dir(dir: &Path, source: &'static str, out: &mut Vec<FoundSkill>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let skill_path = entry.path().join("SKILL.md");
        if !skill_path.is_file() {
            continue;
        }
        let text = match read_text_prefix(&skill_path) {
            Some(text) => text,
            None => continue,
        };
        let disk_name = entry.file_name().to_str().map(str::to_string);
        let Some(disk_name) = disk_name else { continue };
        let (metadata_name, description) = parse_skill_metadata(&text);
        let name = metadata_name
            .filter(|name| !name.is_empty())
            .or_else(|| Some(disk_name.clone()));
        let Some(name) = name else { continue };
        let Some(dir_text) = dir.to_str() else {
            continue;
        };
        out.push(FoundSkill {
            info: SkillInfo {
                name,
                description,
                source: source.to_string(),
                dir: dir_text.to_string(),
            },
            disk_name,
        });
        if out.len() >= MAX_SKILLS {
            return;
        }
    }
}

/// The first bytes of a file, enough to cover any frontmatter.
fn read_text_prefix(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes.into_iter().take(64 * 1024).collect::<Vec<_>>()).ok()
}

/// One found skill: the public entry plus the directory name on disk, which
/// is where the `SKILL.md` actually lives even when the frontmatter names the
/// skill differently.
struct FoundSkill {
    info: SkillInfo,
    disk_name: String,
}

/// Collects the pane's skills, deduped by name with the first directory in
/// priority order winning.
fn collect_skills(dirs: &[(PathBuf, &'static str)]) -> Vec<FoundSkill> {
    let mut skills: Vec<FoundSkill> = Vec::new();
    for (dir, source) in dirs {
        collect_from_dir(dir, source, &mut skills);
    }
    skills.sort_by_key(|found| found.info.name.to_lowercase());
    skills.dedup_by(|later, kept| later.info.name == kept.info.name);
    skills
}

impl App {
    /// The agent a pane is currently running, when one is detected.
    fn pane_agent(&self, pane_id: &str) -> Result<Option<crate::detect::Agent>, ApiFailure> {
        let Some((ws_idx, id)) = self.parse_pane_id(pane_id) else {
            return Err(ApiFailure::new("pane_not_found", "no such pane"));
        };
        let terminal_id = self
            .state
            .workspaces
            .get(ws_idx)
            .and_then(|workspace| workspace.terminal_id(id));
        let agent = terminal_id
            .and_then(|terminal_id| self.state.terminals.get(terminal_id))
            .and_then(|terminal| terminal.effective_known_agent().or(terminal.detected_agent));
        Ok(agent)
    }

    /// The pane's project root, when it has one. Skills are the same job as
    /// the file tree here: a directory that may simply not exist yet.
    fn pane_project_root(&self, pane_id: &str) -> Result<Option<PathBuf>, ApiFailure> {
        let Some((ws_idx, id)) = self.parse_pane_id(pane_id) else {
            return Err(ApiFailure::new("pane_not_found", "no such pane"));
        };
        if let Some(cwd) = self.launch_cwd_for_pane_in_workspace(ws_idx, id) {
            if cwd.is_dir() {
                return Ok(Some(cwd));
            }
        }
        Ok(None)
    }

    pub(super) fn handle_skills_list(&mut self, id: String, params: SkillsListParams) -> String {
        let agent = match self.pane_agent(&params.pane_id) {
            Ok(agent) => agent,
            Err(err) => return encode_error(id, err.code, err.message),
        };
        let project = match self.pane_project_root(&params.pane_id) {
            Ok(project) => project,
            Err(err) => return encode_error(id, err.code, err.message),
        };
        let Some(home) = skills_home_dir() else {
            return encode_error(
                id,
                "home_unavailable",
                "the server's home directory is not set",
            );
        };
        let dirs = skill_directories(agent, &home, project.as_deref());
        let skills: Vec<SkillInfo> = collect_skills(&dirs)
            .into_iter()
            .map(|found| found.info)
            .collect();
        encode_success(
            id,
            ResponseResult::SkillsList {
                skills: SkillsListResult {
                    available: agent_has_skill_system(agent),
                    skills,
                },
            },
        )
    }

    pub(super) fn handle_skills_read(&mut self, id: String, params: SkillsReadParams) -> String {
        let name = params.name.trim();
        if name.is_empty() {
            return encode_error(id, "invalid_request", "skill name is required");
        }
        let agent = match self.pane_agent(&params.pane_id) {
            Ok(agent) => agent,
            Err(err) => return encode_error(id, err.code, err.message),
        };
        let project = match self.pane_project_root(&params.pane_id) {
            Ok(project) => project,
            Err(err) => return encode_error(id, err.code, err.message),
        };
        let Some(home) = skills_home_dir() else {
            return encode_error(
                id,
                "home_unavailable",
                "the server's home directory is not set",
            );
        };
        let dirs = skill_directories(agent, &home, project.as_deref());
        // The frontmatter may name a skill differently from its directory, so
        // either spelling locates it.
        let located = collect_skills(&dirs)
            .into_iter()
            .find(|found| found.info.name == name || found.disk_name == name);
        let Some(found) = located else {
            return encode_error(
                id,
                "skill_not_found",
                format!("no installed skill named {name} for this pane"),
            );
        };
        let path = PathBuf::from(&found.info.dir)
            .join(&found.disk_name)
            .join("SKILL.md");
        let size = match std::fs::metadata(&path) {
            Ok(metadata) => metadata.len(),
            Err(err) => {
                return encode_error(
                    id,
                    "read_failed",
                    format!("could not read the skill: {err}"),
                )
            }
        };
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => {
                return encode_error(
                    id,
                    "read_failed",
                    format!("could not read the skill: {err}"),
                )
            }
        };
        let truncated = bytes.len() as u64 > MAX_READ_BYTES;
        let content_bytes = if truncated {
            &bytes[..MAX_READ_BYTES as usize]
        } else {
            &bytes[..]
        };
        let content = String::from_utf8_lossy(content_bytes).into_owned();
        encode_success(
            id,
            ResponseResult::SkillsRead {
                skill: SkillsReadResult {
                    name: found.info.name,
                    path: path.display().to_string(),
                    content,
                    truncated,
                    size,
                },
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, dir: &str, skill: &str, frontmatter: Option<&str>) {
        let skill_dir = root.join(dir).join(skill);
        std::fs::create_dir_all(&skill_dir).unwrap();
        let body = frontmatter.unwrap_or("");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("{body}\n# {skill}\nDo the thing.\n"),
        )
        .unwrap();
    }

    #[test]
    fn frontmatter_name_and_description_are_parsed() {
        let (name, description) = parse_skill_metadata(
            "---\nname: git-commit\ndescription: 'Commits with a message'\n---\nbody",
        );
        assert_eq!(name.as_deref(), Some("git-commit"));
        assert_eq!(description, "Commits with a message");
    }

    #[test]
    fn frontmatter_without_a_header_yields_nothing() {
        let (name, description) = parse_skill_metadata("# plain skill\nno frontmatter");
        assert_eq!(name, None);
        assert!(description.is_empty());
    }

    #[test]
    fn double_quoted_and_bare_values_are_unquoted() {
        assert_eq!(unquote_yaml_scalar(" \"does things\" "), "does things");
        assert_eq!(unquote_yaml_scalar("plain value"), "plain value");
        assert_eq!(unquote_yaml_scalar("  "), "");
    }

    #[test]
    fn directories_follow_agent_specific_then_shared_order() {
        let home = Path::new("/home/u");
        let project = Path::new("/work/proj");
        let dirs = skill_directories(Some(crate::detect::Agent::Claude), home, Some(project));
        assert_eq!(dirs[0].0, project.join(".claude").join("skills"));
        assert_eq!(dirs[0].1, "project");
        assert_eq!(dirs[1].0, home.join(".claude").join("skills"));
        assert_eq!(dirs[1].1, "user");
        assert_eq!(dirs[2].0, project.join(".agents").join("skills"));
        assert_eq!(dirs[3].0, home.join(".agents").join("skills"));

        // An agent with no skill system of its own still sees the shared
        // locations.
        let shared = skill_directories(Some(crate::detect::Agent::Zcode), home, Some(project));
        assert_eq!(shared.len(), 2);
    }

    #[test]
    fn pi_reads_only_user_level_skills() {
        let dirs = skill_directories(
            Some(crate::detect::Agent::Pi),
            Path::new("/home/u"),
            Some(Path::new("/work/proj")),
        );
        assert_eq!(dirs.len(), 3);
        assert_eq!(dirs[0].0, Path::new("/home/u/.pi/agent/skills"));
        assert_eq!(dirs[0].1, "user");
    }

    #[test]
    fn collection_dedupes_by_name_with_priority_winning() {
        let base = std::env::temp_dir().join(format!("herdr-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let project = base.join("proj");
        std::fs::create_dir_all(home.join(".claude").join("skills")).unwrap();
        std::fs::create_dir_all(home.join(".agents").join("skills")).unwrap();
        std::fs::create_dir_all(project.join(".claude").join("skills")).unwrap();

        write_skill(
            &home,
            ".claude/skills",
            "deploy",
            Some("---\nname: deploy\ndescription: user copy\n---\n"),
        );
        // Same name in the shared directory: the agent-specific one wins.
        write_skill(
            &home,
            ".agents/skills",
            "deploy",
            Some("---\nname: deploy\ndescription: shared copy\n---\n"),
        );
        // A project skill overrides the user one.
        write_skill(
            &project,
            ".claude/skills",
            "deploy",
            Some("---\nname: deploy\ndescription: project copy\n---\n"),
        );
        // A skill without frontmatter falls back to its directory name.
        write_skill(&home, ".agents/skills", "bare-skill", None);

        let dirs = skill_directories(Some(crate::detect::Agent::Claude), &home, Some(&project));
        let skills = collect_skills(&dirs);
        let deploy = skills
            .iter()
            .find(|skill| skill.info.name == "deploy")
            .unwrap();
        assert_eq!(deploy.info.description, "project copy");
        assert_eq!(deploy.info.source, "project");
        assert_eq!(deploy.disk_name, "deploy");
        let bare = skills
            .iter()
            .find(|skill| skill.info.name == "bare-skill")
            .unwrap();
        assert!(bare.info.description.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn skill_availability_reflects_the_agent() {
        assert!(agent_has_skill_system(Some(crate::detect::Agent::Claude)));
        assert!(agent_has_skill_system(Some(crate::detect::Agent::Pi)));
        // ZCode has no skill system of its own; its panes still see the
        // shared `.agents` skills in the list, with `available` saying so.
        assert!(!agent_has_skill_system(Some(crate::detect::Agent::Zcode)));
        assert!(agent_has_skill_system(None));
    }
}
