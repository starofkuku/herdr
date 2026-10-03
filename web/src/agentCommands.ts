// The slash commands an agent's own TUI understands, offered as hints in the
// composer's slash menu.
//
// These are prompts the agent itself interprets — picking one inserts it as
// plain text and the message is sent untouched, exactly as if it had been typed
// from memory. There is no API that lists them, so the tables are curated per
// agent and deliberately short: a wrong hint is worse than a missing one, so
// only commands stable enough to name are listed.

/** One slash command the agent's TUI understands. */
export interface AgentCommand {
  /** The command without its slash, as typed to invoke it. */
  name: string;
  /** What it does, shown beside the name in the menu. */
  description: string;
}

/** Claude Code's core slash commands. */
const CLAUDE_COMMANDS: readonly AgentCommand[] = [
  { name: "compact", description: "压缩对话历史，释放上下文空间" },
  { name: "clear", description: "清空当前会话，从头开始" },
  { name: "resume", description: "恢复一个历史会话" },
  { name: "model", description: "查看或切换模型" },
  { name: "context", description: "查看上下文占用情况" },
  { name: "cost", description: "查看本会话的花费统计" },
  { name: "memory", description: "编辑项目 memory 文件" },
  { name: "config", description: "查看或修改配置" },
  { name: "permissions", description: "查看和调整工具权限" },
  { name: "mcp", description: "查看 MCP 服务器状态" },
  { name: "init", description: "为项目生成 CLAUDE.md" },
  { name: "doctor", description: "检查安装与健康状态" },
  { name: "export", description: "导出当前对话" },
  { name: "status", description: "查看版本、账号与运行状态" },
  { name: "help", description: "查看帮助与全部命令" },
];

/** Codex CLI's core slash commands. */
const CODEX_COMMANDS: readonly AgentCommand[] = [
  { name: "new", description: "开始一个新会话" },
  { name: "status", description: "查看当前会话状态" },
  { name: "diff", description: "查看本会话的改动" },
  { name: "model", description: "查看或切换模型" },
  { name: "approvals", description: "调整审批模式" },
  { name: "init", description: "为项目生成 AGENTS.md" },
  { name: "quit", description: "退出" },
  { name: "help", description: "查看帮助" },
];

/** ZCode's built-in slash commands, as `zcode --help` lists them. */
const ZCODE_COMMANDS: readonly AgentCommand[] = [
  { name: "compact", description: "压缩当前对话" },
  { name: "new", description: "在 TUI 中开始新会话" },
  { name: "resume", description: "按会话 ID 恢复会话" },
  { name: "model", description: "查看或切换会话模型" },
  { name: "mode", description: "查看或切换权限模式" },
  { name: "skill", description: "列出技能，或指定加载一个技能" },
  { name: "mcp", description: "查看和管理 MCP 服务器" },
  { name: "expert", description: "运行或管理 expert 工作流" },
  { name: "dwf", description: "列出、取消或恢复动态工作流" },
  { name: "fork", description: "从检查点分叉出新会话" },
  { name: "rewind", description: "查看或恢复工作区检查点" },
  { name: "goal", description: "查看或设置会话目标" },
  { name: "login", description: "选择 Z.AI 或 BigModel 登录" },
  { name: "logout", description: "移除共享登录凭据" },
  { name: "help", description: "查看斜杠命令帮助" },
];

/**
 * Pi's built-in slash commands, taken from the command registrations in its
 * own bundle (`name`/`description` pairs verbatim, translated here).
 */
const PI_COMMANDS: readonly AgentCommand[] = [
  { name: "compact", description: "手动压缩会话上下文" },
  { name: "new", description: "开始新会话" },
  { name: "resume", description: "恢复另一个会话" },
  { name: "model", description: "选择模型（打开选择器）" },
  { name: "session", description: "查看会话信息与统计" },
  { name: "fork", description: "从历史消息分叉出新会话" },
  { name: "clone", description: "在当前位置复制当前会话" },
  { name: "import", description: "从 JSONL 文件导入并恢复会话" },
  { name: "export", description: "导出会话（HTML 或 JSONL）" },
  { name: "name", description: "设置会话显示名" },
  { name: "tree", description: "导航会话树，切换分支" },
  { name: "thinking", description: "设置思考级别" },
  { name: "scoped-models", description: "管理 Ctrl+P 循环的模型" },
  { name: "copy", description: "复制上一条 agent 消息到剪贴板" },
  { name: "share", description: "以私密 GitHub gist 分享会话" },
  { name: "mcp", description: "管理 MCP 服务器" },
  { name: "login", description: "配置 provider 认证" },
  { name: "logout", description: "移除 provider 认证" },
  { name: "settings", description: "打开设置菜单" },
  { name: "reload", description: "重载键位、扩展、技能与配置" },
  { name: "hotkeys", description: "显示全部快捷键" },
  { name: "trust", description: "保存项目信任决定" },
  { name: "changelog", description: "查看变更日志" },
  { name: "bug", description: "向 Pi 开发者报告 bug" },
  { name: "quit", description: "退出 Pi" },
];

/**
 * The commands an agent understands, by its detected name. Unknown agents get
 * none: a hint that names a command the running agent rejects would mislead
 * more than an empty menu.
 */
export function commandsForAgent(agent: string | undefined): AgentCommand[] {
  switch (agent) {
    case "claude":
      return [...CLAUDE_COMMANDS];
    case "codex":
      return [...CODEX_COMMANDS];
    case "zcode":
      return [...ZCODE_COMMANDS];
    case "pi":
      return [...PI_COMMANDS];
    default:
      return [];
  }
}
