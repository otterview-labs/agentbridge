import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConflictError, ValidationError } from '../domain/errors.js';
import type { DatabaseClient } from '../infra/storage/database.js';

const deviceIdSchema = z.string().uuid();
const machineSchema = z.object({
  id: z.number().int().positive(), name: z.string().max(200),
  status: z.enum(['online', 'offline', 'unknown']),
  lastSeenAt: z.string().max(50).nullable().optional(),
  tools: z.array(z.enum(['codex', 'claude-code', 'gemini'])).max(3).default([]),
}).strict();
const taskSchema = z.object({
  id: z.number().int().positive(), machineId: z.number().int().positive(), title: z.string().max(500),
  agentType: z.enum(['codex', 'claude-code', 'gemini']),
  status: z.enum(['running', 'idle', 'stopped', 'missing']), requiredInput: z.boolean(),
  updatedAt: z.string().max(50).nullable().optional(),
}).strict();
const snapshotSchema = z.object({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  deviceName: z.string().trim().min(1).max(80),
  machines: z.array(machineSchema).max(100), tasks: z.array(taskSchema).max(500),
}).strict();
type DeviceSnapshot = z.infer<typeof snapshotSchema> & { deviceId: string; syncedAt: string };
const memoriesSchema = z.array(z.object({
  id: z.string().min(1).max(80), content: z.string().trim().min(1).max(500),
  createdAt: z.string().max(50).optional(),
}).strict()).max(50);

export class StudioSyncStore {
  constructor(private readonly database: DatabaseClient) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS studio_devices (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS studio_memory_imports (
        device_id TEXT NOT NULL, local_id TEXT NOT NULL, hub_id TEXT NOT NULL,
        PRIMARY KEY(device_id, local_id)
      );
    `);
  }
  private id(input: string) {
    const id = deviceIdSchema.safeParse(input);
    if (!id.success) throw new ValidationError('手机设备标识无效。');
    return id.data;
  }
  receive(device: string, input: unknown) {
    const id = this.id(device);
    const parsed = snapshotSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('手机快照格式无效或超过数量限制；只接受机器和任务摘要，不接受凭据或原始输出。');
    const value = parsed.data;
    const machines = new Set(value.machines.map(m => m.id));
    if (machines.size !== value.machines.length || new Set(value.tasks.map(t => t.id)).size !== value.tasks.length
        || value.tasks.some(t => !machines.has(t.machineId))) throw new ValidationError('手机快照存在重复 ID 或任务对应机器缺失。');
    const syncedAt = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO studio_devices VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,synced_at=excluded.synced_at
      WHERE excluded.revision > studio_devices.revision
    `).run(id, value.revision, JSON.stringify(value), syncedAt);
    return { accepted: result.changes > 0, deviceId: id };
  }
  all(): DeviceSnapshot[] {
    return this.database.prepare('SELECT * FROM studio_devices ORDER BY id').all()
      .map(row => ({ ...JSON.parse(String(row.payload)), deviceId: String(row.id), syncedAt: String(row.synced_at) }) as DeviceSnapshot);
  }
  remove(device: string) {
    this.database.prepare('DELETE FROM studio_devices WHERE id=?').run(this.id(device));
  }
  importMemories(device: string, input: unknown) {
    const id = this.id(device);
    const parsed = memoriesSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('本机记忆格式无效，每条不超过 500 字，最多 50 条。');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      let imported = 0;
      for (const memory of parsed.data) {
        if (this.database.prepare('SELECT hub_id FROM studio_memory_imports WHERE device_id=? AND local_id=?').get(id, memory.id)) continue;
        const count = this.database.prepare('SELECT COUNT(*) AS count FROM studio_memories').get()!;
        if (Number(count.count) >= 50) throw new ConflictError('Hub 记忆将超过 50 条，本次合并未保存。请先整理记忆。');
        const hubId = randomUUID();
        this.database.prepare('INSERT INTO studio_memories VALUES (?,?,?)').run(hubId, memory.content, new Date().toISOString());
        this.database.prepare('INSERT INTO studio_memory_imports VALUES (?,?,?)').run(id, memory.id, hubId);
        imported++;
      }
      this.database.exec('COMMIT');
      return { imported };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}
