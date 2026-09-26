const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const assets = path.resolve(__dirname, '../app/src/main/assets');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function openPhone(t, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 363, height: 800 },
    isMobile: true,
    hasTouch: true,
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce'
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('http://phone.test/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'phone.html';
    const contentType = name.endsWith('.css') ? 'text/css'
      : name.endsWith('.js') ? 'application/javascript' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(path.join(assets, name)), contentType });
  });
  await page.addInitScript(options => {
    const checkedAt = '2026-09-20T03:00:00Z';
    const data = {
      networkHint: '192.168.1',
      machines: [
        { id: 1, name: 'Mac Pro · 开发办公室', username: 'demo', host: '192.168.1.8',
          port: 22, lastStatus: 'online', lastCheckedAt: checkedAt, tools: ['codex', 'claude-code'] },
        { id: 2, name: 'Linux · 测试办公室', username: 'demo', host: '192.168.1.9',
          port: 22, lastStatus: 'offline', lastCheckedAt: checkedAt, tools: ['codex'] }
      ],
      tasks: [
        { id: 1, machineId: 1, title: '修复手机版任务状态显示', agentType: 'codex',
          status: 'running', workSummary: '正在检查状态映射与移动端回归测试',
          workspacePath: '/workspace/agent-session-bridge', controlMode: 'process',
          externalSessionId: 'demo-1', lastOutput: '运行单元测试中' },
        { id: 2, machineId: 1, title: '检查部署配置与远程连接', agentType: 'claude-code',
          status: 'idle', requiredInput: '是否允许执行部署脚本？',
          workSummary: '已完成配置检查，等待确认', controlMode: 'tmux', paneId: '%2' },
        { id: 3, machineId: 2, title: '[Image: original 720x1600, displayed at 360x800. Multiply', agentType: 'codex',
          status: 'idle', workSummary: '最近一次记录：会话空闲', controlMode: 'process' }
      ]
    };
    if (options.empty) { data.machines = []; data.tasks = []; }
    if (options.frpStatus) {
      data.frpServer = { machineId: 2, publicAddress: 'public.example.test',
        bindPort: 7001, status: options.frpStatus,
        lastError: options.frpStatus === 'error' ? '部署公网入口失败：阶段 checksum' : '' };
      data.machines[0].publicAccessError = options.frpStatus === 'error'
        ? '连接目标机器 SSH 失败：地址不可达' : '';
      if (options.frpStatus === 'online') {
        data.frpRelays = [{ machineId: 1, enabled: true, status: 'online', verifiedAt: checkedAt }];
      }
    }
    if (options.noCheckedAt) {
      data.machines.forEach(machine => {
        delete machine.lastCheckedAt;
        machine.updatedAt = checkedAt;
      });
    }
    if (options.longText) {
      data.machines[0].name = 'VeryLongOfficeName'.repeat(8);
      data.tasks[0].title = 'VeryLongTaskTitle'.repeat(10);
      data.tasks[0].workspacePath = '/workspace/' + 'long-path'.repeat(20);
    }
    const ok = data => JSON.stringify({ ok: true, data });
    const fail = error => JSON.stringify({ ok: false, error });
    let reads = 0;
    let operation;
    let tailOperation;
    window.sendCount = 0;
    window.tailCount = 0;
    window.voiceCalls = [];
    window.AgentBridge = {
      state: () => ++reads > 1 && options.stateFails
        ? fail('读取失败') : ok(data),
      discoverTasks: id => (options.failedIds || []).includes(id)
        ? fail('SSH 无法连接') : ok({ tasks: data.tasks }),
      tailTask: () => {
        if (options.taskDisappears) data.tasks.shift();
        else {
          data.tasks[0].status = 'idle';
          data.tasks[0].workSummary = '会话已空闲，尚未验收';
          data.tasks[0].lastOutput = '最新输出';
        }
        return ok({});
      },
      beginSendPrompt: () => {
        window.sendCount += 1;
        operation = { kind: 'send', id: 'test-send', startedAt: Date.now(),
          task: structuredClone(data.tasks[0]) };
        return ok({ operation });
      },
      beginTailTask: id => {
        window.tailCount += 1;
        const task = data.tasks.find(item => item.id === id) || data.tasks[0];
        tailOperation = { kind: 'tail', id: 'test-tail', startedAt: Date.now(),
          taskId: id, stableKey: task.stableKey || '', machineId: task.machineId };
        return ok({ operation: tailOperation });
      },
      operationState: () => {
        const current = operation?.kind === 'send' && (!tailOperation || window.sendCount)
          ? operation : tailOperation;
        if (!current) return fail('后台任务不存在');
        if (current.kind === 'send' && options.holdSend && !window.releaseSend) {
          return ok({ operation: { ...current, state: 'running', message: '执行中' } });
        }
        if (options.sendFails) {
          return ok({ operation: { ...current, state: 'failed', message: '发送失败' } });
        }
        if (current.kind === 'tail') {
          if (options.taskDisappears) data.tasks.shift();
          else {
            data.tasks[0].status = 'idle';
            data.tasks[0].workSummary = '会话已空闲，尚未验收';
            data.tasks[0].lastOutput = '最新输出';
          }
          return ok({ operation: { ...current, state: 'succeeded', message: '任务输出已刷新' } });
        }
        data.tasks[0].status = 'idle';
        data.tasks[0].lastOutput = '回复后的新输出';
        data.tasks[0].workSummary = '回复已结束，等待下一条指令';
        return ok({ operation: { ...current, state: 'succeeded', message: '回复已发送',
          task: structuredClone(data.tasks[0]) } });
      },
      clearOperation: () => {},
      startVoiceInput: autoSend => {
        window.voiceCalls.push(['start', autoSend]);
        return ok({ recording: true });
      },
      stopVoiceInput: () => {
        window.voiceCalls.push(['stop']);
        return ok({ recording: false });
      },
      cancelVoiceInput: () => {
        window.voiceCalls.push(['cancel']);
        return ok({ recording: false });
      }
    };
  }, options);
  await page.goto('http://phone.test/phone.html');
  await page.locator(options.empty ? '.empty' : '.employee').first().waitFor();
  return page;
}

async function expectToast(page, text) {
  await page.waitForFunction(expected =>
    document.getElementById('toast').textContent === expected, text);
}

test('compact office controls, responsive layout and navigation', async t => {
  const page = await openPhone(t);
  for (const width of [320, 363, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  }
  await page.setViewportSize({ width: 363, height: 800 });
  const office = page.locator('.office').first();
  assert.equal(await office.locator('.officeActions button:visible').count(), 2);
  assert.equal(await office.getByRole('button', { name: '删除', exact: true }).isVisible(), false);
  assert.match(await office.locator('.officeCheck').textContent(), /上次连接正常.*2026\/09\/20 11:00/);
  assert.match(await page.locator('.employee').nth(2).locator('.employeeName').textContent(), /图片输入/);
  assert.doesNotMatch(await page.locator('.employee').nth(2).textContent(), /\[Image:/);
  await office.getByRole('button', { name: '更多', exact: true }).click();
  assert.equal(await office.getByRole('button', { name: '删除', exact: true }).isVisible(), true);
  await office.getByRole('button', { name: '收起', exact: true }).click();
  assert.equal(await office.locator('.employee').count(), 0);
  await page.reload();
  await page.locator('.officeCollapsedSummary').first().waitFor();
  await office.getByRole('button', { name: '更多', exact: true }).click();
  await office.getByRole('button', { name: '展开', exact: true }).click();
  assert.equal(await office.locator('.employee').count(), 2);
  if (process.env.SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'phone-offices.png') });
  }
  await page.locator('[data-view="todo"]').click();
  assert.equal(await page.locator('.todoCard').count(), 1);
  await page.locator('.todoCard').click();
  assert.match(await page.locator('#taskMeta').textContent(), /tmux · 可回复/);
  await page.locator('[data-close="taskBackdrop"]').click();
  await page.locator('[data-view="public"]').click();
  await page.getByRole('button', { name: '开始配置', exact: true }).click();
  assert.equal(await page.locator('#frpForm').isVisible(), true);
});

test('refresh reports success, partial failure and total failure accurately', async t => {
  for (const [failedIds, expected] of [
    [[], '任务已刷新'],
    [[2], '已刷新 1/2 台，其余保留上次记录'],
    [[1, 2], '刷新失败，保留上次记录']
  ]) {
    await t.test(expected, async t => {
      const page = await openPhone(t, { failedIds });
      await page.locator('#refreshAll').click();
      await expectToast(page, expected);
    });
  }
});

test('state read failure is not replaced by a success toast', async t => {
  const page = await openPhone(t, { stateFails: true });
  await page.locator('#refreshAll').click();
  await expectToast(page, '读取失败');
  assert.equal(await page.locator('.employee').count(), 3);
});

test('detail refresh updates status and output without clearing a draft', async t => {
  const page = await openPhone(t);
  await page.locator('[data-task-id="1"]').click();
  await page.locator('#replyText').fill('尚未发送的草稿');
  await page.locator('#tailTask').click();
  await expectToast(page, '刷新输出已提交后台，完成后会通知你');
  await page.waitForFunction(() => document.getElementById('taskOutput').textContent === '最新输出');
  assert.match(await page.locator('#taskStatusLine').textContent(), /会话空闲/);
  assert.equal(await page.locator('#replyText').inputValue(), '尚未发送的草稿');
});

test('reply completion displays fresh state, not the initial operation snapshot', async t => {
  const page = await openPhone(t);
  await page.locator('[data-task-id="1"]').click();
  await page.locator('#replyText').fill('测试消息，不发送到真实机器');
  await page.locator('#sendTask').click();
  await expectToast(page, '已提交后台执行，成功或失败会通知你');
  await page.waitForFunction(() => document.getElementById('sendTask').disabled === false);
  assert.equal(await page.locator('#taskOutput').textContent(), '回复后的新输出');
  assert.match(await page.locator('#taskStatusLine').textContent(), /会话空闲/);
  assert.equal(await page.locator('#replyText').inputValue(), '');
});

test('a missing task cannot receive another reply', async t => {
  const page = await openPhone(t, { taskDisappears: true });
  await page.locator('[data-task-id="1"]').click();
  await page.locator('#tailTask').click();
  await expectToast(page, '刷新输出已提交后台，完成后会通知你');
  await page.waitForFunction(() => /本次未发现/.test(document.getElementById('taskStatusLine').textContent));
  assert.match(await page.locator('#taskStatusLine').textContent(), /本次未发现/);
});

test('editing timestamps are not presented as connection checks', async t => {
  const page = await openPhone(t, { noCheckedAt: true });
  assert.equal(await page.locator('.officeCheck').first().textContent(), '尚未检查 · 点击找任务');
});

test('long titles and paths fit narrow screens', async t => {
  const page = await openPhone(t, { longText: true });
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  await page.locator('[data-task-id="1"]').click();
  assert.equal(await page.locator('.taskSheet').evaluate(el => el.scrollWidth <= el.clientWidth), true);
});

test('empty state does not imply active supervision', async t => {
  const page = await openPhone(t, { empty: true });
  await page.locator('[data-view="todo"]').click();
  assert.match(await page.locator('#todo').textContent(), /暂无待输入记录.*检查最新会话状态/);
  assert.equal(await page.locator('#attentionCount').isDisabled(), true);
  await page.locator('#refreshAll').click();
  await page.locator('#machineForm').waitFor({ state: 'visible' });
});

test('attention shortcut and employee ordering prioritize pending input', async t => {
  const page = await openPhone(t);
  assert.equal(await page.locator('.employee').first().getAttribute('data-task-id'), '2');
  assert.equal(await page.locator('#todoTab').textContent(), '待输入 · 1');
  await page.locator('#attentionCount').click();
  assert.equal(await page.locator('#todoTab').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#todo').isVisible(), true);
  await page.locator('.todoCard').click();
  assert.equal(await page.locator('#taskNeed').textContent(), '需要你确认：是否允许执行部署脚本？');
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'phone-task.png') });
  }
});

test('offline employees show historical status with no work animation', async t => {
  const page = await openPhone(t);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const recorded = page.locator('[data-task-id="3"]');
  assert.equal(await recorded.getAttribute('data-record'), 'true');
  assert.equal(await recorded.locator('.employeeBubble').textContent(), '上次');
  assert.match(await recorded.locator('.stateChip').textContent(), /上次：会话空闲/);
  assert.equal(await recorded.locator('.pixelAvatar').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.notEqual(await page.locator('[data-task-id="1"] .pixelAvatar')
    .evaluate(el => getComputedStyle(el).animationName), 'none');
});

test('task drafts remain separate when closing and reopening sheets', async t => {
  const page = await openPhone(t);
  await page.locator('[data-task-id="1"]').click();
  await page.locator('#replyText').fill('任务一的草稿');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#taskBackdrop').isVisible(), false);
  assert.equal(await page.evaluate(() => document.body.classList.contains('sheetOpen')), false);
  await page.locator('[data-task-id="2"]').click();
  assert.equal(await page.locator('#replyText').inputValue(), '');
  await page.locator('#replyText').fill('任务二的草稿');
  assert.equal(await page.evaluate(() => window.phoneUI.closeTopSheet()), true);
  await page.locator('[data-task-id="1"]').click();
  assert.equal(await page.locator('#replyText').inputValue(), '任务一的草稿');
  await page.locator('[data-close="taskBackdrop"]').click();
  await page.locator('[data-task-id="2"]').click();
  assert.equal(await page.locator('#replyText').inputValue(), '任务二的草稿');
});

test('modal contains focus, locks background and restores focus on close', async t => {
  const page = await openPhone(t);
  const trigger = page.locator('[data-task-id="1"]');
  await trigger.focus();
  await trigger.click();
  assert.equal(await page.evaluate(() => document.querySelector('.app').hasAttribute('inert')), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), 'hidden');
  await page.locator('[data-close="taskBackdrop"]').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sendTask');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.close), 'taskBackdrop');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.taskId), '1');
  assert.equal(await page.evaluate(() => document.querySelector('.app').hasAttribute('inert')), false);
});

test('confirmed sends update from operation data even if state reads fail', async t => {
  const page = await openPhone(t, { stateFails: true });
  await page.locator('[data-task-id="1"]').click();
  await page.locator('#replyText').fill('只发送一次');
  await page.locator('#sendTask').click();
  await expectToast(page, '已提交后台执行，成功或失败会通知你');
  await page.waitForFunction(() => document.getElementById('sendTask').disabled === false);
  assert.equal(await page.locator('#replyText').inputValue(), '');
  await page.locator('[data-close="taskBackdrop"]').click();
  await page.locator('[data-task-id="1"]').click();
  assert.equal(await page.locator('#replyText').inputValue(), '');
});

test('failed replies retain the draft for correction', async t => {
  const page = await openPhone(t, { sendFails: true });
  await page.locator('[data-task-id="1"]').click();
  await page.locator('#replyText').fill('需要保留的回复');
  await page.locator('#sendTask').click();
  await expectToast(page, '发送失败');
  assert.equal(await page.locator('#sendTask').isEnabled(), true);
  await page.locator('[data-close="taskBackdrop"]').click();
  await page.locator('[data-task-id="1"]').click();
  assert.equal(await page.locator('#replyText').inputValue(), '需要保留的回复');
});

test('background sending prevents duplicate submissions and allows navigation', async t => {
  const page = await openPhone(t, { holdSend: true });
  await page.locator('[data-task-id="1"]').click();
  await page.locator('#replyText').fill('测试并发点击');
  await page.evaluate(() => {
    const button = document.getElementById('sendTask');
    button.dispatchEvent(new Event('click'));
    button.dispatchEvent(new Event('click'));
  });
  await page.waitForFunction(() => window.sendCount === 1);
  assert.equal(await page.evaluate(() => window.phoneUI.closeTopSheet()), true);
  assert.equal(await page.locator('#taskBackdrop').isVisible(), false);
  assert.equal(await page.locator('#sendTask').isDisabled(), true);
  await page.evaluate(() => { window.releaseSend = true; });
  await page.waitForFunction(() => /^通知|^后台/.test(document.getElementById('backgroundState').textContent)
    && !document.getElementById('backgroundState').textContent.startsWith('后台'));
  assert.equal(await page.evaluate(() => window.sendCount), 1);
  await page.locator('[data-task-id="1"]').click();
  assert.equal(await page.locator('#sendTask').isEnabled(), true);
});

test('unidentified sessions cannot receive a reply', async t => {
  const page = await openPhone(t);
  await page.locator('[data-task-id="3"]').click();
  assert.equal(await page.locator('#sendTask').isDisabled(), true);
  assert.match(await page.locator('#taskMeta').textContent(), /无会话 ID，暂不能回复/);
});

test('butler composer supports hold-to-talk and slide-to-cancel', async t => {
  const page = await openPhone(t);
  await page.locator('[data-view="butler"]').click();
  const button = page.locator('#voiceButton');
  const box = await button.boundingBox();
  assert.ok(box);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.locator('#voicePanel').waitFor();
  assert.match(await page.locator('#voicePanelHint').textContent(), /转文字并发送/);

  await page.mouse.move(x, y - 90, { steps: 4 });
  await page.locator('#voicePanel.cancel').waitFor();
  await page.mouse.up();
  assert.equal(await page.locator('#voicePanel').isHidden(), true);
  assert.deepEqual(await page.evaluate(() => window.voiceCalls), [['start', true], ['cancel']]);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(320);
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.voiceCalls.slice(-2)), [['start', true], ['stop']]);
  assert.match(await page.locator('#voiceStateText').textContent(), /正在整理/);
});

test('public setup shows persistent stage errors and gates deployment on entry readiness', async t => {
  const page = await openPhone(t, { frpStatus: 'error' });
  await page.locator('[data-view="public"]').click();
  assert.match(await page.locator('.publicHeader .deploymentError').textContent(), /阶段 checksum/);
  assert.match(await page.locator('.publicMachine .deploymentError').textContent(), /连接目标机器 SSH/);
  assert.equal(await page.getByRole('button', { name: '先部署公网入口' }).isDisabled(), true);
  assert.match(await page.locator('.publicMachine').textContent(), /尚未验证公网连接/);
});

test('successful relay shows a past verification time, not a continuous connectivity claim', async t => {
  const page = await openPhone(t, { frpStatus: 'online' });
  await page.locator('[data-view="public"]').click();
  assert.match(await page.locator('.publicMachine').textContent(), /上次验证 2026\/09\/20 11:00/);
  assert.doesNotMatch(await page.locator('.publicMachine').textContent(), /已可远程访问/);
  assert.equal(await page.getByRole('button', { name: '重新配置', exact: true }).isEnabled(), true);
});

test('native reply commands do not force bypass and guard the Codex command group', () => {
  const source = fs.readFileSync(path.resolve(assets, '../java/com/otterview/agentsessionbridge/PhoneBridge.java'), 'utf8');
  assert.doesNotMatch(source, /--dangerously-skip-permissions/);
  assert.match(source, /&& \{ codex_bin=/);
  assert.match(source, /thread=.*shellQuote\(sessionId\).*message=.*shellQuote\(value\)/s);
  assert.match(source, /queue --thread/);
  assert.ok(source.includes('--message \\"$message\\"'));
  assert.match(source, /__ASB_CODEX_QUEUED__/);
  assert.equal((source.match(/\.put\("lastCheckedAt", now\(\)\)/g) || []).length, 3);
});
