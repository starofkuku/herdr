use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct AgentLaunchParams {
    pub request_id: String,
    pub kind: String,
    pub cwd: String,
    pub name: Option<String>,
    pub workspace_id: Option<String>,
    pub project_label: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct AgentSessionsParams {
    pub kind: String,
    pub cwd: String,
    pub query: Option<String>,
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct DirectoryListParams {
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct AgentCatalogEntry {
    pub kind: String,
    pub label: String,
    pub available: bool,
    pub resumable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct AgentHistoryEntry {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}
