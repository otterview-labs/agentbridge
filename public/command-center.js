const statuses = { queued: '待下发', dispatching: '下发中', running: '执行中', needs_attention: '需处理', review: '待验收', completed: '已完成', cancelled: '已结束跟踪' };
const names = { codex: 'Codex CLI', 'claude-code': 'Claude Code', gemini: 'Gemini CLI' };
const finished = (task) => ['completed', 'cancelled'].includes(task.status);
const needsAttention = (task) => !finished(task) && ['warn', 'danger'].includes(task.supervision?.tone);
const $ = (id) => document.getElementById(id);
function node(tag, className = '', text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function button(text, action, className = 'textBtn') {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}
function time(value) { return value ? new Date(value).toLocaleString() : '未记录'; }

export function createCommandCenter({ getState, apiGet, apiPost, selectSession, showView, refreshAll }) {
  let tasks = [];
  let error = '';
  let loaded = false;
  let syncedAt = null;
  let filter = 'all';
  let query = '';
  let selectedTaskId = null;
  let actionBusy = false;
  let generation = 0;
  let lastTownKey = '';

  // Keep tasks above infrastructure on the command center; the machine view remains separate.
  $('centerTaskSection').after($('centerMachines'));
  const overviewSupport = node('div', 'overviewSupport');
  $('centerMachines').before(overviewSupport);
  overviewSupport.append($('centerMachines'), $('centerAttention'));
  const iconPaths = {
    overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    machines: 'M4 3h16v7H4z M4 14h16v7H4z M7 6h.01 M7 17h.01 M11 6h6 M11 17h6',
    tasks: 'M9 5h11 M9 12h11 M9 19h11 M3 5l1 1 2-2 M3 12l1 1 2-2 M3 19l1 1 2-2',
    sessions: 'M4 4h16v16H4z M7 9l3 3-3 3 M13 15h4',
    conversation: 'M4 4h16v13H9l-5 4z M8 8h8 M8 12h5',
    services: 'M12 3v5 M12 16v5 M3 12h5 M16 12h5 M6 6l3 3 M15 15l3 3 M18 6l-3 3 M9 15l-3 3 M8 8h8v8H8z',
    approvals: 'M12 3l9 16H3z M12 9v4 M12 16h.01',
    workspace: 'M3 6h7l2 3h9v11H3z',
  };
  document.querySelectorAll('[data-view]').forEach((item) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', iconPaths[item.dataset.view] || iconPaths.tasks);
    svg.append(path);
    item.prepend(svg);
  });
  const titles = {
    overview: ['指挥中心', '管理每台机器上的 AI，让每项工作都有明确的下一步。'],
    machines: ['机器与 AI', '连接状态、工具安装与执行实例分别展示，不把“已安装”当成“正在工作”。'],
    tasks: ['任务管理', '任务是交付目标，会话是执行环境。先定义验收，再安排工作。'],
  };

  function reset() {
    generation += 1;
    tasks = []; loaded = false; error = ''; syncedAt = null;
    $('taskDetailDialog').close(); $('taskCreateDialog').close();
    render();
  }
  async function refresh() {
    const requestGeneration = generation;
    try {
      const payload = await apiGet('/tasks');
      if (requestGeneration !== generation) return;
      tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      loaded = true; error = ''; syncedAt = new Date();
    } catch (cause) {
      if (requestGeneration !== generation) return;
      error = `任务数据不可用：${cause.message}`;
    }
    render();
  }
  function invalidate(clear = false) {
    if (clear) reset();
    error = getState().workError || '连接中断，当前显示最近同步记录。';
    render();
  }
  function metric(label, value, detail, target) {
    const block = button('', () => showView(target), 'centerMetric');
    block.append(node('span', '', label), node('strong', '', value), node('small', '', detail));
    return block;
  }

  function rect(svg, x, y, width, height, fill) {
    const item = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    item.setAttribute('x', String(x));
    item.setAttribute('y', String(y));
    item.setAttribute('width', String(width));
    item.setAttribute('height', String(height));
    item.setAttribute('fill', fill);
    svg.append(item);
  }

  function employeeSprite(agentType, variant) {
    const palettes = {
      codex: { shirt: '#7488bc', trim: '#5a6c9b' },
      'claude-code': { shirt: '#cc8250', trim: '#a96940' },
      gemini: { shirt: '#8b7fc0', trim: '#6d64a1' },
    };
    const palette = palettes[agentType] || { shirt: '#6d7f94', trim: '#546374' };
    const skin = '#f6d1ae';
    const outline = '#2f2a41';
    const hair = '#3b3348';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 18 22');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('pixelAvatar');

    // Ears and hat keep repeated work readable without relying on color alone.
    if (variant === 0) {
      rect(svg, 4, 1, 1, 1, hair); rect(svg, 5, 0, 1, 2, hair); rect(svg, 6, 1, 1, 1, hair);
      rect(svg, 11, 1, 1, 1, hair); rect(svg, 12, 0, 1, 2, hair); rect(svg, 13, 1, 1, 1, hair);
    } else if (variant === 1) {
      rect(svg, 4, 0, 2, 4, hair); rect(svg, 12, 0, 2, 4, hair);
      rect(svg, 4, 0, 2, 1, '#f4a7b8'); rect(svg, 12, 0, 2, 1, '#f4a7b8');
    } else {
      rect(svg, 2, 1, 3, 3, hair); rect(svg, 13, 1, 3, 3, hair);
    }

    rect(svg, 3, 10, 12, 6, palette.shirt);
    rect(svg, 8, 10, 2, 1, '#fffaf0');
    rect(svg, 4, 3, 10, 7, skin);
    rect(svg, 4, 2, 10, 2, hair);
    rect(svg, 3, 3, 1, 3, hair); rect(svg, 14, 3, 1, 3, hair);
    rect(svg, 6, 6, 2, 2, outline); rect(svg, 10, 6, 2, 2, outline);
    rect(svg, 7, 8, 1, 1, '#c26060'); rect(svg, 10, 8, 1, 1, '#c26060');
    rect(svg, 8, 8, 2, 1, '#a95050');
    rect(svg, 5, 8, 1, 1, '#f5a8a8'); rect(svg, 12, 8, 1, 1, '#f5a8a8');
    rect(svg, 2, 11, 2, 4, palette.trim); rect(svg, 14, 11, 2, 4, palette.trim);
    rect(svg, 2, 15, 2, 1, skin); rect(svg, 14, 15, 2, 1, skin);
    rect(svg, 6, 16, 2, 4, '#39415d'); rect(svg, 10, 16, 2, 4, '#39415d');
    rect(svg, 5, 20, 3, 2, '#28304b'); rect(svg, 10, 20, 3, 2, '#28304b');
    return svg;
  }

  function employeeState(task) {
    if (task.status === 'review') return 'review';
    if (task.status === 'needs_attention' || needsAttention(task)) return 'attention';
    if (task.status === 'running') return 'running';
    if (task.status === 'queued') return 'queued';
    if (task.status === 'dispatching') return 'dispatching';
    return finished(task) ? 'finished' : 'idle';
  }

  function employeeCard(task) {
    const current = employeeState(task);
    const card = button('', () => detail(task.id), 'employee');
    card.dataset.state = current;
    card.dataset.agent = task.agentType;
    card.setAttribute('aria-label', `${task.title}，${statuses[task.status]}，${names[task.agentType] || task.agentType}`);
    const stage = node('span', 'employeeStage');
    stage.append(employeeSprite(task.agentType, Number(task.id) % 3));
    stage.append(node('span', 'employeeBubble', current === 'attention' ? '举手' : statuses[task.status]));
    const identity = node('span', 'employeeIdentity');
    identity.append(node('strong', 'employeeName', task.title));
    identity.append(node('span', 'employeeTag', `${names[task.agentType] || task.agentType} · T-${String(task.id).padStart(3, '0')}`));
    card.append(stage, identity);
    return card;
  }

  function renderTown() {
    const state = getState();
    const container = $('townRooms');
    const townKey = JSON.stringify({
      error,
      loaded,
      machineError: state.machinesError,
      machines: state.machines.map((machine) => [machine.id, machine.name, machine.host, machine.status, machine.lastSeenAt, machine.capabilities?.installedAgentTypes]),
      tasks: tasks.map((task) => [task.id, task.title, task.status, task.agentType, task.sessionName, task.machineId, task.supervision?.tone, task.supervision?.label]),
    });
    if (townKey === lastTownKey) return;
    lastTownKey = townKey;
    container.replaceChildren();

    if (!state.machines.length) {
      const room = node('article', 'officeRoom is-loading');
      room.append(node('h3', '', '正在寻找办公室'), node('p', 'officeNote', state.machinesError || '后端连接后，本机会作为第一间办公室出现在这里。'));
      container.append(room);
      return;
    }

    for (const machine of state.machines) {
      const isLocal = machine.name === 'local';
      const roomTasks = tasks.filter((task) => task.machineId === machine.id);
      const online = isLocal && machine.status === 'online';
      const room = node('article', `officeRoom${online ? ' is-online' : isLocal ? ' is-offline' : ' is-remote'}`);
      const sign = node('header', 'officeSign');
      const signCopy = node('div');
      signCopy.append(
        node('small', '', 'OFFICE'),
        node('h3', '', machine.name),
        node('p', 'officeNote', `${machine.host || '未记录主机'} · ${isLocal ? '本机执行端' : '远程登记'}`),
      );
      sign.append(signCopy, node('span', `officeState ${online ? 'ok' : 'warn'}`, online ? '在线' : isLocal ? '不可用' : '未接通'));
      room.append(sign);

      const floor = node('div', 'officeFloor');
      if (roomTasks.length) {
        for (const task of roomTasks) floor.append(employeeCard(task));
      } else {
        const empty = node('div', 'emptyDesk');
        empty.append(node('strong', '', '空工位'), node('span', '', isLocal ? '已连接实例，等待第一项任务' : '远程 Runner 尚未接入'));
        floor.append(empty);
      }
      room.append(floor);

      const installed = Array.isArray(machine.capabilities?.installedAgentTypes) ? machine.capabilities.installedAgentTypes : [];
      const footer = node('footer', 'officeFooter');
      footer.append(
        node('span', '', `${roomTasks.filter((task) => !finished(task)).length} 位在岗员工`),
        node('span', '', installed.length ? `已检测：${installed.map((type) => names[type] || type).join(' / ')}` : 'AI 安装状态未上报'),
      );
      room.append(footer);
      container.append(room);
    }
  }
  function render() {
    const state = getState();
    const title = titles[state.view];
    if (title) {
      $('centerTitle').textContent = title[0];
      $('centerSubtitle').textContent = title[1];
    }
    const machines = state.machines;
    const local = machines.find((m) => m.name === 'local');
    const canCreate = Boolean(local && local.status === 'online' && state.sessions.length && !error && !state.workError && !state.machinesError && loaded);
    $('createTaskButton').disabled = !canCreate;
    $('createTaskButton').title = canCreate ? '创建任务不会立即执行' : '需要连接后端并先创建一个本机会话';
    $('centerConnection').textContent = error || state.workError || (state.machinesError ? '机器数据刷新失败，以下为上次登记记录，不能确认当前可用性。' : '') || (loaded
      ? `最近同步 ${syncedAt.toLocaleTimeString()} · 本机会话可下发任务；远程 Runner 尚未接通。审批与部署不会自动执行。`
      : '正在读取管理中心数据…');
    $('centerConnection').classList.toggle('isStale', Boolean(error || state.workError || state.machinesError));
    const installed = machines.reduce((sum, m) => sum + (Array.isArray(m.capabilities?.installedAgentTypes) ? m.capabilities.installedAgentTypes.length : 0), 0);
    $('centerMetrics').replaceChildren(
      metric('在线执行端', state.machinesLoaded && !state.machinesError && !state.workError ? (local?.status === 'online' ? '1' : '0') : '—', `${machines.length} 台已登记 · 远程仅登记`, 'machines'),
      metric('已检测 AI 工具', state.machinesLoaded && !state.machinesError ? installed : '—', `${state.sessions.length} 个执行实例 · 登录未验证`, 'machines'),
      metric('执行中任务', loaded ? tasks.filter((t) => t.status === 'running' && t.supervision?.tone === 'ok').length : '—', '异常与待核实任务归入需要处理', 'tasks'),
      metric('需要你处理', loaded && state.approvalsLoaded && !state.approvalsError ? `${tasks.filter(needsAttention).length + state.pendingApprovals.length}${state.pendingApprovals.length >= 200 ? '+' : ''}` : '—', '异常、待验收与待审批操作', 'approvals'),
    );
    renderTown(); renderTasks(); renderMachines(); renderAttention();
  }
  function renderTasks() {
    const state = getState();
    document.querySelectorAll('[data-task-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.taskFilter === filter)));
    const rows = tasks.filter((task) => {
      const machine = state.machines.find((m) => m.id === task.machineId);
      const matches = filter === 'all' || (filter === 'active' && task.status === 'running' && task.supervision?.tone === 'ok') ||
        (filter === 'attention' && needsAttention(task)) || (filter === 'queued' && task.status === 'queued') || (filter === 'done' && finished(task));
      return matches && `${task.title} ${task.objective} ${task.sessionName} ${task.agentType} ${machine?.name || ''}`.toLowerCase().includes(query);
    }).sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.id - a.id);
    $('centerTaskRows').replaceChildren();
    for (const task of rows) {
      const tr = node('tr');
      const identity = node('td');
      identity.append(button(task.title, () => detail(task.id), 'taskName'), node('p', 'taskObjective', task.objective), node('small', 'taskId', `T-${String(task.id).padStart(3, '0')}`));
      const executor = node('td');
      const machine = state.machines.find((m) => m.id === task.machineId);
      executor.append(node('strong', 'executorName', machine ? `${machine.name}${machine.name === 'local' ? ' · 本机' : ''}` : '机器记录不可用'), node('p', 'taskSubline', `${names[task.agentType] || task.agentType} / ${task.sessionName}`));
      const status = node('td');
      status.append(node('span', `workStatus ${needsAttention(task) ? 'attention' : finished(task) ? 'stopped' : task.status === 'running' ? 'running' : 'idle'}`, needsAttention(task) && task.status === 'running' ? '需要核实' : statuses[task.status]), node('p', 'taskSubline', task.supervision?.label || '待检查'));
      const next = node('td');
      next.append(node('p', 'taskNext', task.supervision?.next || '等待检查'), node('small', 'taskId', `依据：${task.supervision?.source || '任务记录'}`));
      const action = node('td'); action.append(button('查看 →', () => detail(task.id)));
      [identity, executor, status, next, action].forEach((cell, index) => {
        cell.dataset.label = ['任务 / 要做什么', '机器 / AI 实例', '当前情况', '下一步 / 谁负责', '操作'][index];
      });
      tr.append(identity, executor, status, next, action); $('centerTaskRows').append(tr);
    }
    const empty = $('centerTaskEmpty'); empty.hidden = rows.length > 0; empty.replaceChildren();
    if (!rows.length) {
      empty.append(node('span', 'emptyGlyph', '✿'), node('h3', '', error ? '暂时无法读取任务' : tasks.length ? '没有匹配的任务' : '准备安排第一项工作'),
        node('p', '', error || (tasks.length ? '调整筛选条件或搜索关键词。' : '连接执行实例，写下目标，让 AI 开始工作。所有下发都由你确认。')));
      if (!tasks.length && !error) empty.append(button('创建执行实例 →', () => {
        showView('sessions'); $('newWorkButton').click();
      }));
    }
  }
  function renderMachines() {
    const state = getState();
    const container = $('centerMachines'); container.replaceChildren();
    const head = node('div', 'workListHeading');
    head.append(node('h2', '', '接入机器与 AI 工具'), button('查看全部实例 →', () => showView('sessions'))); container.append(head);
    if (!state.machines.length) {
      container.append(node('div', 'empty', state.workError ? '机器数据不可用，请检查后端连接。' : '暂无机器记录。启动后端后自动登记本机。')); return;
    }
    for (const machine of state.machines) {
      const isLocal = machine.name === 'local';
      const section = node('article', 'machineEntry');
      const heading = node('div', 'machineHeading');
      const name = node('div'); name.append(node('h3', '', `${machine.name}${isLocal ? ' · 本机执行端' : ' · 远程登记'}`), node('p', 'taskSubline', `${machine.host || '未记录主机'} · 最近登记/心跳 ${time(machine.lastSeenAt)}`));
      heading.append(name, node('span', `workStatus ${isLocal && machine.status === 'online' ? 'running' : 'attention'}`, isLocal ? (machine.status === 'online' ? '本机已登记' : '本机不可用') : '远程执行未接通'));
      section.append(heading);
      const toolList = node('div', 'machineTools');
      for (const [type, label] of Object.entries(names)) {
        const installed = Array.isArray(machine.capabilities?.installedAgentTypes) ? machine.capabilities.installedAgentTypes.includes(type) : null;
        const tool = node('div', 'machineTool');
        tool.append(node('strong', '', label), node('span', installed ? 'toolAvailable' : '', installed === null ? '安装状态未上报' : installed ? '已检测到 · 登录未验证' : '未检测到'));
        toolList.append(tool);
      }
      section.append(toolList);
      const instances = isLocal ? state.sessions : [];
      const footer = node('div', 'machineInstances');
      footer.append(node('span', 'taskSubline', isLocal ? `${instances.length} 个执行实例 · ${tasks.filter((t) => t.machineId === machine.id && !finished(t)).length} 项未结束任务` : '尚不能创建、接管或监督这台机器上的 CLI。'));
      for (const session of instances) footer.append(button(`${session.name} / ${session.agentType}`, () => selectSession(session.name), 'instanceChip'));
      section.append(footer); container.append(section);
    }
  }
  function renderAttention() {
    const state = getState();
    const container = $('centerAttention'); container.replaceChildren();
    const items = tasks.filter(needsAttention);
    const heading = node('div', 'workListHeading');
    heading.append(node('h2', '', '待处理与监督提醒'), button('处理审批 →', () => showView('approvals'))); container.append(heading);
    for (const task of items) {
      const row = node('div', 'attentionRow'); const copy = node('div');
      copy.append(node('strong', '', task.title), node('p', 'taskSubline', `${task.supervision.label} · ${task.supervision.next}`));
      row.append(copy, button('核实任务 →', () => detail(task.id))); container.append(row);
    }
    const summary = node('p', 'connectionNote', state.approvalsError || !state.approvalsLoaded
      ? '审批数据尚未确认，不能判断是否有待处理请求。'
      : `${state.pendingApprovals.length}${state.pendingApprovals.length >= 200 ? '+' : ''} 项待审批操作；${items.length} 项任务需要核实。`);
    container.append(summary);
    // The dedicated approval page keeps actionable task alerts next to permission requests.
    let alerts = $('taskAttentionQueue');
    if (!alerts) { alerts = node('section', 'taskAttentionQueue'); alerts.id = 'taskAttentionQueue'; document.querySelector('.railCard--queue').prepend(alerts); }
    alerts.replaceChildren(node('h2', '', '任务需要你处理'));
    if (error) alerts.append(node('p', 'errorText', '任务提醒同步失败，以下可能是旧数据。'));
    for (const task of items) alerts.append(button(`${task.title} · ${task.supervision.label} →`, () => detail(task.id), 'attentionTaskButton'));
    if (!items.length) alerts.append(node('p', 'taskSubline', loaded ? '当前没有任务监督提醒。审批请求见下方。' : '尚未读取任务提醒。'));
  }
  function detail(id) {
    selectedTaskId = id;
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    const body = $('taskDetailBody'); body.replaceChildren(); $('taskDetailError').textContent = '';
    body.append(node('p', 'eyebrow', `TASK ${task.id} / ${statuses[task.status]}`), node('h2', 'taskDetailTitle', task.title));
    const fields = [ ['工作目标', task.objective], ['验收条件', task.acceptance], ['执行位置', `${task.sessionName} · ${task.agentType}\n${task.workspacePath}`], ['监督边界', `${task.quietMinutes} 分钟无活动记录后提示核实；不自动重试、不自动批准、不自动部署。`], ['当前判断', `${task.supervision?.label || '待检查'}：${task.supervision?.next || ''}`] ];
    for (const [label, value] of fields) { const section = node('section', 'taskDetailSection'); section.append(node('h3', '', label), node('p', '', value)); body.append(section); }
    const session = getState().sessions.find((s) => s.id === task.sessionId);
    const output = node('section', 'taskDetailSection'); output.append(node('h3', '', '最近输出 · 会话记录'), node('pre', 'filePreview', session?.lastOutputDigest || '暂无会话输出。'));
    if (session) output.append(button('打开会话 / 查看完整输出与 Diff →', () => { $('taskDetailDialog').close(); selectSession(session.name); }));
    body.append(output);
    if (task.evidence) { const evidence = node('section', 'taskDetailSection'); evidence.append(node('h3', '', '已提交证据 · 人工记录，平台未自动验证'), node('p', '', task.evidence)); body.append(evidence); }
    const timeline = node('ol', 'taskTimeline');
    for (const event of task.timeline) { const item = node('li'); item.append(node('small', '', `${time(event.at)} · ${event.actor}`), node('p', '', event.message)); timeline.append(item); }
    body.append(node('h3', '', '执行时间线'), timeline);
    if (!finished(task)) {
      const label = node('label', 'field', '处理原因 / 验收证据（测试结果、检查结论等）');
      const input = node('textarea'); input.id = 'taskEvidenceInput'; input.rows = 3; input.maxLength = 8000; input.placeholder = '提交验收或结束跟踪前必须填写；不会自动运行这里的文本。'; label.append(input); body.append(label);
      const actions = node('div', 'taskDetailActions');
      if (task.status === 'queued') actions.append(button('确认下发给 AI', () => act('dispatch'), 'primaryBtn'));
      if (['running', 'needs_attention'].includes(task.status)) actions.append(button('提交证据，申请验收', () => act('review'), 'primaryBtn'));
      if (task.status === 'review') actions.append(button('确认验收通过', () => act('complete'), 'primaryBtn'));
      if (task.status !== 'dispatching') actions.append(button('结束跟踪（不停止 AI）', () => act('cancel'), 'ghostBtn'));
      body.append(actions);
      if (error) actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    }
    if (!$('taskDetailDialog').open) $('taskDetailDialog').showModal();
  }
  async function act(action) {
    if (actionBusy) return;
    const evidence = $('taskEvidenceInput')?.value || '';
    if (action !== 'dispatch' && !evidence.trim()) { $('taskDetailError').textContent = '请先填写处理原因或验收证据。'; return; }
    actionBusy = true;
    $('taskDetailBody').querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await apiPost(`/tasks/${selectedTaskId}/${action}`, { actorId: getState().actorId, evidence });
      await refreshAll(); detail(selectedTaskId);
    } catch (cause) { $('taskDetailError').textContent = cause.message; }
    finally { actionBusy = false; $('taskDetailBody').querySelectorAll('button').forEach((b) => { b.disabled = Boolean(error); }); }
  }
  $('createTaskButton').addEventListener('click', () => {
    const select = $('taskSessionSelect'); select.replaceChildren();
    for (const session of getState().sessions) { const option = node('option', '', `${session.name} · ${names[session.agentType] || session.agentType} · ${session.workspacePath}`); option.value = session.id; select.append(option); }
    $('taskCreateError').textContent = ''; $('taskCreateDialog').showModal();
  });
  $('taskCreateForm').addEventListener('submit', async (event) => {
    event.preventDefault(); $('taskCreateSubmit').disabled = true;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await apiPost('/tasks', { ...fields, sessionId: Number(fields.sessionId), quietMinutes: Number(fields.quietMinutes), actorId: getState().actorId });
      $('taskCreateDialog').close(); $('taskCreateForm').reset(); showView('tasks'); await refresh();
    } catch (cause) { $('taskCreateError').textContent = cause.message; }
    finally { $('taskCreateSubmit').disabled = false; }
  });
  document.querySelectorAll('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => $(b.dataset.closeDialog).close()));
  document.querySelectorAll('[data-task-filter]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.taskFilter; renderTasks(); }));
  $('taskSearch').addEventListener('input', (event) => { query = event.target.value.trim().toLowerCase(); renderTasks(); });
  // Task mutations are not SSE events yet; refresh read-only task observations while visible.
  let polling = false;
  setInterval(async () => {
    if (document.hidden || polling) return;
    polling = true;
    try { await refreshAll(); } finally { polling = false; }
  }, 15000);
  return { refresh, render, reset, invalidate };
}
