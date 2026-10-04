# codex-trace-parser 本地补丁

- 上游：https://github.com/xianchoujiduluo/codex-trace
- 基准提交：`d15bba979bedf70553d9bced2510dbf26126e5c7`，`parser/`，版本 `0.4.20`。
- 源码目录：`vendor/codex-trace-parser/`；保留上游 MIT LICENSE。
- 问题来源：本机会话 Pi 已写入空正文 `stopReason: aborted`，Herdr 仍返回 ongoing；Claude 共用相同缺陷路径。未创建上游 issue/PR。
- 补丁：`patches/codex-trace-parser/explicit-terminal-events.patch`。
- 修改文件：`src/chat.rs`、`src/activity.rs`。
- 行为：保留无正文的明确结束事件，区分正常完成、取消、中止和错误；读取 Claude `isApiErrorMessage`；明确结束状态优先于残留工具调用，并保持增量读取状态一致。
- 验证：B 上解析器 421 项既有单元测试，以及临时 Pi/Claude 空正文、部分正文、未返回工具调用和多次快照验证。
- 移除条件：上游提供上述语义且通过相同验证后，改回固定 Git revision，并同步 Cargo.lock 与 Nix 打包配置，删除 vendored 源码和补丁记录。

验证补丁与源码一致：

```sh
git apply --reverse --check --directory=vendor/codex-trace-parser vendor/patches/codex-trace-parser/explicit-terminal-events.patch
```
