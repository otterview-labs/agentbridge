import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP, type AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import nodePath from 'node:path';

import type { Logger } from 'pino';

import { MAX_API_TOKEN_CHARACTERS, type AppConfig } from '../config/env.js';
import { AGENT_TYPES, type AgentType } from '../domain/agent.js';
import type { CommandContext } from '../domain/command.js';
import type { RealtimeSessionEvent } from '../domain/conversation.js';
import {
  ConflictError,
  DomainError,
  NotFoundError,
  PayloadTooLargeError,
} from '../domain/errors.js';
import { ApprovalService } from '../services/approval-service.js';
import { ButlerService } from '../services/butler-service.js';
import { CommandRouter } from '../services/command-router.js';
import { ConversationService } from '../services/conversation-service.js';
import { MachineService } from '../services/machine-service.js';
import { NotificationService } from '../services/notification-service.js';
import { SessionEventBus } from '../services/session-event-bus.js';
import { SessionService } from '../services/session-service.js';
import { SupervisorService } from '../services/supervisor-service.js';
import { TerminalService } from '../services/terminal-service.js';
import { TaskService } from '../services/task-service.js';
import { WorkspaceService } from '../services/workspace-service.js';

type HttpApiServerOptions = {
  taskService: TaskService;
  approvalService: ApprovalService;
  butlerService: ButlerService;
  commandRouter: CommandRouter;
  config: AppConfig;
  conversationService: ConversationService;
  logger: Logger;
  machineService: MachineService;
  notificationService: NotificationService;
  sessionEventBus: SessionEventBus;
  sessionService: SessionService;
  supervisorService: SupervisorService;
  terminalService: TerminalService;
  workspaceService: WorkspaceService;
};

type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const STATIC_ASSETS = new Map<string, string>([
  ['/', 'index.html'],
  ['/ui', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.css', 'app.css'],
  ['/app.js', 'app.js'],
  ['/api-token-state.js', 'api-token-state.js'],
  ['/work-status.js', 'work-status.js'],
  ['/command-center.js', 'command-center.js'],
  ['/manifest.webmanifest', 'manifest.webmanifest'],
  ['/service-worker.js', 'service-worker.js'],
  ['/icon.svg', 'icon.svg'],
]);

const CONTENT_TYPES = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

export const MAX_AUTHORIZATION_HEADER_CHARACTERS = MAX_API_TOKEN_CHARACTERS + 7;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class HttpApiServer {
  private server: Server | null = null;

  constructor(private readonly options: HttpApiServerOptions) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      throw new Error('HTTP server is already running');
    }

    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.config.httpPort, this.options.config.httpHost, () => {
        resolve();
      });
    });

    const address = this.server.address() as AddressInfo;
    this.options.logger.info(
      { host: address.address, port: address.port },
      'HTTP server started',
    );

    return {
      host: address.address,
      port: address.port,
    };
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      this.setSecurityHeaders(response);
      const method = request.method ?? 'GET';
      this.validateHost(request);
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;

      if (method === 'GET' && STATIC_ASSETS.has(pathname)) {
        await this.sendStaticAsset(response, pathname);
        return;
      }

      this.authorize(request);

      if (method === 'GET' && pathname === '/tasks') {
        this.sendJson(response, 200, { tasks: await this.options.taskService.list() });
        return;
      }
      if (method === 'POST' && pathname === '/tasks') {
        const body = await this.readJsonBody(request);
        const task = await this.options.taskService.create(body, resolveActorId(body, request));
        this.sendJson(response, 201, { task });
        return;
      }
      const taskAction = /^\/tasks\/([1-9]\d*)\/(dispatch|review|complete|cancel)$/u.exec(pathname);
      if (method === 'POST' && taskAction) {
        const body = await this.readJsonBody(request);
        const task = await this.options.taskService.action(
          Number(taskAction[1]), taskAction[2]!, resolveActorId(body, request),
          getOptionalString(body.evidence) ?? '',
        );
        this.sendJson(response, 200, { task });
        return;
      }

      if (method === 'GET' && pathname === '/events') {
        this.handleEvents(request, response, url);
        return;
      }

      if (method === 'GET' && pathname === '/health') {
        this.sendJson(response, 200, {
          ok: true,
          service: 'agent-session-bridge',
          supervisor: this.options.supervisorService.getState(),
        });
        return;
      }

      if (method === 'GET' && pathname === '/sessions') {
        const sessions = await this.options.sessionService.listSessions();
        const snapshots = this.options.supervisorService.getState().latestSnapshots;
        this.sendJson(response, 200, {
          sessions,
          snapshots,
        });
        return;
      }

      if (method === 'POST' && pathname === '/sessions') {
        const body = await this.readJsonBody(request);
        const actorId = resolveActorId(body, request);
        const session = await this.options.sessionService.createSession({
          actorId,
          agentType: parseAgentType(getOptionalString(body.agentType)),
          name: requireString(body.name, 'name'),
          workspacePath: requireString(body.workspacePath, 'workspacePath'),
        });
        this.sendJson(response, 201, {
          ok: true,
          session,
        });
        return;
      }

      if (method === 'GET' && pathname === '/supervisor') {
        this.sendJson(response, 200, this.options.supervisorService.getState());
        return;
      }

      if (method === 'POST' && pathname === '/supervisor/run') {
        const snapshots = await this.options.supervisorService.runInspectionCycle();
        this.sendJson(response, 200, {
          ok: true,
          snapshots,
        });
        return;
      }

      if (method === 'POST' && pathname === '/command') {
        const body = await this.readJsonBody(request);
        const command = requireString(body.command, 'command');
        const actorId = resolveActorId(body, request);
        const output = await this.options.commandRouter.execute(command, {
          actorId,
        } satisfies CommandContext);
        this.sendJson(response, 200, {
          ok: true,
          output,
        });
        return;
      }

      if (method === 'GET' && pathname === '/approvals') {
        const status = parseApprovalStatusQuery(url.searchParams.get('status'));
        const limit = parsePositiveInt(url.searchParams.get('limit'), 200) ?? 50;
        const approvals = await this.options.approvalService.listApprovals({
          limit,
          status,
        });
        this.sendJson(response, 200, {
          approvals,
        });
        return;
      }

      const approvalActionMatch = matchApprovalAction(pathname);

      if (method === 'POST' && approvalActionMatch?.action === 'approve') {
        const body = await this.readJsonBody(request);
        const approval = await this.options.approvalService.approve(
          approvalActionMatch.id,
          resolveActorId(body, request),
        );
        this.sendJson(response, 200, {
          approval,
          ok: true,
        });
        return;
      }

      if (method === 'POST' && approvalActionMatch?.action === 'deny') {
        const body = await this.readJsonBody(request);
        const approval = await this.options.approvalService.deny(
          approvalActionMatch.id,
          resolveActorId(body, request),
          getOptionalString(body.reason),
        );
        this.sendJson(response, 200, {
          approval,
          ok: true,
        });
        return;
      }

      if (method === 'GET' && pathname === '/machines') {
        const machines = await this.options.machineService.listMachines();
        this.sendJson(response, 200, {
          machines,
        });
        return;
      }

      if (method === 'GET' && pathname === '/agent-runtimes') {
        const overview = await this.options.butlerService.getOverview();
        this.sendJson(response, 200, {
          runtimes: overview.runtimes,
        });
        return;
      }

      if (method === 'GET' && pathname === '/butler/overview') {
        const overview = await this.options.butlerService.getOverview();
        this.sendJson(response, 200, overview);
        return;
      }

      if (method === 'POST' && pathname === '/notifications/test') {
        const body = await this.readJsonBody(request);
        const result = await this.options.notificationService.sendTestNotification(
          resolveActorId(body, request),
        );
        this.sendJson(response, 200, {
          ok: true,
          result,
        });
        return;
      }

      if (method === 'POST' && pathname === '/machines/register') {
        const body = await this.readJsonBody(request);
        const machine = await this.options.machineService.registerMachine({
          capabilities: getOptionalJsonObject(body.capabilities) ?? undefined,
          host: getOptionalString(body.host),
          labels: getOptionalStringArray(body.labels),
          name: requireString(body.name, 'name'),
          namespace: getOptionalString(body.namespace) ?? undefined,
          runnerVersion: getOptionalString(body.runnerVersion),
        });
        this.sendJson(response, 201, {
          machine,
          ok: true,
        });
        return;
      }

      const machineHeartbeatMatch = matchMachineHeartbeat(pathname);

      if (method === 'POST' && machineHeartbeatMatch) {
        const machine = await this.options.machineService.heartbeat(machineHeartbeatMatch.id);
        this.sendJson(response, 200, {
          machine,
          ok: true,
        });
        return;
      }

      const machineSpawnMatch = matchMachineSpawn(pathname);

      if (method === 'POST' && machineSpawnMatch) {
        const body = await this.readJsonBody(request);
        const session = await this.options.machineService.spawnSession({
          actorId: resolveActorId(body, request),
          agentType: parseAgentType(getOptionalString(body.agentType)),
          machineId: machineSpawnMatch.id,
          name: requireString(body.name, 'name'),
          workspacePath: requireString(body.workspacePath, 'workspacePath'),
        });
        this.sendJson(response, 201, {
          ok: true,
          session,
        });
        return;
      }

      const managedServerDoctorMatch = matchManagedServerDoctor(pathname);

      if (method === 'GET' && managedServerDoctorMatch) {
        const doctor = await this.options.butlerService.doctorManagedServer(
          managedServerDoctorMatch.serverName,
        );
        this.sendJson(response, 200, doctor);
        return;
      }

      const managedServiceStatusMatch = matchManagedServiceStatus(pathname);

      if (method === 'GET' && managedServiceStatusMatch) {
        const status = await this.options.butlerService.getManagedServiceStatus(
          managedServiceStatusMatch.serverName,
          managedServiceStatusMatch.projectName,
        );
        this.sendJson(response, 200, status);
        return;
      }

      const managedServiceLogsMatch = matchManagedServiceLogs(pathname);

      if (method === 'GET' && managedServiceLogsMatch) {
        const logs = await this.options.butlerService.getManagedServiceLogs(
          managedServiceLogsMatch.serverName,
          managedServiceLogsMatch.projectName,
          parsePositiveInt(url.searchParams.get('lines'), 2000) ?? 120,
        );
        this.sendJson(response, 200, logs);
        return;
      }

      const managedServiceActionMatch = matchManagedServiceAction(pathname);

      if (method === 'POST' && managedServiceActionMatch) {
        const body = await this.readJsonBody(request);
        const actorId = resolveActorId(body, request);
        const approval = await this.options.approvalService.requestManagedServiceAction({
          action: managedServiceActionMatch.action,
          actorId,
          projectName: managedServiceActionMatch.projectName,
          riskLevel: managedServiceActionMatch.action === 'stop' ? 'high' : 'medium',
          serverName: managedServiceActionMatch.serverName,
        });
        this.sendJson(response, 202, {
          approval,
          ok: true,
          requiresApproval: true,
        });
        return;
      }

      const managedServiceExecMatch = matchManagedServiceExec(pathname);

      if (method === 'POST' && managedServiceExecMatch) {
        const body = await this.readJsonBody(request);
        const actorId = resolveActorId(body, request);
        const command = requireString(body.command, 'command');
        const risk = this.options.terminalService.assessCommandRisk(command);

        if (risk.requiresApproval) {
          const approval = await this.options.approvalService.requestManagedServiceAction({
            action: 'exec',
            actorId,
            command,
            projectName: managedServiceExecMatch.projectName,
            riskLevel: risk.riskLevel,
            serverName: managedServiceExecMatch.serverName,
          });
          this.sendJson(response, 202, {
            approval,
            ok: true,
            requiresApproval: true,
            risk,
          });
          return;
        }

        const result = await this.options.butlerService.executeManagedCommand(
          managedServiceExecMatch.serverName,
          managedServiceExecMatch.projectName,
          command,
        );
        this.sendJson(response, 200, {
          ok: true,
          requiresApproval: false,
          result,
          risk,
        });
        return;
      }

      const tailMatch = matchSessionTail(pathname);

      if (method === 'GET' && tailMatch) {
        const lines = parsePositiveInt(url.searchParams.get('lines'), 2000) ?? undefined;
        const output = lines
          ? await this.options.sessionService.inspectSession(tailMatch.name, lines)
          : await this.options.sessionService.inspectSession(tailMatch.name);
        this.sendJson(response, 200, output);
        return;
      }

      const sessionMatch = matchSession(pathname);

      if (method === 'GET' && sessionMatch) {
        const inspection = await this.options.sessionService.inspectSession(sessionMatch.name);
        this.sendJson(response, 200, inspection);
        return;
      }

      const sessionMessagesMatch = matchSessionMessages(pathname);

      if (method === 'GET' && sessionMessagesMatch) {
        const limit = parsePositiveInt(url.searchParams.get('limit'), 200) ?? 80;
        const session = await this.options.sessionService.requireByName(sessionMessagesMatch.name);
        const messages = await this.options.conversationService.listMessagesBySession(
          session.id,
          limit,
        );
        this.sendJson(response, 200, {
          messages,
          session,
        });
        return;
      }

      if (method === 'POST' && sessionMessagesMatch) {
        const body = await this.readJsonBody(request);
        const session = await this.options.sessionService.sendPrompt({
          actorId: resolveActorId(body, request),
          name: sessionMessagesMatch.name,
          prompt: requireString(body.prompt, 'prompt'),
        });
        this.sendJson(response, 200, {
          ok: true,
          session,
        });
        return;
      }

      const sessionUseMatch = matchSessionUse(pathname);

      if (method === 'POST' && sessionUseMatch) {
        const body = await this.readJsonBody(request);
        const session = await this.options.sessionService.setCurrentSession(
          resolveActorId(body, request),
          sessionUseMatch.name,
        );
        this.sendJson(response, 200, {
          ok: true,
          session,
        });
        return;
      }

      const sessionStopMatch = matchSessionStop(pathname);

      if (method === 'POST' && sessionStopMatch) {
        const body = await this.readJsonBody(request);
        const approval = await this.options.approvalService.requestSessionStop({
          actorId: resolveActorId(body, request),
          sessionName: sessionStopMatch.name,
        });
        this.sendJson(response, 202, {
          approval,
          ok: true,
        });
        return;
      }

      const sessionFilesMatch = matchSessionFiles(pathname);

      if (method === 'GET' && sessionFilesMatch) {
        const listing = await this.options.workspaceService.listFiles(
          sessionFilesMatch.name,
          getOptionalString(url.searchParams.get('path')) ?? '',
        );
        this.sendJson(response, 200, listing);
        return;
      }

      const sessionFileMatch = matchSessionFile(pathname);

      if (method === 'GET' && sessionFileMatch) {
        const filePath = requireString(url.searchParams.get('path'), 'path');
        const preview = await this.options.workspaceService.readFilePreview(
          sessionFileMatch.name,
          filePath,
        );
        this.sendJson(response, 200, preview);
        return;
      }

      const sessionGitStatusMatch = matchSessionGitStatus(pathname);

      if (method === 'GET' && sessionGitStatusMatch) {
        const gitStatus = await this.options.workspaceService.getGitStatus(
          sessionGitStatusMatch.name,
        );
        this.sendJson(response, 200, gitStatus);
        return;
      }

      const sessionGitDiffMatch = matchSessionGitDiff(pathname);

      if (method === 'GET' && sessionGitDiffMatch) {
        const gitDiff = await this.options.workspaceService.getGitDiff(
          sessionGitDiffMatch.name,
          getOptionalString(url.searchParams.get('path')) ?? undefined,
        );
        this.sendJson(response, 200, gitDiff);
        return;
      }

      const sessionTerminalCommandsMatch = matchSessionTerminalCommands(pathname);

      if (method === 'GET' && sessionTerminalCommandsMatch) {
        const commands = await this.options.terminalService.listCommands(
          sessionTerminalCommandsMatch.name,
          parsePositiveInt(url.searchParams.get('limit'), 200) ?? 20,
        );
        this.sendJson(response, 200, {
          commands,
        });
        return;
      }

      if (method === 'POST' && sessionTerminalCommandsMatch) {
        const body = await this.readJsonBody(request);
        const actorId = resolveActorId(body, request);
        const command = requireString(body.command, 'command');
        const risk = this.options.terminalService.assessCommandRisk(command);

        if (risk.requiresApproval) {
          const approval = await this.options.approvalService.requestTerminalCommand({
            actorId,
            command,
            riskLevel: risk.riskLevel,
            sessionName: sessionTerminalCommandsMatch.name,
          });
          this.sendJson(response, 202, {
            approval,
            ok: true,
            requiresApproval: true,
            risk,
          });
          return;
        }

        const terminalCommand = await this.options.terminalService.startCommand({
          actorId,
          command,
          sessionName: sessionTerminalCommandsMatch.name,
        });
        this.sendJson(response, 202, {
          command: terminalCommand,
          ok: true,
          requiresApproval: false,
          risk,
        });
        return;
      }

      const terminalCommandMatch = matchTerminalCommand(pathname);

      if (method === 'GET' && terminalCommandMatch) {
        const terminalCommand = await this.options.terminalService.getCommand(
          terminalCommandMatch.id,
        );
        this.sendJson(response, 200, {
          command: terminalCommand,
        });
        return;
      }

      const terminalCommandCancelMatch = matchTerminalCommandCancel(pathname);

      if (method === 'POST' && terminalCommandCancelMatch) {
        const body = await this.readJsonBody(request);
        const terminalCommand = await this.options.terminalService.cancelCommand(
          terminalCommandCancelMatch.id,
          resolveActorId(body, request),
        );
        this.sendJson(response, 200, {
          command: terminalCommand,
          ok: true,
        });
        return;
      }

      this.sendJson(response, 404, {
        error: 'Not Found',
      });
    } catch (error) {
      this.handleError(response, error);
    }
  }

  private async sendStaticAsset(
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const assetName = STATIC_ASSETS.get(pathname);

    if (!assetName) {
      this.sendJson(response, 404, {
        error: 'Not Found',
      });
      return;
    }

    const filePath = nodePath.join(process.cwd(), 'public', assetName);
    const contentType =
      CONTENT_TYPES.get(nodePath.extname(filePath)) ?? 'application/octet-stream';
    const content = await readFile(filePath);

    response.statusCode = 200;
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'no-store');
    response.end(content);
  }

  private authorize(request: IncomingMessage): void {
    const token = this.options.config.apiToken;

    if (!token) {
      return;
    }

    const header = request.headers.authorization;
    const providedBearer = parseBearerToken(header);
    const rawHeader = request.headers['x-asb-token'];
    const providedRaw =
      typeof rawHeader === 'string' &&
      rawHeader.length <= MAX_API_TOKEN_CHARACTERS
        ? rawHeader
        : null;
    const providedToken = providedBearer ?? providedRaw;

    if (!providedToken || !tokensMatch(providedToken, token)) {
      throw new DomainError('Unauthorized');
    }
  }

  private handleError(response: ServerResponse, error: unknown): void {
    this.options.logger.error({ err: error }, 'HTTP request failed');

    if (error instanceof DomainError) {
      const statusCode =
        error.message === 'Unauthorized'
          ? 401
          : error instanceof NotFoundError
            ? 404
            : error instanceof ConflictError
              ? 409
              : error instanceof PayloadTooLargeError
                ? 413
                : 400;
      this.sendJson(response, statusCode, {
        error: error.message,
      });
      return;
    }

    this.sendJson(response, 500, {
      error: 'Internal server error',
    });
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const contentType =
      request.headers['content-type']?.toString().split(';', 1)[0]?.trim().toLowerCase() ?? '';

    if (contentType !== 'application/json') {
      throw new DomainError('Content-Type must be application/json');
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;

      if (totalBytes > MAX_JSON_BODY_BYTES) {
        throw new PayloadTooLargeError(
          `JSON request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
        );
      }

      chunks.push(buffer);
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();

    if (!raw) {
      return {};
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new DomainError('Request body must contain valid JSON');
    }

    if (!isRecord(parsed)) {
      throw new DomainError('Request body must be a JSON object');
    }

    return parsed;
  }

  private sendJson(response: ServerResponse, statusCode: number, payload: JsonValue): void {
    response.statusCode = statusCode;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload, null, 2));
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
  }

  private validateHost(request: IncomingMessage): void {
    const header = request.headers.host;

    if (!header) {
      throw new DomainError('Host header is required');
    }

    const requestedHost = parseHostHeader(header);

    const configuredHost = normalizeHostname(this.options.config.httpHost);
    const allowedHosts = new Set(
      this.options.config.allowedHttpHosts.map(normalizeHostname),
    );

    if (isLoopbackHostname(configuredHost)) {
      allowedHosts.add('127.0.0.1');
      allowedHosts.add('localhost');
      allowedHosts.add('::1');
    } else if (configuredHost !== '0.0.0.0' && configuredHost !== '::') {
      allowedHosts.add(configuredHost);
    }

    if (!allowedHosts.has(requestedHost)) {
      throw new DomainError('Host header is not allowed');
    }
  }

  private handleEvents(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void {
    const sessionNameFilter = getOptionalString(url.searchParams.get('session'));
    const afterId = request.headers['last-event-id']?.toString() ?? url.searchParams.get('after');

    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();
    response.write(': connected\n\n');

    const unsubscribe = this.options.sessionEventBus.subscribe(
      (event) => {
        if (sessionNameFilter && event.sessionName !== sessionNameFilter) {
          return;
        }

        response.write(formatSseEvent(event));
      },
      {
        afterId,
      },
    );

    const heartbeat = setInterval(() => {
      response.write(': keep-alive\n\n');
    }, 15_000);

    let closed = false;

    const cleanup = () => {
      if (closed) {
        return;
      }

      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    };

    request.on('close', cleanup);
    response.on('close', cleanup);
    request.on('error', cleanup);
  }
}

export function parseBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  if (header.slice(0, 6).toLowerCase() !== 'bearer') {
    return null;
  }

  if (header.length === 6) {
    return '';
  }

  const delimiter = header.charCodeAt(6);
  if (delimiter !== 0x20) {
    // A following RFC tchar means this is a different (longer) auth scheme,
    // while any other delimiter is a malformed Bearer attempt that must not
    // fall back to the alternate token header.
    return isHttpTokenCharacter(delimiter) ? null : '';
  }

  // Preserve the distinction between an absent Bearer scheme (null) and a
  // present but invalid credential ('') so malformed Authorization headers
  // cannot unexpectedly fall back to X-ASB-Token.
  if (header.length > MAX_AUTHORIZATION_HEADER_CHARACTERS) {
    return '';
  }

  let tokenStart = 7;
  while (header.charCodeAt(tokenStart) === 0x20) {
    tokenStart += 1;
  }

  let tokenEnd = header.length;
  while (tokenEnd > tokenStart && header.charCodeAt(tokenEnd - 1) === 0x20) {
    tokenEnd -= 1;
  }

  for (let index = tokenStart; index < tokenEnd; index += 1) {
    const character = header.charCodeAt(index);
    if (character < 0x21 || character > 0x7e) {
      return '';
    }
  }

  return header.slice(tokenStart, tokenEnd);
}

export function tokensMatch(provided: string, expected: string): boolean {
  // These ephemeral digests only normalize bearer token values to a fixed
  // length for timingSafeEqual. They are never stored or exposed and are not
  // password verifiers. UTF-16LE preserves exact JavaScript code units.
  const providedDigest = createHash('sha256').update(provided, 'utf16le').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf16le').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function isHttpTokenCharacter(character: number): boolean {
  return (
    (character >= 0x30 && character <= 0x39) ||
    (character >= 0x41 && character <= 0x5a) ||
    (character >= 0x61 && character <= 0x7a) ||
    "!#$%&'*+-.^_`|~".includes(String.fromCharCode(character))
  );
}

export function parseHostHeader(header: string): string {
  if (
    header !== header.trim() ||
    /[\u0000-\u0020\u007f,\/@?#\\]/u.test(header)
  ) {
    throw new DomainError('Host header is invalid');
  }

  let hostname: string;
  let port: string | undefined;

  if (header.startsWith('[')) {
    const match = header.match(/^\[([0-9a-f:.]+)\](?::([0-9]{1,5}))?$/iu);

    if (!match?.[1] || isIP(match[1]) !== 6) {
      throw new DomainError('Host header is invalid');
    }

    hostname = match[1];
    port = match[2];
  } else {
    const match = header.match(/^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/iu);

    if (!match?.[1] || !isValidDnsOrIpv4Hostname(match[1])) {
      throw new DomainError('Host header is invalid');
    }

    hostname = match[1];
    port = match[2];
  }

  if (port) {
    const portNumber = Number.parseInt(port, 10);

    if (portNumber < 1 || portNumber > 65_535) {
      throw new DomainError('Host header is invalid');
    }
  }

  return normalizeHostname(hostname);
}

function isValidDnsOrIpv4Hostname(hostname: string): boolean {
  if (isIP(hostname) === 4) {
    return true;
  }

  if (isIP(hostname) !== 0 || hostname.length > 253) {
    return false;
  }

  return hostname
    .split('.')
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
    );
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/gu, '');
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'))
  );
}

function getOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim());
}

function getOptionalJsonObject(value: unknown): { [key: string]: JsonValue } | null {
  if (!isRecord(value)) {
    return null;
  }

  return value as { [key: string]: JsonValue };
}

function resolveActorId(body: Record<string, unknown>, request: IncomingMessage): string {
  return (
    getOptionalString(body.actorId) ??
    request.headers['x-asb-actor']?.toString() ??
    'http-api'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchApprovalAction(pathname: string): { action: 'approve' | 'deny'; id: number } | null {
  const match = pathname.match(/^\/approvals\/(\d+)\/(approve|deny)$/u);
  return match?.[1] && match[2]
    ? { action: match[2] as 'approve' | 'deny', id: Number.parseInt(match[1], 10) }
    : null;
}

function matchSession(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchSessionMessages(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/messages$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchSessionUse(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/use$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchSessionStop(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/stop$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchSessionFiles(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/files$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchSessionFile(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/file$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchSessionGitStatus(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/git\/status$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchSessionGitDiff(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/git\/diff$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchSessionTerminalCommands(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/terminal\/commands$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchSessionTail(pathname: string): { name: string } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/tail$/u);
  return match?.[1] ? { name: decodeURIComponent(match[1]) } : null;
}

function matchTerminalCommand(pathname: string): { id: number } | null {
  const match = pathname.match(/^\/terminal\/commands\/(\d+)$/u);
  return match?.[1] ? { id: Number.parseInt(match[1], 10) } : null;
}

function matchTerminalCommandCancel(pathname: string): { id: number } | null {
  const match = pathname.match(/^\/terminal\/commands\/(\d+)\/cancel$/u);
  return match?.[1] ? { id: Number.parseInt(match[1], 10) } : null;
}

function matchMachineHeartbeat(pathname: string): { id: number } | null {
  const match = pathname.match(/^\/machines\/(\d+)\/heartbeat$/u);
  return match?.[1] ? { id: Number.parseInt(match[1], 10) } : null;
}

function matchMachineSpawn(pathname: string): { id: number } | null {
  const match = pathname.match(/^\/machines\/(\d+)\/spawn$/u);
  return match?.[1] ? { id: Number.parseInt(match[1], 10) } : null;
}

function matchManagedServerDoctor(pathname: string): { serverName: string } | null {
  const match = pathname.match(/^\/butler\/servers\/([^/]+)\/doctor$/u);
  return match?.[1] ? { serverName: decodeURIComponent(match[1]) } : null;
}

function matchManagedServiceStatus(
  pathname: string,
): { projectName: string; serverName: string } | null {
  const match = pathname.match(/^\/butler\/services\/([^/]+)\/([^/]+)\/status$/u);
  return match?.[1] && match[2]
    ? {
        projectName: decodeURIComponent(match[2]),
        serverName: decodeURIComponent(match[1]),
      }
    : null;
}

function matchManagedServiceLogs(
  pathname: string,
): { projectName: string; serverName: string } | null {
  const match = pathname.match(/^\/butler\/services\/([^/]+)\/([^/]+)\/logs$/u);
  return match?.[1] && match[2]
    ? {
        projectName: decodeURIComponent(match[2]),
        serverName: decodeURIComponent(match[1]),
      }
    : null;
}

function matchManagedServiceAction(
  pathname: string,
): { action: 'restart' | 'start' | 'stop'; projectName: string; serverName: string } | null {
  const match = pathname.match(
    /^\/butler\/services\/([^/]+)\/([^/]+)\/actions\/(start|stop|restart)$/u,
  );
  return match?.[1] && match[2] && match[3]
    ? {
        action: match[3] as 'restart' | 'start' | 'stop',
        projectName: decodeURIComponent(match[2]),
        serverName: decodeURIComponent(match[1]),
      }
    : null;
}

function matchManagedServiceExec(
  pathname: string,
): { projectName: string; serverName: string } | null {
  const match = pathname.match(/^\/butler\/services\/([^/]+)\/([^/]+)\/exec$/u);
  return match?.[1] && match[2]
    ? {
        projectName: decodeURIComponent(match[2]),
        serverName: decodeURIComponent(match[1]),
      }
    : null;
}

function parsePositiveInt(value: string | null, maximum: number): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : null;
}

function parseApprovalStatusQuery(
  value: string | null,
): 'approved' | 'cancelled' | 'denied' | 'executing' | 'expired' | 'failed' | 'pending' | null {
  if (!value || value === 'all') {
    return null;
  }

  if (
    ['pending', 'executing', 'approved', 'denied', 'failed', 'expired', 'cancelled'].includes(value)
  ) {
    return value as
      | 'approved'
      | 'cancelled'
      | 'denied'
      | 'executing'
      | 'expired'
      | 'failed'
      | 'pending';
  }

  throw new DomainError(
    'Query "status" must be pending, executing, approved, denied, failed, expired, cancelled, or all',
  );
}

function parseAgentType(value: string | null): AgentType {
  if (!value) {
    return 'codex';
  }

  if (AGENT_TYPES.includes(value as AgentType)) {
    return value as AgentType;
  }

  throw new DomainError(
    `Unsupported agentType "${value}". Currently supported: ${AGENT_TYPES.join(', ')}`,
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DomainError(`Field "${field}" must be a non-empty string`);
  }

  return value.trim();
}

function formatSseEvent(event: RealtimeSessionEvent): string {
  return [
    `id: ${event.id}`,
    `event: ${event.eventType}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}
