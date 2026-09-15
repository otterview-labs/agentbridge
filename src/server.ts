#!/usr/bin/env node

import process from 'node:process';

import { createApplication } from './app/bootstrap.js';
import { HttpApiServer } from './app/http-server.js';

async function main(): Promise<void> {
  const app = createApplication();
  await app.machineService.registerLocalMachine();
  app.notificationService.start();
  const httpServer = new HttpApiServer({
    taskService: app.taskService,
    approvalService: app.approvalService,
    butlerService: app.butlerService,
    commandRouter: app.commandRouter,
    config: app.config,
    conversationService: app.conversationService,
    logger: app.logger.child({ component: 'http-server' }),
    machineService: app.machineService,
    notificationService: app.notificationService,
    sessionEventBus: app.sessionEventBus,
    sessionService: app.sessionService,
    supervisorService: app.supervisorService,
    terminalService: app.terminalService,
    workspaceService: app.workspaceService,
  });

  if (app.config.supervisorEnabled) {
    app.supervisorService.start();
    await app.supervisorService.runInspectionCycle();
  }

  if (app.config.feishuEnabled) {
    await app.feishuChannel.start();
  }

  const address = await httpServer.start();

  const shutdown = async (signal: string) => {
    app.logger.info({ signal }, 'shutting down server');
    app.notificationService.stop();
    app.supervisorService.stop();
    await httpServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  console.log(
    `Agent Session Bridge HTTP server listening on http://${address.host}:${address.port}`,
  );
}

void main();
