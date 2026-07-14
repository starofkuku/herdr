# Herdr 开发环境与发布说明

本文说明 Herdr 的 Windows Terminal/WSL 通知实现、开发工具链、常见构建问题，以及在 GitHub 上发布版本的标准流程。示例版本为 `0.7.4`。

## Windows Terminal 与 WSL 通知原理

Herdr 的 `delivery = "terminal"` 会要求外层终端显示桌面通知，而不是由 WSL 内的 Linux 桌面服务处理通知。

Windows Terminal 会向其启动的 Shell（包括 WSL）注入 `WT_SESSION` 环境变量。Herdr 通过该变量识别 Windows Terminal，并发送以下 OSC 777 转义序列：

```text
ESC ] 777 ; notify ; <title> ; <body> ESC \
```

Windows Terminal 收到该序列后，在 Windows 通知中心显示带标题和正文的 Toast。通知标题中的协议分隔符和控制字符会先被清理，避免破坏序列结构。

Windows Terminal 默认禁止应用发送 OSC 777 通知。需要在对应 Profile 的 `settings.json` 中显式启用：

```json
{
  "profiles": {
    "defaults": {
      "compatibility.allowOSC777": true
    }
  }
}
```

然后配置 Herdr：

```toml
[ui.toast]
delivery = "terminal"
```

启用 OSC 777 后，该 Profile 中运行的其他程序也能创建 Windows 通知，因此只应在信任其中程序的 Profile 中启用。

## 开发工具链的作用

### Rust 1.96.1

Rust 是 Herdr 的主要开发语言。`cargo` 负责依赖解析、编译和测试，`rustfmt` 检查格式，`clippy` 执行静态分析。项目还安装 `x86_64-pc-windows-msvc` 目标，以便在 Linux/WSL 中检查 Windows 专用代码是否可以编译。

### just

`just` 是项目任务入口，统一封装 Cargo、Bun 和维护脚本：

```fish
just lint   # rustfmt + clippy
just test   # Rust、维护脚本和 TypeScript 测试
just check  # 完整检查，包括 Windows 目标 lint
```

### Cargo Nextest

Cargo Nextest 是 Rust 测试运行器。它并行运行测试、提供更清晰的失败报告，并被 `just test` 和 `just check` 使用。

### Zig 0.15.2

Herdr vendored 了 `libghostty-vt` 终端解析库。Cargo 执行 `build.rs` 时会调用 Zig 构建该原生库，因此没有 Zig 或 Zig 版本不匹配时，Rust 编译也会失败。

Zig 使用内容哈希缓存依赖：

```text
~/.cache/zig
```

当前网络代理会让 Zig 自己的 HTTP 客户端收到 `400 Bad Request`。解决方式是使用 curl 下载锁定归档，再通过 `zig fetch` 从本地文件写入哈希缓存。写入后，后续构建会直接命中缓存，不再由 Zig 联网下载。

### Bun

Bun 用于运行 Agent 集成资产和插件市场的 TypeScript 测试。完整的 `just check` 不仅检查 Rust，也会执行这些测试。

### fish PATH

工具路径通过 fish 通用变量持久保存：

```fish
fish_add_path -U $HOME/.cargo/bin $HOME/.local/bin $HOME/.bun/bin
```

新 fish 会话会自动加载。验证命令：

```fish
rustc --version
just --version
cargo nextest --version
zig version
bun --version
```

## 在 Herdr 会话内运行测试

Herdr 窗格会继承当前 session、socket、workspace 和 pane 环境变量。集成测试也会启动临时 Herdr server；如果保留这些变量，测试进程可能错误连接到正在运行的正式 server。

在 Herdr 窗格中运行完整检查时使用：

```fish
env -u HERDR_SOCKET_PATH \
    -u HERDR_CLIENT_SOCKET_PATH \
    -u HERDR_SESSION \
    -u HERDR_ENV \
    -u HERDR_PANE_ID \
    -u HERDR_TAB_ID \
    -u HERDR_WORKSPACE_ID \
    just check
```

## GitHub Release 发布流程

官方 `ogulcancelik/herdr` 的发布操作仅由项目维护者执行。Fork 所有者可以在自己的仓库中参考以下流程，但需要自行负责 Actions 权限、Secrets、标签和发布渠道。

### 1. 完成功能分支

确认分支没有未提交改动，并运行完整检查：

```fish
git status
git diff --check

env -u HERDR_SOCKET_PATH \
    -u HERDR_CLIENT_SOCKET_PATH \
    -u HERDR_SESSION \
    -u HERDR_ENV \
    -u HERDR_PANE_ID \
    -u HERDR_TAB_ID \
    -u HERDR_WORKSPACE_ID \
    just check
```

提交信息使用小写 Conventional Commits，例如：

```text
feat: support Windows Terminal notifications from WSL
```

### 2. 合并到 master

```fish
git switch master
git pull --ff-only origin master
git merge --ff-only feat/windows-terminal-wsl-notifications
git push origin master
```

发布前确认 `master` 干净：

```fish
git status --short --branch
```

### 3. 准备发布提交

稳定发布前应完成 pre-release audit，确认 `docs/next`、变更日志和用户文档覆盖自上个版本以来的变更。然后执行：

```fish
just release-prepare 0.7.4
```

该命令会：

- 验证版本格式和工作区状态；
- 检查发布文档是否同步；
- 将 `Cargo.toml` 和 `Cargo.lock` 更新为 `0.7.4`；
- 运行完整 `just check`；
- 创建 `release: v0.7.4` 发布提交。

发布前人工复核：

```fish
git log -2 --oneline
git show --stat HEAD
git status
```

### 4. 创建并推送标签

确认发布提交正确后，在 `master` 执行：

```fish
just release-publish 0.7.4
```

该命令会推送发布提交，创建带注释的 `v0.7.4` 标签，并将标签推送到 GitHub。不要在执行该命令后再次手工创建相同标签。

如果只需理解底层 Git 操作，其核心步骤是：

```fish
git push origin master
git tag -a v0.7.4 -m "v0.7.4"
git push origin v0.7.4
```

项目流程应优先使用 `just release-publish`，因为它会在推送前验证分支、版本、文档和标签状态。

### 5. GitHub Actions 构建 Release

推送 `v0.7.4` 后，`.github/workflows/release.yml` 会自动：

1. 检查标签与 Cargo 版本是否一致；
2. 构建 Linux 和 macOS 二进制；
3. 创建 GitHub Release；
4. 上传四个发布资产；
5. 更新发布 manifest 和网站数据。

查看进度：

```fish
gh run list --workflow release.yml --limit 5
gh run watch <run-id>
```

Release 必须包含：

```text
herdr-linux-x86_64
herdr-linux-aarch64
herdr-macos-x86_64
herdr-macos-aarch64
```

Fork 通常没有原仓库的 deploy key、Issue token 或 Cloudflare hook。二进制和 GitHub Release 可能成功，但更新网站 manifest 或部署网站的后续 Job 可能失败，需要在 fork 中配置相应 Secrets 或自行维护发布渠道。

### 6. 验证安装

根目录 `install.sh` 会直接下载 `starofkuku/herdr` 的 `v0.7.4` Release 资产，不依赖 `herdr.dev/latest.json`：

```fish
curl -fsSL https://raw.githubusercontent.com/starofkuku/herdr/master/install.sh | sh
herdr --version
```

预期版本：

```text
herdr 0.7.4
```

## 凭据安全

不要在 `~/.config/fish/config.fish` 中保存明文 GitHub Token。推荐使用：

```fish
gh auth login
gh auth status
```

已经暴露或写入明文配置的 Token 应立即在 GitHub 中撤销并重新生成。
