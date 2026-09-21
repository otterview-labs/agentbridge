import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConflictError, ValidationError } from '../domain/errors.js';
import type { DatabaseClient } from '../infra/storage/database.js';
import type { StudioModel } from './studio-service.js';

export type PiSettings = { enabled: boolean; provider: 'anthropic' | 'openrouter' | 'openai-compatible'; modelId: string; baseUrl: string; apiKey: string };
const schema = z.object({
  enabled: z.boolean(), provider: z.enum(['anthropic', 'openrouter', 'openai-compatible']),
  modelId: z.string().trim().max(160), baseUrl: z.string().trim().max(1000).default(''),
  apiKey: z.string().trim().max(8192).optional(),
}).strict();
const defaults = { anthropic: 'https://api.anthropic.com', openrouter: 'https://openrouter.ai/api/v1', 'openai-compatible': '' };

export function validateModelUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError('请输入有效的模型 API 地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
      || url.username || url.password || url.search || url.hash) {
    throw new ValidationError('模型 API 须使用 HTTPS（本机模型可用 HTTP），且不能带用户名、密码、查询参数或片段。');
  }
  return url.toString().replace(/\/+$/u, '');
}

/** Persist secrets encrypted, with a separate owner-readable key outside SQLite. */
export class StudioModelSettings {
  private testing = false;
  constructor(private readonly options: {
    database: DatabaseClient; keyPath: string; env: NodeJS.ProcessEnv;
    factory: (config: PiSettings) => StudioModel;
  }) {
    options.database.exec('CREATE TABLE IF NOT EXISTS studio_model_settings (id INTEGER PRIMARY KEY CHECK(id=1), encrypted TEXT NOT NULL, updated_at TEXT NOT NULL)');
  }
  private key(): Buffer {
    fs.mkdirSync(path.dirname(this.options.keyPath), { recursive: true });
    try { fs.writeFileSync(this.options.keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const fd = fs.openSync(this.options.keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077)) throw new Error('Unsafe studio model key');
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  }
  private stored(): PiSettings | undefined {
    const row = this.options.database.prepare('SELECT encrypted FROM studio_model_settings WHERE id=1').get();
    if (!row) return undefined;
    try {
      // Never create a replacement encryption key for a database that already has secrets.
      if (!fs.existsSync(this.options.keyPath)) throw new Error('Missing key');
      const [iv, tag, payload] = String(row.encrypted).split('.');
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv!, 'base64'));
      decipher.setAAD(Buffer.from('asb-studio-model-v1'));
      decipher.setAuthTag(Buffer.from(tag!, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload!, 'base64')), decipher.final()]).toString()) as PiSettings;
    } catch { throw new ConflictError('模型配置无法解密，请恢复 Hub 的模型加密密钥文件。'); }
  }
  private current(): PiSettings {
    const stored = this.stored();
    if (stored) return stored;
    const env = this.options.env;
    return {
      enabled: env.ASB_PI_ENABLED === 'true',
      provider: (env.ASB_PI_PROVIDER || 'anthropic') as PiSettings['provider'],
      modelId: env.ASB_PI_MODEL || '', baseUrl: env.ASB_PI_BASE_URL || '',
      apiKey: env.ASB_PI_API_KEY?.trim() || '',
    };
  }
  publicState() {
    const current = this.current();
    return {
      enabled: current.enabled, provider: current.provider, modelId: current.modelId,
      baseUrl: current.baseUrl || defaults[current.provider] || '',
      hasApiKey: Boolean(current.apiKey),
      source: this.options.database.prepare('SELECT id FROM studio_model_settings WHERE id=1').get() ? 'saved' : 'environment',
    };
  }
  private candidate(input: unknown): PiSettings {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ValidationError('模型配置格式无效，请检查提供商、模型名和启用开关。');
    const next = parsed.data;
    const previous = this.current();
    const baseUrl = validateModelUrl(next.baseUrl || defaults[next.provider]);
    const sameDestination = next.provider === previous.provider
      && baseUrl === (previous.baseUrl || defaults[previous.provider]);
    // A retained key must never be forwarded to a newly chosen endpoint.
    const apiKey = next.apiKey || (sameDestination ? previous.apiKey : '');
    if (!apiKey && next.enabled) throw new ValidationError('请填写 API Key；更换提供商或 API 地址时必须重新输入密钥。');
    if (!next.modelId && next.enabled) throw new ValidationError('请填写模型名称。');
    return { enabled: next.enabled, provider: next.provider, modelId: next.modelId, baseUrl, apiKey };
  }
  save(input: unknown) {
    const config = this.candidate(input);
    if (config.enabled) this.options.factory(config);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from('asb-studio-model-v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(config)), cipher.final()]);
    const payload = [iv, cipher.getAuthTag(), encrypted].map(x => x.toString('base64')).join('.');
    this.options.database.prepare('INSERT INTO studio_model_settings VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at')
      .run(payload, new Date().toISOString());
    return this.publicState();
  }
  model(): StudioModel | undefined {
    const config = this.current();
    return config.enabled ? this.options.factory(config) : undefined;
  }
  async test(input: unknown) {
    if (this.testing) throw new ConflictError('模型连接测试正在进行，请稍后。');
    const config = this.candidate(input);
    if (!config.enabled) throw new ValidationError('请先勾选启用模型，再测试连接。');
    this.testing = true;
    try {
      const model = this.options.factory(config);
      const reply = await model.reply({ message: '连接测试，请仅回复 PI_OK。', history: [], memories: [], context: '{}' });
      if (!reply.trim()) throw new Error('Empty test response');
      return { ok: true, label: model.label, testedAt: new Date().toISOString(), saved: false };
    } catch { throw new ConflictError('模型连接测试失败。请检查 API 地址、模型名、密钥权限或服务额度；配置尚未自动保存。'); }
    finally { this.testing = false; }
  }
}
