import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pino from 'pino';

import { DatabaseClient } from '../src/infra/storage/database.js';
import { SshMachineService } from '../src/services/ssh-machine-service.js';
import type { MachineRecord } from '../src/domain/machine.js';
import type { CommandResult } from '../src/infra/process/command-runner.js';

function fixture() {
  const database = new DatabaseClient(':memory:', pino({ level: 'silent' }));
  let machine: MachineRecord | null = null;
  const scripts: string[] = [];
  const commandRunner = async (_command: string, args: string[]): Promise<CommandResult> => {
    const script = String(args.at(-1));
    scripts.push(script);
    if (script.includes('ASB_OS=')) {
      return {
        exitCode: 0,
        stderr: '',
        stdout: 'ASB_OS=Darwin\nASB_TOOL_claude=1\nASB_TOOL_codex=1\nASB_TOOL_gemini=0\ntmux 3.4',
      };
    }
    if (script.includes('tmux list-panes')) {
      return {
        exitCode: 0,
        stderr: '',
        stdout: '%12\tmain\t2\tclaude\tclaude\t/Users/demo/project\t0\n%13\tshell\t1\tzsh\tzsh\t/Users/demo\t0',
      };
    }
    if (script.includes('capture-pane')) {
      return {
        exitCode: 0,
        stderr: '',
        stdout: script.includes('%12') ? 'Claude Code\nwaiting for input' : 'demo@mac ~ %',
      };
    }
    return { exitCode: 0, stderr: '', stdout: '' };
  };
  const service = new SshMachineService({
    codexHome: path.join(os.tmpdir(), 'asb-empty-codex-home'),
    commandRunner,
    database,
    logger: pino({ level: 'silent' }),
    machines: {
      listMachines: async () => (machine ? [machine] : []),
      registerMachine: async (input) => {
        const now = new Date().toISOString();
        const next: MachineRecord = {
          capabilities: input.capabilities ?? {},
          createdAt: machine?.createdAt ?? now,
          host: input.host ?? null,
          id: machine?.id ?? 2,
          labels: input.labels ?? [],
          lastSeenAt: now,
          name: input.name,
          namespace: input.namespace ?? 'default',
          runnerVersion: input.runnerVersion ?? null,
          status: input.status ?? 'online',
          updatedAt: now,
        };
        machine = next;
        return next;
      },
    },
  });
  return { commandRunner, database, machine: () => machine, scripts, service };
}

function remoteProcessFixture() {
  const database = new DatabaseClient(':memory:', pino({ level: 'silent' }));
  const scripts: string[] = [];
  let machine: MachineRecord | null = null;
  const service = new SshMachineService({
    codexHome: path.join(os.tmpdir(), 'asb-empty-codex-home'),
    commandRunner: async (_command: string, args: string[]) => {
      const script = String(args.at(-1));
      scripts.push(script);
      if (script.includes('ASB_OS=')) {
        return { exitCode: 0, stderr: '', stdout: 'ASB_OS=Linux\nASB_TOOL_claude=1\nASB_TOOL_codex=1\nASB_TOOL_gemini=0\ntmux 3.4' };
      }
      if (script.includes('tmux list-panes')) return { exitCode: 0, stderr: '', stdout: '' };
      if (script.includes('ps -axo')) {
        return { exitCode: 0, stderr: '', stdout: '217 216 03:00:00 claude --model remote-test' };
      }
      if (script.includes('for pid in 217')) {
        return { exitCode: 0, stderr: '', stdout: '217\t/remote/project' };
      }
      if (script.includes('.claude/sessions/217.json')) {
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            sessionId: 'remote-claude-session',
            cwd: '/remote/project',
            name: 'remote-login-fix',
            status: 'idle',
          }),
        };
      }
      if (script.includes('find "$HOME/.claude/projects"')) {
        return { exitCode: 0, stderr: '', stdout: '/remote/home/.claude/projects/-remote-project/remote-claude-session.jsonl' };
      }
      if (script.includes('tail -c 524288')) {
        return {
          exitCode: 0,
          stderr: '',
          stdout: [
            JSON.stringify({ sessionId: 'remote-claude-session', message: { role: 'user', content: '修复远程登录超时' } }),
            JSON.stringify({ sessionId: 'remote-claude-session', message: { role: 'assistant', content: [{ type: 'text', text: '远程登录问题已定位。要不要继续跑测试？' }] } }),
          ].join('\n'),
        };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    },
    database,
    logger: pino({ level: 'silent' }),
    machines: {
      listMachines: async () => (machine ? [machine] : []),
      registerMachine: async (input) => {
        const now = new Date().toISOString();
        machine = {
          capabilities: input.capabilities ?? {},
          createdAt: now,
          host: input.host ?? null,
          id: 2,
          labels: input.labels ?? [],
          lastSeenAt: now,
          name: input.name,
          namespace: input.namespace ?? 'default',
          runnerVersion: input.runnerVersion ?? null,
          status: input.status ?? 'online',
          updatedAt: now,
        };
        return machine;
      },
    },
  });
  return { scripts, service };
}

function localFixture() {
  const database = new DatabaseClient(':memory:', pino({ level: 'silent' }));
  const now = new Date().toISOString();
  const machine: MachineRecord = {
    capabilities: { installedAgentTypes: ['codex', 'claude-code', 'gemini'] },
    createdAt: now,
    host: 'local-host',
    id: 1,
    labels: ['local'],
    lastSeenAt: now,
    name: 'local',
    namespace: 'default',
    runnerVersion: null,
    status: 'online',
    updatedAt: now,
  };
  const scripts: string[] = [];
  const service = new SshMachineService({
    codexHome: path.join(os.tmpdir(), 'asb-empty-codex-home'),
    commandRunner: async (_command: string, args: string[]) => {
      const script = String(args.at(-1));
      scripts.push(script);
      if (script.includes('tmux list-panes')) {
        return {
          exitCode: 0,
          stderr: '',
          stdout: '%7\tcodex-work\t1\tcodex\tcodex\t/Users/demo/repo\t0',
        };
      }
      if (script.includes('capture-pane')) {
        return { exitCode: 0, stderr: '', stdout: 'Codex CLI\nworking on login fix' };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    },
    database,
    logger: pino({ level: 'silent' }),
    machines: {
      listMachines: async () => [machine],
      registerMachine: async () => machine,
    },
  });
  return { scripts, service };
}

function localProcessFixture() {
  const database = new DatabaseClient(':memory:', pino({ level: 'silent' }));
  const commands: string[] = [];
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-claude-'));
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, 'projects', '-Users-demo-project'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'sessions', '123.json'), JSON.stringify({
    sessionId: 'session-123',
    cwd: '/Users/demo/project',
    name: 'login-fix',
    status: 'idle',
  }));
  fs.writeFileSync(
    path.join(claudeHome, 'projects', '-Users-demo-project', 'session-123.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '修复登录超时 password=abc123' }, sessionId: 'session-123' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已定位接口超时并完成修复。要不要我现在继续跑回归测试？' }] }, sessionId: 'session-123' }),
    ].join('\n'),
  );
  const now = new Date().toISOString();
  const machine: MachineRecord = {
    capabilities: {},
    createdAt: now,
    host: 'local-host',
    id: 1,
    labels: ['local'],
    lastSeenAt: now,
    name: 'local',
    namespace: 'default',
    runnerVersion: null,
    status: 'online',
    updatedAt: now,
  };
  const service = new SshMachineService({
    commandRunner: async (_command: string, args: string[]) => {
      commands.push(`${_command} ${args.join(' ')}`);
      const script = String(args.at(-1));
      if (script.includes('tmux list-panes')) return { exitCode: 0, stderr: '', stdout: '' };
      if (script.includes('ps -axo')) {
        return {
          exitCode: 0,
          stderr: '',
          stdout: '123 45 01:02:03 claude --model test\n124 46 00:01:00 /Applications/ChatGPT.app/Contents/MacOS/Codex',
        };
      }
      if (script.includes('for pid in 123')) {
        return { exitCode: 0, stderr: '', stdout: '123\t/Users/demo/project' };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    },
    claudeHome,
    codexHome: path.join(os.tmpdir(), 'asb-empty-codex-home'),
    database,
    logger: pino({ level: 'silent' }),
    machines: {
      listMachines: async () => [machine],
      registerMachine: async () => machine,
    },
  });
  return { claudeHome, commands, service };
}

function localCodexDesktopFixture() {
  const database = new DatabaseClient(':memory:', pino({ level: 'silent' }));
  const commands: string[] = [];
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-codex-'));
  const threadId = '01999999-9999-7999-a999-999999999999';
  const sessionDirectory = path.join(codexHome, 'sessions', '2026', '09', '17');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'thread-writer-locks'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({
    id: threadId,
    thread_name: '撰写项目需求文档',
    updated_at: new Date().toISOString(),
  })}\n`);
  fs.writeFileSync(path.join(codexHome, 'thread-writer-locks', `${threadId}.lock`), '');
  fs.writeFileSync(path.join(sessionDirectory, `rollout-2026-09-17T00-00-00-${threadId}.jsonl`), [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        cwd: '/Users/demo/project',
        originator: 'Codex Desktop',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        role: 'user',
        content: [{ type: 'input_text', text: '撰写项目需求文档 password=secret123' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        role: 'assistant',
        content: [{ type: 'output_text', text: '需求文档结构和核心用户流程已经完成。请确认后继续。' }],
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }),
  ].join('\n'));
  const now = new Date().toISOString();
  const machine: MachineRecord = {
    capabilities: {},
    createdAt: now,
    host: 'local-host',
    id: 1,
    labels: ['local'],
    lastSeenAt: now,
    name: 'local',
    namespace: 'default',
    runnerVersion: null,
    status: 'online',
    updatedAt: now,
  };
  const service = new SshMachineService({
    claudeHome: path.join(os.tmpdir(), 'asb-empty-claude-home'),
    codexHome,
    commandRunner: async (command: string, args: string[]) => {
      commands.push(`${command} ${args.join(' ')}`);
      return { exitCode: 0, stderr: '', stdout: '' };
    },
    database,
    logger: pino({ level: 'silent' }),
    machines: {
      listMachines: async () => [machine],
      registerMachine: async () => machine,
    },
  });
  return { commands, service };
}

test('SSH machine registration probes tools and discovers only AI tmux panes', async () => {
  const f = fixture();
  const { machine, probe } = await f.service.addMachine({
    host: 'mac-pro',
    name: 'Mac Pro',
    port: 6022,
    user: 'demo',
  });

  assert.equal(machine.name, 'mac-pro');
  assert.equal(machine.capabilities.connection, 'ssh');
  assert.deepEqual(machine.capabilities.installedAgentTypes, ['claude-code', 'codex']);
  assert.equal(probe.tmuxVersion, '3.4');
  assert.match(f.scripts[0] ?? '', /ASB_OS=/u);

  const tasks = await f.service.discoverTasks(machine.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.agentType, 'claude-code');
  assert.equal(tasks[0]?.sessionName, 'main');
  assert.equal(tasks[0]?.workspacePath, '/Users/demo/project');
  assert.match(tasks[0]?.lastOutput ?? '', /Claude Code/u);
});

test('remote SSH process tasks resume their CLI session over SSH', async () => {
  const f = fixture();
  const { machine } = await f.service.addMachine({ host: 'linux', name: 'linux', user: 'demo' });
  const [initial] = await f.service.discoverTasks(machine.id);
  assert.ok(initial);
  f.database.prepare(`
    UPDATE ssh_tasks
    SET control_mode='process',
        pane_id='process:999',
        external_session_id='remote-session',
        workspace_path='/remote/project'
    WHERE id=?
  `).run(initial.id);

  await f.service.sendPrompt(initial.id, 'hello remote', 'tester');
  const resumeScript = f.scripts.find(script =>
    script.includes('cd /remote/project') || script.includes("cd '/remote/project'")
    && script.includes('claude --resume'));
  assert.match(resumeScript ?? '', /claude --resume 'remote-session' --print 'hello remote'/u);
});

test('remote SSH machines discover non-tmux Claude processes and transcripts', async () => {
  const f = remoteProcessFixture();
  const { machine } = await f.service.addMachine({ host: 'linux', name: 'linux', user: 'demo' });
  const tasks = await f.service.discoverTasks(machine.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.controlMode, 'process');
  assert.equal(tasks[0]?.agentType, 'claude-code');
  assert.equal(tasks[0]?.externalSessionId, 'remote-claude-session');
  assert.equal(tasks[0]?.workspacePath, '/remote/project');
  assert.equal(tasks[0]?.status, 'idle');
  assert.match(tasks[0]?.title ?? '', /远程登录超时/u);
  assert.match(tasks[0]?.workSummary ?? '', /远程登录问题已定位/u);
  assert.match(tasks[0]?.requiredInput ?? '', /要不要继续跑测试/u);

  await f.service.sendPrompt(tasks[0]!.id, '继续跑测试', 'tester');
  const resumeScript = f.scripts.find(script => script.includes("claude --resume 'remote-claude-session' --print '继续跑测试'"));
  assert.match(resumeScript ?? '', /cd '\/remote\/project'/u);
});

test('local machine tmux panes are discovered without SSH', async () => {
  const f = localFixture();
  const tasks = await f.service.discoverTasks(1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.agentType, 'codex');
  assert.equal(tasks[0]?.sessionName, 'codex-work');
  assert.match(tasks[0]?.lastOutput ?? '', /login fix/u);
  assert.equal(f.scripts.every((script) => script.includes('ssh ') === false), true);
});

test('local agent processes outside tmux are automatically discovered as read-only tasks', async () => {
  const f = localProcessFixture();
  const tasks = await f.service.discoverTasks(1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.controlMode, 'process');
  assert.equal(tasks[0]?.agentType, 'claude-code');
  assert.equal(tasks[0]?.paneId, 'process:123');
  assert.equal(tasks[0]?.workspacePath, '/Users/demo/project');
  assert.match(tasks[0]?.title ?? '', /Claude · 修复登录超时/u);
  assert.match(tasks[0]?.workSummary ?? '', /修复登录超时/u);
  assert.match(tasks[0]?.workSummary ?? '', /password=\*\*\*/u);
  assert.match(tasks[0]?.lastOutput ?? '', /已定位接口超时/u);
  assert.equal(tasks[0]?.externalSessionId, 'session-123');
  assert.match(tasks[0]?.requiredInput ?? '', /要不要我现在继续跑回归测试/u);
  assert.equal(tasks[0]?.suggestedReply, '要，继续。');
  await f.service.sendPrompt(tasks[0]!.id, 'hello', 'tester');
  assert.equal(f.commands.some(command => command.startsWith('claude --resume session-123 --print hello')), true);
  const renamed = await f.service.renameTask(tasks[0]!.id, '登录接口排期');
  assert.equal(renamed.title, '登录接口排期');
  assert.equal(renamed.customTitle, '登录接口排期');
  const rediscovered = await f.service.discoverTasks(1);
  assert.equal(rediscovered[0]?.title, '登录接口排期');
  await assert.rejects(f.service.renameTask(tasks[0]!.id, ' '), /任务名称/u);
  const sessionPath = path.join(f.claudeHome, 'sessions', '123.json');
  fs.writeFileSync(sessionPath, JSON.stringify({
    sessionId: 'session-123',
    cwd: '/Users/demo/project',
    name: 'login-fix',
    status: 'idle',
  }));
  const idle = await f.service.discoverTasks(1);
  assert.equal(idle[0]?.status, 'idle');
  assert.equal(idle[0]?.title, '登录接口排期');
});

test('local Codex Desktop threads are automatically discovered with work summaries', async () => {
  const f = localCodexDesktopFixture();
  const tasks = await f.service.discoverTasks(1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.agentType, 'codex');
  assert.equal(tasks[0]?.controlMode, 'process');
  assert.equal(tasks[0]?.externalSessionId, '01999999-9999-7999-a999-999999999999');
  assert.equal(tasks[0]?.status, 'idle');
  assert.match(tasks[0]?.title ?? '', /Codex · .*需求文档/u);
  assert.equal(tasks[0]?.workspacePath, '/Users/demo/project');
  assert.match(tasks[0]?.workSummary ?? '', /撰写项目需求文档/u);
  assert.match(tasks[0]?.workSummary ?? '', /password=\*\*\*/u);
  assert.match(tasks[0]?.lastOutput ?? '', /需求文档结构和核心用户流程/u);
  assert.match(tasks[0]?.requiredInput ?? '', /请确认后继续/u);
  assert.equal(tasks[0]?.suggestedReply, '确认，继续。');
  await f.service.sendPrompt(tasks[0]!.id, 'hello', 'tester');
  assert.equal(f.commands.some(command => command.startsWith('codex exec resume --skip-git-repo-check 01999999-9999-7999-a999-999999999999 hello')), true);
});

test('SSH task input is shell-quoted and delivered to the discovered pane', async () => {
  const f = fixture();
  const { machine } = await f.service.addMachine({ host: 'linux', name: 'linux', user: 'demo' });
  const [task] = await f.service.discoverTasks(machine.id);
  assert.ok(task);
  const sent = await f.service.sendPrompt(task.id, "summary'; rm -rf /tmp/evil", 'tester');
  const sendScript = f.scripts.filter((script) => script.includes('send-keys')).at(-1);
  assert.match(sendScript ?? '', /%12/u);
  assert.equal(sendScript?.includes(String.raw`'summary'\''; rm -rf /tmp/evil'`), true);
  assert.equal(sent.status, 'running');
});

test('SSH machine input rejects ambiguous hosts and unsupported prompts', async () => {
  const f = fixture();
  await assert.rejects(f.service.addMachine({ host: 'bad host', name: 'bad' }), /SSH Host/u);
  const { machine } = await f.service.addMachine({ host: 'linux', name: 'linux' });
  const [task] = await f.service.discoverTasks(machine.id);
  assert.ok(task);
  await assert.rejects(f.service.sendPrompt(task.id, ' ', 'tester'), /不能为空/u);
});
