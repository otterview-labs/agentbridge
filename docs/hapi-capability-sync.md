# HAPI Capability Sync

## 1. 目标

本文定义 `AgentBridge` 对齐 `HAPI` 能力的产品与工程路线。

这里的“同步”指：

- 同步能力边界：移动端控制、实时会话、审批、文件、终端、远程启动、PWA、通知、语音。
- 同步产品体验：本地执行、远程接续、离开电脑也能观察和处理阻塞点。
- 不直接复制实现：保持当前项目的轻量 `tmux + SQLite + HTTP + Feishu` 内核，按模块补齐控制面能力。

## 2. 参考来源

调研时间：2026-04-19。

公开参考：

- `https://hapi.run/docs/guide/how-it-works`
- `https://hapi.run/docs/guide/pwa`
- `https://hapi.run/docs/guide/voice-assistant`
- `https://github.com/tiann/hapi`

注意事项：

- GitHub 仓库页面标注为 `AGPL-3.0 license`。
- 官网文档页脚标注为 `LGPL-3.0 License`。
- 在许可证信息不一致的情况下，本项目只做能力级参考，不复制源码、文案、样式或协议实现。

## 3. 能力矩阵

| 能力 | HAPI 形态 | ASB 当前状态 | 目标模块 | 优先级 |
| --- | --- | --- | --- | --- |
| 本地优先 | Agent 在本机运行，远端只控制 | 已有，基于 `tmux + Codex` | 保持内核不变 | P0 |
| 无缝接续 | 本地终端与远端 Web/PWA 切换 | 部分具备，tmux 可兜底 | `AgentAdapter` + `SessionMode` | P2 |
| 多 Agent | Claude/Codex/Cursor/Gemini/OpenCode | 目前偏 Codex | `AgentAdapter` | P3 |
| 实时更新 | Hub 到 Web 使用 SSE | 当前靠轮询刷新 | `SessionEventBus` + `/events` | P0 |
| CLI/Runner 注册 | CLI 或 runner 向 hub 注册会话 | 当前服务主动创建 tmux window | `MachineService` + `RunnerService` | P2 |
| 远程启动 | 手机选择机器后 spawn 新会话 | 当前只能在本服务机器新建 | `/spawn` + runner | P2 |
| 会话消息 | 消息分页、历史、状态同步 | 当前只保存摘要 | `ConversationService` | P0 |
| 权限审批 | 手机批准/拒绝工具请求 | 文档预留，未实现 | `ApprovalService` | P1 |
| 文件浏览 | 文件树、文件内容、git diff | 未实现 | `WorkspaceService` | P1 |
| 远程终端 | Web 中打开远程 shell | 只有 tmux tail | `TerminalService` | P2 |
| PWA | 可安装、离线、后台同步 | 普通静态页 | `manifest` + service worker | P1 |
| 推送通知 | 权限请求、任务完成提醒 | 飞书可回复，无通用通知 | `NotificationService` | P1 |
| Telegram Mini App | Telegram 入口与通知 | 当前优先飞书 | 未来 `TelegramChannel` | P4 |
| 语音助手 | 语音发消息、审批、播报 | 未实现 | `VoiceBridgeService` | P3 |
| 隧道/远程访问 | Relay、Cloudflare、Tailscale | 可自行暴露 HTTP | 部署文档 + URL 配置 | P1 |
| 命名空间 | 多用户/多团队隔离 | actor 粗粒度 | `Namespace` + token scope | P2 |
| MCP 桥 | 给外部工具提供 stdio bridge | 未实现 | `McpBridgeService` | P4 |

## 4. 目标架构

```text
Phone / Browser / PWA / Feishu / Future Telegram / Voice
          ↓
HTTP API + SSE Events + Channel Adapters
          ↓
Command Router / Action Router
          ↓
Application Services
  ├─ SessionService
  ├─ ConversationService
  ├─ ApprovalService
  ├─ WorkspaceService
  ├─ TerminalService
  ├─ MachineService
  ├─ NotificationService
  ├─ VoiceBridgeService
  └─ SupervisorService
          ↓
Storage + Event Bus
  ├─ SQLite repositories
  └─ SessionEventBus
          ↓
Agent Adapters
  ├─ TmuxCodexAdapter
  ├─ NativeCodexAdapter       (future)
  ├─ ClaudeAdapter            (future)
  ├─ GeminiAdapter            (future)
  └─ OpenCodeAdapter          (future)
          ↓
Local machines / runner processes / tmux windows
```

设计原则：

- `SessionService` 继续是会话生命周期中心。
- `CommandRouter` 继续承担文本命令兼容层。
- 新增 `Action Router` 或 service-level API，承接 Web/PWA 的结构化动作。
- `tmux` 仍是第一后端，避免在第一阶段推翻现有实现。
- 所有实时能力先通过 `SSE` 落地；只有 runner 双向连接需要时再引入 WebSocket/Socket.IO。

## 5. 核心模块

### 5.1 SessionEventBus

职责：

- 在服务内部发布事件。
- 将事件广播给 SSE 客户端、飞书通知、未来 Telegram/PWA Push。
- 统一事件结构，避免各模块直接依赖前端或渠道。

事件类型：

- `session.created`
- `session.updated`
- `session.stopped`
- `session.tail.updated`
- `message.created`
- `approval.requested`
- `approval.resolved`
- `machine.online`
- `machine.offline`
- `terminal.output`
- `supervisor.snapshot`

第一版可以用进程内 `EventEmitter`，后续再考虑持久化 event log。

### 5.2 ConversationService

职责：

- 保存用户消息、桥接器回执、agent 输出摘要。
- 支持分页读取历史。
- 为 Web/PWA、飞书、语音助手提供统一上下文。

消息角色：

- `user`
- `assistant`
- `system`
- `tool`
- `approval`

### 5.3 ApprovalService

职责：

- 管理待审批请求。
- 支持批准、拒绝、超时、取消。
- 将高风险动作从“立即执行”变为“先入队，等批准”。

第一阶段审批范围：

- 停止会话。
- 执行终端命令。
- 读取白名单外路径。
- 写文件或应用 patch。
- 远程 spawn 到未信任机器。

### 5.4 WorkspaceService

职责：

- 基于 session 的 `workspacePath` 浏览文件树。
- 安全读取文件内容。
- 输出 `git status` 和 `git diff`。
- 支持文件搜索。

安全边界：

- 所有路径必须限制在当前 session 的 workspace 内。
- 默认只读。
- 写入和删除必须走审批。
- 大文件、二进制文件和敏感文件需要限制。

### 5.5 TerminalService

职责：

- 在指定 workspace 内执行受控命令。
- 持久化命令记录。
- 将 stdout/stderr 增量输出推送到事件流。

安全边界：

- 默认关闭。
- 支持命令白名单。
- 支持危险命令审批。
- 命令输出需要大小限制和超时。

### 5.6 MachineService / RunnerService

职责：

- 注册本机或远程机器。
- 记录机器心跳、标签、能力、runner 版本。
- 支持从 Web/PWA 选择机器并创建新会话。

第一版可以将当前 ASB 服务进程注册为 `local` machine。

### 5.7 NotificationService

职责：

- 将重要事件转成通知。
- 支持 Web Push、飞书、未来 Telegram。

通知类型：

- 审批请求。
- 会话完成或进入等待输入。
- 会话异常。
- 远程 spawn 成功/失败。
- Supervisor 巡检异常。

### 5.8 PWA Shell

职责：

- 提供 `manifest.webmanifest`。
- 提供 service worker。
- 缓存 app shell。
- 离线展示最近会话和消息。
- 联网后同步离线操作。

第一阶段只实现安装和基础缓存；离线消息队列后置。

### 5.9 VoiceBridgeService

职责：

- 将语音输入转成消息。
- 将审批意图映射到 `approve/deny`。
- 将任务完成、异常和待审批状态转成可播报摘要。

建议分两步：

1. 浏览器 Web Speech API：低成本、无服务端依赖。
2. ElevenLabs 或其他 WebRTC 语音服务：更接近 HAPI 体验。

### 5.10 AgentAdapter

职责：

- 抽象不同 Agent 的启动、发送、停止、状态观察。
- 保留 `TmuxCodexAdapter` 作为第一实现。
- 为未来 Native Codex、Claude、Gemini、OpenCode 留扩展点。

接口草案：

```ts
type AgentAdapter = {
  agentType: string;
  createSession(input: CreateAgentSessionInput): Promise<AgentSessionHandle>;
  sendMessage(handle: AgentSessionHandle, message: string): Promise<void>;
  captureOutput(handle: AgentSessionHandle, lines: number): Promise<string>;
  stopSession(handle: AgentSessionHandle): Promise<void>;
  inspect(handle: AgentSessionHandle): Promise<AgentInspection>;
};
```

## 6. 数据模型草案

### 6.1 `machines`

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `name` | 机器名 |
| `namespace` | 命名空间 |
| `host` | 主机名或展示地址 |
| `status` | `online` / `offline` / `unknown` |
| `labels_json` | 标签 |
| `capabilities_json` | 支持的 agent、终端、文件、spawn 能力 |
| `runner_version` | runner 版本 |
| `last_seen_at` | 最近心跳 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

### 6.2 `session_messages`

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `session_id` | 会话 ID |
| `role` | `user` / `assistant` / `system` / `tool` / `approval` |
| `content` | 消息正文 |
| `content_type` | `text` / `json` / `markdown` |
| `source` | `web` / `cli` / `feishu` / `supervisor` / `voice` |
| `actor_id` | 发起者 |
| `metadata_json` | 扩展信息 |
| `created_at` | 创建时间 |

### 6.3 `session_events`

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `session_id` | 可空 |
| `event_type` | 事件类型 |
| `payload_json` | 事件内容 |
| `actor_id` | 可空 |
| `created_at` | 创建时间 |

### 6.4 `approval_requests`

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `session_id` | 可空 |
| `request_type` | `terminal_command` / `file_write` / `session_stop` / `spawn` |
| `title` | 展示标题 |
| `description` | 展示说明 |
| `risk_level` | `low` / `medium` / `high` |
| `payload_json` | 待执行动作 |
| `status` | `pending` / `approved` / `denied` / `expired` / `cancelled` |
| `requested_by` | 请求来源 |
| `resolved_by` | 处理者 |
| `expires_at` | 过期时间 |
| `created_at` | 创建时间 |
| `resolved_at` | 处理时间 |

### 6.5 `terminal_commands`

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `session_id` | 会话 ID |
| `command` | 命令 |
| `cwd` | 执行目录 |
| `status` | `queued` / `running` / `succeeded` / `failed` / `cancelled` |
| `exit_code` | 退出码 |
| `stdout_tail` | 输出摘要 |
| `stderr_tail` | 错误摘要 |
| `created_by` | 发起者 |
| `started_at` | 开始时间 |
| `completed_at` | 完成时间 |
| `created_at` | 创建时间 |

### 6.6 `push_subscriptions`

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `actor_id` | 用户 |
| `channel` | `web_push` / `feishu` / `telegram` |
| `endpoint` | 推送地址或渠道标识 |
| `subscription_json` | 浏览器 push 订阅 |
| `enabled` | 是否启用 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

### 6.7 `voice_sessions`

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `session_id` | 关联会话 |
| `provider` | `web_speech` / `elevenlabs` / `other` |
| `status` | `starting` / `active` / `ended` / `error` |
| `metadata_json` | 语音服务状态 |
| `started_at` | 开始时间 |
| `ended_at` | 结束时间 |

## 7. HTTP / SSE API 草案

### 7.1 实时事件

- `GET /events`
  - 返回 `text/event-stream`
  - 支持 `Last-Event-ID`
  - 推送 session、message、approval、machine、terminal、supervisor 事件

### 7.2 会话与消息

- `GET /sessions`
- `POST /sessions`
- `GET /sessions/:name`
- `POST /sessions/:name/messages`
- `GET /sessions/:name/messages?cursor=&limit=`
- `POST /sessions/:name/use`
- `POST /sessions/:name/stop`

### 7.3 审批

- `GET /approvals?status=pending`
- `POST /approvals`
- `POST /approvals/:id/approve`
- `POST /approvals/:id/deny`
- `POST /approvals/:id/cancel`

### 7.4 文件与 Git

- `GET /sessions/:name/files?path=`
- `GET /sessions/:name/file?path=`
- `GET /sessions/:name/git/status`
- `GET /sessions/:name/git/diff?path=`
- `GET /sessions/:name/search?q=`

### 7.5 终端

- `POST /sessions/:name/terminal/commands`
- `GET /terminal/commands/:id`
- `GET /terminal/commands/:id/events`
- `POST /terminal/commands/:id/cancel`

### 7.6 机器与远程启动

- `GET /machines`
- `POST /machines/register`
- `POST /machines/:id/heartbeat`
- `POST /machines/:id/spawn`

### 7.7 通知与 PWA

- `GET /manifest.webmanifest`
- `GET /service-worker.js`
- `POST /notifications/subscribe`
- `POST /notifications/test`

### 7.8 语音

- `POST /voice/sessions`
- `POST /voice/sessions/:id/message`
- `POST /voice/sessions/:id/approval`
- `POST /voice/sessions/:id/end`

## 8. 命令草案

现有命令继续可用。新增命令建议：

```text
/messages [name]
/approvals
/approve <id>
/deny <id>
/files [name] [path]
/cat <name> <path>
/git <name> status
/diff <name> [path]
/terminal <name> <command>
/machines
/spawn <machine> <name> <workspace_path> [agent_type]
/notify test
/voice status
```

命令仍是移动端兜底入口，Web/PWA 应优先使用结构化 API。

## 9. 前端信息架构

目标 Web/PWA 页面分区：

- **Chat**：消息流、prompt 输入、语音入口。
- **Sessions**：会话列表、状态、当前目标、历史会话。
- **Files**：文件树、文件内容、git diff。
- **Terminal**：受控 shell、命令历史、输出流。
- **Approvals**：待审批、已处理、风险说明。
- **Machines**：本机/远程 runner、spawn 新会话。
- **Settings**：API Token、Actor、通知、PWA、语音、渠道绑定。

移动端优先级：

1. Chat
2. Approvals
3. Sessions
4. Files
5. Terminal
6. Machines
7. Settings

## 10. 分阶段实施计划

### Phase 0：安全基线与文档对齐

目标：

- 明确能力同步边界。
- 不复制 HAPI 源码。
- 保持现有项目可运行。

交付：

- 本文档。
- 更新架构、路线图、命令文档、README。

### Phase 1：事件流与消息持久化

目标：

- 从轮询式控制台升级到实时控制面。

交付：

- `SessionEventBus`
- `ConversationService`
- `session_messages`
- `session_events`
- `GET /events`
- 前端 SSE 自动刷新

验收：

- `/send` 后 Web 能自动看到消息状态。
- Supervisor 快照能实时推到 Web。
- 刷新页面后能看到历史消息。

### Phase 2：文件 / Git 面板

目标：

- 远程查看工作区变化。

交付：

- `WorkspaceService`
- 文件树 API
- 文件预览 API
- Git status/diff API
- Web `Files` / `Changes` 面板

验收：

- 手机能查看某会话 workspace 文件。
- 手机能看到当前 git 修改摘要和 diff。
- 不能越界读取 workspace 外路径。

### Phase 3：审批中心与通知

目标：

- 离开电脑也能处理阻塞点。

交付：

- `ApprovalService`
- `approval_requests`
- `/approve` `/deny`
- Web 审批页
- 飞书审批提醒
- 浏览器通知基础能力

验收：

- 高风险动作进入待审批。
- Web 和飞书都能批准/拒绝。
- 审批结果进入事件流和消息历史。

### Phase 4：受控终端

目标：

- 在手机或浏览器执行受限命令。

交付：

- `TerminalService`
- `terminal_commands`
- 命令输出事件
- Terminal 面板
- 命令超时、输出截断、审批策略

验收：

- 能在 session workspace 中执行安全命令。
- 危险命令必须先审批。
- 输出能流式显示并持久化摘要。

### Phase 5：机器模型与远程 Spawn

目标：

- 将单机桥接器升级为多机器控制面。

交付：

- `MachineService`
- `machines`
- 本机自动注册为 `local`
- runner 注册协议
- `/spawn`
- Machines 面板

验收：

- Web 能看到当前机器。
- 能在指定机器上创建会话。
- 机器离线后不能 spawn。

### Phase 6：PWA 与离线体验

目标：

- 手机可安装，弱网下仍可观察最近状态。

交付：

- `manifest.webmanifest`
- `service-worker.js`
- app shell cache
- 离线状态提示
- 最近会话/消息缓存

验收：

- iOS Safari 和 Android Chrome 可添加到桌面。
- 断网时能看到最近加载过的会话和消息。
- 恢复网络后自动刷新。

### Phase 7：语音助手

目标：

- 支持语音发 prompt、语音审批、任务播报。

交付：

- 浏览器 Web Speech API 入口。
- `VoiceBridgeService`
- 语音意图到消息/审批映射。
- 可选 ElevenLabs 配置。

验收：

- 能用语音发送 prompt。
- 能用“同意/拒绝”处理 pending approval。
- 会话完成或异常时能生成短播报。

### Phase 8：AgentAdapter 与多 Agent

目标：

- 从 Codex-only 过渡到多 Agent。

交付：

- `AgentAdapter` 接口。
- `TmuxCodexAdapter`
- 配置 `agent_type`
- 预留 Claude/Gemini/OpenCode/Cursor 适配。

验收：

- 当前 Codex 功能不回退。
- 新会话可以记录 agent type。
- 后续添加新 agent 不影响 `SessionService` 主流程。

### Phase 9：高级扩展

可选：

- Telegram Mini App。
- MCP bridge。
- 多 namespace 权限隔离。
- Web 独立部署与 CORS。
- Relay / Cloudflare Tunnel / Tailscale 自动配置向导。

## 11. 风险与约束

### 11.1 许可证

- 只做能力参考，不复制 HAPI 代码。
- 如后续需要复用代码，必须先确认许可证和项目发布策略。

### 11.2 安全

- 终端、文件写入、远程 spawn 必须默认保守。
- 远程暴露 HTTP 时必须配置 token、HTTPS 或 VPN。
- PWA Push、语音、第三方服务要单独说明数据流。

### 11.3 架构复杂度

- 第一阶段只用 SSE，不提前引入双向 socket。
- 只有 runner 需要双向长连接时再升级协议。
- 不为了追齐 HAPI 而放弃现有 `tmux` 稳定性。

### 11.4 状态准确性

- `tmux capture-pane` 只能推断状态，不是 Agent 原生事件。
- 审批和无缝接续要想做到很细，需要未来接入 Agent 原生协议或 wrapper。

## 12. 最近行动清单

建议马上做：

1. 新增 `SessionEventBus`。
2. 新增 `ConversationService` 和消息表。
3. 增加 `/events` SSE。
4. 前端从手动刷新改成事件驱动刷新。
5. 新增 `WorkspaceService` 只读文件树和 git status。
6. 新增 `ApprovalService` 最小闭环。

这 6 项完成后，项目会从“可远程发命令”升级为“HAPI 风格控制面”的第一版。
