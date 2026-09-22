import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { SessionRecord } from '../domain/session.js';
import type { MachineRecord } from '../domain/machine.js';
import type { SessionService } from './session-service.js';
import type { MachineService } from './machine-service.js';
import type { DatabaseClient } from '../infra/storage/database.js';

const inputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(8000),
  acceptance: z.string().trim().min(1).max(4000),
  sessionId: z.number().int().positive(),
  quietMinutes: z.number().int().min(5).max(1440).default(15),
});
type TaskStatus = 'queued' | 'dispatching' | 'running' | 'needs_attention' | 'review' | 'completed' | 'cancelled';
export type WorkTask = z.infer<typeof inputSchema> & {
  id: number;
  machineId: number;
  sessionName: string;
  agentType: string;
  workspacePath: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  evidence: string;
  timeline: { at: string; actor: string; message: string }[];
};
type Options = {
  database: DatabaseClient;
  sessions: Pick<SessionService, 'requireByName' | 'listSessions' | 'sendPrompt' | 'inspectSession'>;
  machines: Pick<MachineService, 'listMachines'>;
};

function timestamp(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} /u.test(value) ? `${value.replace(' ', 'T')}Z` : value) || 0;
}

export class TaskService {
  constructor(private readonly options: Options) {
    options.database.exec(`CREATE TABLE IF NOT EXISTS work_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_task_per_session
      ON work_tasks(session_id) WHERE status IN ('dispatching','running','needs_attention','review');`);
  }

  async list() {
    const sessions = await this.options.sessions.listSessions();
    const tasks = this.options.database.prepare('SELECT id, payload FROM work_tasks ORDER BY id DESC').all()
      .map((row) => this.decode(row));
    return tasks.map((task) => ({
      ...task,
      supervision: this.observe(task, sessions.find((s) => s.id === task.sessionId)),
    }));
  }

  async create(input: unknown, actor: string): Promise<WorkTask> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('请填写任务名称、目标、验收条件和有效会话；无输出阈值为 5–1440 分钟。');
    const session = (await this.options.sessions.listSessions()).find((s) => s.id === parsed.data.sessionId);
    if (!session) throw new NotFoundError('所选会话不存在，请刷新后重试。');
    const machine = await this.localMachine();
    const now = new Date().toISOString();
    const task: WorkTask = {
      ...parsed.data, id: 0, machineId: machine.id, sessionName: session.name,
      agentType: session.agentType, workspacePath: session.workspacePath, status: 'queued',
      createdAt: now, updatedAt: now, startedAt: null, evidence: '',
      timeline: [{ at: now, actor, message: '任务已创建，尚未发送给 AI。' }],
    };
    const result = this.options.database.prepare(
      'INSERT INTO work_tasks(session_id,status,payload) VALUES (?,?,?)',
    ).run(session.id, task.status, JSON.stringify(task));
    task.id = Number(result.lastInsertRowid);
    return task;
  }

  async action(id: number, action: string, actor: string, evidence = ''): Promise<WorkTask> {
    let task = this.get(id);
    if (action === 'dispatch') {
      if (task.status !== 'queued') throw new ConflictError('任务已下发或已结束，不能重复下发。');
      const session = (await this.options.sessions.listSessions()).find((s) => s.id === task.sessionId);
      if (!session) throw new NotFoundError('任务会话已不存在，请创建新任务。');
      await this.localMachine();
      if (session.status !== 'idle') throw new ConflictError('只能向空闲会话下发任务，请先检查会话。');
      const inspection = await this.options.sessions.inspectSession(session.name);
      if (!inspection.windowExists || inspection.observedState !== 'ready') {
        throw new ConflictError('会话未确认就绪；请先进入会话处理输入或审批。');
      }
      // Re-read after asynchronous checks; a competing request may have dispatched already.
      task = this.get(id);
      if (task.status !== 'queued') throw new ConflictError('任务已被另一请求处理。');
      const occupied = this.options.database.prepare(
        "SELECT id FROM work_tasks WHERE session_id=? AND status IN ('dispatching','running','needs_attention','review')",
      ).get(session.id);
      if (occupied) throw new ConflictError('该会话已有未结束任务，请先验收或结束原任务。');
      task.sessionName = session.name;
      task.status = 'dispatching';
      task.startedAt = new Date().toISOString();
      this.save(task, actor, '开始下发；断线或进程中断后不会自动重复发送。');
      try {
        await this.options.sessions.sendPrompt({
          actorId: actor, name: session.name,
          prompt: `任务：${task.title}\n\n目标：\n${task.objective}\n\n验收条件：\n${task.acceptance}\n\n请报告进展与验证证据。不得擅自扩大范围；遇到权限请求请保留人工确认。完成后提供修改和测试摘要，不要自行宣称已通过平台验收。`,
        });
        task.status = 'running';
        this.save(task, actor, '指令已发送。规则监督仅观察，不自动重试或批准操作。');
      } catch {
        task.status = 'needs_attention';
        this.save(task, actor, '下发未确认成功，指令可能已送达。请检查会话，禁止自动重发。');
      }
      return task;
    }
    if (action === 'review') {
      if (!['running', 'needs_attention'].includes(task.status)) throw new ConflictError('当前状态不能申请验收。');
      this.requireEvidence(evidence);
      task.status = 'review';
      task.evidence = evidence.trim();
      return this.save(task, actor, `人工提交验收证据：${task.evidence}`);
    }
    if (action === 'complete') {
      if (task.status !== 'review') throw new ConflictError('请先提交验收证据，再确认完成。');
      this.requireEvidence(evidence);
      task.status = 'completed';
      return this.save(task, actor, `人工验收通过：${evidence.trim()}`);
    }
    if (action === 'cancel') {
      if (!['queued', 'running', 'needs_attention', 'review'].includes(task.status)) {
        throw new ConflictError('任务已经结束。');
      }
      this.requireEvidence(evidence);
      task.status = 'cancelled';
      return this.save(task, actor, `结束任务跟踪（不会停止 AI 进程）：${evidence.trim()}`);
    }
    throw new ValidationError('不支持的任务操作。');
  }

  private observe(task: WorkTask, session?: SessionRecord) {
    if (task.status === 'queued') return { tone: 'muted', label: '等待下发', next: '由你确认目标后下发。', source: '任务记录' };
    if (task.status === 'review') return { tone: 'warn', label: '待人工验收', next: '核对 Diff、测试结果与验收条件。', source: '人工提交' };
    if (['completed', 'cancelled'].includes(task.status)) return { tone: 'muted', label: '跟踪已结束', next: '可查看验收记录和执行时间线。', source: '人工决定' };
    if (task.status === 'dispatching' || task.status === 'needs_attention') {
      return { tone: 'warn', label: '需检查下发结果', next: '打开会话核实，不自动重复下发。', source: '执行记录' };
    }
    if (!session || ['error', 'stopped'].includes(session.status)) {
      return { tone: 'danger', label: '执行会话异常', next: '检查会话；任务不会自动重启。', source: '会话记录' };
    }
    const last = Math.max(timestamp(session.lastActiveAt), timestamp(task.startedAt || ''));
    if (Date.now() - last > task.quietMinutes * 60_000) {
      return { tone: 'warn', label: '较长时间无活动记录', next: '检查最新输出。此提示不等于卡死。', source: '规则检查' };
    }
    if (session.status === 'idle') return { tone: 'warn', label: '会话空闲，结果待核实', next: '检查输出，确认是否可提交验收。', source: '会话记录' };
    return { tone: 'ok', label: '执行中', next: '观察最近输出，等待结果或权限请求。', source: '会话记录' };
  }

  private requireEvidence(value: string) {
    if (!value.trim() || value.length > 8000) throw new ValidationError('请填写处理原因或验收证据（最多 8000 字）。');
  }
  private async localMachine(): Promise<MachineRecord> {
    const machine = (await this.options.machines.listMachines()).find((m) => m.name === 'local');
    if (!machine || machine.status !== 'online') throw new ConflictError('本机执行端未就绪；远程执行尚未接通。');
    return machine;
  }
  private get(id: number): WorkTask {
    const row = this.options.database.prepare('SELECT id,payload FROM work_tasks WHERE id=?').get(id);
    if (!row) throw new NotFoundError('任务不存在。');
    return this.decode(row);
  }
  private decode(row: Record<string, unknown>): WorkTask {
    return { ...JSON.parse(String(row.payload)) as WorkTask, id: Number(row.id) };
  }
  private save(task: WorkTask, actor: string, message: string): WorkTask {
    task.updatedAt = new Date().toISOString();
    task.timeline.push({ at: task.updatedAt, actor, message });
    this.options.database.prepare('UPDATE work_tasks SET status=?,payload=? WHERE id=?')
      .run(task.status, JSON.stringify(task), task.id);
    return task;
  }
}
