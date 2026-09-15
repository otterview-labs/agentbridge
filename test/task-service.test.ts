import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { DatabaseClient } from '../src/infra/storage/database.js';
import { TaskService } from '../src/services/task-service.js';
import type { SessionRecord } from '../src/domain/session.js';
import type { MachineRecord } from '../src/domain/machine.js';
import { SqliteSessionRepository } from '../src/infra/repositories/sqlite-session-repository.js';

function fixture() {
  const database = new DatabaseClient(':memory:', pino({ level: 'silent' }));
  const now = new Date().toISOString();
  const session: SessionRecord = { id: 1, name: 'demo', agentType: 'codex', createdAt: now,
    updatedAt: now, lastActiveAt: now, defaultForActor: false, ownerActorId: null,
    status: 'idle', lastOutputDigest: null, tmuxSessionName: 'test', tmuxWindowName: 'demo', workspacePath: '/tmp' };
  const machine: MachineRecord = { id: 1, name: 'local', namespace: 'default', host: 'test', status: 'online',
    labels: [], capabilities: {}, createdAt: now, updatedAt: now, lastSeenAt: now, runnerVersion: null };
  let sends = 0;
  let fail = false;
  const service = new TaskService({ database,
    sessions: {
      listSessions: async () => [session], requireByName: async () => session,
      inspectSession: async () => ({ session, checkedAt: now, note: 'ready', observedState: 'ready', tail: '', tailDigest: null, windowExists: true }),
      sendPrompt: async () => { sends += 1; if (fail) throw new Error('delivery unknown'); return session; },
    }, machines: { listMachines: async () => [machine] },
  });
  const input = { title: 'Fix login', objective: 'Fix timeout', acceptance: 'Tests pass', sessionId: 1, quietMinutes: 15 };
  return { service, database, session, machine, input, sends: () => sends, fail: () => { fail = true; } };
}

test('task creation persists without sending; explicit dispatch and evidence gate completion', async () => {
  const f = fixture();
  const task = await f.service.create(f.input, 'tester');
  assert.equal(task.status, 'queued'); assert.equal(f.sends(), 0);
  assert.equal((await f.service.list())[0]?.id, task.id);
  await assert.rejects(f.service.action(task.id, 'complete', 'tester', 'ok'), /先提交/);
  await f.service.action(task.id, 'dispatch', 'tester');
  assert.equal(f.sends(), 1);
  await assert.rejects(f.service.action(task.id, 'dispatch', 'tester'), /重复下发/);
  await assert.rejects(f.service.action(task.id, 'review', 'tester'), /填写/);
  await f.service.action(task.id, 'review', 'tester', 'npm test: passed');
  await f.service.action(task.id, 'complete', 'tester', 'Diff reviewed and tests checked');
  const completed = (await f.service.list())[0]!;
  assert.equal(completed.status, 'completed'); assert.equal(completed.timeline.length, 5);
});

test('concurrent dispatch sends once and a second active task cannot share the session', async () => {
  const f = fixture(); const task = await f.service.create(f.input, 'tester');
  const results = await Promise.allSettled([f.service.action(task.id, 'dispatch', 'a'), f.service.action(task.id, 'dispatch', 'b')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); assert.equal(f.sends(), 1);
  const second = await f.service.create(f.input, 'tester');
  await assert.rejects(f.service.action(second.id, 'dispatch', 'tester'), /未结束任务/);
});

test('ambiguous delivery is retained for inspection, never retried automatically', async () => {
  const f = fixture(); f.fail(); const task = await f.service.create(f.input, 'tester');
  assert.equal((await f.service.action(task.id, 'dispatch', 'tester')).status, 'needs_attention');
  await assert.rejects(f.service.action(task.id, 'dispatch', 'tester'));
  assert.equal(f.sends(), 1);
});

test('machine unavailable, busy session and invalid input fail closed', async () => {
  const f = fixture();
  await assert.rejects(f.service.create({ ...f.input, acceptance: '' }, 'tester'));
  await assert.rejects(f.service.create({ ...f.input, sessionId: 9 }, 'tester'));
  const task = await f.service.create(f.input, 'tester');
  f.machine.status = 'offline'; await assert.rejects(f.service.action(task.id, 'dispatch', 'tester'));
  f.machine.status = 'online'; f.session.status = 'busy'; await assert.rejects(f.service.action(task.id, 'dispatch', 'tester'));
  assert.equal(f.sends(), 0);
});

test('supervision distinguishes stale activity and never treats idle as completed', async () => {
  const f = fixture(); const task = await f.service.create(f.input, 'tester');
  await f.service.action(task.id, 'dispatch', 'tester');
  assert.equal((await f.service.list())[0]?.supervision.label, '会话空闲，结果待核实');
  const row = f.database.prepare('SELECT payload FROM work_tasks WHERE id=?').get(task.id)!;
  const saved = JSON.parse(String(row.payload)); saved.startedAt = '2020-01-01T00:00:00Z';
  f.database.prepare('UPDATE work_tasks SET payload=? WHERE id=?').run(JSON.stringify(saved), task.id);
  f.session.lastActiveAt = '2020-01-01 00:00:00';
  assert.equal((await f.service.list())[0]?.supervision.label, '较长时间无活动记录');
  f.session.status = 'error'; assert.equal((await f.service.list())[0]?.supervision.tone, 'danger');
  await f.service.action(task.id, 'cancel', 'tester', 'Stop tracking only');
  assert.equal(f.sends(), 1);
});

test('unchanged inspection does not reset session activity time', async () => {
  const f = fixture();
  f.database.prepare(`INSERT INTO codex_sessions (name,workspace_path,tmux_session_name,tmux_window_name,status,last_output_digest,last_active_at)
    VALUES ('demo','/tmp','test','demo','idle','same','2020-01-01 00:00:00')`).run();
  const repo = new SqliteSessionRepository(f.database, pino({ level: 'silent' }));
  await repo.updateDigest(1, 'same'); await repo.updateStatus(1, 'idle');
  assert.equal((await repo.findByName('demo'))?.lastActiveAt, '2020-01-01 00:00:00');
  await repo.updateDigest(1, 'new output');
  assert.notEqual((await repo.findByName('demo'))?.lastActiveAt, '2020-01-01 00:00:00');
});

test('task HTTP endpoints enforce auth, validate input and retain tasks', async (t) => {
  const { HttpApiServer } = await import('../src/app/http-server.js');
  const f = fixture();
  const server = new HttpApiServer({ taskService: f.service,
    config: { allowedHttpHosts: [], apiToken: 'test-secret', httpHost: '127.0.0.1', httpPort: 0 },
    logger: pino({ level: 'silent' }),
  } as never);
  const { port } = await server.start(); t.after(() => server.stop());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/tasks`)).status, 401);
  const headers = { authorization: 'Bearer test-secret', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/tasks`, { method: 'POST', headers, body: '{}' })).status, 400);
  const created = await fetch(`${base}/tasks`, { method: 'POST', headers, body: JSON.stringify(f.input) });
  assert.equal(created.status, 201);
  const payload = await created.json() as { task: { id: number } };
  assert.equal((await fetch(`${base}/tasks`, { headers })).status, 200);
  const dispatched = await fetch(`${base}/tasks/${payload.task.id}/dispatch`, { method: 'POST', headers, body: '{}' });
  assert.equal(dispatched.status, 200); assert.equal(f.sends(), 1);
  assert.equal((await fetch(`${base}/tasks/${payload.task.id}/dispatch`, { method: 'POST', headers, body: '{}' })).status, 409);
});
