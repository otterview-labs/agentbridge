import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { DatabaseClient } from '../src/infra/storage/database.js';
import { StudioModelSettings, validateModelUrl } from '../src/services/studio-model-settings.js';
import { createPiModel } from '../src/services/pi-studio-model.js';
import { StudioService, type StudioModel } from '../src/services/studio-service.js';
import type { TaskService } from '../src/services/task-service.js';
import { HttpApiServer } from '../src/app/http-server.js';

const logger = pino({ level: 'silent' });
const deviceId = '68c78e62-e20f-4c50-81e6-1d52475c3a7c';
const configuration = {
  enabled: true, provider: 'openai-compatible' as const, modelId: 'test-model',
  baseUrl: 'https://model.example.test/v1', apiKey: 'secret-test-api-key',
};
function fixture(model?: StudioModel) {
  const database = new DatabaseClient(':memory:', logger);
  const tasks: Awaited<ReturnType<TaskService['list']>> = [];
  const service = new StudioService({
    database, tasks: { list: async () => tasks }, machines: { listMachines: async () => [] },
    ssh: { listTasks: async () => [] }, model, now: () => new Date('2026-09-20T09:00:00Z'),
  });
  return { database, service, tasks };
}
const report = {
  summary: '今天完成了手机列表的验收，下一步优先验证连接稳定性。',
  completed: [{ text: '手机列表已人工验收。', taskIds: ['T-1'] }],
  ongoing: [], blockers: [], tomorrow: [{ text: '建议补充断网回归，尚未派发。', taskIds: ['T-1'] }], decisions: [],
};
function acceptedTask() {
  return {
    id: 1, title: '手机列表', machineId: 1, status: 'completed', sessionName: 'dev',
    agentType: 'codex', updatedAt: '2026-09-20T08:00:00Z', objective: '清晰展示', evidence: '用户验收通过',
    timeline: [{ at: '2026-09-20T08:00:00Z', actor: 'owner', message: '人工验收通过：已检查' }],
    supervision: { tone: 'muted', label: '已结束', source: '人工决定', next: '' },
  } as Awaited<ReturnType<TaskService['list']>>[number];
}
test('model config encrypts keys, survives restart, never echoes secrets, rejects key reuse at another endpoint', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const database = new DatabaseClient(':memory:', logger);
  let receivedKey = '';
  const options = { database, keyPath: path.join(dir, 'model.key'), env: {},
    factory: (config: typeof configuration) => ({ label: config.modelId, reply: async () => { receivedKey = config.apiKey; return 'PI_OK'; } }),
  };
  const settings = new StudioModelSettings(options as ConstructorParameters<typeof StudioModelSettings>[0]);
  const publicState = settings.save(configuration);
  assert.equal(publicState.hasApiKey, true);
  assert.equal(JSON.stringify(publicState).includes(configuration.apiKey), false);
  assert.equal(String(database.prepare('SELECT encrypted FROM studio_model_settings').get()!.encrypted).includes(configuration.apiKey), false);
  assert.equal(fs.statSync(options.keyPath).mode & 0o777, 0o600);
  const restarted = new StudioModelSettings(options as ConstructorParameters<typeof StudioModelSettings>[0]);
  await restarted.test({ ...configuration, apiKey: '' });
  assert.equal(receivedKey, configuration.apiKey);
  assert.throws(() => settings.save({ ...configuration, apiKey: '', baseUrl: 'https://other.example.test/v1' }), /重新输入/);
  assert.equal(settings.publicState().baseUrl, configuration.baseUrl);
  settings.save({ ...configuration, enabled: false, apiKey: '' });
  assert.equal(settings.model(), undefined);
  fs.unlinkSync(options.keyPath);
  assert.throws(() => restarted.publicState(), /无法解密/);
  assert.equal(fs.existsSync(options.keyPath), false);
});
test('model URL policy refuses insecure remote destinations and embedded credentials', () => {
  for (const url of ['http://example.com/v1', 'file:///tmp/key', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#key']) {
    assert.throws(() => validateModelUrl(url));
  }
  assert.equal(validateModelUrl('http://127.0.0.1:8787/v1/'), 'http://127.0.0.1:8787/v1');
});
test('Pi Agent really traverses compatible HTTP stream; receives no tools; refuses redirects', async t => {
  let requestBody: Record<string, unknown> = {};
  let auth = '';
  let redirect = false;
  let leaked = 0;
  const api = createServer(async (req, res) => {
    if (req.url === '/leak') { leaked++; res.end('{}'); return; }
    if (redirect) { res.writeHead(302, { location: '/leak' }); res.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requestBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    auth = req.headers.authorization || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'PI_OK' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.closeAllConnections(); api.close(); });
  const model = createPiModel({ ...configuration, baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1` });
  assert.equal(await model.reply({ message: '连接测试', history: [], memories: [], context: '{}' }), 'PI_OK');
  assert.equal(auth, `Bearer ${configuration.apiKey}`);
  assert.ok(!requestBody.tools || (requestBody.tools as unknown[]).length === 0);
  redirect = true;
  await assert.rejects(model.reply({ message: '拒绝重定向', history: [], memories: [], context: '{}' }));
  assert.equal(leaked, 0);
});
test('daily report is generated by model, persisted with sources, and never replaces old report on failure', async () => {
  let output = JSON.stringify(report);
  const f = fixture({ label: 'test-pi', reply: async input => {
    assert.match(input.context, /用户验收通过/);
    assert.match(input.message, /不要机械复制列表/);
    return output;
  } });
  f.tasks.push(acceptedTask());
  const saved = await f.service.generateReport('2026-09-20');
  assert.equal(saved.content.summary, report.summary);
  assert.equal((await f.service.snapshot()).dailyReport?.id, saved.id);
  assert.equal(saved.sources[0]?.id, 'T-1');
  output = 'not json';
  await assert.rejects(f.service.generateReport('2026-09-20'), /格式/);
  assert.equal(f.service.reports('2026-09-20').length, 1);
  output = JSON.stringify({ ...report, completed: [{ text: '编造完成', taskIds: ['T-2'] }] });
  await assert.rejects(f.service.generateReport('2026-09-20'), /不存在/);
  f.tasks[0]!.status = 'running';
  output = JSON.stringify(report);
  await assert.rejects(f.service.generateReport('2026-09-20'), /未验收/);
  await assert.rejects(f.service.generateReport('2026-09-19'), /历史/);
  assert.equal(f.service.reports('2026-09-20')[0]?.id, saved.id);
});
test('device sync separates namespaces, rejects secrets and ignores stale snapshots', async () => {
  const f = fixture();
  const payload = {
    revision: 2, deviceName: '测试手机', machines: [{ id: 1, name: 'Mac', status: 'online', tools: ['codex'] }],
    tasks: [{ id: 1, machineId: 1, title: '修复', agentType: 'codex', status: 'idle', requiredInput: false }],
  };
  assert.equal(f.service.sync.receive(deviceId, payload).accepted, true);
  assert.equal(f.service.sync.receive(deviceId, { ...payload, revision: 1, tasks: [] }).accepted, false);
  assert.equal((await f.service.snapshot()).tasks.length, 1);
  assert.equal((await f.service.snapshot()).tasks[0]?.id, `P-${deviceId}-1`);
  assert.equal((await f.service.snapshot()).report.completed.length, 0);
  assert.throws(() => f.service.sync.receive(deviceId, { ...payload, privateKey: 'secret' }));
  assert.throws(() => f.service.sync.receive(deviceId, { ...payload, tasks: [{ ...payload.tasks[0], lastOutput: 'raw' }] }));
  assert.throws(() => f.service.sync.receive(deviceId, { ...payload, tasks: [{ ...payload.tasks[0], status: 'completed' }] }));
  f.service.sync.remove(deviceId);
  assert.equal((await f.service.snapshot()).tasks.length, 0);
});
test('mobile memory import is atomic, idempotent and does not resurrect a deleted Hub memory', () => {
  const f = fixture();
  const payload = [{ id: 'local-1', content: '先说结论' }];
  assert.equal(f.service.sync.importMemories(deviceId, payload).imported, 1);
  assert.equal(f.service.sync.importMemories(deviceId, payload).imported, 0);
  f.service.deleteMemory(f.service.memories()[0]!.id);
  assert.equal(f.service.sync.importMemories(deviceId, payload).imported, 0);
  assert.equal(f.service.memories().length, 0);
  for (let i = 0; i < 49; i++) f.service.addMemory(String(i));
  assert.throws(() => f.service.sync.importMemories(deviceId, [{ id: 'a', content: 'a' }, { id: 'b', content: 'b' }]), /50/);
  assert.equal(f.service.memories().length, 49);
});
test('model, report and device routes enforce authorization before any access', async t => {
  const server = new HttpApiServer({
    config: { allowedHttpHosts: [], apiToken: 'x'.repeat(32), httpHost: '127.0.0.1', httpPort: 0 }, logger,
  } as never);
  const { port } = await server.start(); t.after(() => server.stop());
  for (const [url, method] of [
    ['/studio/model', 'GET'], ['/studio/model', 'PUT'], ['/studio/model/test', 'POST'],
    ['/studio/reports?date=2026-09-20', 'GET'], ['/studio/reports', 'POST'],
    [`/studio/devices/${deviceId}/snapshot`, 'POST'], [`/studio/devices/${deviceId}/snapshot`, 'DELETE'],
    [`/studio/devices/${deviceId}/memories`, 'POST'],
  ]) assert.equal((await fetch(`http://127.0.0.1:${port}${url}`, { method })).status, 401);
});
