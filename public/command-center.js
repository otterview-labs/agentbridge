const statuses = { queued: '待下发', dispatching: '下发中', running: '执行中', needs_attention: '需处理', review: '待验收', completed: '已完成', cancelled: '已结束跟踪', idle: '空闲', stopped: '已停止', missing: '面板丢失' };
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
function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

export function createCommandCenter({ getState, apiGet, apiPost, selectSession, showView, refreshAll, getApiToken }) {
  let tasks = [];
  let sshTasks = [];
  let sshError = '';
  let frpServers = [];
  let frpRelays = [];
  let frpError = '';
  let error = '';
  let loaded = false;
  let syncedAt = null;
  let filter = 'all';
  let query = '';
  let selectedTaskId = null;
  let actionBusy = false;
  let generation = 0;
  let lastTownKey = '';
  let localDiscoveryStarted = false;

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
    overview: ['工作台', '查看机器、任务和待处理事项。'],
    machines: ['机器', '管理连接方式和已安装的编码工具。'],
    tasks: ['任务', '查看执行状态、输出和验收结果。'],
  };

  function reset() {
    generation += 1;
    tasks = []; sshTasks = []; sshError = ''; frpServers = []; frpRelays = []; frpError = ''; loaded = false; error = ''; syncedAt = null;
    localDiscoveryStarted = false;
    $('taskDetailDialog').close(); $('taskCreateDialog').close(); $('sshMachineDialog').close();
    $('frpServerDialog').close(); $('frpRelayDialog').close(); $('frpCommandDialog').close();
    render();
  }
  async function refresh() {
    const requestGeneration = generation;
    sshError = ''; frpError = '';
    try {
      const [payload, sshPayload, frpPayload] = await Promise.all([
        apiGet('/tasks'),
        apiGet('/ssh/tasks').catch((cause) => {
          sshError = `SSH 任务发现不可用：${cause.message}`;
          return { tasks: [] };
        }),
        apiGet('/frp/overview').catch((cause) => {
          frpError = `FRP 配置不可用：${cause.message}`;
          return { servers: [], relays: [] };
        }),
      ]);
      if (requestGeneration !== generation) return;
      tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      sshTasks = Array.isArray(sshPayload.tasks) ? sshPayload.tasks : [];
      frpServers = Array.isArray(frpPayload.servers) ? frpPayload.servers : [];
      frpRelays = Array.isArray(frpPayload.relays) ? frpPayload.relays : [];
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

  function normalizedSshTask(record) {
    const missing = record.status === 'missing' || record.status === 'stopped';
    const processTask = record.controlMode === 'process';
    const requiredInput = record.requiredInput || '';
    const needsInput = Boolean(requiredInput) && !missing;
    return {
      ...record,
      id: `ssh-${record.id}`,
      remoteTaskId: record.id,
      remote: true,
      customTitle: record.customTitle,
      needsInput,
      requiredInput,
      suggestedReply: record.suggestedReply || '',
      objective: processTask
        ? record.workSummary || `自动发现的本机进程：${record.processCommand || record.paneId}`
        : `自动发现的 tmux 面板：${record.sessionName}:${record.windowIndex}`,
      acceptance: processTask
        ? '进程任务仅自动观察；要发送输入，需要使用 tmux 执行实例。'
        : 'tmux 任务可通过面板输入；发送前请确认目标会话。',
      status: record.status,
      supervision: {
        tone: missing || needsInput ? 'warn' : 'ok',
        label: missing ? '任务不存在' : needsInput ? '待输入' : processTask ? (record.status === 'idle' ? '已完成' : '执行中') : 'tmux 会话在线',
        next: missing
          ? '重新自动探查，或检查对应进程/面板。'
            : needsInput
              ? 'Claude 已空闲，可能等待你补充信息或确认结果。'
              : processTask
                ? '该进程不在 tmux 中；当前仅自动观察。'
            : '可刷新输出；发送输入会直接写入 tmux。',
        source: processTask ? '本机进程探查' : 'tmux 探查',
      },
    };
  }

  function allTasks() {
    return [...tasks, ...sshTasks.map(normalizedSshTask)];
  }

  function canCreate() {
    const state = getState();
    const local = state.machines.find((machine) => machine.name === 'local');
    return Boolean(local?.status === 'online' && state.sessions.length && !error && !state.workError && !state.machinesError && loaded);
  }

function taskSortKey(task) {
  return task.remote ? 1_000_000_000 + Number(task.remoteTaskId || 0) : Number(task.id || 0);
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
    if (task.needsInput) return 'attention';
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
    stage.append(employeeSprite(task.agentType, Number(String(task.id).replace(/\D/g, '')) % 3));
    stage.append(node('span', 'employeeBubble', task.needsInput ? '待输入' : current === 'attention' ? '举手' : statuses[task.status]));
    const identity = node('span', 'employeeIdentity');
    identity.append(node('strong', 'employeeName', task.title));
    identity.append(node('span', 'employeeTag', task.remote
      ? `${names[task.agentType] || task.agentType} · ${task.controlMode === 'process' ? '进程' : 'tmux'} · S-${String(task.remoteTaskId).padStart(3, '0')}`
      : `${names[task.agentType] || task.agentType} · T-${String(task.id).padStart(3, '0')}`));
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
      tasks: allTasks().map((task) => [task.id, task.title, task.status, task.agentType, task.sessionName, task.machineId, task.supervision?.tone, task.supervision?.label]),
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
      const roomTasks = allTasks().filter((task) => task.machineId === machine.id);
      const online = machine.status === 'online';
      const room = node('article', `officeRoom${online ? ' is-online' : isLocal ? ' is-offline' : ' is-remote'}`);
      const sign = node('header', 'officeSign');
      const signCopy = node('div');
      signCopy.append(
        node('h3', '', isLocal ? '这台 Mac' : machine.name),
        node('p', 'officeNote', isLocal ? '本机执行端' : `${machine.host || '未记录主机'} · ${machine.capabilities?.connection === 'ssh' ? 'SSH' : '远程'}`),
      );
      sign.append(signCopy, node('span', `officeState ${online ? 'ok' : 'warn'}`, online ? '在线' : isLocal ? '不可用' : '未接通'));
      room.append(sign);

      const floor = node('div', 'officeFloor');
      if (roomTasks.length) {
        for (const task of roomTasks) floor.append(employeeCard(task));
      } else {
        const empty = node('div', 'emptyDesk');
        empty.append(node('strong', '', isLocal ? '等待任务' : '未发现任务'));
        floor.append(empty);
      }
      room.append(floor);

      const installed = Array.isArray(machine.capabilities?.installedAgentTypes) ? machine.capabilities.installedAgentTypes : [];
      const footer = node('footer', 'officeFooter');
      if (roomTasks.length) footer.append(node('span', '', `${roomTasks.filter((task) => !finished(task)).length} 个任务`));
      footer.append(node('span', '', installed.length ? `工具：${installed.map((type) => names[type] || type).join(' / ')}` : '工具状态未上报'));
      room.append(footer);
      container.append(room);
    }
  }
  function render() {
    const state = getState();
    document.body.classList.toggle('has-tasks', allTasks().length > 0);
    const localMachine = state.machines.find((machine) => machine.name === 'local');
    if (localMachine && !localDiscoveryStarted && !state.workError) {
      localDiscoveryStarted = true;
      void apiPost(`/machines/${localMachine.id}/ssh/discover`, { actorId: state.actorId })
        .then(() => refreshAll())
        .catch(() => {
          localDiscoveryStarted = false;
        });
    }
    const title = titles[state.view];
    if (title) {
      $('centerTitle').textContent = title[0];
      $('centerSubtitle').textContent = title[1];
    }
    const machines = state.machines;
    const visibleTasks = allTasks();
    $('createTaskButton').title = canCreate()
      ? '创建任务不会立即执行'
      : '还没有可执行实例；点击先添加 SSH 机器';
    $('centerConnection').textContent = error || state.workError || (state.machinesError ? '机器数据刷新失败，以下为上次登记记录。' : '') || (loaded
      ? `已同步 ${syncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${sshError ? ` · ${sshError}` : ''}${frpError ? ` · ${frpError}` : ''}`
      : '正在读取管理中心数据…');
    $('centerConnection').classList.toggle('isStale', Boolean(error || state.workError || state.machinesError));
    const installed = machines.reduce((sum, m) => sum + (Array.isArray(m.capabilities?.installedAgentTypes) ? m.capabilities.installedAgentTypes.length : 0), 0);
    $('centerMetrics').replaceChildren(
      metric('在线执行端', state.machinesLoaded && !state.machinesError && !state.workError ? machines.filter((m) => m.status === 'online').length : '—', `${machines.length} 台已登记 · 本机 + SSH`, 'machines'),
      metric('编码工具', state.machinesLoaded && !state.machinesError ? installed : '—', `${state.sessions.length + sshTasks.length} 个执行实例`, 'machines'),
      metric('执行中任务', loaded ? visibleTasks.filter((t) => t.status === 'running' && t.supervision?.tone === 'ok').length : '—', '异常与待核实任务归入需要处理', 'tasks'),
      metric('需要你处理', loaded && state.approvalsLoaded && !state.approvalsError ? `${visibleTasks.filter(needsAttention).length + state.pendingApprovals.length}${state.pendingApprovals.length >= 200 ? '+' : ''}` : '—', '异常、待验收与待审批操作', 'approvals'),
    );
    renderTown(); renderTasks(); renderMachines(); renderAttention();
    renderTodo();
  }
  function renderTasks() {
    const state = getState();
    document.querySelectorAll('[data-task-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.taskFilter === filter)));
    const rows = allTasks().filter((task) => {
      const machine = state.machines.find((m) => m.id === task.machineId);
      const matches = filter === 'all' || (filter === 'active' && task.status === 'running' && task.supervision?.tone === 'ok') ||
        (filter === 'attention' && needsAttention(task)) || (filter === 'queued' && task.status === 'queued') || (filter === 'done' && finished(task));
      return matches && `${task.title} ${task.objective} ${task.sessionName} ${task.agentType} ${machine?.name || ''}`.toLowerCase().includes(query);
    }).sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || taskSortKey(b) - taskSortKey(a));
    $('centerTaskRows').replaceChildren();
    for (const task of rows) {
      const tr = node('tr');
      const identity = node('td');
      identity.append(button(task.title, () => detail(task.id), 'taskName'), node('p', 'taskObjective', task.objective), node('small', 'taskId', task.remote ? `S-${String(task.remoteTaskId).padStart(3, '0')} · SSH 发现` : `T-${String(task.id).padStart(3, '0')}`));
      const executor = node('td');
      const machine = state.machines.find((m) => m.id === task.machineId);
      executor.append(node('strong', 'executorName', machine ? `${machine.name}${machine.name === 'local' ? ' · 本机' : ''}` : '机器记录不可用'), node('p', 'taskSubline', `${names[task.agentType] || task.agentType} / ${task.sessionName}`));
      const status = node('td');
      status.append(node('span', `workStatus ${needsAttention(task) ? 'attention' : finished(task) ? 'stopped' : task.status === 'running' ? 'running' : 'idle'}`, task.needsInput ? '待输入' : needsAttention(task) && task.status === 'running' ? '需要核实' : task.remote && task.controlMode === 'process' && task.status === 'idle' ? '已完成' : statuses[task.status]), node('p', 'taskSubline', task.supervision?.label || '待检查'));
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
      empty.append(node('span', 'emptyGlyph', '✿'), node('h3', '', error ? '暂时无法读取任务' : allTasks().length ? '没有匹配的任务' : '准备安排第一项工作'),
        node('p', '', error || (allTasks().length ? '调整筛选条件或搜索关键词。' : '添加 SSH 机器并发现任务，或在本地创建执行实例。')));
      if (!allTasks().length && !error) empty.append(button('添加 SSH 机器 →', () => {
        showView('machines'); $('addSshMachineButton').click();
      }));
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
    const frpSummary = node('div', 'frpSummary');
    frpSummary.append(node('strong', '', `FRP 公网入口：${frpServers.length}`));
    if (frpError) frpSummary.append(node('span', 'errorText', frpError));
    for (const server of frpServers) {
      const serverMachine = state.machines.find((machine) => machine.id === server.machineId);
      frpSummary.append(node('span', '', `${serverMachine?.name || `M-${server.machineId}`} · ${server.publicAddress}:${server.bindPort} · ${server.status}`));
    }
    if (!frpServers.length && !frpError) frpSummary.append(node('span', '', '未部署。可先添加公网 SSH 机器，再自动部署 frps。'));
    container.append(frpSummary);
    if (!state.machines.length) {
      container.append(node('div', 'empty', state.workError ? '机器数据不可用，请检查后端连接。' : '暂无机器记录。启动后端后自动登记本机。')); return;
    }
    for (const machine of state.machines) {
      const isLocal = machine.name === 'local';
      const isSsh = machine.capabilities?.connection === 'ssh';
      const frpServer = frpServers.find((item) => item.machineId === machine.id);
      const frpRelay = frpRelays.find((item) => item.machineId === machine.id);
      const section = node('article', 'machineEntry');
      const heading = node('div', 'machineHeading');
      const name = node('div'); name.append(node('h3', '', isLocal ? '这台 Mac' : `${machine.name}${isSsh ? frpRelay?.enabled ? ' · FRP 中转' : ' · SSH' : ' · 远程'}`), node('p', 'taskSubline', isLocal ? '本机执行端' : `${machine.host || '未记录主机'} · ${machine.capabilities?.os || 'OS 未记录'}`));
      heading.append(name, node('span', `workStatus ${machine.status === 'online' ? 'running' : 'attention'}`, machine.status === 'online' ? '在线' : '离线'));
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
      footer.append(node('span', 'taskSubline', isLocal ? `${instances.length} 个执行实例 · ${tasks.filter((t) => t.machineId === machine.id && !finished(t)).length} 项未结束任务` : isSsh ? `${sshTasks.filter((t) => t.machineId === machine.id).length} 个已发现远程任务 · tmux ${machine.capabilities?.tmuxVersion || '未检测'}` : '尚不能创建、接管或监督这台机器上的 CLI。'));
      if (frpServer) footer.append(node('span', 'frpChip', `frps ${frpServer.status} · :${frpServer.bindPort}`));
      if (frpRelay) footer.append(node('span', `frpChip ${frpRelay.status === 'online' ? 'ok' : frpRelay.status === 'error' ? 'bad' : ''}`, `frpc ${frpRelay.status} · visitor 127.0.0.1:${frpRelay.visitorPort}`));
      for (const session of instances) footer.append(button(`${session.name} / ${session.agentType}`, () => selectSession(session.name), 'instanceChip'));
      if (isSsh) footer.append(button('发现远程任务 →', () => discoverSshMachine(machine.id), 'instanceChip'));
      if (frpServer) footer.append(button('重新部署 frps →', () => deployFrpServer(frpServer.id), 'instanceChip'));
      if (frpRelay?.enabled) {
        footer.append(button('一键接入命令 →', () => showFrpCommand(frpRelay), 'instanceChip'));
        footer.append(button('重新部署 frpc →', () => deployFrpRelay(frpRelay.id), 'instanceChip'));
        footer.append(button('停用公网中转 →', () => disableFrpRelay(frpRelay.id), 'instanceChip'));
      }
      section.append(footer); container.append(section);
    }
  }

  function renderTodo() {
    const section = $('todoSection');
    const container = $('todoList');
    const items = allTasks().filter((task) => task.needsInput || needsAttention(task));
    section.hidden = items.length === 0;
    $('todoCount').textContent = String(items.length);
    container.replaceChildren();
    for (const task of items) {
      const row = node('div', `todoRow${task.needsInput ? ' needsInput' : ''}`);
      const copy = node('div');
      copy.append(
        node('strong', '', task.title),
        node('span', '', task.needsInput
          ? task.requiredInput || '等待输入或确认'
          : task.supervision?.label || '需要处理'),
      );
      row.append(copy, button(task.needsInput ? '处理 →' : '查看 →', () => detail(task.id), 'ghostBtn compactBtn'));
      container.append(row);
    }
  }

  function sshMachines() {
    return getState().machines.filter((machine) => machine.capabilities?.connection === 'ssh');
  }

  function fillFrpServerSelect() {
    const select = $('frpServerMachineSelect'); select.replaceChildren();
    for (const machine of sshMachines()) {
      const option = node('option', '', `${machine.name} · ${machine.host || '未记录主机'}`);
      option.value = machine.id; select.append(option);
    }
    return Boolean(select.options.length);
  }

  function fillFrpRelaySelects() {
    const serverIds = new Set(frpServers.map((server) => server.machineId));
    const machines = sshMachines().filter((machine) => !serverIds.has(machine.id));
    const machineSelect = $('frpRelayMachineSelect'); machineSelect.replaceChildren();
    for (const machine of machines) {
      const option = node('option', '', `${machine.name} · ${machine.host || '未记录主机'}`);
      option.value = machine.id; machineSelect.append(option);
    }
    const serverSelect = $('frpRelayServerSelect'); serverSelect.replaceChildren();
    for (const server of frpServers.filter((server) => server.status === 'online')) {
      const machine = getState().machines.find((item) => item.id === server.machineId);
      const option = node('option', '', `${machine?.name || `M-${server.machineId}`} · ${server.publicAddress}:${server.bindPort}`);
      option.value = server.id; serverSelect.append(option);
    }
    return Boolean(machineSelect.options.length && serverSelect.options.length);
  }

  async function deployFrpServer(id) {
    if (actionBusy) return;
    actionBusy = true; $('centerConnection').textContent = '正在自动部署云端 frps…';
    try {
      await apiPost(`/frp/servers/${id}/deploy`, { actorId: getState().actorId });
      await refreshAll();
    } catch (cause) { $('centerConnection').textContent = `frps 部署失败：${cause.message}`; }
    finally { actionBusy = false; }
  }

  async function deployFrpRelay(id) {
    if (actionBusy) return;
    actionBusy = true; $('centerConnection').textContent = '正在部署远端 frpc 和本地 FRP visitor…';
    try {
      await apiPost(`/frp/relays/${id}/deploy`, { actorId: getState().actorId });
      await refreshAll();
    } catch (cause) { $('centerConnection').textContent = `frpc 部署失败：${cause.message}`; }
    finally { actionBusy = false; }
  }

  async function disableFrpRelay(id) {
    if (actionBusy) return;
    actionBusy = true;
    try { await apiPost(`/frp/relays/${id}/disable`, { actorId: getState().actorId }); await refreshAll(); }
    catch (cause) { $('centerConnection').textContent = `停用中转失败：${cause.message}`; }
    finally { actionBusy = false; }
  }

  function showFrpCommand(relay) {
    const token = getApiToken?.() || '';
    const loopback = window.location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    const base = loopback ? 'http://<HUB_ADDRESS>' : window.location.origin.replace(/\/$/u, '');
    const url = `${base}${relay.installPath}`;
    const auth = token ? ` -H ${shellQuote(`Authorization: Bearer ${token}`)}` : '';
    const command = `curl -fsSL${auth} ${shellQuote(url)} | bash`;
    $('frpCommandText').textContent = loopback ? `# 先把 <HUB_ADDRESS> 替换成目标机器可访问的 Hub 局域网/公网地址\n${command}` : command;
    $('frpCommandDialog').showModal();
  }
  function renderAttention() {
    const state = getState();
    const container = $('centerAttention'); container.replaceChildren();
    const items = allTasks().filter(needsAttention);
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
    const visibleTask = allTasks().find((item) => item.id === id);
    if (visibleTask?.remote) {
      remoteDetail(visibleTask);
      return;
    }
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

  function remoteDetail(task) {
    selectedTaskId = task.id;
    const body = $('taskDetailBody'); body.replaceChildren(); $('taskDetailError').textContent = '';
    body.append(node('p', 'eyebrow', `${task.controlMode === 'process' ? 'PROCESS' : 'TMUX'} TASK ${task.remoteTaskId} / ${statuses[task.status]}`), node('h2', 'taskDetailTitle', task.title));
    const renameForm = node('form', 'taskRenameForm');
    const renameInput = node('input');
    renameInput.id = 'sshTitleInput';
    renameInput.value = task.title;
    renameInput.maxLength = 160;
    renameInput.required = true;
    renameInput.setAttribute('aria-label', '任务名称');
    const renameButton = node('button', 'ghostBtn compactBtn', '保存名称');
    renameButton.type = 'submit';
    renameForm.append(renameInput, renameButton);
    renameForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void remoteTaskAction(task.remoteTaskId, 'rename');
    });
    body.append(renameForm);
    if (task.requiredInput) {
      const required = node('section', 'taskDetailSection requiredInputSection');
      required.append(node('h3', '', '需要你输入'));
      required.append(node('p', '', task.requiredInput));
      if (task.suggestedReply) {
        const reply = node('div', 'suggestedReply');
        reply.append(node('span', '', task.suggestedReply));
        reply.append(button('复制回复', async () => {
          try {
            await navigator.clipboard.writeText(task.suggestedReply);
            const element = reply.querySelector('button');
            if (element) {
              element.textContent = '已复制';
              setTimeout(() => { element.textContent = '复制回复'; }, 1500);
            }
          } catch {
            $('taskDetailError').textContent = '复制失败，请手动选择文本。';
          }
        }, 'ghostBtn compactBtn'));
        required.append(reply);
      }
      body.append(required);
    }
    const fields = [
      ['任务来源', task.controlMode === 'process' ? '由本机进程自动探查发现；平台没有创建该进程。' : '由 tmux 面板自动探查发现；平台没有创建该进程。'],
      ['执行位置', task.controlMode === 'process'
        ? `${task.paneId}\n${task.workspacePath}`
        : `${task.sessionName}:${task.windowIndex} · ${task.windowName}\n${task.workspacePath}`],
      ...(task.controlMode === 'process' ? [['进程命令', task.processCommand || '未记录']] : []),
      ...(task.controlMode === 'process' && task.workSummary ? [['具体工作', task.workSummary]] : []),
      ['当前判断', `${task.supervision.label}：${task.supervision.next}`],
      ['最近活跃', time(task.lastActiveAt)],
    ];
    for (const [label, value] of fields) {
      const section = node('section', 'taskDetailSection');
      section.append(node('h3', '', label), node('p', '', value));
      body.append(section);
    }
    const output = node('section', 'taskDetailSection');
    output.append(node('h3', '', task.controlMode === 'process' ? '进程信息' : 'tmux 输出'), node('pre', 'filePreview', task.lastOutput || '暂无输出。'));
    body.append(output);
    const canSendReply = task.status !== 'missing'
      && task.status !== 'stopped'
      && (task.controlMode !== 'process' || Boolean(task.externalSessionId));
    if (canSendReply) {
      const label = node('label', 'field', task.controlMode === 'process' ? '发送回原会话的回复' : '发送给远端 CLI 的输入');
      const input = node('textarea');
      input.id = 'sshPromptInput';
      input.rows = 4;
      input.maxLength = 12000;
      input.value = task.suggestedReply || '';
      input.placeholder = task.controlMode === 'process'
        ? task.requiredInput
          ? '可修改建议回复后发送。'
          : '输入追加指令后发送；空回复不会被发送。'
        : '这段文本会通过 tmux send-keys 写入远端 CLI，按回车执行。';
      label.append(input);
      body.append(label);
    }
    const actions = node('div', 'taskDetailActions');
    actions.append(button(task.controlMode === 'process' ? '重新自动探查 →' : '刷新输出 →', () => remoteTaskAction(task.remoteTaskId, 'tail'), 'ghostBtn'));
    if (canSendReply) {
      const sendButton = button(task.controlMode === 'process' ? '发送回原会话 →' : '发送到远端任务 →', () => remoteTaskAction(task.remoteTaskId, 'send'), 'primaryBtn');
      sendButton.classList.add('remoteSendButton');
      sendButton.disabled = !task.suggestedReply;
      const input = $('sshPromptInput');
      if (input) {
        input.addEventListener('input', () => {
          sendButton.disabled = !input.value.trim();
          $('taskDetailError').textContent = input.value.trim() ? '' : '请输入回复内容。';
        });
      }
      actions.append(sendButton);
    } else if (task.controlMode === 'process' && task.status !== 'missing' && task.status !== 'stopped') {
      const missingSession = node('section', 'taskDetailSection');
      missingSession.append(
        node('h3', '', '暂时不能直接回复'),
        node('p', '', '这个进程没有找到可恢复的 CLI 会话 ID。可以查看输出，或在原终端中继续对话。'),
      );
      body.append(missingSession);
    }
    body.append(actions);
    if (!$('taskDetailDialog').open) $('taskDetailDialog').showModal();
  }

  async function remoteTaskAction(id, action) {
    if (actionBusy) return;
    if (action === 'send' && !($('sshPromptInput')?.value || '').trim()) {
      $('taskDetailError').textContent = '请输入回复内容。';
      return;
    }
    actionBusy = true;
    if (action === 'send') $('taskDetailError').textContent = '正在发送回复，等待 CLI 完成这一轮…';
    $('taskDetailBody').querySelectorAll('button').forEach((item) => { item.disabled = true; });
    try {
      const payload = await apiPost(`/ssh/tasks/${id}/${action}`, action === 'send'
        ? { actorId: getState().actorId, prompt: $('sshPromptInput')?.value || '' }
        : action === 'rename'
          ? { actorId: getState().actorId, title: $('sshTitleInput')?.value || '' }
          : { actorId: getState().actorId });
      const record = payload.task;
      if (record) {
        sshTasks = sshTasks.map((item) => item.id === record.id ? record : item);
        remoteDetail(normalizedSshTask(record));
      }
    } catch (cause) {
      $('taskDetailError').textContent = cause.message;
      $('taskDetailBody').querySelectorAll('button').forEach((item) => { item.disabled = false; });
    } finally {
      actionBusy = false;
    }
  }

  async function discoverSshMachine(id) {
    if (actionBusy) return;
    actionBusy = true;
    $('centerConnection').textContent = '正在通过 SSH 扫描远端 tmux 面板…';
    try {
      await apiPost(`/machines/${id}/ssh/discover`, { actorId: getState().actorId });
      await refreshAll();
    } catch (cause) {
      $('centerConnection').textContent = `SSH 任务发现失败：${cause.message}`;
    } finally {
      actionBusy = false;
    }
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
    if (!canCreate()) {
      showView('machines');
      $('addSshMachineButton').click();
      return;
    }
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
  $('addSshMachineButton').addEventListener('click', () => {
    $('sshMachineError').textContent = '';
    $('sshMachineDialog').showModal();
  });
  $('sshMachineForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('sshMachineSubmit').disabled = true;
    $('sshMachineError').textContent = '';
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const payload = await apiPost('/machines/ssh', {
        ...fields,
        port: Number(fields.port || 22),
        actorId: getState().actorId,
      });
      if (payload.machine?.id) {
        await apiPost(`/machines/${payload.machine.id}/ssh/discover`, {
          actorId: getState().actorId,
        });
      }
      $('sshMachineDialog').close();
      $('sshMachineForm').reset();
      showView('machines');
      await refreshAll();
    } catch (cause) {
      $('sshMachineError').textContent = cause.message;
    } finally {
      $('sshMachineSubmit').disabled = false;
    }
  });
  $('configureFrpServerButton').addEventListener('click', () => {
    $('frpServerError').textContent = '';
    if (!fillFrpServerSelect()) {
      $('frpServerError').textContent = '请先添加一台可通过 SSH 访问的公网 Linux 机器。';
    }
    $('frpServerDialog').showModal();
  });
  $('frpServerForm').addEventListener('submit', async (event) => {
    event.preventDefault(); $('frpServerSubmit').disabled = true; $('frpServerError').textContent = '';
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const payload = await apiPost('/frp/servers', {
        ...fields,
        bindPort: Number(fields.bindPort),
        machineId: Number(fields.machineId),
        actorId: getState().actorId,
      });
      $('frpServerDialog').close();
      await deployFrpServer(payload.server.id);
    } catch (cause) { $('frpServerError').textContent = cause.message; }
    finally { $('frpServerSubmit').disabled = false; }
  });
  $('configureFrpRelayButton').addEventListener('click', () => {
    $('frpRelayError').textContent = '';
    if (!fillFrpRelaySelects()) {
      $('frpRelayError').textContent = frpServers.some((server) => server.status === 'online')
        ? '没有可开启中转的局域网 SSH 机器。'
        : '请先部署在线的云端 frps。';
    }
    $('frpRelayDialog').showModal();
  });
  $('frpRelayForm').addEventListener('submit', async (event) => {
    event.preventDefault(); $('frpRelaySubmit').disabled = true; $('frpRelayError').textContent = '';
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const payload = await apiPost('/frp/relays', {
        machineId: Number(fields.machineId),
        serverId: Number(fields.serverId),
        actorId: getState().actorId,
      });
      $('frpRelayDialog').close();
      await deployFrpRelay(payload.relay.id);
    } catch (cause) { $('frpRelayError').textContent = cause.message; }
    finally { $('frpRelaySubmit').disabled = false; }
  });
  $('copyFrpCommandButton').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('frpCommandText').textContent); $('copyFrpCommandButton').textContent = '已复制'; }
    catch { $('copyFrpCommandButton').textContent = '复制失败'; }
    setTimeout(() => { $('copyFrpCommandButton').textContent = '复制命令'; }, 1600);
  });
  document.querySelectorAll('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => $(b.dataset.closeDialog).close()));
  document.querySelectorAll('[data-task-filter]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.taskFilter; renderTasks(); }));
  $('taskSearch').addEventListener('input', (event) => { query = event.target.value.trim().toLowerCase(); renderTasks(); });
  // Task mutations are not SSE events yet; refresh read-only task observations while visible.
  let polling = false;
  setInterval(async () => {
    if (document.hidden || polling || actionBusy) return;
    polling = true;
    try { await refreshAll(); } finally { polling = false; }
  }, 15000);
  return { refresh, render, reset, invalidate };
}
