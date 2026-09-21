import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from 'pino';

import type { AgentType } from '../domain/agent.js';
import type { MachineRecord } from '../domain/machine.js';
import { CommandExecutionError, DependencyError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { SshMachineConnection, SshMachineProbe, SshTaskRecord } from '../domain/ssh-machine.js';
import { runCommand, type CommandResult } from '../infra/process/command-runner.js';
import type { DatabaseClient } from '../infra/storage/database.js';
import { hostKeyCheckingOption, shellQuote, type SshHostKeyPolicy } from '../utils/runtime-command.js';
import type { MachineService } from './machine-service.js';

type SshMachineServiceOptions = {
  claudeHome?: string;
  claudeBin?: string;
  codexHome?: string;
  codexBin?: string;
  database: DatabaseClient;
  hostKeyPolicy: SshHostKeyPolicy;
  logger: Logger;
  machines: Pick<MachineService, 'listMachines' | 'registerMachine'>;
  commandRunner?: typeof runCommand;
};

type RemotePane = {
  agentType: AgentType | null;
  command: string;
  controlMode: 'tmux' | 'process';
  dead: boolean;
  externalSessionId: string;
  output: string;
  observedStatus: 'idle' | 'running' | 'stopped';
  paneId: string;
  parentPid: number | null;
  processCommand: string;
  requiredInput: string;
  sessionName: string;
  suggestedReply: string;
  shellPid: number | null;
  title: string;
  workSummary: string;
  windowIndex: number;
  windowName: string;
  workspacePath: string;
};

const SSH_TASK_STATUSES = new Set(['running', 'idle', 'stopped', 'missing']);
const MAX_PROMPT_CHARACTERS = 12_000;
const MAX_REMOTE_OUTPUT_CHARACTERS = 24_000;
const MAX_PROCESS_OUTPUT_CHARACTERS = 2_000_000;

export class SshMachineService {
  private readonly execute: typeof runCommand;
  private readonly claudeHome: string;
  private readonly claudeBin: string;
  private readonly codexHome: string;
  private readonly codexBin: string;
  private localDiscoveryTimer: NodeJS.Timeout | null = null;
  private localDiscoveryRunning = false;

  constructor(private readonly options: SshMachineServiceOptions) {
    this.execute = options.commandRunner ?? runCommand;
    this.claudeHome = options.claudeHome ?? path.join(os.homedir(), '.claude');
    this.codexHome = options.codexHome ?? path.join(os.homedir(), '.codex');
    this.claudeBin = options.claudeBin ?? 'claude';
    this.codexBin = options.codexBin ?? 'codex';
    this.options.database.exec(`
      CREATE TABLE IF NOT EXISTS ssh_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        window_index INTEGER NOT NULL,
        window_name TEXT NOT NULL,
        title TEXT NOT NULL,
        custom_title TEXT,
        external_session_id TEXT NOT NULL DEFAULT '',
        agent_type TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL,
        last_output TEXT NOT NULL DEFAULT '',
        control_mode TEXT NOT NULL DEFAULT 'tmux',
        process_command TEXT NOT NULL DEFAULT '',
        work_summary TEXT NOT NULL DEFAULT '',
        required_input TEXT NOT NULL DEFAULT '',
        suggested_reply TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        UNIQUE(machine_id, pane_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ssh_tasks_machine_id
      ON ssh_tasks(machine_id, updated_at DESC);
    `);
    for (const statement of [
      'ALTER TABLE ssh_tasks ADD COLUMN control_mode TEXT NOT NULL DEFAULT \'tmux\';',
      'ALTER TABLE ssh_tasks ADD COLUMN process_command TEXT NOT NULL DEFAULT \'\';',
      'ALTER TABLE ssh_tasks ADD COLUMN work_summary TEXT NOT NULL DEFAULT \'\';',
      'ALTER TABLE ssh_tasks ADD COLUMN required_input TEXT NOT NULL DEFAULT \'\';',
      'ALTER TABLE ssh_tasks ADD COLUMN suggested_reply TEXT NOT NULL DEFAULT \'\';',
      'ALTER TABLE ssh_tasks ADD COLUMN custom_title TEXT;',
      'ALTER TABLE ssh_tasks ADD COLUMN external_session_id TEXT NOT NULL DEFAULT \'\';',
    ]) {
      try {
        this.options.database.exec(statement);
      } catch {
        // Both columns already exist after the first migration.
      }
    }
  }

  async addMachine(input: {
    host: string;
    name: string;
    port?: number;
    privateKeyPath?: string;
    user?: string;
  }): Promise<{ machine: MachineRecord; probe: SshMachineProbe }> {
    const name = requireMachineName(input.name);
    const connection = parseConnection(input);
    const probe = await this.probeConnection(connection);
    const machine = await this.options.machines.registerMachine({
      capabilities: {
        connection: 'ssh',
        installedAgentTypes: probe.installedAgentTypes,
        os: probe.os,
        ssh: connection,
        tmuxVersion: probe.tmuxVersion,
      },
      host: connection.host,
      labels: ['ssh', probe.os.toLowerCase(), ...probe.installedAgentTypes],
      name,
      namespace: 'ssh',
      runnerVersion: 'ssh-probe-1',
      status: 'online',
    });
    return { machine, probe };
  }

  async probeMachine(id: number): Promise<SshMachineProbe> {
    const machine = await this.requireSshMachine(id);
    const connection = readConnection(machine);
    try {
      const probe = await this.probeConnection(connection);
      await this.saveMachineState(machine, probe, 'online');
      return probe;
    } catch (error) {
      await this.saveMachineState(
        machine,
        {
          host: connection.host,
          installedAgentTypes: readInstalledAgentTypes(machine),
          os: typeof machine.capabilities.os === 'string' ? machine.capabilities.os : 'unknown',
          tmuxVersion: typeof machine.capabilities.tmuxVersion === 'string' ? machine.capabilities.tmuxVersion : null,
        },
        'offline',
      );
      throw error;
    }
  }

  async discoverTasks(id: number): Promise<SshTaskRecord[]> {
    const machines = await this.options.machines.listMachines();
    const machine = machines.find((item) => item.id === id);
    if (!machine) throw new NotFoundError(`Machine "${id}" was not found`);
    if (machine.name === 'local') return this.discoverLocalTasks(machine);
    if (machine.capabilities.connection !== 'ssh' || typeof machine.capabilities.ssh !== 'object') {
      throw new ValidationError('This machine is not configured as an SSH machine.');
    }
    const connection = readConnection(machine);
    const probe = await this.probeConnection(connection);
    await this.saveMachineState(machine, probe, 'online');

    const tmuxPanes = probe.tmuxVersion ? await this.listRemotePanes(connection) : [];
    const processPanes = await this.listRemoteProcessPanes(connection, new Set(
      tmuxPanes.map((pane) => pane.shellPid).filter((pid): pid is number => typeof pid === 'number'),
    ));
    return this.persistDiscoveredPanes(machine, [...tmuxPanes, ...processPanes]);
  }

  private async discoverLocalTasks(machine: MachineRecord): Promise<SshTaskRecord[]> {
    const result = await this.runLocal(`
      if ! command -v tmux >/dev/null 2>&1; then exit 0; fi
      tmux list-panes -a -F '#{pane_id}\\t#{session_name}\\t#{window_index}\\t#{window_name}\\t#{pane_current_command}\\t#{pane_current_path}\\t#{pane_dead}\\t#{pane_pid}' 2>/dev/null || true
    `);
    const tmuxPanes = await this.attachPaneOutput(parsePanes(result.stdout), (paneId) => this.captureLocalPane(paneId));
    const processPanes = await this.listLocalProcessPanes(new Set(tmuxPanes.map((pane) => pane.shellPid).filter((pid): pid is number => typeof pid === 'number')));
    const codexPanes = this.listLocalCodexDesktopPanes();
    return this.persistDiscoveredPanes(machine, [...tmuxPanes, ...processPanes, ...codexPanes]);
  }

  private async persistDiscoveredPanes(machine: MachineRecord, panes: RemotePane[]): Promise<SshTaskRecord[]> {
    const seenPaneIds = new Set<string>();
    const now = new Date().toISOString();

    for (const pane of panes) {
      seenPaneIds.add(pane.paneId);
      if (!pane.agentType) {
        this.options.database.prepare(`
          UPDATE ssh_tasks
          SET status='idle', last_output=?, updated_at=?
          WHERE machine_id=? AND pane_id=?
        `).run(pane.output, now, machine.id, pane.paneId);
        continue;
      }
      const statement = this.options.database.prepare(`
        INSERT INTO ssh_tasks (
          machine_id, pane_id, session_name, window_index, window_name, title,
          agent_type, external_session_id, workspace_path, status, last_output, created_at, updated_at, last_active_at
          , control_mode, process_command
          , work_summary
          , required_input, suggested_reply
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(machine_id, pane_id) DO UPDATE SET
          session_name = excluded.session_name,
          window_index = excluded.window_index,
          window_name = excluded.window_name,
          title = excluded.title,
          agent_type = excluded.agent_type,
          external_session_id = excluded.external_session_id,
          workspace_path = excluded.workspace_path,
          status = excluded.status,
          last_output = excluded.last_output,
          control_mode = excluded.control_mode,
          process_command = excluded.process_command,
          work_summary = excluded.work_summary,
          required_input = excluded.required_input,
          suggested_reply = excluded.suggested_reply,
          updated_at = excluded.updated_at,
          last_active_at = excluded.last_active_at
      `);
      statement.run(
        machine.id,
        pane.paneId,
        pane.sessionName,
        pane.windowIndex,
        pane.windowName,
        pane.title,
        pane.agentType,
        pane.externalSessionId,
        pane.workspacePath,
        pane.observedStatus,
        pane.output,
        now,
        now,
        now,
        pane.controlMode,
        pane.processCommand,
        pane.workSummary,
        pane.requiredInput,
        pane.suggestedReply,
      );
    }

    await this.markMissingPanes(machine.id, seenPaneIds);
    return this.listTasks(machine.id);
  }

  async listTasks(machineId?: number): Promise<SshTaskRecord[]> {
    const rows = machineId
      ? this.options.database.prepare(`
          SELECT * FROM ssh_tasks
          WHERE machine_id=?
            AND NOT (control_mode='process' AND status='missing')
          ORDER BY updated_at DESC, id DESC
        `).all(machineId)
      : this.options.database.prepare(`
          SELECT * FROM ssh_tasks
          WHERE NOT (control_mode='process' AND status='missing')
          ORDER BY updated_at DESC, id DESC
        `).all();
    return rows.map((row) => mapTaskRow(row as Record<string, unknown>));
  }

  async renameTask(id: number, title: string): Promise<SshTaskRecord> {
    const value = title.trim().replace(/\s+/gu, ' ');
    if (!value || value.length > 160) {
      throw new ValidationError('任务名称不能为空，且最多 160 个字符。');
    }
    this.options.database.prepare(`
      UPDATE ssh_tasks
      SET custom_title=?, title=?, updated_at=?
      WHERE id=?
    `).run(value, value, new Date().toISOString(), id);
    return this.requireTask(id);
  }

  startLocalDiscovery(intervalMs = 15_000): void {
    if (this.localDiscoveryTimer) return;
    const run = async () => {
      if (this.localDiscoveryRunning) return;
      this.localDiscoveryRunning = true;
      try {
        const machine = (await this.options.machines.listMachines()).find((item) => item.name === 'local');
        if (machine) await this.discoverLocalTasks(machine);
      } catch (error) {
        this.options.logger.warn({ err: error }, 'local task discovery failed');
      } finally {
        this.localDiscoveryRunning = false;
      }
    };
    void run();
    this.localDiscoveryTimer = setInterval(() => void run(), intervalMs);
  }

  stopLocalDiscovery(): void {
    if (this.localDiscoveryTimer) clearInterval(this.localDiscoveryTimer);
    this.localDiscoveryTimer = null;
  }

  async connectionForMachine(id: number): Promise<{
    connection: SshMachineConnection;
    machine: MachineRecord;
  }> {
    const machine = await this.requireSshMachine(id);
    return { connection: readConnection(machine), machine };
  }

  async tailTask(id: number): Promise<SshTaskRecord> {
    const task = await this.requireTask(id);
    const machines = await this.options.machines.listMachines();
    const machine = machines.find((item) => item.id === task.machineId);
    if (!machine) throw new NotFoundError(`Machine "${task.machineId}" was not found`);
    if (task.controlMode === 'process') {
      await this.discoverTasks(machine.id);
      return this.requireTask(id);
    }
    const script = `
      if command -v tmux >/dev/null 2>&1; then
        tmux capture-pane -p -S -160 -t ${shellQuote(task.paneId)}
      fi
    `;
    const output = machine.name === 'local'
      ? await this.runLocal(script)
      : await this.runRemote(readConnection(machine), script);
    const clean = sanitizeRemoteOutput(output.stdout);
    this.options.database.prepare(`
      UPDATE ssh_tasks
      SET last_output=?, status=?, updated_at=?, last_active_at=?
      WHERE id=?
    `).run(clean, task.status === 'missing' ? 'running' : task.status, new Date().toISOString(), new Date().toISOString(), id);
    return this.requireTask(id);
  }

  async sendPrompt(id: number, prompt: string, actorId: string): Promise<SshTaskRecord> {
    const value = prompt.trim();
    if (!value || value.length > MAX_PROMPT_CHARACTERS) {
      throw new ValidationError('SSH 任务输入不能为空，且最多 12000 字。');
    }
    const task = await this.requireTask(id);
    if (task.status === 'missing' || task.status === 'stopped') {
      throw new DependencyError('该 tmux 面板已不存在，不能发送输入。');
    }
    const machines = await this.options.machines.listMachines();
    const machine = machines.find((item) => item.id === task.machineId);
    if (!machine) throw new NotFoundError(`Machine "${task.machineId}" was not found`);
    if (task.controlMode === 'process') {
      return this.sendExternalProcessPrompt(task, value, actorId, machine);
    }
    const script = `
      test "$(tmux display-message -p -t ${shellQuote(task.paneId)} '#{pane_id}')" = ${shellQuote(task.paneId)}
      tmux send-keys -t ${shellQuote(task.paneId)} -l -- ${shellQuote(value)}
      tmux send-keys -t ${shellQuote(task.paneId)} Enter
    `;
    if (machine.name === 'local') await this.runLocal(script);
    else await this.runRemote(readConnection(machine), script);
    const now = new Date().toISOString();
    this.options.database.prepare(`
      UPDATE ssh_tasks
      SET status='running', updated_at=?, last_active_at=?
      WHERE id=?
    `).run(now, now, id);
    this.options.logger.info({ actorId, machineId: machine.id, sshTaskId: id }, 'ssh task prompt sent');
    return this.tailTask(id);
  }

  private async sendExternalProcessPrompt(
    task: SshTaskRecord,
    prompt: string,
    actorId: string,
    machine: MachineRecord,
  ): Promise<SshTaskRecord> {
    if (!task.externalSessionId) {
      throw new DependencyError('没有找到该进程对应的 CLI 会话 ID，不能直接回复。');
    }
    const now = new Date().toISOString();
    this.options.database.prepare(`
      UPDATE ssh_tasks
      SET status='running', required_input='', suggested_reply='', updated_at=?, last_active_at=?
      WHERE id=?
    `).run(now, now, task.id);

    try {
      const result = machine.name === 'local'
        ? task.agentType === 'codex'
          ? await this.execute(this.codexBin, [
              'exec', 'resume', '--skip-git-repo-check', task.externalSessionId, prompt,
            ], {
              cwd: task.workspacePath,
              maxOutputCharacters: MAX_REMOTE_OUTPUT_CHARACTERS,
            })
          : task.agentType === 'claude-code'
            ? await this.execute(this.claudeBin, [
                '--resume', task.externalSessionId, '--print', prompt,
              ], {
                cwd: task.workspacePath,
                maxOutputCharacters: MAX_REMOTE_OUTPUT_CHARACTERS,
              })
            : null
        : task.agentType === 'codex' || task.agentType === 'claude-code'
          ? await this.runRemote(readConnection(machine), `
              cd ${shellQuote(task.workspacePath)} &&
              ${task.agentType === 'codex'
                ? `codex exec resume --skip-git-repo-check ${shellQuote(task.externalSessionId)} ${shellQuote(prompt)}`
                : `claude --resume ${shellQuote(task.externalSessionId)} --print ${shellQuote(prompt)}`}
            `)
          : null;
      if (!result) {
        throw new DependencyError(`暂不支持向 ${task.agentType} 进程会话直接回复。`);
      }
      this.options.logger.info({ actorId, machineId: machine.id, sshTaskId: task.id }, 'external process prompt sent');
      await this.discoverTasks(machine.id);
      return this.requireTask(task.id);
    } catch (error) {
      const detail = error instanceof CommandExecutionError
        ? [error.message, error.stderr, error.stdout]
          .filter(value => value && value.trim())
          .join('\n')
          .replace(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
          .trim()
        : error instanceof Error ? error.message : String(error);
      this.options.database.prepare(`
        UPDATE ssh_tasks
        SET status='idle', last_output=?, updated_at=?
        WHERE id=?
      `).run(`回复发送失败：${detail}\n\n${task.lastOutput}`, new Date().toISOString(), task.id);
      throw error instanceof CommandExecutionError
        ? new DependencyError(`回复发送失败：${detail}`)
        : error;
    }
  }

  private async probeConnection(connection: SshMachineConnection): Promise<SshMachineProbe> {
    const result = await this.runRemote(connection, `
      printf 'ASB_OS=%s\\n' "$(uname -s 2>/dev/null || printf unknown)"
      command -v claude >/dev/null 2>&1 && printf 'ASB_TOOL_claude=1\\n' || printf 'ASB_TOOL_claude=0\\n'
      command -v codex >/dev/null 2>&1 && printf 'ASB_TOOL_codex=1\\n' || printf 'ASB_TOOL_codex=0\\n'
      command -v gemini >/dev/null 2>&1 && printf 'ASB_TOOL_gemini=1\\n' || printf 'ASB_TOOL_gemini=0\\n'
      if command -v tmux >/dev/null 2>&1; then tmux -V; fi
    `);
    return { ...parseProbeOutput(result.stdout), host: connection.host };
  }

  private async listRemotePanes(connection: SshMachineConnection): Promise<RemotePane[]> {
    const result = await this.runRemote(connection, `
      if ! command -v tmux >/dev/null 2>&1; then exit 0; fi
      tmux list-panes -a -F '#{pane_id}\\t#{session_name}\\t#{window_index}\\t#{window_name}\\t#{pane_current_command}\\t#{pane_current_path}\\t#{pane_dead}\\t#{pane_pid}' 2>/dev/null || true
    `);
    return this.attachPaneOutput(parsePanes(result.stdout), (paneId) => this.capturePane(connection, paneId));
  }

  private async listRemoteProcessPanes(
    connection: SshMachineConnection,
    tmuxShellPids: Set<number>,
  ): Promise<RemotePane[]> {
    const ps = await this.runRemote(connection, 'ps -axo pid=,ppid=,etime=,command=');
    const processes = parseProcessOutput(ps.stdout);
    const descendants = collectDescendantPids(processes, tmuxShellPids);
    const candidates = processes.filter((process) =>
      !descendants.has(process.pid)
      && detectProcessAgent(process.command) !== null);
    if (!candidates.length) return [];

    const cwdResult = await this.runRemote(connection, `
      for pid in ${candidates.map((process) => process.pid).join(' ')}; do
        cwd=''
        if command -v lsof >/dev/null 2>&1; then
          cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
        fi
        if [ -z "$cwd" ] && [ -r "/proc/$pid/cwd" ]; then
          cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
        fi
        printf '%s\\t%s\\n' "$pid" "$cwd"
      done
    `);
    const cwdByPid = new Map(cwdResult.stdout.split('\n').filter(Boolean).map((line) => {
      const [pid, cwd] = line.split('\t');
      return [Number(pid), cwd || ''];
    }));

    const panes: RemotePane[] = [];
    for (const process of candidates) {
      const agentType = detectProcessAgent(process.command);
      if (!agentType) continue;
      const workspacePath = cwdByPid.get(process.pid) || '/tmp';
      const workspaceName = path.basename(workspacePath) || 'Remote';
      const pane: RemotePane = {
        agentType,
        command: path.basename(process.command.split(/\s+/u)[0] ?? ''),
        controlMode: 'process',
        dead: false,
        externalSessionId: '',
        observedStatus: 'running',
        output: `远程进程 PID ${process.pid} · 运行 ${process.elapsed}\n${sanitizeProcessCommand(process.command)}`,
        paneId: `process:${process.pid}`,
        parentPid: process.parentPid,
        processCommand: sanitizeProcessCommand(process.command),
        requiredInput: '',
        sessionName: 'process',
        suggestedReply: '',
        shellPid: null,
        title: `${namesForAgentType[agentType]} · ${workspaceName}`,
        workSummary: '',
        windowIndex: 0,
        windowName: workspaceName,
        workspacePath,
      };

      if (agentType === 'claude-code') {
        const sessionResult = await this.runRemote(connection, `
          session_file="$HOME/.claude/sessions/${process.pid}.json"
          if [ -r "$session_file" ]; then cat "$session_file"; fi
        `);
        const meta = parseJsonObject(sessionResult.stdout) as {
          cwd?: unknown; name?: unknown; sessionId?: unknown; status?: unknown;
        } | null;
        if (typeof meta?.sessionId === 'string' && isSafeSessionId(meta.sessionId)) {
          pane.externalSessionId = meta.sessionId;
          if (typeof meta.cwd === 'string' && meta.cwd) pane.workspacePath = meta.cwd;
          if (typeof meta.name === 'string' && meta.name) pane.sessionName = meta.name;
          pane.observedStatus = meta.status === 'busy' ? 'running' : 'idle';
          const transcriptResult = await this.runRemote(connection, `
            find "$HOME/.claude/projects" -name ${shellQuote(`${meta.sessionId}.jsonl`)} -print -quit 2>/dev/null || true
          `);
          const transcriptPath = transcriptResult.stdout.trim();
          if (transcriptPath) {
            const tail = await this.runRemote(connection, `tail -c 524288 ${shellQuote(transcriptPath)}`);
            const work = readClaudeWorkFromText(tail.stdout, transcriptPath);
            const title = deriveWorkTitle(work?.latestUser)
              || deriveWorkTitle(work?.latestAssistant)
              || pane.sessionName
              || workspaceName;
            pane.title = `Claude · ${title}`;
            pane.workSummary = [
              work?.latestUser ? `最近指令：${truncateWorkText(work.latestUser, 700)}` : null,
              work?.latestAssistant ? `最近输出：${truncateWorkText(work.latestAssistant, 1200)}` : null,
            ].filter(Boolean).join('\n');
            pane.output = [
              `远程 Claude 会话：${meta.sessionId}`,
              `状态：${meta.status ?? 'unknown'}`,
              `记录：${transcriptPath}`,
              '',
              pane.workSummary || '已关联远程 Claude 会话。',
            ].join('\n');
            if (pane.observedStatus === 'idle') applyRequiredInput(pane, work?.latestAssistant);
          }
        }
      }

      if (agentType === 'codex') {
        const opened = await this.runRemote(connection, `
          if command -v lsof >/dev/null 2>&1; then
            lsof -p ${process.pid} 2>/dev/null || true
          fi
        `);
        const sessionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu
          .exec(opened.stdout)?.[1]?.toLowerCase();
        if (sessionId) {
          pane.externalSessionId = sessionId;
          const transcriptPath = opened.stdout
            .split('\n')
            .find(line => line.includes(`${sessionId}.jsonl`))
            ?.match(/\S*\.jsonl/u)?.[0];
          if (transcriptPath) {
            const tail = await this.runRemote(connection, `tail -c 524288 ${shellQuote(transcriptPath)}`);
            const work = readCodexWorkFromText(tail.stdout);
            pane.observedStatus = work?.status === 'running' ? 'running' : 'idle';
            pane.title = `Codex · ${deriveWorkTitle(work?.latestUser) || deriveWorkTitle(work?.latestAssistant) || workspaceName}`;
            pane.workSummary = [
              work?.latestUser ? `最近指令：${truncateWorkText(work.latestUser, 700)}` : null,
              work?.latestAssistant ? `最近输出：${truncateWorkText(work.latestAssistant, 1200)}` : null,
            ].filter(Boolean).join('\n');
            pane.output = `远程 Codex 会话：${sessionId}\n记录：${transcriptPath}\n\n${pane.workSummary}`;
            if (pane.observedStatus === 'idle') applyRequiredInput(pane, work?.latestAssistant);
          }
        }
      }
      panes.push(pane);
    }
    return panes;
  }

  private async capturePane(connection: SshMachineConnection, paneId: string): Promise<string> {
    if (!/^%[0-9]+$/u.test(paneId)) return '';
    const result = await this.runRemote(connection, `
      tmux capture-pane -p -S -100 -t ${shellQuote(paneId)}
    `);
    return sanitizeRemoteOutput(result.stdout);
  }

  private async captureLocalPane(paneId: string): Promise<string> {
    if (!/^%[0-9]+$/u.test(paneId)) return '';
    const result = await this.runLocal(`tmux capture-pane -p -S -100 -t ${shellQuote(paneId)}`);
    return sanitizeRemoteOutput(result.stdout);
  }

  private async listLocalProcessPanes(tmuxShellPids: Set<number>): Promise<RemotePane[]> {
    const ps = await this.execute('/bin/sh', ['-lc', 'ps -axo pid=,ppid=,etime=,command='], {
      maxOutputCharacters: MAX_PROCESS_OUTPUT_CHARACTERS,
    });
    const processes = parseProcessOutput(ps.stdout);
    const descendants = collectDescendantPids(processes, tmuxShellPids);
    const candidates = processes.filter((process) =>
      !descendants.has(process.pid)
      && detectProcessAgent(process.command) !== null);
    if (!candidates.length) return [];

    const cwdResult = await this.runLocal(`
      for pid in ${candidates.map((process) => process.pid).join(' ')}; do
        cwd=''
        if command -v lsof >/dev/null 2>&1; then
          cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
        fi
        if [ -z "$cwd" ] && [ -r "/proc/$pid/cwd" ]; then
          cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
        fi
        printf '%s\\t%s\\n' "$pid" "$cwd"
      done
    `);
    const cwdByPid = new Map(cwdResult.stdout.split('\n').filter(Boolean).map((line) => {
      const [pid, cwd] = line.split('\t');
      return [Number(pid), cwd ?? os.homedir()];
    }));

    return candidates.map((process) => {
      const agentType = detectProcessAgent(process.command);
      if (!agentType) throw new Error('Unreachable agent type');
      const workspacePath = cwdByPid.get(process.pid) || os.homedir();
      const workspaceName = path.basename(workspacePath) || 'Home';
      const pane: RemotePane = {
        agentType,
        command: path.basename(process.command.split(/\s+/u)[0] ?? ''),
        controlMode: 'process',
        dead: false,
        externalSessionId: '',
        observedStatus: 'running',
        output: `进程 PID ${process.pid} · 运行 ${process.elapsed}\n${sanitizeProcessCommand(process.command)}`,
        paneId: `process:${process.pid}`,
        parentPid: process.parentPid,
        processCommand: sanitizeProcessCommand(process.command),
        requiredInput: '',
        sessionName: 'process',
        suggestedReply: '',
        shellPid: null,
        title: `${namesForAgentType[agentType]} · ${workspaceName}`,
        workSummary: '',
        windowIndex: 0,
        windowName: workspaceName,
        workspacePath,
      };
      if (agentType === 'claude-code') enrichProcessPaneWithClaudeWork(pane, this.claudeHome);
      return pane;
    });
  }

  private listLocalCodexDesktopPanes(): RemotePane[] {
    const locksRoot = path.join(this.codexHome, 'thread-writer-locks');
    if (!fs.existsSync(locksRoot)) return [];
    const titles = readCodexThreadTitles(path.join(this.codexHome, 'session_index.jsonl'));
    const transcriptByThread = indexCodexTranscripts(path.join(this.codexHome, 'sessions'));

    return fs.readdirSync(locksRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.lock') && entry.name !== '.coordination.lock')
      .map(entry => {
        const threadId = entry.name.replace(/\.lock$/u, '');
        const transcriptPath = transcriptByThread.get(threadId) ?? null;
        const meta = transcriptPath ? readCodexSessionMeta(transcriptPath) : null;
        const work = transcriptPath ? readCodexWork(transcriptPath) : null;
        const threadTitle = titles.get(threadId) ?? null;
        const workspacePath = meta?.cwd ?? os.homedir();
        const workspaceName = path.basename(workspacePath) || 'Home';
        const userTitle = deriveWorkTitle(work?.latestUser);
        const assistantTitle = deriveWorkTitle(work?.latestAssistant);
        const workTitle = userTitle && !isVagueWorkTitle(userTitle)
          ? userTitle
          : threadTitle && !isVagueWorkTitle(threadTitle)
            ? threadTitle
            : assistantTitle
              || userTitle
              || threadTitle
              || workspaceName;
        const status = work?.status === 'running' ? 'running' : 'idle';
        const workSummary = [
          work?.latestUser ? `最近指令：${truncateWorkText(work.latestUser, 700)}` : null,
          work?.latestAssistant ? `最近输出：${truncateWorkText(work.latestAssistant, 1200)}` : null,
        ].filter(Boolean).join('\n') || (threadTitle ? `Codex 线程：${threadTitle}` : '已发现 Codex Desktop 线程，暂未读取到文本记录。');
        const required = status === 'idle' ? extractRequiredInput(work?.latestAssistant) : null;

        return {
          agentType: 'codex' as const,
          command: 'Codex Desktop',
          controlMode: 'process' as const,
          dead: false,
          externalSessionId: threadId,
          observedStatus: status,
          output: [
            `Codex 线程：${threadId}`,
            `状态：${status === 'running' ? 'task_started' : '等待输入'}`,
            `来源：${meta?.originator ?? 'Codex Desktop'}`,
            transcriptPath ? `记录：${transcriptPath}` : '未找到本地 transcript',
            '',
            workSummary,
          ].join('\n'),
          paneId: `codex:${threadId}`,
          parentPid: null,
          processCommand: meta?.originator ? `${meta.originator} (Codex Desktop)` : 'Codex Desktop',
          requiredInput: required?.input ?? '',
          sessionName: threadTitle ?? workTitle,
          suggestedReply: required?.reply ?? '',
          shellPid: null,
          title: `Codex · ${workTitle}`,
          workSummary,
          windowIndex: 0,
          windowName: workspaceName,
          workspacePath,
        };
      });
  }

  private async attachPaneOutput(
    panes: RemotePane[],
    capture: (paneId: string) => Promise<string>,
  ): Promise<RemotePane[]> {
    for (const pane of panes) {
      pane.output = await capture(pane.paneId);
      pane.agentType = detectAgentType(pane);
      applyRequiredInput(pane, pane.output);
    }
    return panes;
  }

  private async runLocal(script: string): Promise<CommandResult> {
    return this.execute('/bin/sh', ['-lc', script], {
      maxOutputCharacters: MAX_REMOTE_OUTPUT_CHARACTERS,
    });
  }

  private async runRemote(
    connection: SshMachineConnection,
    script: string,
  ): Promise<CommandResult> {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', `StrictHostKeyChecking=${hostKeyCheckingOption(this.options.hostKeyPolicy)}`,
      '-p', String(connection.port),
    ];
    if (connection.privateKeyPath) args.push('-i', connection.privateKeyPath);
    const target = connection.user ? `${connection.user}@${connection.host}` : connection.host;
    args.push(target, '/bin/sh', '-lc', script);
    return this.execute('ssh', args, { maxOutputCharacters: MAX_REMOTE_OUTPUT_CHARACTERS });
  }

  private async saveMachineState(
    machine: MachineRecord,
    probe: SshMachineProbe,
    status: 'online' | 'offline',
  ): Promise<MachineRecord> {
    const connection = readConnection(machine);
    return this.options.machines.registerMachine({
      capabilities: {
        ...machine.capabilities,
        connection: 'ssh',
        installedAgentTypes: probe.installedAgentTypes,
        os: probe.os,
        ssh: connection,
        tmuxVersion: probe.tmuxVersion,
      },
      host: connection.host,
      labels: [...new Set(['ssh', probe.os.toLowerCase(), ...probe.installedAgentTypes])],
      name: machine.name,
      namespace: machine.namespace,
      runnerVersion: 'ssh-probe-1',
      status,
    });
  }

  private async markMissingPanes(machineId: number, seenPaneIds: Set<string>): Promise<void> {
    const rows = this.options.database.prepare(
      'SELECT id, pane_id FROM ssh_tasks WHERE machine_id=?',
    ).all(machineId) as Array<{ id: number; pane_id: string }>;
    for (const row of rows) {
      if (seenPaneIds.has(row.pane_id)) continue;
      this.options.database.prepare(`
        UPDATE ssh_tasks
        SET status='missing', updated_at=?
        WHERE id=?
      `).run(new Date().toISOString(), row.id);
    }
  }

  private async requireSshMachine(id: number): Promise<MachineRecord> {
    const machines = await this.options.machines.listMachines();
    const machine = machines.find((item) => item.id === id);
    if (!machine) throw new NotFoundError(`Machine "${id}" was not found`);
    if (machine.capabilities.connection !== 'ssh' || typeof machine.capabilities.ssh !== 'object') {
      throw new ValidationError('This machine is not configured as an SSH machine.');
    }
    return machine;
  }

  private async requireTask(id: number): Promise<SshTaskRecord> {
    const row = this.options.database.prepare('SELECT * FROM ssh_tasks WHERE id=?').get(id);
    if (!row) throw new NotFoundError(`SSH task "${id}" was not found`);
    return mapTaskRow(row as Record<string, unknown>);
  }
}

function parseConnection(input: { host: string; port?: number; user?: string; privateKeyPath?: string }): SshMachineConnection {
  const host = input.host.trim();
  if (!host || /[\s@:]/u.test(host)) throw new ValidationError('SSH Host 必须是不含空格的主机名、IP 或 SSH alias。');
  const port = input.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError('SSH 端口必须在 1–65535。');
  const user = input.user?.trim() || null;
  if (user && !/^[A-Za-z0-9._-]+$/u.test(user)) throw new ValidationError('SSH 用户名只能包含字母、数字、点、下划线和横线。');
  const privateKeyPath = input.privateKeyPath?.trim() || null;
  let resolvedPrivateKeyPath: string | null = null;
  if (privateKeyPath) {
    const expanded = privateKeyPath === '~'
      ? os.homedir()
      : privateKeyPath.startsWith(`~/`)
        ? path.join(os.homedir(), privateKeyPath.slice(2))
        : privateKeyPath;
    resolvedPrivateKeyPath = path.resolve(expanded);
    if (!fs.existsSync(resolvedPrivateKeyPath) || !fs.statSync(resolvedPrivateKeyPath).isFile()) {
      throw new ValidationError(`SSH 私钥文件不存在：${resolvedPrivateKeyPath}`);
    }
  }
  return { host, port, user, privateKeyPath: resolvedPrivateKeyPath };
}

function readConnection(machine: MachineRecord): SshMachineConnection {
  const value = machine.capabilities.ssh;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('SSH 连接配置不完整。');
  }
  const host = typeof value.host === 'string' ? value.host.trim() : '';
  if (!host) throw new ValidationError('SSH 连接配置缺少 host。');
  return {
    host,
    port: typeof value.port === 'number' ? value.port : 22,
    user: typeof value.user === 'string' && value.user ? value.user : null,
    privateKeyPath: typeof value.privateKeyPath === 'string' && value.privateKeyPath ? value.privateKeyPath : null,
  };
}

function readInstalledAgentTypes(machine: MachineRecord): AgentType[] {
  const value = machine.capabilities.installedAgentTypes;
  return Array.isArray(value) ? value.filter((entry): entry is AgentType =>
    entry === 'codex' || entry === 'claude-code' || entry === 'gemini') : [];
}

function requireMachineName(value: string): string {
  const name = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name || name === 'local') throw new ValidationError('机器名称不能为空，也不能使用 local。');
  return name.slice(0, 48);
}

function parseProbeOutput(value: string): SshMachineProbe {
  const installedAgentTypes: AgentType[] = [];
  if (value.includes('ASB_TOOL_claude=1')) installedAgentTypes.push('claude-code');
  if (value.includes('ASB_TOOL_codex=1')) installedAgentTypes.push('codex');
  if (value.includes('ASB_TOOL_gemini=1')) installedAgentTypes.push('gemini');
  const os = /^ASB_OS=(.*)$/mu.exec(value)?.[1]?.trim() || 'unknown';
  const tmuxVersion = /^tmux\s+([0-9][^\n]*)$/mu.exec(value)?.[1]?.trim() ?? null;
  return { host: '', installedAgentTypes, os, tmuxVersion };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isSafeSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function detectAgentType(pane: RemotePane): AgentType | null {
  const haystack = `${pane.sessionName}\n${pane.windowName}\n${pane.command}\n${pane.output}`.toLowerCase();
  if (haystack.includes('claude')) return 'claude-code';
  if (haystack.includes('codex')) return 'codex';
  if (haystack.includes('gemini')) return 'gemini';
  return null;
}

function parsePanes(value: string): RemotePane[] {
  return value.split('\n').filter(Boolean).map((line) => {
    const [paneId, sessionName, windowIndex, windowName, command, workspacePath, dead, shellPid] = line.split('\t');
    return {
      agentType: null,
      command: command ?? '',
      controlMode: 'tmux' as const,
      dead: dead === '1',
      externalSessionId: '',
      observedStatus: dead === '1' ? 'stopped' as const : 'running' as const,
      output: '',
      paneId: paneId ?? '',
      parentPid: null,
      processCommand: '',
      requiredInput: '',
      sessionName: sessionName ?? '',
      suggestedReply: '',
        shellPid: Number.parseInt(shellPid ?? '', 10) || null,
        title: buildTitle(sessionName ?? '', windowName ?? '', windowIndex ?? '0'),
        workSummary: '',
      windowIndex: Number.parseInt(windowIndex ?? '0', 10) || 0,
      windowName: windowName ?? '',
      workspacePath: workspacePath ?? '',
    };
  }).filter((pane) => /^%[0-9]+$/u.test(pane.paneId));
}

type LocalProcess = {
  command: string;
  elapsed: string;
  parentPid: number;
  pid: number;
};

type ClaudeProcessWork = {
  latestAssistant: string | null;
  latestUser: string | null;
  name: string | null;
  sessionId: string;
  status: string;
  transcriptPath: string | null;
};

type CodexProcessWork = {
  latestAssistant: string | null;
  latestUser: string | null;
  status: 'idle' | 'running' | null;
};

type RequiredInput = {
  input: string;
  reply: string;
};

const namesForAgentType = {
  'claude-code': 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
} as const;

function parseProcessOutput(value: string): LocalProcess[] {
  return value.split('\n').filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/u);
    const pid = Number.parseInt(fields[0] ?? '', 10);
    const parentPid = Number.parseInt(fields[1] ?? '', 10);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) return null;
    return {
      command: fields.slice(3).join(' '),
      elapsed: fields[2] ?? '',
      parentPid,
      pid,
    };
  }).filter((process): process is LocalProcess => Boolean(process));
}

function collectDescendantPids(processes: LocalProcess[], roots: Set<number>): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.parentPid) ?? [];
    children.push(process.pid);
    childrenByParent.set(process.parentPid, children);
  }
  const descendants = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift();
    if (pid === undefined || descendants.has(pid)) continue;
    descendants.add(pid);
    queue.push(...childrenByParent.get(pid) ?? []);
  }
  return descendants;
}

function detectProcessAgent(command: string): AgentType | null {
  const normalized = command.toLowerCase();
  if (
    /^\/(?:bin|usr\/bin)\/(?:sh|zsh|bash)(?:\s|$)/u.test(normalized)
    || normalized.includes('snapshot_file=')
    || normalized.includes('/applications/chatgpt.app/')
    || normalized.includes('codex (renderer)')
    || normalized.includes('chatgpt for chrome')
    || normalized.includes('app-server')
  ) return null;
  if (/(^|\s|\/)claude(\s|$)/u.test(normalized)) return 'claude-code';
  if (/(^|\s|\/)codex(\s|$)/u.test(normalized)) return 'codex';
  if (/(^|\s|\/)gemini(\s|$)/u.test(normalized)) return 'gemini';
  return null;
}

function sanitizeProcessCommand(command: string): string {
  return command
    .replace(/(Authorization:\s*Bearer\s+)\S+/giu, '$1***')
    .replace(/((?:api[_-]?key|token|password)=)[^\s]+/giu, '$1***')
    .slice(0, 4000);
}

function enrichProcessPaneWithClaudeWork(pane: RemotePane, claudeHome: string): void {
  const pid = pane.paneId.replace(/^process:/u, '');
  const sessionPath = path.join(claudeHome, 'sessions', `${pid}.json`);
  if (!fs.existsSync(sessionPath)) return;

  try {
    const meta = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      cwd?: string;
      name?: string;
      sessionId?: string;
      status?: string;
    };
    if (!meta.sessionId) return;

    const sessionName = meta.name?.trim() || pane.windowName || 'Claude 会话';
    const transcriptPath = findClaudeTranscript(claudeHome, meta.sessionId, meta.cwd ?? pane.workspacePath);
    const work = transcriptPath ? readClaudeWork(transcriptPath) : undefined;
    const userTitle = deriveWorkTitle(work?.latestUser);
    const assistantTitle = deriveWorkTitle(work?.latestAssistant);
    const workTitle = userTitle && !isVagueWorkTitle(userTitle)
      ? userTitle
      : sessionName && !isVagueWorkTitle(sessionName)
        ? sessionName
        : assistantTitle
          || userTitle
          || sessionName;
    pane.sessionName = sessionName;
    pane.externalSessionId = meta.sessionId;
    pane.title = `Claude · ${workTitle}`;
    pane.observedStatus = meta.status === 'busy' ? 'running' : 'idle';
    pane.workSummary = [
      work?.latestUser ? `最近指令：${truncateWorkText(work.latestUser, 700)}` : null,
      work?.latestAssistant ? `最近输出：${truncateWorkText(work.latestAssistant, 1200)}` : null,
    ].filter(Boolean).join('\n') || '已关联 Claude 会话，暂未读取到可展示的文本记录。';
    pane.output = [
      `Claude 会话：${meta.sessionId}`,
      `状态：${meta.status ?? 'unknown'}`,
      transcriptPath ? `记录：${transcriptPath}` : '未找到本地 transcript',
      '',
      pane.workSummary,
    ].join('\n');
    if (pane.observedStatus === 'idle') applyRequiredInput(pane, work?.latestAssistant);
    else {
      pane.requiredInput = '';
      pane.suggestedReply = '';
    }
  } catch {
    // A malformed or concurrently replaced session file is not a task failure.
  }
}

function deriveWorkTitle(value: string | undefined | null): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/<[^>]+>/gu, ' ')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/(?:\/[\w.-]+){2,}/gu, ' ')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return null;

  const chinese = cleaned.match(/[\p{Script=Han}][\p{Script=Han}A-Za-z0-9，。；、：()（）\s-]{5,80}/gu);
  if (chinese?.length) {
    const candidate = chinese
      .map(entry => entry.trim())
      .sort((a, b) => b.length - a.length)[0] ?? '';
    return candidate
      .replace(/[│┌┐└┘├┤|]+/gu, ' ')
      .split(/[。？！；]|(?=呢)/u)[0]
      ?.replace(/^(?:因为|如果|看看|帮我|请)/u, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 48) || null;
  }

  const words = cleaned.split(/\s+/u).slice(0, 8).join(' ');
  return words.slice(0, 60) || null;
}

function extractRequiredInput(value: string | null | undefined): RequiredInput | null {
  if (!value) return null;
  const readable = value
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\|/gu, ' ')
    .split(/\r?\n/u)
    .map(line => line.replace(/^#{1,6}\s*/u, '').replace(/\s+/gu, ' ').trim())
    .filter(line => line && !/^(?:[-*]\s|>\s*)/u.test(line));
  const sentences = readable
    .flatMap(line => line.split(/(?<=[。！？!?])\s*/u))
    .map(sentence => sentence.trim())
    .filter(Boolean);
  const normalized = sentences.join('\n');
  if (!normalized) return null;
  const flatNormalized = normalized.replace(/\s+/gu, ' ').trim();
  if (!flatNormalized) return null;

  const candidates = sentences.filter(sentence => {
    const cue = /(需要你|你需要|你要|请确认|你确认|等你|告诉我|要不要|是否|要不要我|你选|你决定|手动|传到手机|装好后|说一声|最后一步|你只需要|你拍板|发给我|提供|输入|确认一下|可以授权我|需要的话|未提交|想验证|你拿|传上来|验收)/iu;
    return cue.test(sentence) || /[?？]$/u.test(sentence);
  });
  const selected = candidates.at(-1);
  if (!selected) {
    const fallback = extractAroundLastCue(flatNormalized);
    return fallback ? { input: fallback, reply: suggestedReplyFor(fallback) } : null;
  }

  const input = selected
    .replace(/^[*-]\s*/u, '')
    .replace(/^\*+/u, '')
    .replace(/^[:：,，。]\s*/u, '')
    .slice(0, 320)
    .trim();
  if (input.length >= 6) return { input, reply: suggestedReplyFor(input) };
  const fallback = extractAroundLastCue(flatNormalized);
  return fallback ? { input: fallback, reply: suggestedReplyFor(fallback) } : null;
}

function extractAroundLastCue(value: string): string | null {
  const cue = /(需要你|你需要|你要|请确认|确认一下|你确认|等你|告诉我|要不要|是否|要不要我|你选|你决定|手动|传到手机|装好后|说一声|最后一步|你只需要|你拍板|可以授权我|需要的话|未提交|想验证|传上来|由你)/iu;
  const matches = [...value.matchAll(new RegExp(cue.source, 'giu'))];
  const match = matches.at(-1);
  if (match?.index === undefined) return null;
  let segment = value.slice(match.index, match.index + 360).trim();
  const boundary = [...segment.matchAll(/[。！？!?]/gu)].find(item => (item.index ?? 0) > 8)?.index;
  if (boundary !== undefined) segment = segment.slice(0, boundary + 1);
  segment = segment
    .replace(/^[#>*\s-]+/u, '')
    .replace(/\*+/gu, '')
    .replace(/^[:：,，。]\s*/u, '')
    .trim();
  return segment.length >= 6 ? segment : null;
}

function applyRequiredInput(pane: RemotePane, value: string | null | undefined): void {
  const required = extractRequiredInput(value);
  pane.requiredInput = required?.input ?? '';
  pane.suggestedReply = required?.reply ?? '';
}

function suggestedReplyFor(value: string): string {
  if (/可以授权|解除隔离/u.test(value)) return '可以授权，继续。';
  if (/由你更新|你更新环境/u.test(value)) return '我来更新环境，结果：';
  if (/现象|异常|报错|结果/u.test(value)) return '我操作后的结果如下：';
  if (/选|拍板|哪个方案/u.test(value)) return '选这个，继续。';
  if (/要不要|是否|要不要我|要不要现在/u.test(value)) return '要，继续。';
  if (/确认|验收|审核/u.test(value)) return '确认，继续。';
  if (/传到手机|安装|装好后/u.test(value)) return '我已安装并测试，结果：';
  if (/验证|测试/u.test(value)) return '我用真实场景验证，结果：';
  if (/修改|导出|后续要/u.test(value)) return '先按当前版本验收；后续需要修改时我再说明。';
  if (/发给我|提供|告诉我/u.test(value)) return '信息如下：';
  return '继续，按你的建议处理。';
}

function isVagueWorkTitle(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return true;
  if (/^\d{4}-\d{2}-\d{2}(?:\s|$)/u.test(trimmed)) return true;
  if (trimmed.length <= 18 && /(继续|咋样|怎么样|好的|可以|搞定|继续呢|看看|启动|刷新)/u.test(trimmed)) return true;
  return trimmed.length <= 3;
}

function readCodexThreadTitles(indexPath: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (!fs.existsSync(indexPath)) return titles;
  for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof entry.id === 'string' && typeof entry.thread_name === 'string') {
        titles.set(entry.id, entry.thread_name);
      }
    } catch {
      // Ignore a partially written index line.
    }
  }
  return titles;
}

function indexCodexTranscripts(sessionsRoot: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(sessionsRoot)) return result;
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(next);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(entry.name);
      if (match?.[1]) result.set(match[1].toLowerCase(), next);
    }
  };
  walk(sessionsRoot);
  return result;
}

function readCodexSessionMeta(transcriptPath: string): {
  cwd: string | null;
  originator: string | null;
} | null {
  const descriptor = fs.openSync(transcriptPath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytes).toString('utf8').split('\n', 1)[0] ?? '';
    const entry = JSON.parse(firstLine) as {
      payload?: { cwd?: unknown; originator?: unknown };
    };
    return {
      cwd: typeof entry.payload?.cwd === 'string' ? entry.payload.cwd : null,
      originator: typeof entry.payload?.originator === 'string' ? entry.payload.originator : null,
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readCodexWork(transcriptPath: string): CodexProcessWork | null {
  return readCodexWorkFromText(readLastTextLines(transcriptPath, 512 * 1024));
}

function readCodexWorkFromText(value: string): CodexProcessWork | null {
  const lines = value.split('\n').filter(Boolean);
  let latestUser: string | null = null;
  let latestAssistant: string | null = null;
  let status: 'idle' | 'running' | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(lines[index]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = (entry.payload as Record<string, unknown> | undefined) ?? {};
    if (entry.type === 'event_msg') {
      const eventType = String(payload.type ?? '');
      if (status === null) {
        if (eventType === 'task_started') status = 'running';
        else if (['task_complete', 'task_failed', 'task_cancelled'].includes(eventType)) status = 'idle';
      }
    }
    if (entry.type !== 'response_item') continue;
    const role = String(payload.role ?? '');
    const text = extractCodexMessageText(payload.content);
    if (!text) continue;
    if (role === 'user' && !latestUser && isRealCodexUserMessage(text)) latestUser = sanitizeWorkText(text);
    if (role === 'assistant' && !latestAssistant) latestAssistant = sanitizeWorkText(text);
    if (latestUser && latestAssistant && status !== null) break;
  }

  return latestUser || latestAssistant ? { latestAssistant, latestUser, status } : null;
}

function extractCodexMessageText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value
    .filter((item): item is { text?: unknown } =>
      typeof item === 'object'
      && item !== null
      && ['input_text', 'output_text'].includes(String((item as { type?: unknown }).type)))
    .map(item => typeof item.text === 'string' ? item.text : '')
    .join('\n')
    .trim();
  return text || null;
}

function isRealCodexUserMessage(value: string): boolean {
  return !value.startsWith('<in-app-browser-context')
    && !value.startsWith('<subagent_notification>')
    && !value.startsWith('<task-notification>')
    && !value.startsWith('<system-reminder>')
    && !value.startsWith('<environment_context>')
    && !value.startsWith('<turn_aborted>')
    && !value.startsWith('<app-context>');
}

function findClaudeTranscript(claudeHome: string, sessionId: string, cwd: string): string | null {
  const encodedCwd = cwd.replace(/\//gu, '-');
  const directPath = path.join(claudeHome, 'projects', encodedCwd, `${sessionId}.jsonl`);
  if (fs.existsSync(directPath)) return directPath;

  const projectsRoot = path.join(claudeHome, 'projects');
  if (!fs.existsSync(projectsRoot)) return null;
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readClaudeWork(transcriptPath: string): ClaudeProcessWork | null {
  return readClaudeWorkFromText(readLastTextLines(transcriptPath, 512 * 1024), transcriptPath);
}

function readClaudeWorkFromText(value: string, transcriptPath: string): ClaudeProcessWork | null {
  const lines = value.split('\n').filter(Boolean);
  let latestUser: string | null = null;
  let latestAssistant: string | null = null;
  let sessionId = '';

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(lines[index]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : sessionId;
    const role = (entry.message as { role?: unknown } | undefined)?.role;
    const text = extractClaudeMessageText(entry.message);
    if (!text) continue;
    if (
      role === 'user'
      && !latestUser
      && !text.startsWith('<task-notification>')
      && !text.startsWith('<system-reminder>')
      && !text.includes('<tool-use-id>')
    ) latestUser = text;
    if (
      role === 'assistant'
      && !latestAssistant
      && !text.startsWith('API Error:')
    ) latestAssistant = text;
    if (latestUser && latestAssistant) break;
  }

  if (!latestUser && !latestAssistant) return null;
  return {
    latestAssistant: latestAssistant ? sanitizeWorkText(latestAssistant) : null,
    latestUser: latestUser ? sanitizeWorkText(latestUser) : null,
    name: null,
    sessionId,
    status: 'unknown',
    transcriptPath,
  };
}

function readLastTextLines(filePath: string, maximumBytes: number): string {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maximumBytes);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(descriptor);
  }
  const value = buffer.toString('utf8');
  return length === stat.size ? value : value.slice(value.indexOf('\n') + 1);
}

function extractClaudeMessageText(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const content = (value as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((item): item is { text?: unknown } =>
      typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text')
    .map(item => typeof item.text === 'string' ? item.text : '')
    .join('\n')
    .trim();
  return text || null;
}

function sanitizeWorkText(value: string): string {
  return value
    .replace(/(Authorization:\s*Bearer\s+)\S+/giu, '$1***')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/gu, '***')
    .replace(/((?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;}]+/giu, '$1***')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function truncateWorkText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function buildTitle(sessionName: string, windowName: string, windowIndex: string): string {
  if (windowName && !['bash', 'zsh', 'sh', 'node', 'npm'].includes(windowName.toLowerCase())) {
    return windowName;
  }
  return `${sessionName}-${windowIndex}`;
}

function sanitizeRemoteOutput(value: string): string {
  return value
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim()
    .slice(0, 20_000);
}

function mapTaskRow(row: Record<string, unknown>): SshTaskRecord {
  const status = String(row.status);
  return {
    agentType: row.agent_type as AgentType,
    controlMode: row.control_mode === 'process' ? 'process' : 'tmux',
    customTitle: typeof row.custom_title === 'string' && row.custom_title ? row.custom_title : null,
    externalSessionId: String(row.external_session_id ?? ''),
    createdAt: String(row.created_at),
    id: Number(row.id),
    lastActiveAt: String(row.last_active_at),
    lastOutput: String(row.last_output ?? ''),
    machineId: Number(row.machine_id),
    paneId: String(row.pane_id),
    processCommand: String(row.process_command ?? ''),
    requiredInput: String(row.required_input ?? ''),
    sessionName: String(row.session_name),
    suggestedReply: String(row.suggested_reply ?? ''),
    status: SSH_TASK_STATUSES.has(status) ? status as SshTaskRecord['status'] : 'idle',
    title: String(row.custom_title ?? row.title),
    workSummary: String(row.work_summary ?? ''),
    updatedAt: String(row.updated_at),
    windowIndex: Number(row.window_index),
    windowName: String(row.window_name),
    workspacePath: String(row.workspace_path),
  };
}
