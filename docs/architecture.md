# Architecture

## 1. 项目定位

`agentBridge` 是一个单机自托管桥接层，用于把外部消息命令转换成对本机多个 `Codex CLI` 会话的管理操作。

它不是完整远控桌面，也不是大型 Agent 平台。它的边界非常明确：

- 输入端：外部消息或远程入口
- 控制端：桥接服务
- 执行端：本机 `tmux + Codex CLI`
- 存储端：本地 `SQLite`

## 2. 总体架构

```text
Chat App / Bot / Remote Client
  ↓ event / message
Channel Adapter
  ↓ normalized command
Command Router
  ↓
Application Services
  ├─ Session Service
  ├─ Conversation Service
  ├─ Approval Service
  └─ Auth Service
  ↓
Infrastructure Layer
  ├─ Tmux Manager
  ├─ Codex Adapter
  ├─ SQLite Repositories
  └─ Output Capture
  ↓
tmux windows → Codex CLI processes
```

## 3. 核心模块

### 3.1 Channel Adapter

职责：

- 接收外部消息事件
- 校验渠道签名和用户身份
- 把外部消息解析为统一命令格式
- 发送文本消息和交互卡片

建议先支持：

- 第一接入渠道先选一个最顺手的，例如飞书
- 采用私聊机器人或指定群聊中的命令消息

### 3.2 Command Router

职责：

- 识别 `/new`、`/list`、`/send` 等命令
- 参数解析
- 统一错误处理
- 将命令分发给对应服务

建议命令采用纯文本格式，第一版不要做自然语言意图识别。

### 3.3 Session Service

职责：

- 创建会话
- 列出会话
- 切换默认会话
- 停止会话
- 维护会话元数据

核心思想：

- 一个业务会话对应一个 `tmux window`
- 一个 `tmux window` 对应一个工作目录中的一条 `Codex` 交互会话

### 3.4 Tmux Manager

职责：

- 创建总 `tmux session`
- 创建新窗口
- 发送输入
- 抓取输出
- 检查窗口是否存活

建议固定一个总会话名，例如：`codex-hub`

### 3.5 Codex Adapter

职责：

- 启动 `codex`
- 向对应窗口发送文本 prompt
- 识别常见运行状态
- 为将来接入 `codex resume`、`codex exec` 预留扩展点

第一版不强依赖 `Codex` 内部 API，只通过 `tmux` 驱动和抓屏。

### 3.6 Output Capture

职责：

- 从 `tmux capture-pane` 获取最近输出
- 做尾部截断
- 清理 ANSI 控制字符
- 输出摘要或原文片段

### 3.7 Auth & Approval

职责：

- 只允许指定 `open_id` / 群聊使用
- 限制工作目录白名单
- 对高风险命令执行二次确认

高风险示例：

- 删除文件
- Git 强制重置
- 停服务
- 远程服务器操作

## 4. 会话模型

建议定义 `codex_session` 表：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `name` | 会话名，唯一 |
| `workspace_path` | 工作目录 |
| `tmux_session_name` | 总会话名，通常固定 |
| `tmux_window_name` | 窗口名 |
| `status` | `starting` / `idle` / `busy` / `stopped` / `error` |
| `owner_open_id` | 创建者 |
| `default_for_owner` | 是否为当前用户默认会话 |
| `last_output_digest` | 最近输出摘要 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |
| `last_active_at` | 最近活跃时间 |

## 5. 关键流程

### 5.1 新建会话

```text
/new example-project /path/to/your/projects/example-project
  ↓
校验目录是否合法
  ↓
Session Service 创建数据库记录
  ↓
Tmux Manager 创建 window
  ↓
在目录中启动 codex
  ↓
更新状态为 idle
  ↓
渠道返回创建成功
```

### 5.2 发送 prompt

```text
/send example-project 请检查这个项目当前的部署状态
  ↓
查找会话
  ↓
判断会话是否 busy
  ↓
Tmux send-keys 写入 prompt
  ↓
等待片刻并抓取输出
  ↓
渠道返回最近输出片段
```

### 5.3 查看最近输出

```text
/tail example-project
  ↓
Tmux capture-pane
  ↓
清洗输出
  ↓
渠道回发最近 N 行
```

### 5.4 停止会话

```text
/stop example-project
  ↓
二次确认
  ↓
关闭 tmux window
  ↓
更新数据库状态
  ↓
返回停止结果
```

## 6. 多会话管理策略

### 6.1 为什么 `tmux` 最合适

- 会话可持久化
- 手机断线不影响任务
- 便于抓取终端输出
- 不依赖修改 `Codex CLI`
- 便于人工 SSH 兜底

### 6.2 推荐会话组织方式

```text
tmux session: codex-hub
  ├─ scenario2
  ├─ example-project
  ├─ docs
  ├─ bugfix-api
  └─ ui-polish
```

### 6.3 同仓库并行处理策略

如果同一仓库要跑多个 `Codex`：

- 优先使用 `git worktree`
- 每个工作树创建独立会话
- 不要让两个会话同时改同一份工作目录

## 7. 状态机建议

```text
starting → idle → busy → idle
                  ↓
                 error
                  ↓
                stopped
```

状态切换规则：

- 新建后先进入 `starting`
- 启动成功变成 `idle`
- 发送任务后变成 `busy`
- 输出稳定后回到 `idle`
- 异常退出进入 `error`
- 主动关闭进入 `stopped`

## 8. 安全边界

第一版必须做的安全约束：

- 只接受指定渠道用户或群
- 限定可操作目录前缀
- 不直接暴露 shell 命令执行接口
- 高风险动作必须二次确认
- 日志脱敏，避免回传 token 和密码

## 9. 为什么第一版不要做流式转发

流式输出当然更爽，但会明显增加复杂度：

- 需要处理消息平台的频率限制
- 需要维护长连接和分片输出
- 需要更细的状态同步

所以第一版建议只做：

- 发送任务
- 拉取最近输出
- 简单状态展示

等基础稳定后再加自动推送和摘要。

## 10. HAPI 能力对齐后的演进方向

当前架构已经具备“本地多会话桥接器”所需的核心骨架，但如果要对齐 `HAPI` 风格能力，需要把现在的“命令式桥接层”升级为“实时控制面”。

演进后的总体结构建议为：

```text
Phone / Browser / PWA / Feishu / Future Telegram / Voice
          ↓
HTTP API + SSE Events + Channel Adapters
          ↓
Command Router / Action Router
          ↓
Application Services
  ├─ Session Service
  ├─ Conversation Service
  ├─ Approval Service
  ├─ Workspace Service
  ├─ Terminal Service
  ├─ Machine Service
  ├─ Notification Service
  ├─ Voice Bridge Service
  └─ Supervisor Service
          ↓
SQLite + Event Bus + Repositories
          ↓
Agent Adapters
  ├─ Tmux Codex Adapter
  ├─ Native Codex Adapter      (future)
  ├─ Claude Adapter            (future)
  ├─ Gemini Adapter            (future)
  └─ OpenCode Adapter          (future)
          ↓
tmux windows / runner processes / local or remote machines
```

### 10.1 新增模块建议

#### Conversation Service

职责：

- 持久化聊天消息、桥接器输出、系统事件。
- 给 Web、飞书、未来语音入口提供统一会话上下文。
- 支持刷新页面后继续查看历史消息。

#### Approval Service

职责：

- 把高风险动作从“立即执行”改成“待审批”。
- 支持 Web、飞书、未来 Telegram 的批准和拒绝。
- 为 AFK 审批、危险操作确认提供统一入口。

#### Workspace Service

职责：

- 浏览 session 对应 workspace 的文件树。
- 安全读取文件内容。
- 通过进程内 Git 对象/索引读取提供 `git status` 与 `git diff`，不执行仓库配置的 filter、external diff 或 hook。
- 拒绝指向工作区外部的 `.git` 元数据，避免工作区浏览越界。
- 内容预览不复现原生 Git 的 rename detection 或 mode-only 变化；这类检查转入受审批的终端命令。

#### Terminal Service

职责：

- 提供受限 shell 能力。
- 记录命令、输出、退出码和审批状态。
- 把输出增量发往实时事件流。

#### Machine Service

职责：

- 将当前服务机器抽象为 `machine`。
- 未来接入 runner 心跳、远程 spawn 和多机管理。

#### Notification Service

职责：

- 将审批、异常、完成事件转为浏览器通知、飞书通知和未来 Push。

#### Voice Bridge Service

职责：

- 语音输入转文字。
- 文字意图转普通消息或审批动作。
- 将重要事件转成可播报摘要。

### 10.2 为什么先上 SSE

如果要对齐移动端体验，第一步不是马上重写 Agent 内核，而是补齐“实时状态同步”。

先做 `SSE` 的原因：

- 比 WebSocket 更轻，便于快速挂到当前 HTTP 服务上。
- 足够承载消息、tail、审批、巡检快照这类单向事件。
- 与现在的轮询式 Web UI 最兼容。

建议优先推送的事件：

- `message.created`
- `session.updated`
- `session.tail.updated`
- `approval.requested`
- `approval.resolved`
- `machine.online`
- `machine.offline`
- `supervisor.snapshot`

### 10.3 为什么保留 tmux

即使目标对齐 HAPI，也不建议第一阶段移除 `tmux`：

- 当前项目的最大优势就是稳定托管本机会话。
- `tmux` 仍然是最轻的会话持久化与人工兜底手段。
- 真正要实现更细的状态和审批，需要的是在 `tmux` 之上加 `AgentAdapter`，而不是直接推翻现有实现。

### 10.4 数据模型扩展建议

在现有 `codex_sessions` 之外，建议逐步增加：

- `session_messages`
- `session_events`
- `approval_requests`
- `terminal_commands`
- `machines`
- `push_subscriptions`
- `voice_sessions`

这些表的详细设计见：`docs/hapi-capability-sync.md`

### 10.5 当前与目标的边界

当前系统更像：

- 多会话桥接器
- 命令执行入口
- 轻量远程聊天控制台

目标系统更像：

- 本地优先的 Agent 控制面
- 可远程审批、查看文件、执行受控终端的工作台
- 面向多机器、多入口、多 Agent 的统一 Hub
