import { AGENT_TYPES } from '../domain/agent.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type { CommandContext, ParsedCommand } from '../domain/command.js';
import type { SessionInspection, SessionRecord } from '../domain/session.js';
import type { ApprovalRequestRecord, ApprovalStatus } from '../domain/approval.js';
import type { MachineRecord } from '../domain/machine.js';
import type { TerminalCommandRecord } from '../domain/terminal.js';
import type { WorkspaceGitStatus, WorkspaceListing } from '../domain/workspace.js';
import { ApprovalService } from './approval-service.js';
import { MachineService } from './machine-service.js';
import { NotificationService } from './notification-service.js';
import { SessionService } from './session-service.js';
import { splitCommandLine } from '../utils/shell.js';
import { SupervisorService } from './supervisor-service.js';
import { TerminalService } from './terminal-service.js';
import { WorkspaceService } from './workspace-service.js';

type CommandRouterOptions = {
  approvalService: ApprovalService;
  machineService: MachineService;
  notificationService: NotificationService;
  sessionService: SessionService;
  supervisorService: SupervisorService;
  terminalService: TerminalService;
  workspaceService: WorkspaceService;
};

export class CommandRouter {
  constructor(private readonly options: CommandRouterOptions) {}

  async execute(rawInput: string, context: CommandContext): Promise<string> {
    const command = this.parse(rawInput);

    switch (command.name) {
      case 'help':
        return this.renderHelp();
      case 'ping':
        return 'pong';
      case 'list':
      case 'sessions':
        return this.renderSessionList(await this.options.sessionService.listSessions());
      case 'watch': {
        const state = command.forceRun
          ? await this.options.supervisorService.runInspectionCycle()
          : this.options.supervisorService.getState().latestSnapshots;
        return this.renderSupervisorSnapshots(state);
      }
      case 'current':
        return this.renderCurrentSession(
          await this.options.sessionService.getCurrentSession(context.actorId),
        );
      case 'new': {
        const session = await this.options.sessionService.createSession({
          actorId: context.actorId,
          agentType: command.agentType,
          name: command.sessionName,
          workspacePath: command.workspacePath,
        });
        return `Created session "${session.name}" at ${session.workspacePath}`;
      }
      case 'use': {
        const session = await this.options.sessionService.setCurrentSession(
          context.actorId,
          command.sessionName,
        );
        return `Current session is now "${session.name}"`;
      }
      case 'inspect': {
        const inspection = command.sessionName
          ? await this.options.sessionService.inspectSession(command.sessionName)
          : await this.options.sessionService.inspectCurrentSession(context.actorId);
        return this.renderInspection(inspection);
      }
      case 'status': {
        const session = command.sessionName
          ? await this.options.sessionService.requireByName(command.sessionName)
          : await this.options.sessionService.requireCurrentSession(context.actorId);
        return this.renderSessionDetails(session);
      }
      case 'send': {
        const session = await this.options.sessionService.sendPrompt({
          actorId: context.actorId,
          name: command.sessionName,
          prompt: command.prompt,
        });
        return `Sent prompt to "${session.name}"`;
      }
      case 'ask': {
        const session = await this.options.sessionService.sendPromptToCurrent(
          context.actorId,
          command.prompt,
        );
        return `Sent prompt to current session "${session.name}"`;
      }
      case 'tail': {
        const output = command.sessionName
          ? await this.options.sessionService.tailSession(command.sessionName)
          : await this.options.sessionService.tailCurrentSession(context.actorId);
        return output || '(no output yet)';
      }
      case 'stop': {
        const approval = await this.options.approvalService.requestSessionStop({
          actorId: context.actorId,
          sessionName: command.sessionName,
        });
        return [
          `Approval #${approval.id} requested: ${approval.title}`,
          `Risk: ${approval.riskLevel}`,
          `Approve with /approve ${approval.id} or deny with /deny ${approval.id}`,
        ].join('\n');
      }
      case 'rename': {
        const session = await this.options.sessionService.renameSession(
          command.oldName,
          command.newName,
        );
        return `Renamed session "${command.oldName}" to "${session.name}"`;
      }
      case 'approvals': {
        const status = command.status === 'all' ? null : command.status ?? 'pending';
        return this.renderApprovals(await this.options.approvalService.listApprovals({ status }));
      }
      case 'approve':
        return this.renderApproval(
          await this.options.approvalService.approve(command.approvalId, context.actorId),
        );
      case 'deny':
        return this.renderApproval(
          await this.options.approvalService.deny(
            command.approvalId,
            context.actorId,
            command.reason,
          ),
        );
      case 'files': {
        const session = command.sessionName
          ? await this.options.sessionService.requireByName(command.sessionName)
          : await this.options.sessionService.requireCurrentSession(context.actorId);
        return this.renderWorkspaceListing(
          await this.options.workspaceService.listFiles(session.name, command.path ?? ''),
        );
      }
      case 'cat': {
        const preview = await this.options.workspaceService.readFilePreview(
          command.sessionName,
          command.path,
        );
        if (preview.isBinary) {
          return `${preview.path} is a binary file (${preview.size} bytes).`;
        }
        return preview.content || '(empty file)';
      }
      case 'git': {
        if (command.subcommand === 'status') {
          return this.renderGitStatus(
            await this.options.workspaceService.getGitStatus(command.sessionName),
          );
        }

        const diff = await this.options.workspaceService.getGitDiff(
          command.sessionName,
          command.path,
        );
        return diff.available ? diff.content || '(no diff)' : diff.reason ?? 'git diff unavailable';
      }
      case 'diff': {
        const diff = await this.options.workspaceService.getGitDiff(
          command.sessionName,
          command.path,
        );
        return diff.available ? diff.content || '(no diff)' : diff.reason ?? 'git diff unavailable';
      }
      case 'terminal': {
        const risk = this.options.terminalService.assessCommandRisk(command.command);
        if (risk.requiresApproval) {
          const approval = await this.options.approvalService.requestTerminalCommand({
            actorId: context.actorId,
            command: command.command,
            riskLevel: risk.riskLevel,
            sessionName: command.sessionName,
          });
          return [
            `Terminal command needs approval #${approval.id}`,
            `Risk: ${risk.riskLevel}`,
            `Reason: ${risk.reason}`,
            `Approve with /approve ${approval.id}`,
          ].join('\n');
        }

        const record = await this.options.terminalService.startCommand({
          actorId: context.actorId,
          command: command.command,
          sessionName: command.sessionName,
        });
        return this.renderTerminalCommand(record);
      }
      case 'terminal-status':
        return this.renderTerminalCommand(
          await this.options.terminalService.getCommand(command.commandId),
        );
      case 'terminal-cancel':
        return this.renderTerminalCommand(
          await this.options.terminalService.cancelCommand(command.commandId, context.actorId),
        );
      case 'machines':
        return this.renderMachines(await this.options.machineService.listMachines());
      case 'notify': {
        const result = await this.options.notificationService.sendTestNotification(context.actorId);
        return `Notification test sent. Delivered: ${result.delivered}`;
      }
      case 'spawn': {
        const machine = await this.resolveMachine(command.machine);
        const session = await this.options.machineService.spawnSession({
          actorId: context.actorId,
          agentType: command.agentType,
          machineId: machine.id,
          name: command.sessionName,
          workspacePath: command.workspacePath,
        });
        return `Spawned session "${session.name}" on machine "${machine.name}"`;
      }
    }
  }

  parse(rawInput: string): ParsedCommand {
    const normalized = rawInput.trim();

    if (!normalized) {
      return { name: 'help' };
    }

    const tokens = splitCommandLine(normalized);

    if (tokens.length === 0) {
      return { name: 'help' };
    }

    const head = tokens[0]!;
    const rest = tokens.slice(1);
    const commandName = head.startsWith('/') ? head.slice(1) : head;

    switch (commandName) {
      case 'help':
        return { name: 'help' };
      case 'ping':
        return { name: 'ping' };
      case 'list':
        return { name: 'list' };
      case 'sessions':
        return { name: 'sessions' };
      case 'watch':
        return {
          forceRun: rest[0] === 'run',
          name: 'watch',
        };
      case 'current':
        return { name: 'current' };
      case 'new': {
        if (rest.length < 2) {
          throw new ValidationError('Usage: /new <name> <workspace_path> [agent_type]');
        }

        const workspaceParts = rest.slice(1);
        const maybeAgentType = workspaceParts[workspaceParts.length - 1];
        const agentType = isAgentType(maybeAgentType) ? maybeAgentType : undefined;
        const workspacePath = (agentType ? workspaceParts.slice(0, -1) : workspaceParts).join(' ');

        return {
          agentType,
          name: 'new',
          sessionName: rest[0]!,
          workspacePath,
        };
      }
      case 'use': {
        if (rest.length !== 1) {
          throw new ValidationError('Usage: /use <name>');
        }
        return {
          name: 'use',
          sessionName: rest[0]!,
        };
      }
      case 'status':
        return {
          name: 'status',
          sessionName: rest[0],
        };
      case 'inspect':
        return {
          name: 'inspect',
          sessionName: rest[0],
        };
      case 'send': {
        if (rest.length < 2) {
          throw new ValidationError('Usage: /send <name> <prompt>');
        }
        return {
          name: 'send',
          prompt: rest.slice(1).join(' '),
          sessionName: rest[0]!,
        };
      }
      case 'ask': {
        if (rest.length === 0) {
          throw new ValidationError('Usage: /ask <prompt>');
        }
        return {
          name: 'ask',
          prompt: rest.join(' '),
        };
      }
      case 'tail':
        return {
          name: 'tail',
          sessionName: rest[0],
        };
      case 'stop': {
        if (rest.length !== 1) {
          throw new ValidationError('Usage: /stop <name>');
        }
        return {
          name: 'stop',
          sessionName: rest[0]!,
        };
      }
      case 'rename': {
        if (rest.length !== 2) {
          throw new ValidationError('Usage: /rename <old_name> <new_name>');
        }
        return {
          name: 'rename',
          newName: rest[1]!,
          oldName: rest[0]!,
        };
      }
      case 'approvals':
        return {
          name: 'approvals',
          status: parseApprovalStatus(rest[0]),
        };
      case 'approve': {
        if (rest.length !== 1) {
          throw new ValidationError('Usage: /approve <id>');
        }
        return {
          approvalId: parseId(rest[0]!, 'approval id'),
          name: 'approve',
        };
      }
      case 'deny': {
        if (rest.length < 1) {
          throw new ValidationError('Usage: /deny <id> [reason]');
        }
        return {
          approvalId: parseId(rest[0]!, 'approval id'),
          name: 'deny',
          reason: rest.slice(1).join(' ') || undefined,
        };
      }
      case 'files':
        return {
          name: 'files',
          path: rest.length > 1 ? rest.slice(1).join(' ') : undefined,
          sessionName: rest[0],
        };
      case 'cat': {
        if (rest.length < 2) {
          throw new ValidationError('Usage: /cat <name> <path>');
        }
        return {
          name: 'cat',
          path: rest.slice(1).join(' '),
          sessionName: rest[0]!,
        };
      }
      case 'git': {
        if (rest.length < 2 || !['status', 'diff'].includes(rest[1]!)) {
          throw new ValidationError('Usage: /git <name> status|diff [path]');
        }
        return {
          name: 'git',
          path: rest.slice(2).join(' ') || undefined,
          sessionName: rest[0]!,
          subcommand: rest[1] as 'diff' | 'status',
        };
      }
      case 'diff': {
        if (rest.length < 1) {
          throw new ValidationError('Usage: /diff <name> [path]');
        }
        return {
          name: 'diff',
          path: rest.slice(1).join(' ') || undefined,
          sessionName: rest[0]!,
        };
      }
      case 'terminal': {
        if (rest.length < 2) {
          throw new ValidationError('Usage: /terminal <name> <command>');
        }
        return {
          command: rest.slice(1).join(' '),
          name: 'terminal',
          sessionName: rest[0]!,
        };
      }
      case 'terminal-status': {
        if (rest.length !== 1) {
          throw new ValidationError('Usage: /terminal-status <id>');
        }
        return {
          commandId: parseId(rest[0]!, 'terminal command id'),
          name: 'terminal-status',
        };
      }
      case 'terminal-cancel': {
        if (rest.length !== 1) {
          throw new ValidationError('Usage: /terminal-cancel <id>');
        }
        return {
          commandId: parseId(rest[0]!, 'terminal command id'),
          name: 'terminal-cancel',
        };
      }
      case 'machines':
        return { name: 'machines' };
      case 'notify': {
        if (rest.length !== 1 || rest[0] !== 'test') {
          throw new ValidationError('Usage: /notify test');
        }
        return {
          name: 'notify',
          subcommand: 'test',
        };
      }
      case 'spawn': {
        if (rest.length < 3) {
          throw new ValidationError('Usage: /spawn <machine> <name> <workspace_path> [agent_type]');
        }

        const workspaceParts = rest.slice(2);
        const maybeAgentType = workspaceParts[workspaceParts.length - 1];
        const agentType = isAgentType(maybeAgentType) ? maybeAgentType : undefined;
        const workspacePath = (agentType ? workspaceParts.slice(0, -1) : workspaceParts).join(' ');

        return {
          agentType,
          machine: rest[0]!,
          name: 'spawn',
          sessionName: rest[1]!,
          workspacePath,
        };
      }
      default:
        if (normalized.startsWith('/')) {
          throw new NotFoundError(`Unknown command "/${commandName}"`);
        }
        return {
          name: 'ask',
          prompt: normalized,
        };
    }
  }

  renderHelp(): string {
    return [
      'agentBridge',
      '',
      'Commands:',
      '  /ping',
      '  /list',
      '  /watch',
      '  /watch run',
      '  /new <name> <workspace_path> [agent_type]',
      '  /use <name>',
      '  /current',
      '  /inspect [name]',
      '  /status [name]',
      '  /send <name> <prompt>',
      '  /ask <prompt>',
      '  /tail [name]',
      '  /stop <name>',
      '  /rename <old_name> <new_name>',
      '  /approvals [pending|approved|denied|all]',
      '  /approve <id>',
      '  /deny <id> [reason]',
      '  /files [name] [path]',
      '  /cat <name> <path>',
      '  /git <name> status|diff [path]',
      '  /terminal <name> <command>',
      '  /terminal-status <id>',
      '  /terminal-cancel <id>',
      '  /machines',
      '  /notify test',
      '  /spawn <machine> <name> <workspace_path> [agent_type]',
    ].join('\n');
  }

  private renderCurrentSession(session: SessionRecord | null): string {
    if (!session) {
      return 'No current session is selected.';
    }

    return this.renderSessionDetails(session);
  }

  private renderSessionDetails(session: SessionRecord): string {
    return [
      `Session: ${session.name}`,
      `Status: ${session.status}`,
      `Workspace: ${session.workspacePath}`,
      `tmux: ${session.tmuxSessionName}:${session.tmuxWindowName}`,
      `Last active: ${session.lastActiveAt}`,
      `Last digest: ${session.lastOutputDigest ?? '(empty)'}`,
    ].join('\n');
  }

  private renderSessionList(sessions: SessionRecord[]): string {
    if (sessions.length === 0) {
      return 'No sessions found.';
    }

    return sessions
      .map((session, index) =>
        [
          `${index + 1}. ${session.name}${session.defaultForActor ? ' (current)' : ''}`,
          `   status: ${session.status}`,
          `   workspace: ${session.workspacePath}`,
          `   tmux: ${session.tmuxSessionName}:${session.tmuxWindowName}`,
        ].join('\n'),
      )
      .join('\n\n');
  }

  private renderInspection(inspection: SessionInspection): string {
    return [
      `Session: ${inspection.session.name}`,
      `Observed: ${inspection.observedState}`,
      `Status: ${inspection.session.status}`,
      `Window: ${inspection.windowExists ? 'present' : 'missing'}`,
      `Note: ${inspection.note}`,
      `Digest: ${inspection.tailDigest ?? '(empty)'}`,
    ].join('\n');
  }

  private renderSupervisorSnapshots(snapshots: SessionInspection[]): string {
    if (snapshots.length === 0) {
      return 'Supervisor has no session snapshots yet.';
    }

    return snapshots
      .map(
        (snapshot, index) =>
          [
            `${index + 1}. ${snapshot.session.name}`,
            `   observed: ${snapshot.observedState}`,
            `   status: ${snapshot.session.status}`,
            `   note: ${snapshot.note}`,
          ].join('\n'),
      )
      .join('\n\n');
  }

  private renderApproval(approval: ApprovalRequestRecord): string {
    return [
      `Approval #${approval.id}: ${approval.title}`,
      `Status: ${approval.status}`,
      `Risk: ${approval.riskLevel}`,
      `Session: ${approval.sessionName ?? '-'}`,
      `Requested by: ${approval.requestedBy ?? '-'}`,
      `Resolved by: ${approval.resolvedBy ?? '-'}`,
      approval.description,
    ].join('\n');
  }

  private renderApprovals(approvals: ApprovalRequestRecord[]): string {
    if (approvals.length === 0) {
      return 'No approvals found.';
    }

    return approvals
      .map((approval) =>
        [
          `#${approval.id} ${approval.title}`,
          `   status: ${approval.status}`,
          `   risk: ${approval.riskLevel}`,
          `   session: ${approval.sessionName ?? '-'}`,
          `   action: /approve ${approval.id}  or  /deny ${approval.id}`,
        ].join('\n'),
      )
      .join('\n\n');
  }

  private renderWorkspaceListing(listing: WorkspaceListing): string {
    if (listing.entries.length === 0) {
      return `No files in ${listing.path || '/'}.`;
    }

    return listing.entries
      .map((entry) => `${entry.isDirectory ? 'dir ' : 'file'} ${entry.path}`)
      .join('\n');
  }

  private renderGitStatus(status: WorkspaceGitStatus): string {
    if (!status.available) {
      return status.reason ?? 'git status unavailable';
    }

    if (status.clean) {
      return `${status.branch ?? 'Git repository'} is clean.`;
    }

    return [
      `Branch: ${status.branch ?? '-'}`,
      ...status.entries.map((entry) => `${entry.status.padEnd(3)} ${entry.path}`),
    ].join('\n');
  }

  private renderTerminalCommand(command: TerminalCommandRecord): string {
    const lines = [
      `Terminal command #${command.id}`,
      `Status: ${command.status}`,
      `Session: ${command.sessionName}`,
      `Command: ${command.command}`,
    ];

    if (command.exitCode !== null) {
      lines.push(`Exit code: ${command.exitCode}`);
    }

    if (command.stdoutTail.trim()) {
      lines.push('', 'stdout:', command.stdoutTail);
    }

    if (command.stderrTail.trim()) {
      lines.push('', 'stderr:', command.stderrTail);
    }

    return lines.join('\n');
  }

  private renderMachines(machines: MachineRecord[]): string {
    if (machines.length === 0) {
      return 'No machines registered.';
    }

    return machines
      .map((machine) =>
        [
          `#${machine.id} ${machine.name}`,
          `   status: ${machine.status}`,
          `   host: ${machine.host ?? '-'}`,
          `   labels: ${machine.labels.join(', ') || '-'}`,
        ].join('\n'),
      )
      .join('\n\n');
  }

  private async resolveMachine(value: string): Promise<MachineRecord> {
    const machines = await this.options.machineService.listMachines();
    const numericId = Number.parseInt(value, 10);
    const machine = Number.isFinite(numericId)
      ? machines.find((item) => item.id === numericId)
      : machines.find((item) => item.name === value);

    if (!machine) {
      throw new NotFoundError(`Machine "${value}" was not found`);
    }

    return machine;
  }
}

function parseId(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function parseApprovalStatus(value: string | undefined): ApprovalStatus | 'all' | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'all') {
    return 'all';
  }

  if (['pending', 'approved', 'denied', 'expired', 'cancelled'].includes(value)) {
    return value as ApprovalStatus;
  }

      throw new ValidationError(
        'Usage: /approvals [pending|executing|approved|denied|failed|expired|cancelled|all]',
      );
}

function isAgentType(value: string | undefined): value is (typeof AGENT_TYPES)[number] {
  return typeof value === 'string' && AGENT_TYPES.includes(value as (typeof AGENT_TYPES)[number]);
}
