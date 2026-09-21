import * as Lark from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';

import type { AppConfig } from '../../config/env.js';
import type { CommandRouter } from '../../services/command-router.js';
import { FeishuApiClient } from './api-client.js';
import type { FeishuMessageEvent } from '../../domain/feishu.js';
import { DomainError } from '../../domain/errors.js';

type FeishuChannelOptions = {
  apiClient: FeishuApiClient;
  commandRouter: CommandRouter;
  config: AppConfig;
  logger: Logger;
};

type FeishuWsClient = {
  start(args: { eventDispatcher: unknown }): Promise<void> | void;
};

export class FeishuChannel {
  private client: FeishuWsClient | null = null;

  constructor(private readonly options: FeishuChannelOptions) {}

  async start(): Promise<void> {
    if (!this.options.config.feishuEnabled) {
      return;
    }

    if (!this.options.config.feishuAppId || !this.options.config.feishuAppSecret) {
      throw new DomainError('Feishu is enabled but app_id/app_secret are missing');
    }

    const baseConfig = {
      appId: this.options.config.feishuAppId,
      appSecret: this.options.config.feishuAppSecret,
    };

    this.client = new Lark.WSClient(baseConfig) as FeishuWsClient;
    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        await this.handleRawMessageEvent(data);
      },
    });

    await this.client.start({ eventDispatcher });
    this.options.logger.info('Feishu long connection started');
  }

  async handleRawMessageEvent(data: unknown): Promise<void> {
    try {
      const event = normalizeMessageEvent(data);

      if (!event) {
        this.options.logger.debug({ data }, 'ignored unsupported Feishu payload');
        return;
      }

      if (!this.isAuthorized(event)) {
        await this.options.apiClient.replyText(
          event.messageId,
          '当前会话没有控制权限，请先把发送者或群聊加入白名单。',
        );
        return;
      }

      if (event.messageType !== 'text') {
        await this.options.apiClient.replyText(
          event.messageId,
          '目前只支持文本消息控制，请直接发送 /list、/watch、/new 等命令。',
        );
        return;
      }

      const command = this.extractCommand(event);

      if (!command) {
        await this.options.apiClient.replyText(
          event.messageId,
          [
            '我已经连上 AgentBridge 了。',
            '直接发命令即可，例如：',
            '/list',
            '/new demo /path/to/your/projects/demo',
            '/watch',
            '/inspect demo',
          ].join('\n'),
        );
        return;
      }

      const output = await this.options.commandRouter.execute(command, {
        actorId: `feishu:${event.openId ?? event.chatId}`,
      });
      await this.options.apiClient.replyText(event.messageId, output);
    } catch (error) {
      this.options.logger.error({ err: error }, 'Feishu event handling failed');
      if (isMessageIdCarrier(data)) {
        try {
          await this.options.apiClient.replyText(
            data.event.message.message_id,
            formatErrorMessage(error),
          );
        } catch (replyError) {
          this.options.logger.error({ err: replyError }, 'Feishu error reply failed');
        }
      }
    }
  }

  private extractCommand(event: FeishuMessageEvent): string | null {
    let text = event.rawText;

    for (const mention of event.mentions) {
      if (mention.key) {
        text = text.replaceAll(mention.key, '');
      }
    }

    text = text.trim();

    if (!text) {
      return null;
    }

    const configuredPrefix = this.options.config.feishuGroupPrefix;

    if (event.chatType === 'group' && configuredPrefix) {
      if (!text.startsWith(configuredPrefix)) {
        return null;
      }
      text = text.slice(configuredPrefix.length).trim();
    }

    return text || null;
  }

  private isAuthorized(event: FeishuMessageEvent): boolean {
    const { feishuAllowedChatIds, feishuAllowedOpenIds } = this.options.config;

    if (feishuAllowedChatIds.length === 0 && feishuAllowedOpenIds.length === 0) {
      return false;
    }

    const chatAllowed =
      feishuAllowedChatIds.length === 0 || feishuAllowedChatIds.includes(event.chatId);
    const openIdAllowed =
      feishuAllowedOpenIds.length === 0 ||
      (!!event.openId && feishuAllowedOpenIds.includes(event.openId));

    return chatAllowed && openIdAllowed;
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `执行失败：${error.message}`;
  }

  return '执行失败：未知错误';
}

function isMessageIdCarrier(value: unknown): value is {
  event: { message: { message_id: string } };
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const maybeEvent = (value as { event?: unknown }).event;
  if (typeof maybeEvent !== 'object' || maybeEvent === null) {
    return false;
  }

  const maybeMessage = (maybeEvent as { message?: unknown }).message;
  if (typeof maybeMessage !== 'object' || maybeMessage === null) {
    return false;
  }

  return typeof (maybeMessage as { message_id?: unknown }).message_id === 'string';
}

function normalizeMessageEvent(data: unknown): FeishuMessageEvent | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const event = (data as { event?: unknown }).event;
  if (typeof event !== 'object' || event === null) {
    return null;
  }

  const sender = (event as { sender?: unknown }).sender;
  const message = (event as { message?: unknown }).message;
  if (typeof sender !== 'object' || sender === null) {
    return null;
  }
  if (typeof message !== 'object' || message === null) {
    return null;
  }

  const senderId = (sender as { sender_id?: unknown }).sender_id;
  const content = getTextField(message, 'content');
  const parsedContent = parseTextContent(content);
  const mentions = Array.isArray((message as { mentions?: unknown }).mentions)
    ? ((message as { mentions?: unknown[] }).mentions ?? [])
    : [];

  return {
    chatId: getTextField(message, 'chat_id'),
    chatType: getTextField(message, 'chat_type'),
    mentions: mentions.map((mention) => ({
      key: typeof mention === 'object' && mention !== null ? getTextField(mention, 'key') : '',
      openId:
        typeof mention === 'object' && mention !== null
          ? getNestedTextField(mention, ['id', 'open_id'])
          : null,
    })),
    messageId: getTextField(message, 'message_id'),
    messageType: getTextField(message, 'message_type'),
    openId:
      typeof senderId === 'object' && senderId !== null
        ? getNestedTextField(senderId, ['open_id'])
        : null,
    rawText: parsedContent.text,
  };
}

function parseTextContent(content: string): { text: string } {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
    };
  } catch {
    return { text: '' };
  }
}

function getNestedTextField(
  value: unknown,
  path: string[],
): string | null {
  let current: unknown = value;

  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === 'string' && current.trim() ? current : null;
}

function getTextField(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }

  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : '';
}
