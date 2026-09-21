import path from 'node:path';

import { parseConfig } from '../config/env.js';
import { loadEnvFile } from '../config/load-env.js';
import { FeishuApiClient } from '../channels/feishu/api-client.js';
import { FeishuChannel } from '../channels/feishu/channel.js';
import { FeishuTokenService } from '../channels/feishu/token-service.js';
import { ButlerService } from '../services/butler-service.js';
import { ApprovalService } from '../services/approval-service.js';
import { AgentRuntimeService } from '../services/agent-runtime-service.js';
import { CommandRouter } from '../services/command-router.js';
import { ConversationService } from '../services/conversation-service.js';
import { MachineService } from '../services/machine-service.js';
import { NotificationService } from '../services/notification-service.js';
import { ServerManagerService } from '../services/server-manager-service.js';
import { FrpService } from '../services/frp-service.js';
  import { SessionService } from '../services/session-service.js';
  import { SshMachineService } from '../services/ssh-machine-service.js';
import { SessionEventBus } from '../services/session-event-bus.js';
import { SupervisorService } from '../services/supervisor-service.js';
import { TerminalService } from '../services/terminal-service.js';
import { TaskService } from '../services/task-service.js';
import { StudioService } from '../services/studio-service.js';
import { createPiModel } from '../services/pi-studio-model.js';
import { StudioModelSettings } from '../services/studio-model-settings.js';
import { TmuxCliAgentAdapter } from '../services/tmux-cli-agent-adapter.js';
import { TmuxCodexAgentAdapter } from '../services/tmux-codex-agent-adapter.js';
import { WorkspaceService } from '../services/workspace-service.js';
import { LoggerFactory } from '../infra/logger.js';
import { SqliteApprovalRepository } from '../infra/repositories/sqlite-approval-repository.js';
import { SqliteConversationRepository } from '../infra/repositories/sqlite-conversation-repository.js';
import { SqliteMachineRepository } from '../infra/repositories/sqlite-machine-repository.js';
import { DatabaseClient } from '../infra/storage/database.js';
import { SqliteSessionRepository } from '../infra/repositories/sqlite-session-repository.js';
import { SqliteTerminalCommandRepository } from '../infra/repositories/sqlite-terminal-command-repository.js';
import { TmuxManager } from '../infra/tmux/tmux-manager.js';
import { resolveCommandExecutable } from '../utils/runtime-command.js';

export function createApplication() {
  loadEnvFile(process.cwd());
  const config = parseConfig(process.env);
  const logger = LoggerFactory.create(config.logLevel);
  const database = new DatabaseClient(
    path.resolve(config.dbPath),
    logger.child({ component: 'database' }),
  );
  const sessionRepository = new SqliteSessionRepository(
    database,
    logger.child({ component: 'session-repository' }),
  );
  const conversationRepository = new SqliteConversationRepository(
    database,
    logger.child({ component: 'conversation-repository' }),
  );
  const approvalRepository = new SqliteApprovalRepository(
    database,
    logger.child({ component: 'approval-repository' }),
  );
  const terminalCommandRepository = new SqliteTerminalCommandRepository(
    database,
    logger.child({ component: 'terminal-command-repository' }),
  );
  const machineRepository = new SqliteMachineRepository(
    database,
    logger.child({ component: 'machine-repository' }),
  );
  const sessionEventBus = new SessionEventBus(
    logger.child({ component: 'session-event-bus' }),
  );
  const conversationService = new ConversationService({
    eventBus: sessionEventBus,
    logger: logger.child({ component: 'conversation-service' }),
    repository: conversationRepository,
  });
  const tmuxManager = new TmuxManager({
    autoConfirmWorkspaceTrust: config.autoConfirmWorkspaceTrust,
    hubSessionName: config.hubSessionName,
    logger: logger.child({ component: 'tmux' }),
    runtimeCommands: {
      'claude-code': config.claudeBin,
      codex: config.codexBin,
      gemini: config.geminiBin,
    },
  });
  const agentAdapters = {
    'claude-code': new TmuxCliAgentAdapter({
      agentType: 'claude-code',
      logger: logger.child({ component: 'claude-adapter' }),
      tmuxManager,
    }),
    codex: new TmuxCodexAgentAdapter({
      logger: logger.child({ component: 'agent-adapter' }),
      tmuxManager,
    }),
    gemini: new TmuxCliAgentAdapter({
      agentType: 'gemini',
      logger: logger.child({ component: 'gemini-adapter' }),
      tmuxManager,
    }),
  } as const;
  const agentRuntimeService = new AgentRuntimeService({
    config,
    logger: logger.child({ component: 'agent-runtime-service' }),
    supportedAgentTypes: Object.keys(agentAdapters) as ('claude-code' | 'codex' | 'gemini')[],
  });
  const sessionService = new SessionService({
    agentAdapters,
    allowedWorkspaceRoots: config.allowedWorkspaceRoots,
    conversationService,
    defaultTailLines: config.defaultTailLines,
    logger: logger.child({ component: 'session-service' }),
    repository: sessionRepository,
  });
  const serverManagerService = new ServerManagerService({
    configPath: config.serverManagerConfigPath,
    logger: logger.child({ component: 'agent-adapter' }),
    pythonBin: config.pythonBin,
    repoPath: config.serverManagerPath,
  });
  const supervisorService = new SupervisorService({
    conversationService,
    enabled: config.supervisorEnabled,
    intervalMs: config.supervisorIntervalMs,
    logger: logger.child({ component: 'supervisor' }),
    sessionService,
    tailLines: config.supervisorTailLines,
  });
  const workspaceService = new WorkspaceService({
    logger: logger.child({ component: 'workspace-service' }),
    maxDiffCharacters: 24_000,
    maxFilePreviewBytes: 32_000,
    maxListEntries: 200,
    sessionService,
  });
  const terminalService = new TerminalService({
    commandTimeoutMs: 120_000,
    conversationService,
    logger: logger.child({ component: 'terminal-service' }),
    maxOutputCharacters: 24_000,
    repository: terminalCommandRepository,
    sessionEventBus,
    sessionService,
  });
  const approvalService = new ApprovalService({
    conversationService,
    logger: logger.child({ component: 'approval-service' }),
    repository: approvalRepository,
    serverManagerService,
    sessionService,
    terminalService,
  });
  const machineService = new MachineService({
    agentRuntimeService,
    conversationService,
    logger: logger.child({ component: 'machine-service' }),
    repository: machineRepository,
    sessionService,
  });
  const sshMachineService = new SshMachineService({
    claudeBin: resolveCommandExecutable(config.claudeBin),
    codexBin: resolveCommandExecutable(config.codexBin),
    database,
    logger: logger.child({ component: 'ssh-machine-service' }),
    machines: machineService,
  });
  const frpService = new FrpService({
    database,
    downloadBase: config.frpDownloadBase,
    frpcBin: config.frpcBin,
    logger: logger.child({ component: 'frp-service' }),
    machines: machineService,
    ssh: sshMachineService,
    stateDir: path.join(config.dataDir, 'frp'),
    version: config.frpVersion,
  });
  const feishuTokenService = new FeishuTokenService({
    config,
    logger: logger.child({ component: 'feishu-token' }),
  });
  const taskService = new TaskService({ database, sessions: sessionService, machines: machineService });
  const studioModelSettings = new StudioModelSettings({
    database, keyPath: path.join(config.dataDir, 'pi-model.key'), env: process.env, factory: createPiModel,
  });
  const studioService = new StudioService({
    database, tasks: taskService, machines: machineService, ssh: sshMachineService,
    modelProvider: () => studioModelSettings.model(),
  });
  const feishuApiClient = new FeishuApiClient({
    logger: logger.child({ component: 'feishu-api' }),
    replyInThread: config.feishuReplyInThread,
    tokenService: feishuTokenService,
  });
  const notificationService = new NotificationService({
    config,
    eventBus: sessionEventBus,
    feishuApiClient,
    logger: logger.child({ component: 'notification-service' }),
  });
  const butlerService = new ButlerService({
    approvalService,
    agentRuntimeService,
    logger: logger.child({ component: 'butler-service' }),
    machineService,
    serverManagerService,
    sessionService,
  });
  const commandRouter = new CommandRouter({
    approvalService,
    machineService,
    notificationService,
    sessionService,
    supervisorService,
    terminalService,
    workspaceService,
  });
  const feishuChannel = new FeishuChannel({
    apiClient: feishuApiClient,
    commandRouter,
    config,
    logger: logger.child({ component: 'feishu-channel' }),
  });

  return {
    studioModelSettings,
    studioService,
    taskService,
    agentAdapters,
    agentRuntimeService,
    approvalRepository,
    approvalService,
    butlerService,
    commandRouter,
    config,
    conversationRepository,
    conversationService,
    database,
    feishuApiClient,
    feishuChannel,
    feishuTokenService,
    frpService,
    logger,
    machineRepository,
    machineService,
    notificationService,
    serverManagerService,
    sessionEventBus,
    sessionRepository,
    sessionService,
    sshMachineService,
    supervisorService,
    terminalCommandRepository,
    terminalService,
    tmuxManager,
    workspaceService,
  };
}
