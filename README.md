# Agent Session Bridge

Agent Session Bridge 使用 `tmux` 在本机创建和管理 Codex、Claude Code 与 Gemini CLI 会话，并提供 Web UI、CLI、HTTP API 和可选的飞书入口。会话与消息状态保存在本地 SQLite 数据库中。

> [!WARNING]
> 本项目可以读取工作区文件、向会话发送输入，并执行经过审批的本机命令。默认只监听 `127.0.0.1`。远程使用时必须配置 API Token、允许的 Host 和工作区目录，并通过受信任的 HTTPS 反向代理或 VPN 接入。

## 功能

- 指挥中心分开展示机器、已检测 AI 工具、执行实例、任务与待处理事项
- 本机任务支持明确目标、人工下发、规则观察、提交证据与人工验收
- 任务和时间线保存在 SQLite；远程 Runner 尚未实现，不会将远程登记显示为可执行

任务流程、监督边界及 API 见 [`docs/command-center.md`](docs/command-center.md)。
SSH 机器发现与 FRP 公网中转见 [`docs/frp-relay.md`](docs/frp-relay.md)。
Android WebView 壳与 APK 构建见 [`docs/android-app.md`](docs/android-app.md)。

- 按工作区创建、切换、重命名和停止会话
- 使用 `tmux` 保持会话持续运行
- 支持 Codex、Claude Code 和 Gemini CLI
- 提供 Web UI、CLI、HTTP API 和 SSE 事件流
- 保存会话消息、状态与巡检结果
- 浏览工作区文件，查看 `git status` 和 `git diff`
- 对停止会话和高风险终端命令执行审批
- 查看机器、外部服务状态和日志，并提交受控操作
- 可选飞书长连接、主动通知、浏览器通知和 PWA 安装

### 当前状态

| 功能 | 状态 |
| --- | --- |
| Codex 与本机 `tmux` 会话 | 可用，项目仍处于早期阶段 |
| Claude Code、Gemini CLI | 实验性 |
| Web UI、CLI、HTTP API、SSE | 可用，面向单一可信操作者 |
| 飞书入口 | 实验性，必须配置用户或群聊白名单 |
| 文件浏览、Git 预览、受控终端 | 实验性，高权限功能 |
| 外部服务器管理 | 可选集成，需要单独安装兼容项目 |
| 在远程机器上创建会话 | 尚未实现 |

## 环境要求

- Node.js 22 或更高版本
- `tmux`
- 至少安装一个受支持的 Agent CLI：Codex、Claude Code 或 Gemini CLI
- macOS 或 Linux

macOS 可以使用 Homebrew 安装 `tmux`：

```bash
brew install tmux
```

## 快速开始

```bash
git clone https://github.com/otterview-labs/agent-session-bridge.git
cd agent-session-bridge
npm ci
cp .env.example .env
npm run build
npm run start:server
```

服务默认监听 `http://127.0.0.1:8787`。启动后打开：

- `http://127.0.0.1:8787/`
- `http://127.0.0.1:8787/ui`

如果需要更换端口，在 `.env` 中设置：

```bash
ASB_HTTP_PORT=8790
```

默认的 Agent 命令是：

```bash
ASB_CODEX_BIN="codex --no-alt-screen"
ASB_CLAUDE_BIN="claude"
ASB_GEMINI_BIN="gemini"
```

可以在 `.env` 中替换为对应可执行文件的完整路径或命令参数。

## 使用方式

### Web UI

Web UI 可以管理会话、查看输出、浏览工作区、处理审批，以及检查机器和外部服务。

配置了 `ASB_API_TOKEN` 时，在页面的访问配置中输入 Token。Token 只保存在当前页面内存中，不会写入 Web Storage；刷新或关闭页面后需要重新输入。

### CLI

构建后可以直接执行：

```bash
node dist/cli.js /ping
node dist/cli.js /list
node dist/cli.js /new demo /path/to/projects/demo
node dist/cli.js /use demo
node dist/cli.js /ask 检查当前项目状态
node dist/cli.js /tail demo
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/ping` | 检查服务状态 |
| `/list`、`/sessions` | 列出会话 |
| `/new <name> <workspace>` | 创建会话 |
| `/use <name>` | 设置当前会话 |
| `/current` | 查看当前会话 |
| `/status [name]` | 查看会话状态 |
| `/inspect [name]` | 检查会话 |
| `/rename <old> <new>` | 重命名会话 |
| `/stop <name>` | 请求停止会话 |
| `/send <name> <prompt>` | 向指定会话发送消息 |
| `/ask <prompt>` | 向当前会话发送消息 |
| `/tail [name]` | 查看最近输出 |
| `/watch`、`/watch run` | 查看或立即执行巡检 |

完整命令说明见 [`docs/commands.md`](docs/commands.md)。

### HTTP API

常用端点包括：

- `GET /health`
- `GET /sessions`
- `GET /sessions/:name`
- `GET /sessions/:name/tail`
- `POST /command`
- `GET /supervisor`
- `POST /supervisor/run`
- `GET /events`

本机默认配置下可以直接检查健康状态：

```bash
curl http://127.0.0.1:8787/health
```

配置了 API Token 时，使用 Bearer 鉴权：

```bash
curl http://127.0.0.1:8787/sessions \
  -H "Authorization: Bearer $ASB_API_TOKEN"
```

### 飞书

飞书入口使用长连接，不需要公开 HTTP 回调地址。最小配置示例：

```bash
ASB_FEISHU_ENABLED=true
ASB_FEISHU_APP_ID=cli_xxx
ASB_FEISHU_APP_SECRET=xxx
ASB_FEISHU_ALLOWED_OPEN_IDS=ou_xxx
ASB_FEISHU_ALLOWED_CHAT_IDS=
ASB_FEISHU_REPLY_IN_THREAD=true
```

启用时必须至少填写一项 `ASB_FEISHU_ALLOWED_OPEN_IDS` 或 `ASB_FEISHU_ALLOWED_CHAT_IDS`，否则程序会拒绝启动。

飞书应用需要机器人、长连接事件订阅以及消息接收、发送和回复权限。相关设置请参考飞书开放平台文档：

- [接收消息事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)
- [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)
- [获取 tenant access token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)
- [长连接事件订阅](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)

## 配置

完整示例见 [`.env.example`](.env.example)。

| 配置项 | 说明 |
| --- | --- |
| `ASB_CODEX_BIN` | Codex 启动命令 |
| `ASB_CLAUDE_BIN` | Claude Code 启动命令 |
| `ASB_GEMINI_BIN` | Gemini CLI 启动命令 |
| `ASB_HTTP_HOST` | HTTP 监听地址，默认 `127.0.0.1` |
| `ASB_HTTP_PORT` | HTTP 端口，默认 `8787` |
| `ASB_API_TOKEN` | API Token，最多 4096 个无空格的可见 ASCII 字符；非回环监听时至少 32 字符 |
| `ASB_ALLOWED_HTTP_HOSTS` | 非回环监听允许接受的 Host 列表 |
| `ASB_ALLOWED_WORKSPACE_ROOTS` | 允许创建会话的工作区根目录 |
| `ASB_AUTO_CONFIRM_WORKSPACE_TRUST` | 是否自动确认 Agent 的工作区信任提示，默认关闭 |
| `ASB_DATA_DIR` | 运行数据目录，默认 `./data` |
| `ASB_DB_PATH` | SQLite 数据库路径 |
| `ASB_SUPERVISOR_ENABLED` | 是否启用定时巡检 |
| `ASB_SUPERVISOR_INTERVAL_MS` | 巡检间隔 |
| `ASB_FEISHU_ENABLED` | 是否启用飞书入口 |
| `ASB_FEISHU_ALLOWED_OPEN_IDS` | 允许控制服务的飞书用户列表 |
| `ASB_FEISHU_ALLOWED_CHAT_IDS` | 允许控制服务的飞书群聊列表 |
| `ASB_FEISHU_NOTIFY_CHAT_IDS` | 接收审批和失败操作通知的群聊列表 |
| `ASB_SERVER_MANAGER_PATH` | 可选服务器管理项目的路径 |

## 安全

- 不要提交 `.env`、数据库、日志、会话输出或访问令牌。
- 保持默认的 `ASB_HTTP_HOST=127.0.0.1`，不要将无鉴权服务直接暴露到公网。
- 绑定非回环地址时，程序强制要求 API Token、Host 白名单和工作区根目录。
- 可以使用 `openssl rand -hex 32` 生成随机 API Token。
- 远程访问请使用受信任的 HTTPS 反向代理或 VPN。
- `ASB_AUTO_CONFIRM_WORKSPACE_TRUST` 默认关闭，只应对完全信任的目录启用。
- `actorId` 是审计标签，不是多租户身份认证机制。
- 终端、文件浏览和服务器管理属于高权限功能。
- 安全问题请使用 GitHub 的私密漏洞报告，不要创建公开 Issue。详情见 [`SECURITY.md`](SECURITY.md)。

## 限制

- 当前主要面向单一可信操作者，不提供多租户身份隔离。
- Claude Code 和 Gemini CLI 适配仍处于实验阶段。
- 远程机器上的会话创建尚未实现。
- Git 预览不会执行仓库配置的 clean filter、external diff 或 hook，只支持元数据位于工作区内部的普通 `.git` 目录。
- Git 预览不包含原生 Git 的 rename detection 和仅文件模式变化。
- Web UI 刷新或关闭后不会保留 API Token。

## 项目结构

```text
agent-session-bridge/
├── public/        # Web UI 与 PWA 文件
├── src/           # 应用源码
├── test/          # 自动测试
├── docs/          # 架构、命令和路线文档
├── data/          # 本机运行数据；Git 只跟踪 .gitkeep
└── .github/       # CI、安全扫描和仓库维护配置
```

## 开发

```bash
npm ci
npm run check
```

`npm run check` 会依次执行类型检查、自动测试和构建。

## 文档

- [架构说明](docs/architecture.md)
- [命令说明](docs/commands.md)
- [FRP 公网中转](docs/frp-relay.md)
- [Android App](docs/android-app.md)
- [开发路线](docs/roadmap.md)
- [贡献指南](CONTRIBUTING.md)
- [支持范围](SUPPORT.md)
- [版本记录](CHANGELOG.md)
- [安全策略](SECURITY.md)

## 许可证

[Apache License 2.0](LICENSE)

## Pi 小镇工作室

新增 `/studio`：响应式 Web / 手机工作室，包含管家对话、像素办公室、
Pi 分析生成的日报 / 明日建议和显式用户记忆。Android 0.5.0 使用同一页面资源，
支持连接 Hub 共享对话、记忆和日报，并可选择上传本机任务摘要。
页面内可配置模型提供商、API 地址和加密保存的密钥，原有控制台仍可进入。
Pi 默认关闭，配置方法与数据边界见
[Pi 工作室说明](docs/pi-studio.md)。
