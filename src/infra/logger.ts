import pino, { type Logger } from 'pino';

type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export class LoggerFactory {
  static create(level: LogLevel): Logger {
    return pino({
      level,
      name: 'agentbridge',
    });
  }
}
