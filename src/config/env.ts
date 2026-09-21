import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';

import { z } from 'zod';

export const MAX_API_TOKEN_CHARACTERS = 4096;

function booleanFromEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value !== 'string') {
      return defaultValue;
    }

    const normalized = value.trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
      return false;
    }

    return defaultValue;
  }, z.boolean());
}

const apiTokenSchema = z
  .string()
  .trim()
  .max(MAX_API_TOKEN_CHARACTERS, {
    message: `ASB_API_TOKEN must contain at most ${MAX_API_TOKEN_CHARACTERS} characters`,
  })
  .refine(hasOnlyVisibleAsciiCharacters, {
    message: 'ASB_API_TOKEN must use visible ASCII characters without spaces',
  });

const envSchema = z.object({
  ASB_ALLOWED_HTTP_HOSTS: z.string().optional(),
  ASB_ALLOWED_WORKSPACE_ROOTS: z.string().optional(),
  ASB_API_TOKEN: apiTokenSchema.optional(),
  ASB_AUTO_CONFIRM_WORKSPACE_TRUST: booleanFromEnv(false).default(false),
  ASB_CLAUDE_BIN: z.string().default('claude'),
  ASB_CODEX_BIN: z.string().default('codex --no-alt-screen'),
  ASB_DATA_DIR: z.string().default('./data'),
  ASB_DB_PATH: z.string().optional(),
  ASB_DEFAULT_TAIL_LINES: z.coerce.number().int().positive().default(120),
  ASB_FEISHU_ALLOWED_CHAT_IDS: z.string().optional(),
  ASB_FEISHU_ALLOWED_OPEN_IDS: z.string().optional(),
  ASB_FEISHU_APP_ID: z.string().optional(),
  ASB_FEISHU_APP_SECRET: z.string().optional(),
  ASB_FEISHU_ENABLED: booleanFromEnv(false).default(false),
  ASB_FEISHU_GROUP_PREFIX: z.string().optional(),
  ASB_FEISHU_NOTIFY_CHAT_IDS: z.string().optional(),
  ASB_FEISHU_REPLY_IN_THREAD: booleanFromEnv(true).default(true),
  ASB_FRPC_BIN: z.string().optional(),
  ASB_FRP_DOWNLOAD_BASE: z.string().default('https://github.com/fatedier/frp/releases/download'),
  ASB_FRP_VERSION: z.string().default('0.61.1'),
  ASB_GEMINI_BIN: z.string().default('gemini'),
  ASB_HUB_SESSION_NAME: z.string().min(1).default('codex-hub'),
  ASB_HTTP_HOST: z.string().default('127.0.0.1'),
  ASB_HTTP_PORT: z.coerce.number().int().positive().max(65535).default(8787),
  ASB_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  ASB_PYTHON_BIN: z.string().default('python3'),
  ASB_SERVER_MANAGER_CONFIG: z.string().default('servers_config.json'),
  ASB_SERVER_MANAGER_PATH: z.string().default('../server-manager'),
  ASB_SUPERVISOR_ENABLED: booleanFromEnv(true).default(true),
  ASB_SUPERVISOR_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  ASB_SUPERVISOR_TAIL_LINES: z.coerce.number().int().positive().default(80),
  ASB_VOICE_ENGINE: z.enum(['local-whisper']).default('local-whisper'),
  ASB_WHISPER_BIN: z.string().default('whisper-cli'),
  ASB_WHISPER_MODEL: z.string().optional(),
  ASB_WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
});

export type AppConfig = {
  allowedHttpHosts: string[];
  allowedWorkspaceRoots: string[];
  apiToken: string | null;
  autoConfirmWorkspaceTrust: boolean;
  claudeBin: string;
  codexBin: string;
  dataDir: string;
  dbPath: string;
  defaultTailLines: number;
  feishuAllowedChatIds: string[];
  feishuAllowedOpenIds: string[];
  feishuAppId: string | null;
  feishuAppSecret: string | null;
  feishuEnabled: boolean;
  feishuGroupPrefix: string | null;
  feishuNotifyChatIds: string[];
  feishuReplyInThread: boolean;
  frpcBin: string | null;
  frpDownloadBase: string;
  frpVersion: string;
  geminiBin: string;
  hubSessionName: string;
  httpHost: string;
  httpPort: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  pythonBin: string;
  serverManagerConfigPath: string;
  serverManagerPath: string;
  supervisorEnabled: boolean;
  supervisorIntervalMs: number;
  supervisorTailLines: number;
  voiceEngine: 'local-whisper';
  whisperBin: string;
  whisperModel: string;
  whisperTimeoutMs: number;
};

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse(env);
  const allowedHttpHosts = splitList(parsed.ASB_ALLOWED_HTTP_HOSTS).map(normalizeHost);
  const allowedWorkspaceRoots = splitRoots(parsed.ASB_ALLOWED_WORKSPACE_ROOTS);
  const apiToken = parsed.ASB_API_TOKEN?.trim() ? parsed.ASB_API_TOKEN.trim() : null;
  const feishuAllowedChatIds = splitList(parsed.ASB_FEISHU_ALLOWED_CHAT_IDS);
  const feishuAllowedOpenIds = splitList(parsed.ASB_FEISHU_ALLOWED_OPEN_IDS);

  if (!isLoopbackHost(parsed.ASB_HTTP_HOST)) {
    if (!apiToken || apiToken.length < 32) {
      throw new Error(
        'ASB_API_TOKEN must contain at least 32 characters when ASB_HTTP_HOST is not loopback',
      );
    }

    if (allowedWorkspaceRoots.length === 0) {
      throw new Error(
        'ASB_ALLOWED_WORKSPACE_ROOTS is required when ASB_HTTP_HOST is not loopback',
      );
    }

    if (isWildcardHost(parsed.ASB_HTTP_HOST) && allowedHttpHosts.length === 0) {
      throw new Error(
        'ASB_ALLOWED_HTTP_HOSTS is required when ASB_HTTP_HOST binds to all interfaces',
      );
    }
  }

  if (
    parsed.ASB_FEISHU_ENABLED &&
    feishuAllowedChatIds.length === 0 &&
    feishuAllowedOpenIds.length === 0
  ) {
    throw new Error(
      'At least one Feishu allowlist is required when ASB_FEISHU_ENABLED is true',
    );
  }

  const dataDir = path.resolve(parsed.ASB_DATA_DIR);
  const serverManagerPath = path.resolve(parsed.ASB_SERVER_MANAGER_PATH);
  const serverManagerConfigPath = path.isAbsolute(parsed.ASB_SERVER_MANAGER_CONFIG)
    ? parsed.ASB_SERVER_MANAGER_CONFIG
    : path.join(serverManagerPath, parsed.ASB_SERVER_MANAGER_CONFIG);
  const whisperModelSetting = parsed.ASB_WHISPER_MODEL
    ? parsed.ASB_WHISPER_MODEL.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), parsed.ASB_WHISPER_MODEL.slice(2))
      : parsed.ASB_WHISPER_MODEL
    : path.join(os.homedir(), '.cache', 'whisper.cpp', 'ggml-base.bin');
  const whisperModel = path.resolve(whisperModelSetting);
  const dbPath = parsed.ASB_DB_PATH
    ? path.resolve(parsed.ASB_DB_PATH)
    : path.join(dataDir, 'agent-session-bridge.sqlite');

  return {
    allowedHttpHosts,
    allowedWorkspaceRoots,
    apiToken,
    autoConfirmWorkspaceTrust: parsed.ASB_AUTO_CONFIRM_WORKSPACE_TRUST,
    claudeBin: parsed.ASB_CLAUDE_BIN,
    codexBin: parsed.ASB_CODEX_BIN,
    dataDir,
    dbPath,
    defaultTailLines: parsed.ASB_DEFAULT_TAIL_LINES,
    feishuAllowedChatIds,
    feishuAllowedOpenIds,
    feishuAppId: parsed.ASB_FEISHU_APP_ID?.trim() ? parsed.ASB_FEISHU_APP_ID.trim() : null,
    feishuAppSecret: parsed.ASB_FEISHU_APP_SECRET?.trim()
      ? parsed.ASB_FEISHU_APP_SECRET.trim()
      : null,
    feishuEnabled: parsed.ASB_FEISHU_ENABLED,
    feishuGroupPrefix: parsed.ASB_FEISHU_GROUP_PREFIX?.trim()
      ? parsed.ASB_FEISHU_GROUP_PREFIX.trim()
      : null,
    feishuNotifyChatIds: splitList(parsed.ASB_FEISHU_NOTIFY_CHAT_IDS),
    feishuReplyInThread: parsed.ASB_FEISHU_REPLY_IN_THREAD,
    frpcBin: parsed.ASB_FRPC_BIN?.trim() ? parsed.ASB_FRPC_BIN.trim() : null,
    frpDownloadBase: parsed.ASB_FRP_DOWNLOAD_BASE.replace(/\/$/u, ''),
    frpVersion: parsed.ASB_FRP_VERSION.replace(/^v/u, ''),
    geminiBin: parsed.ASB_GEMINI_BIN,
    hubSessionName: parsed.ASB_HUB_SESSION_NAME,
    httpHost: parsed.ASB_HTTP_HOST,
    httpPort: parsed.ASB_HTTP_PORT,
    logLevel: parsed.ASB_LOG_LEVEL,
    pythonBin: parsed.ASB_PYTHON_BIN,
    serverManagerConfigPath,
    serverManagerPath,
    supervisorEnabled: parsed.ASB_SUPERVISOR_ENABLED,
    supervisorIntervalMs: parsed.ASB_SUPERVISOR_INTERVAL_MS,
    supervisorTailLines: parsed.ASB_SUPERVISOR_TAIL_LINES,
    voiceEngine: parsed.ASB_VOICE_ENGINE,
    whisperBin: parsed.ASB_WHISPER_BIN.trim(),
    whisperModel,
    whisperTimeoutMs: parsed.ASB_WHISPER_TIMEOUT_MS,
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);

  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    (isIP(normalized) === 4 && normalized.startsWith('127.'))
  );
}

function hasOnlyVisibleAsciiCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e) {
      return false;
    }
  }

  return true;
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === '0.0.0.0' || normalized === '::';
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/gu, '');
}

function splitRoots(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
