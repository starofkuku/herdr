use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnAgentOutput {
    pub agent_id: String,
    pub nickname: String,
}

/// Metadata returned by Codex v2 after a task is created. The task name is not the
/// child session ID; that ID is carried by the `SubAgentActivity` item instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnAgentMetadata {
    pub task_name: String,
    pub nickname: String,
}

pub fn parse_spawn_agent_output(output: &str) -> Option<SpawnAgentOutput> {
    let parsed: Value = serde_json::from_str(output).ok()?;
    let agent_id = parsed.get("agent_id")?.as_str()?.to_string();
    if agent_id.is_empty() {
        return None;
    }

    let nickname = parsed
        .get("nickname")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Some(SpawnAgentOutput { agent_id, nickname })
}

pub fn parse_spawn_agent_metadata(output: &str) -> Option<SpawnAgentMetadata> {
    let parsed: Value = serde_json::from_str(output).ok()?;
    let task_name = parsed.get("task_name")?.as_str()?.to_string();
    if task_name.is_empty() {
        return None;
    }

    let nickname = parsed
        .get("nickname")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Some(SpawnAgentMetadata {
        task_name,
        nickname,
    })
}

pub fn is_spawn_agent_output_success(output: &str) -> bool {
    parse_spawn_agent_output(output).is_some() || parse_spawn_agent_metadata(output).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spawn_agent_output() {
        let parsed = parse_spawn_agent_output(
            r#"{"agent_id":"019dcd48-57d3-7a42-9952-bb488d179d0f","nickname":"Parfit"}"#,
        )
        .unwrap();

        assert_eq!(parsed.agent_id, "019dcd48-57d3-7a42-9952-bb488d179d0f");
        assert_eq!(parsed.nickname, "Parfit");
    }

    #[test]
    fn ignores_non_json_spawn_agent_output() {
        assert!(
            parse_spawn_agent_output("Full-history forked agents inherit parent config").is_none()
        );
    }

    #[test]
    fn parses_v2_spawn_agent_metadata_without_treating_task_name_as_session_id() {
        let parsed = parse_spawn_agent_metadata(
            r#"{"task_name":"/root/package_inspect","nickname":"Helmholtz"}"#,
        )
        .unwrap();

        assert_eq!(parsed.task_name, "/root/package_inspect");
        assert_eq!(parsed.nickname, "Helmholtz");
        assert!(parse_spawn_agent_output(
            r#"{"task_name":"/root/package_inspect","nickname":"Helmholtz"}"#
        )
        .is_none());
        assert!(is_spawn_agent_output_success(
            r#"{"task_name":"/root/package_inspect","nickname":"Helmholtz"}"#
        ));
    }
}
