import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { DatabaseClient } from '../src/infra/storage/database.js';
import { StudioService, studioDate, type StudioModel } from '../src/services/studio-service.js';
import { createPiStudioModel } from '../src/services/pi-studio-model.js';
import { HttpApiServer } from '../src/app/http-server.js';
import type { TaskService } from '../src/services/task-service.js';

function fixture(model?: StudioModel) {
  const database = new DatabaseClient(':memory:', pino({ level: 'silent' }));
  const work: Awaited<ReturnType<TaskService['list']>> = [];
  const options = {
    database, model, tasks: { list: async () => work },
    machines: { listMachines: async () => [] },
    ssh: { listTasks: async () => [] },
    now: () => new Date('2026-09-20T16:05:00Z'),
  };
  return { service: new StudioService(options), database, work, options };
}
test('studio memory persists across service instances and validates limits', () => {
  const f = fixture();
  const saved = f.service.addMemory('  先说结论  ');
  assert.equal(new StudioService(f.options).memories()[0]?.content, '先说结论');
  assert.throws(() => f.service.addMemory(' '));
  assert.throws(() => f.service.addMemory('x'.repeat(501)));
  f.service.deleteMemory(saved.id);
  assert.deepEqual(f.service.memories(), []);
  assert.throws(() => f.service.deleteMemory(saved.id), /不存在/);
  for (let i = 0; i < 50; i++) f.service.addMemory(`偏好 ${i}`);
  assert.throws(() => f.service.addMemory('over limit'), /50/);
});
test('report uses Shanghai date and actual acceptance event; idle is never complete', async () => {
  const f = fixture();
  const task = {
    id: 1, machineId: 1, title: '验收', agentType: 'codex', status: 'completed',
    updatedAt: '2026-09-20T16:01:00Z', sessionName: 'dev',
    timeline: [{ at: '2026-09-20T15:59:00Z', actor: 'user', message: '人工验收通过：ok' }],
    supervision: { label: '已结束', next: '', tone: 'muted', source: '人工决定' },
  } as Awaited<ReturnType<TaskService['list']>>[number];
  f.work.push(task);
  let state = await f.service.snapshot();
  assert.equal(state.date, '2026-09-21');
  assert.equal(state.report.completed.length, 0);
  task.timeline[0]!.at = '2026-09-20T16:00:00Z';
  state = await f.service.snapshot();
  assert.equal(state.report.completed.length, 1);
  task.status = 'running';
  task.supervision.label = '会话空闲，结果待核实';
  assert.equal((await f.service.snapshot()).report.completed.length, 0);
  assert.equal(studioDate(new Date('2026-12-31T16:01:00Z')), '2027-01-01');
});
test('Pi is opt-in, with dedicated credentials and no ambient credential fallback', () => {
  assert.equal(createPiStudioModel({ ANTHROPIC_API_KEY: 'ambient' }), undefined);
  assert.throws(() => createPiStudioModel({ ASB_PI_ENABLED: 'true', ANTHROPIC_API_KEY: 'ambient' }));
  assert.throws(() => createPiStudioModel({
    ASB_PI_ENABLED: 'true', ASB_PI_PROVIDER: 'anthropic', ASB_PI_MODEL: 'not-a-model', ASB_PI_API_KEY: 'dedicated',
  }));
});
test('unconfigured Pi refuses chat without fabricating history', async () => {
  const f = fixture();
  await assert.rejects(f.service.chat('hello'), /尚未配置/);
  assert.deepEqual(f.service.messages(), []);
});
test('chat keeps explicit preferences and history, rejects concurrent requests, redacts errors', async () => {
  let complete!: (value: string) => void;
  let fail = false;
  let received: Parameters<StudioModel['reply']>[0] | undefined;
  const f = fixture({
    label: 'test-model',
    reply: async input => {
      received = input;
      if (fail) throw new Error('secret-api-key');
      return new Promise<string>(resolve => { complete = resolve; });
    },
  });
  f.service.addMemory('偏好');
  const first = f.service.chat('今天怎样');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.chat('重复'), /上一条/);
  assert.equal(received?.memories[0]?.content, '偏好');
  complete('没有验收记录。');
  await first;
  assert.equal(new StudioService(f.options).messages().length, 2);
  fail = true;
  await assert.rejects(f.service.chat('再试'), error =>
    error instanceof Error && /失败/.test(error.message) && !error.message.includes('secret-api-key'));
  assert.equal(f.service.messages().length, 2);
});
test('studio routes require auth; static UI is public and API responses are no-store', async t => {
  const f = fixture();
  const server = new HttpApiServer({
    config: { allowedHttpHosts: [], apiToken: 'x'.repeat(32), httpHost: '127.0.0.1', httpPort: 0 },
    logger: pino({ level: 'silent' }), studioService: f.service,
  } as never);
  const { port } = await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/studio`)).status, 200);
  for (const [path, method] of [['state', 'GET'], ['messages', 'POST'], ['memories', 'POST'], [`memories/${'a'.repeat(36)}`, 'DELETE']]) {
    assert.equal((await fetch(`${base}/studio/${path}`, { method })).status, 401);
  }
  const headers = { Authorization: `Bearer ${'x'.repeat(32)}`, 'Content-Type': 'application/json' };
  const state = await fetch(`${base}/studio/state`, { headers });
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('cache-control'), 'no-store');
  const add = await fetch(`${base}/studio/memories`, { method: 'POST', headers, body: JSON.stringify({ content: '<script>alert(1)</script>' }) });
  assert.equal(add.status, 201);
  const body = await add.json() as { memory: { id: string } };
  const del = await fetch(`${base}/studio/memories/${body.memory.id}`, { method: 'DELETE', headers });
  assert.equal(del.status, 200);
  assert.deepEqual(f.service.memories(), []);
});
