import { splitCommandLine } from './shell.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/u;

export function extractCommandBinary(commandLine: string): string | null {
  const trimmed = commandLine.trim();

  if (!trimmed) {
    return null;
  }

  const tokens = splitCommandLine(trimmed);

  if (tokens.length === 0) {
    return null;
  }

  let index = 0;

  if (tokens[0] === 'env' || tokens[0]?.endsWith('/env')) {
    index = 1;

    while (index < tokens.length) {
      const token = tokens[index]!;

      if (token === '-u' || token === '--unset') {
        index += 2;
        continue;
      }

      if (token.startsWith('-')) {
        index += 1;
        continue;
      }

      if (ENV_ASSIGNMENT.test(token)) {
        index += 1;
        continue;
      }

      return token;
    }

    return null;
  }

  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]!)) {
    index += 1;
  }

  return tokens[index] ?? null;
}

export function resolveCommandExecutable(commandLine: string): string {
  const binary = extractCommandBinary(commandLine) ?? commandLine.trim();
  if (!binary || binary.includes(path.sep)) {
    return binary;
  }

  const directories = [
    ...String(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.npm-global/bin'),
    path.join(os.homedir(), '.local/bin'),
  ].filter(Boolean);

  for (const directory of new Set(directories)) {
    const candidate = path.join(directory, binary);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue with the next common installation directory.
    }
  }
  return binary;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type SshHostKeyPolicy = 'accept-new' | 'strict';

/**
 * Maps the operator-facing policy onto the value ssh actually expects.
 * `accept-new` trusts an unknown host on first contact but still refuses a
 * later key change; `strict` refuses unknown hosts and needs a prepared
 * known_hosts entry.
 */
export function hostKeyCheckingOption(policy: SshHostKeyPolicy): string {
  return policy === 'strict' ? 'yes' : 'accept-new';
}
