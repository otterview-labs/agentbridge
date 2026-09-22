const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = path.resolve(__dirname, '../../public');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

function data(ready = false) {
  const task = { id: 'T-24', machineId: 2, title: '验证公网接入', agentType: 'codex',
    status: 'review', label: '待人工验收', next: '检查真机测试记录，不自动批准。', source: 'Hub 任务', needsAttention: true };
  return {
    date: '2026-09-20', tomorrow: '2026-09-21', scope: '测试 Hub 数据，不含手机记录',
    model: { ready, label: ready ? 'Pi · test-only' : 'Pi 未配置' },
    machines: [
      { id: 1, name: 'MacBook', status: 'online', lastSeenAt: '2026-09-20T03:00:00Z' },
      { id: 2, name: 'Mac Pro', status: 'unknown', lastSeenAt: null },
      { id: 3, name: 'Linux', status: 'offline', lastSeenAt: '2026-09-19T03:00:00Z' },
    ],
    tasks: [task], report: { completed: [], ongoing: [task],
      suggestions: [{ taskId: task.id, title: task.title, next: task.next }] },
    memories: [], messages: [],
  };
}
function report() {
  return {
    id: 'report-1', date: '2026-09-20', generatedAt: '2026-09-20T04:00:00Z', model: 'Pi · test-only',
    content: { summary: '接入工作已进入验收阶段，当前没有证据说明交付完成。',
      completed: [], ongoing: [{ text: '先核实真机接入结果，再决定是否交付。', taskIds: ['T-24'] }],
      blockers: [], tomorrow: [{ text: '优先补齐真机测试证据。', taskIds: ['T-24'] }], decisions: [] },
    sources: [{ id: 'T-24', title: '验证公网接入', source: 'Hub 任务' }], coverage: '测试记录范围',
  };
}
async function open(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: options.width || 390, height: 844 }, reducedMotion: 'reduce' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  const state = data(options.ready);
  const config = { enabled: false, provider: 'anthropic', modelId: '', baseUrl: 'https://api.anthropic.com', hasApiKey: false, source: 'saved' };
  const requests = [];
  if (options.empty) { state.machines = []; state.tasks = []; state.report.ongoing = []; state.report.suggestions = []; }
  if (options.long) { state.machines[1].name = 'VeryLongOfficeName'.repeat(15); state.tasks[0].title = '<img src=x onerror=alert(1)>' + '长任务名称'.repeat(50); }
  let failed = false;
  await page.route('http://studio.test/**', async route => {
    const name = new URL(route.request().url()).pathname;
    if (name.startsWith('/studio/')) requests.push({ name, method: route.request().method() });
    if (name === '/studio/model') {
      if (route.request().method() === 'PUT') {
        if (options.modelFails) return route.fulfill({ status: 400, json: { error: '测试：模型配置无效' } });
        const input = route.request().postDataJSON();
        Object.assign(config, input, { hasApiKey: Boolean(input.apiKey) || config.hasApiKey });
        delete config.apiKey;
        state.model.ready = config.enabled;
        state.model.label = 'Pi · configured-test';
      }
      return route.fulfill({ json: config });
    }
    if (name === '/studio/model/test') return route.fulfill({ json: { ok: true, saved: false } });
    if (name === '/studio/reports') {
      if (route.request().method() === 'POST') {
        if (options.reportFails) return route.fulfill({ status: 409, json: { error: '测试：模型不可用，旧日报已保留' } });
        state.dailyReport = report();
        state.reportHistory = [{ date: state.date, versions: 1 }];
        return route.fulfill({ json: { report: state.dailyReport } });
      }
      return route.fulfill({ json: { reports: state.dailyReport ? [state.dailyReport] : [] } });
    }
    if (name === '/studio/state') {
      if (failed) return route.fulfill({ status: 503, json: { error: 'Hub 暂时离线' } });
      return route.fulfill({ json: state });
    }
    if (name === '/studio/memories' && route.request().method() === 'POST') {
      const memory = { id: 'test-memory', content: route.request().postDataJSON().content, createdAt: new Date().toISOString() };
      state.memories.push(memory);
      return route.fulfill({ status: 201, json: { memory } });
    }
    if (name.startsWith('/studio/memories/')) { state.memories = []; return route.fulfill({ json: { ok: true } }); }
    if (name === '/studio/messages') {
      if (options.chatFails) return route.fulfill({ status: 409, json: { error: '管家回复失败' } });
      state.messages.push({ id: 'user', role: 'user', content: route.request().postDataJSON().content },
        { id: 'assistant', role: 'assistant', content: '测试模型回复：任务尚待验收。' });
      return route.fulfill({ json: { messages: state.messages } });
    }
    const filename = name === '/studio' ? 'studio.html' : name.slice(1);
    return route.fulfill({ body: fs.readFileSync(path.join(assets, filename)), contentType: filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  if (options.native || options.nativeHub) {
    await page.addInitScript(({ connected, state }) => {
      const memories = [];
      const ok = data => JSON.stringify({ ok: true, data });
      window.testHubOffline = false;
      window.testNativeCalls = [];
      window.AgentBridge = {
        studioHubSettings: () => ok({ connected, baseUrl: 'https://hub.test', deviceId: 'test-device', shareTasks: false }),
        disconnectStudioHub: () => ok({}),
        beginStudioHubRequest: (id, route, method, body) => {
          window.testNativeCalls.push({ route, method });
          let data = state;
          if (route === '/studio/messages') {
            state.messages.push({ role: 'user', content: JSON.parse(body).content }, { role: 'assistant', content: '共享管家回复' });
            data = { messages: state.messages };
          } else if (route === '/studio/memories') {
            const memory = { id: 'shared-memory', content: JSON.parse(body).content };
            state.memories.push(memory); data = { memory };
          } else if (route === '/studio/model') {
            data = { enabled: true, provider: 'openai-compatible', modelId: 'test', baseUrl: 'https://model.test/v1', hasApiKey: true };
          }
          setTimeout(() => window.studioHubResponse(id, window.testHubOffline
            ? { ok: false, error: 'Hub 测试断网' } : { ok: true, data: JSON.parse(JSON.stringify(data)) }), 5);
        },
        studioState: () => ok({ machines: [{ id: 1, name: '手机上的 Mac', status: 'online' }],
          tasks: [{ id: 2, machineId: 1, title: '手机任务', agentType: 'codex', status: 'idle' }], memories }),
        addStudioMemory: content => { const memory = { id: 'local', content, createdAt: new Date().toISOString() }; memories.push(memory); return ok({ memory }); },
        deleteStudioMemory: () => { memories.length = 0; return ok({}); },
      };
    }, { connected: Boolean(options.nativeHub), state });
  }
  await page.goto('http://studio.test/studio');
  await page.waitForFunction(() => !document.getElementById('dateLabel').textContent.includes('正在'));
  return { page, state, requests, fail: () => { failed = true; } };
}
for (const width of [320, 390, 760, 1280]) {
  test(`studio ${width}px navigates without horizontal overflow, including long titles`, async t => {
    const { page } = await open(t, { width, long: true });
    for (const name of ['town', 'daily', 'memory', 'chat']) {
      await page.locator(`[data-view="${name}"]`).click();
      assert.equal(await page.locator(`#view-${name}`).isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.equal(await page.locator('#send').isDisabled(), true);
    await page.locator('[data-view=town]').click();
    await page.locator('#officeList .office').nth(1).click();
    assert.match(await page.locator('#taskList').innerText(), /待人工验收/);
    assert.equal(await page.locator('#taskList img').count(), 0);
  });
}
test('memory creates, persists after reload, renders untrusted text safely and deletes', async t => {
  const { page } = await open(t);
  await page.locator('[data-view=memory]').click();
  await page.locator('#memoryInput').fill('<img src=x onerror=alert(1)>先说结论');
  await page.locator('#remember').click();
  await page.locator('.memory').waitFor();
  await page.reload();
  await page.locator('[data-view=memory]').click();
  await page.locator('.memory').waitFor();
  assert.equal(await page.locator('.memory img').count(), 0);
  page.on('dialog', d => d.accept());
  await page.locator('.memory button').click();
  await page.waitForFunction(() => !document.querySelector('.memory'));
  assert.equal(await page.evaluate(() => localStorage.getItem('asb.apiToken')), null);
});
test('configured chat displays mocked API response; failed requests retain draft', async t => {
  const { page } = await open(t, { ready: true });
  await page.locator('#chatInput').fill('今天怎样');
  await page.locator('#send').click();
  await page.getByText('测试模型回复：任务尚待验收。', { exact: true }).waitFor();
  assert.equal(await page.locator('#chatInput').inputValue(), '');
  const failed = await open(t, { ready: true, chatFails: true });
  await failed.page.locator('#chatInput').fill('保留草稿');
  await failed.page.locator('#send').click();
  await failed.page.locator('#errorBanner').waitFor();
  assert.equal(await failed.page.locator('#chatInput').inputValue(), '保留草稿');
  assert.equal(await failed.page.locator('#messages .assistant').count(), 0);
});
test('refresh failure preserves last records and clearly marks them stale', async t => {
  const f = await open(t);
  f.fail();
  await f.page.locator('#refresh').click();
  await f.page.locator('#errorBanner').waitFor();
  assert.match(await f.page.locator('#dateLabel').innerText(), /上次读取/);
  assert.equal(await f.page.locator('#officePreview .office').count(), 3);
});
test('empty state links to existing console without inventing machines', async t => {
  const { page } = await open(t, { empty: true });
  assert.match(await page.locator('#brief').innerText(), /还没有工作记录/);
  assert.equal(await page.locator('.office').count(), 0);
});
test('Android adapter uses only local bridge, never claims shared Hub memory or completion', async t => {
  const { page } = await open(t, { native: true });
  assert.equal(await page.locator('#consoleLink').getAttribute('href'), './phone.html');
  assert.equal(await page.locator('#send').isDisabled(), true);
  await page.locator('[data-view=daily]').click();
  await page.locator('.report-evidence summary').click();
  assert.match(await page.locator('#reportCompleted').innerText(), /尚无人工验收/);
  await page.locator('[data-view=memory]').click();
  assert.match(await page.locator('#memoryScope').innerText(), /尚未与 Hub 同步/);
  await page.locator('#memoryInput').fill('手机偏好');
  await page.locator('#remember').click();
  await page.locator('.memory').waitFor();
  await page.locator('[data-view=town]').click();
  assert.equal(await page.locator('#taskList a').getAttribute('href'), './phone.html#task=2');
});
test('model settings stay within mobile width; save clears key and test does not save', async t => {
  const { page, requests } = await open(t, { width: 320 });
  await page.locator('#connectionToggle').click();
  await page.locator('#modelDetails summary').click();
  await page.locator('#modelProvider').selectOption('openai-compatible');
  await page.locator('#modelId').fill('test-model');
  await page.locator('#modelKey').fill('test-only-secret');
  await page.locator('#modelEnabled').check();
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#testModel').click();
  await page.waitForFunction(() => document.getElementById('modelStatus').textContent.includes('测试通过'));
  assert.equal(requests.some(r => r.method === 'PUT'), false);
  await page.locator('#saveModel').click();
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  assert.equal(await page.locator('#modelKey').inputValue(), '');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => document.body.innerText.includes('test-only-secret')), false);
});
test('failed model save stays visible and never enables unconfigured chat', async t => {
  const { page } = await open(t, { modelFails: true });
  await page.locator('#connectionToggle').click();
  await page.locator('#modelDetails summary').click();
  await page.locator('#modelId').fill('invalid');
  await page.locator('#saveModel').click();
  await page.locator('#errorBanner').waitFor();
  assert.match(await page.locator('#errorBanner').innerText(), /模型配置无效/);
  assert.equal(await page.locator('#send').isDisabled(), true);
});
test('daily report is model analysis with sources, persists after reload, and failure preserves old report', async t => {
  const { page } = await open(t, { ready: true });
  await page.locator('[data-view=daily]').click();
  await page.locator('#generateReport').click();
  await page.getByText(report().content.summary, { exact: true }).waitFor();
  assert.match(await page.locator('#dailyReport').innerText(), /T-24.*验证公网接入/);
  assert.equal(await page.locator('.report-evidence').getAttribute('open'), null);
  await page.reload();
  await page.locator('[data-view=daily]').click();
  await page.getByText(report().content.summary, { exact: true }).waitFor();
  const failed = await open(t, { ready: true, reportFails: true });
  failed.state.dailyReport = report();
  await failed.page.locator('#refresh').click();
  await failed.page.locator('[data-view=daily]').click();
  await failed.page.getByText(report().content.summary, { exact: true }).waitFor();
  await failed.page.locator('#generateReport').click();
  await failed.page.locator('#errorBanner').waitFor();
  assert.match(await failed.page.locator('#dailyReport').innerText(), /当前没有证据/);
});
test('connected Android uses shared chat and memory; offline never silently falls back to local data', async t => {
  const { page, requests } = await open(t, { nativeHub: true, ready: true });
  await page.locator('#chatInput').fill('跨端上下文');
  await page.locator('#send').click();
  await page.getByText('共享管家回复', { exact: true }).waitFor();
  await page.locator('[data-view=memory]').click();
  assert.match(await page.locator('#memoryScope').innerText(), /同一份记忆/);
  await page.locator('#memoryInput').fill('共享偏好');
  await page.locator('#remember').click();
  await page.locator('.memory').waitFor();
  await page.evaluate(() => { window.testHubOffline = true; });
  await page.locator('#refresh').click();
  await page.locator('#errorBanner').waitFor();
  assert.match(await page.locator('#dateLabel').innerText(), /上次读取/);
  assert.match(await page.locator('.memory').innerText(), /共享偏好/);
  assert.equal(requests.length, 0, 'native transport must not put Hub credentials into browser fetch');
  const calls = await page.evaluate(() => window.testNativeCalls);
  assert.equal(calls.some(c => c.route === '/studio/messages'), true);
  assert.equal(calls.some(c => c.route === '/studio/memories'), true);
});
