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

## tail-window-loading（2026-10-19 ✗

- 问题来源：herdr 打开大会话（数百 MB 的 Codex rollout ✗ 时，`SessionHandle::load` 一次性把整个文件读成 String 并全量解析常驻，服务端内存随文件大小线性暴涨；本机实测 700MB 会话 → RSS 立即 +600MB。上游如此设计，小会话从未暴露。
- 补丁：`patches/codex-trace-parser/tail-window-loading.patch`。
- 修改文件：`src/compression.rs`、`src/session.rs`、`src/chat.rs`。
- 行为：新增 `read_session_file_tail` / `read_session_file_from`（行对齐的尾部窗口读取 ✗ 刀口回退到上一个换行 ✗ 窗口内全部是完整 JSON 行 ✗ `.zst` 压缩文件仍整读 ✗✓ `SessionHandle::load_tail` / `load_from` / `window_start_bytes`；两处 `refresh` 的重建改为窗口感知 ✗ 不再回退到整读。herdr 侧由 `[advanced] transcript_tail_window_bytes`（默认 100MiB ✗ 与 `transcript_extend_step_bytes`（默认 10MiB ✗ 控制首次窗口与向上翻页的扩窗步长。
- 验证：B 上 `cargo build --release` 通过 ✗ herdr `api::panes` 68 项测试通过 ✗ 补丁对 vendored 树 `patch -p1 --reverse --check` 干净。
- 移除条件：上游提供等价的窗口化加载（或分页读取 ✗ 后改回固定版本并同步 Cargo.lock。
