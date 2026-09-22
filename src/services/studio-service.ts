import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { DatabaseClient } from '../infra/storage/database.js';
import type { MachineService } from './machine-service.js';
import type { SshMachineService } from './ssh-machine-service.js';
import type { TaskService } from './task-service.js';
import { StudioSyncStore } from './studio-sync-store.js';
import { parseStudioReport, REPORT_INSTRUCTION, type StudioReport } from './studio-report.js';

export type StudioMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: string };
export type StudioMemory = { id: string; content: string; createdAt: string };
export type StudioModel = {
  label: string;
  reply(input: { message: string; history: StudioMessage[]; memories: StudioMemory[]; context: string }): Promise<string>;
};
type Options = {
  database: DatabaseClient;
  tasks: Pick<TaskService, 'list'>;
  machines: Pick<MachineService, 'listMachines'>;
  ssh: Pick<SshMachineService, 'listTasks'>;
  model?: StudioModel;
  modelProvider?: () => StudioModel | undefined;
  now?: () => Date;
};
const textSchema = z.string().trim().min(1).max(4000);
const memorySchema = z.string().trim().min(1).max(500);
export function studioDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
function dated(value: string): string {
  const date = new Date(/^\d{4}-\d\d-\d\d /u.test(value) ? `${value.replace(' ', 'T')}Z` : value);
  return Number.isNaN(date.getTime()) ? '' : studioDate(date);
}

/** One trusted Hub owner, with explicit memory and no execution capabilities. */
export class StudioService {
  private busy = false;
  readonly sync: StudioSyncStore;
  constructor(private readonly options: Options) {
    options.database.exec(`
      CREATE TABLE IF NOT EXISTS studio_messages (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS studio_memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS studio_reports (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, payload TEXT NOT NULL
      );
    `);
    this.sync = new StudioSyncStore(options.database);
  }
  private model() { return this.options.modelProvider ? this.options.modelProvider() : this.options.model; }
  private now() { return this.options.now?.() ?? new Date(); }
  messages(): StudioMessage[] {
    return this.options.database.prepare(
      'SELECT id,role,content,created_at AS createdAt FROM (SELECT rowid,* FROM studio_messages ORDER BY rowid DESC LIMIT 100) ORDER BY rowid',
    ).all() as StudioMessage[];
  }
  memories(): StudioMemory[] {
    return this.options.database.prepare(
      'SELECT id,content,created_at AS createdAt FROM studio_memories ORDER BY rowid',
    ).all() as StudioMemory[];
  }
  addMemory(input: unknown) {
    const parsed = memorySchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('记忆内容须为 1–500 字。');
    if (this.memories().length >= 50) throw new ConflictError('最多保存 50 条记忆，请先整理旧记忆。');
    const memory = { id: randomUUID(), content: parsed.data, createdAt: this.now().toISOString() };
    this.options.database.prepare('INSERT INTO studio_memories VALUES (?,?,?)')
      .run(memory.id, memory.content, memory.createdAt);
    return memory;
  }
  deleteMemory(id: string) {
    if (!this.options.database.prepare('DELETE FROM studio_memories WHERE id=?').run(id).changes) {
      throw new NotFoundError('记忆不存在或已删除。');
    }
  }
  async snapshot() {
    const [machines, work, ssh] = await Promise.all([
      this.options.machines.listMachines(), this.options.tasks.list(), this.options.ssh.listTasks(),
    ]);
    const date = studioDate(this.now());
    const tomorrow = studioDate(new Date(this.now().getTime() + 86_400_000));
    const tasks = [
      ...work.map(t => ({
        id: `T-${t.id}`, machineId: t.machineId, title: t.title, agentType: t.agentType,
        status: t.status, label: t.status === 'completed' ? '已人工验收' : t.supervision.label,
        needsAttention: !['completed', 'cancelled'].includes(t.status) && ['warn', 'danger'].includes(t.supervision.tone),
        next: t.supervision.next, source: 'Hub 任务', updatedAt: t.updatedAt,
        objective: t.objective?.slice(0, 1500) || '', evidence: t.evidence?.slice(0, 1500) || '',
        activity: t.timeline.filter(e => dated(e.at) === date).slice(-10).map(e => ({ at: e.at, message: e.message.slice(0, 1000) })),
        completedToday: t.status === 'completed' && t.timeline.some(e =>
          e.message.startsWith('人工验收通过：') && dated(e.at) === date),
      })),
      ...ssh.filter(t => !work.some(w => w.machineId === t.machineId && w.sessionName === t.sessionName
          && !['completed', 'cancelled'].includes(w.status)))
        .map(t => ({
          id: `S-${t.id}`, machineId: t.machineId, title: t.customTitle || t.title,
          agentType: t.agentType, status: t.status,
          needsAttention: Boolean(t.requiredInput) || t.status !== 'running',
          label: t.requiredInput ? '待输入' : ({ running: '执行中', idle: '空闲，待核实', stopped: '已停止', missing: '未发现' })[t.status],
          next: t.requiredInput ? '进入控制台核对输出后回复，不自动批准。' : '进入控制台查看输出；会话状态不代表任务已验收。',
          source: 'SSH 会话记录', updatedAt: t.updatedAt, completedToday: false,
          summary: t.workSummary?.slice(0, 1500) || '', summaryVerified: false,
        })),
    ];
    const devices = this.sync.all();
    const mobileTasks = devices.flatMap(d => d.tasks.map(t => ({
      id: `P-${d.deviceId}-${t.id}`, machineId: `P-${d.deviceId}-${t.machineId}`,
      localTaskId: t.id, deviceId: d.deviceId, title: t.title, agentType: t.agentType, status: t.status,
      needsAttention: t.requiredInput || t.status !== 'running',
      label: t.requiredInput ? '待输入' : ({ running: '执行中', idle: '空闲，待核实', stopped: '已停止', missing: '未发现' })[t.status],
      next: '在来源手机查看输出并核实，不根据会话状态推断完成。',
      source: `${d.deviceName} · 手机上传记录`, syncedAt: d.syncedAt,
      updatedAt: t.updatedAt || '', completedToday: false,
    })));
    const allTasks = [...tasks, ...mobileTasks];
    const model = this.model();
    return {
      generatedAt: this.now().toISOString(), date, tomorrow, timeZone: 'Asia/Shanghai',
      scope: `Hub 共享上下文，含 ${devices.length} 台手机已上传记录；未上传数据不可见，连接状态为历史记录。`,
      model: { ready: Boolean(model), label: model?.label ?? 'Pi 未配置' },
      machines: [...machines.map(m => ({
        id: m.id, name: m.name, status: m.status, lastSeenAt: m.lastSeenAt,
        tools: Array.isArray(m.capabilities.installedAgentTypes)
          ? m.capabilities.installedAgentTypes.filter(t => typeof t === 'string' && ['codex', 'claude-code', 'gemini'].includes(t)) : [],
      })), ...devices.flatMap(d => d.machines.map(m => ({
        ...m, id: `P-${d.deviceId}-${m.id}`, name: `${m.name} · ${d.deviceName}`,
        lastSeenAt: m.lastSeenAt || null, deviceId: d.deviceId, syncedAt: d.syncedAt,
      })))],
      tasks: allTasks, memories: this.memories(), messages: this.messages(),
      dailyReport: this.reports(date)[0] ?? null,
      reportHistory: this.reportHistory(),
      report: {
        completed: allTasks.filter(t => t.completedToday),
        ongoing: allTasks.filter(t => !['completed', 'cancelled'].includes(t.status)),
        suggestions: allTasks.filter(t => !['completed', 'cancelled'].includes(t.status)).map(t => ({
          taskId: t.id, title: t.title, next: t.next,
        })),
      },
    };
  }
  reports(date: string): StudioReport[] {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new ValidationError('日报日期格式无效。');
    return this.options.database.prepare('SELECT payload FROM studio_reports WHERE date=? ORDER BY rowid DESC LIMIT 20').all(date)
      .map(row => JSON.parse(String(row.payload)) as StudioReport);
  }
  reportHistory() {
    return this.options.database.prepare('SELECT date,COUNT(*) AS versions FROM studio_reports GROUP BY date ORDER BY date DESC LIMIT 60').all()
      .map(row => ({ date: String(row.date), versions: Number(row.versions) }));
  }
  async generateReport(date: unknown) {
    const today = studioDate(this.now());
    if (date !== today) throw new ValidationError('只可根据当前记录生成今日日报；历史日期请查看已保存报告。');
    const model = this.model();
    if (!model) throw new ConflictError('Pi 尚未配置，请先在模型设置中接入模型。');
    if (this.busy) throw new ConflictError('管家正在处理请求，请稍后再生成。');
    this.busy = true;
    try {
      const state = await this.snapshot();
      const tasks = state.tasks.slice(0, 100);
      const answer = await model.reply({
        message: REPORT_INSTRUCTION, history: this.messages().filter(m => dated(m.createdAt) === today).slice(-20),
        memories: this.memories(),
        context: JSON.stringify({ date: today, timeZone: state.timeZone, scope: state.scope, tasks, omittedTasks: state.tasks.length - tasks.length }),
      });
      const sources = tasks.map(t => ({ id: t.id, title: t.title, label: t.label, source: t.source, completedToday: t.completedToday }));
      const content = parseStudioReport(answer, sources);
      const report: StudioReport = {
        id: randomUUID(), date: today, generatedAt: this.now().toISOString(), model: model.label,
        content, sources, coverage: `${state.scope} 使用 ${tasks.length} 条任务记录，省略 ${state.tasks.length - tasks.length} 条。`,
      };
      this.options.database.prepare('INSERT INTO studio_reports VALUES (?,?,?)').run(report.id, today, JSON.stringify(report));
      return report;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ConflictError('日报生成失败或超时，旧日报已保留；请检查模型配置后重试。');
    } finally { this.busy = false; }
  }
  async chat(input: unknown) {
    const parsed = textSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('消息须为 1–4000 字。');
    const model = this.model();
    if (!model) throw new ConflictError('Pi 尚未配置模型。请在模型设置中接入后再发送。');
    if (this.busy) throw new ConflictError('管家正在回复上一条消息，请稍后再试。');
    this.busy = true;
    try {
      const snapshot = await this.snapshot();
      const answer = await model.reply({
        message: parsed.data, history: this.messages().slice(-20), memories: this.memories(),
        // Include bounded task evidence, never SSH credentials or raw terminal output.
        context: JSON.stringify({
          date: snapshot.date, timeZone: snapshot.timeZone, scope: snapshot.scope,
          machines: snapshot.machines, tasks: snapshot.tasks.slice(0, 100),
          omittedTasks: Math.max(0, snapshot.tasks.length - 100),
        }),
      });
      if (!answer.trim() || answer.length > 24000) throw new Error('Invalid model response');
      const now = this.now().toISOString();
      const user: StudioMessage = { id: randomUUID(), role: 'user', content: parsed.data, createdAt: now };
      const assistant: StudioMessage = { id: randomUUID(), role: 'assistant', content: answer, createdAt: now };
      // Commit both messages together. Failed requests do not leave a phantom answer.
      this.options.database.exec('BEGIN IMMEDIATE');
      try {
        const insert = this.options.database.prepare('INSERT INTO studio_messages VALUES (?,?,?,?)');
        for (const m of [user, assistant]) insert.run(m.id, m.role, m.content, m.createdAt);
        this.options.database.exec('COMMIT');
      } catch (error) {
        this.options.database.exec('ROLLBACK');
        throw error;
      }
      return { messages: this.messages() };
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      // Provider errors may contain credentials or request bodies.
      throw new ConflictError('管家回复失败或超时。本次消息未保存，也没有执行操作；请检查模型配置后重试。');
    } finally { this.busy = false; }
  }
}
