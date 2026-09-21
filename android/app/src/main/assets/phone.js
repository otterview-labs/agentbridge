(function() {
  'use strict';

  const state = {
    machines: [],
    tasks: [],
    frpServer: null,
    frpRelays: [],
    studio: null,
    studioLoading: false,
    networkHint: '',
    view: 'offices',
    currentTaskId: null,
    drafts: new Map(),
    sending: false,
    authType: 'password',
    frpAuthType: 'password',
    butlerPlanMode: loadButlerPlanMode(),
    voiceAutoSend: loadVoicePreference('voiceAutoSend', true),
    voiceSpeakReply: loadVoicePreference('voiceSpeakReply', true),
    voiceRecording: false,
    voiceLevel: 0,
    voiceStartedAt: 0,
    collapsedSprites: loadCollapsedSprites()
  };
  const voicePointer = { id: null, x: 0, y: 0, startedAt: 0, cancelArmed: false };
  const agentNames = { codex: 'Codex', 'claude-code': 'Claude', gemini: 'Gemini' };
  const $ = (id) => document.getElementById(id);
  console.log('phone-controller bootstrap');

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => selectView(tab.dataset.view));
  });
  $('attentionCount').addEventListener('click', () => selectView('todo'));
  $('cloudState').addEventListener('click', openCloudSheet);
  $('openCloudFromButler').addEventListener('click', openCloudSheet);
  $('refreshButler').addEventListener('click', () => void loadStudio());
  $('cloudForm').addEventListener('submit', saveCloudConnection);
  $('disconnectCloud').addEventListener('click', disconnectCloud);
  $('sendPi').addEventListener('click', sendPiMessage);
  $('generateReport').addEventListener('click', generateTodayReport);
  if (window.PointerEvent) {
    $('voiceButton').addEventListener('pointerdown', beginVoicePointer);
    $('voiceButton').addEventListener('pointermove', moveVoicePointer);
    $('voiceButton').addEventListener('pointerup', endVoicePointer);
    $('voiceButton').addEventListener('pointercancel', cancelVoicePointer);
    $('voiceButton').addEventListener('contextmenu', (event) => event.preventDefault());
  } else {
    $('voiceButton').addEventListener('click', toggleVoiceInput);
  }
  $('voiceAutoSend').addEventListener('click', () => toggleVoicePreference('voiceAutoSend'));
  $('voiceSpeakReply').addEventListener('click', () => toggleVoicePreference('voiceSpeakReply'));
  document.querySelectorAll('[data-quick-prompt]').forEach((button) => {
    button.addEventListener('click', () => {
      $('piInput').value = button.dataset.quickPrompt;
      autoResizeChatInput();
      void sendPiMessage();
    });
  });
  $('piInput').addEventListener('input', autoResizeChatInput);
  $('piInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendPiMessage();
    }
  });
  $('voiceAutoSend').classList.toggle('active', state.voiceAutoSend);
  $('voiceAutoSend').setAttribute('aria-pressed', String(state.voiceAutoSend));
  $('voiceSpeakReply').classList.toggle('active', state.voiceSpeakReply);
  $('voiceSpeakReply').setAttribute('aria-pressed', String(state.voiceSpeakReply));
  updateVoiceUi('stopped');
  $('brandMascot').append(employeeSprite('pi', 1));
  document.querySelectorAll('[data-plan-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.butlerPlanMode = button.dataset.planMode === 'records' ? 'records' : 'ai';
      try {
        localStorage.setItem('butlerPlanMode', state.butlerPlanMode);
      } catch (error) {
        // The in-memory mode still works if private storage is unavailable.
      }
      renderPiDetail();
    });
  });

  function selectView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach((item) => {
      const selected = item.dataset.view === view;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    render();
  }

  $('openAdd').addEventListener('click', () => {
    $('scanPrefix').value = state.networkHint || '';
    openMachineSheet();
  });
  $('openScan').addEventListener('click', () => {
    $('scanPrefix').value = state.networkHint || '';
    openMachineSheet();
    setTimeout(() => runScan(), 50);
  });
  $('refreshAll').addEventListener('click', refreshAll);
  $('runScan').addEventListener('click', runScan);
  $('machineForm').addEventListener('submit', saveMachine);
  $('frpForm').addEventListener('submit', saveFrpServer);
  document.querySelectorAll('[data-frp-auth]').forEach((button) => {
    button.addEventListener('click', () => {
      state.frpAuthType = button.dataset.frpAuth;
      document.querySelectorAll('[data-frp-auth]').forEach((item) => item.classList.toggle('active', item === button));
      $('frpPasswordLabel').classList.toggle('hidden', state.frpAuthType !== 'password');
      $('frpKeyLabel').classList.toggle('hidden', state.frpAuthType !== 'key');
    });
  });
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeSheet(button.dataset.close));
  });
  $('taskBackdrop').addEventListener('click', (event) => {
    if (event.target === $('taskBackdrop')) closeSheet('taskBackdrop');
  });
  $('replyText').addEventListener('input', () => {
    if (state.currentTaskId !== null) state.drafts.set(state.currentTaskId, $('replyText').value);
  });

  let sheetTrigger = null;
  function openSheet(id) {
    sheetTrigger = document.activeElement;
    $(id).classList.remove('hidden');
    document.body.classList.add('sheetOpen');
    document.querySelector('.app').setAttribute('inert', '');
    $(id).querySelector('[data-close]').focus({ preventScroll: true });
  }

  function closeSheet(id) {
    if (state.sending || !$('busy').classList.contains('hidden')) return false;
    $(id).classList.add('hidden');
    document.body.classList.remove('sheetOpen');
    document.querySelector('.app').removeAttribute('inert');
    if (sheetTrigger && sheetTrigger.isConnected) sheetTrigger.focus({ preventScroll: true });
    else $('refreshAll').focus({ preventScroll: true });
    sheetTrigger = null;
    return true;
  }

  function closeTopSheet() {
    if (state.sending || !$('busy').classList.contains('hidden')) return true;
    const sheet = document.querySelector('.sheetBackdrop:not(.hidden)');
    return sheet ? closeSheet(sheet.id) : false;
  }

  window.phoneUI = { closeTopSheet };
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && closeTopSheet()) event.preventDefault();
    if (event.key !== 'Tab') return;
    const sheet = document.querySelector('.sheetBackdrop:not(.hidden)');
    if (!sheet) return;
    const controls = Array.from(sheet.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary'
    )).filter((node) => node.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });
  document.querySelectorAll('[data-auth]').forEach((button) => {
    button.addEventListener('click', () => {
      state.authType = button.dataset.auth;
      document.querySelectorAll('[data-auth]').forEach((item) => item.classList.toggle('active', item === button));
      $('passwordLabel').classList.toggle('hidden', state.authType !== 'password');
      $('keyLabel').classList.toggle('hidden', state.authType !== 'key');
    });
  });
  $('renameTask').addEventListener('click', renameCurrentTask);
  $('tailTask').addEventListener('click', refreshCurrentTask);
  $('sendTask').addEventListener('click', sendCurrentTask);

  function call(method, busyText) {
    const args = Array.prototype.slice.call(arguments, 2);
    return new Promise((resolve) => {
      showBusy(busyText);
      setTimeout(() => {
        let parsed;
        try {
          const raw = AgentBridge[method].apply(AgentBridge, args);
          parsed = JSON.parse(raw);
        } catch (error) {
          console.error('bridge call failed: ' + method + ': ' + (error && error.message ? error.message : String(error)));
          parsed = { ok: false, error: error && error.message ? error.message : String(error) };
        }
        hideBusy();
        if (!parsed.ok) toast(parsed.error || '操作失败');
        resolve(parsed);
      }, 40);
    });
  }

  async function loadState() {
    console.log('loading state');
    const result = await call('state', '读取本机数据…');
    console.log('state result: ok=' + Boolean(result.ok)
      + ' machines=' + (result.data && result.data.machines ? result.data.machines.length : 0)
      + ' tasks=' + (result.data && result.data.tasks ? result.data.tasks.length : 0));
    if (!result.ok) return false;
    state.machines = result.data.machines || [];
    state.tasks = result.data.tasks || [];
    state.frpServer = result.data.frpServer || null;
    state.frpRelays = result.data.frpRelays || [];
    state.networkHint = result.data.networkHint || '';
    render();
    return true;
  }

  async function refreshAll() {
    if (!state.machines.length) {
      toast('先添加一台 SSH 机器');
      openMachineSheet();
      return;
    }
    let failed = 0;
    const total = state.machines.length;
    for (const machine of state.machines) {
      const result = await call('discoverTasks', `正在探查 ${machine.name}…`, machine.id);
      if (!result.ok) failed += 1;
    }
    if (!await loadState()) return;
    await loadStudio();
    toast(failed === total ? '刷新失败，保留上次记录'
      : failed ? `已刷新 ${total - failed}/${total} 台，其余保留上次记录`
        : '任务已刷新');
  }

  async function loadStudio() {
    if (state.studioLoading) return;
    state.studioLoading = true;
    try {
      const result = await call('studioOverview', '读取管家与今日记录…');
      if (result.ok) {
        state.studio = result.data;
        render();
      }
      return result.ok;
    } catch (error) {
      console.error('loadStudio failed: ' + (error && error.message ? error.message : String(error)));
      return false;
    } finally {
      state.studioLoading = false;
    }
  }

  async function runScan() {
    const prefix = $('scanPrefix').value.trim() || state.networkHint;
    const result = await call('scanNetwork', '正在扫描局域网端口…', prefix);
    const container = $('scanResult');
    container.textContent = '';
    if (!result.ok) return;
    if (!result.data.hosts.length) {
      container.appendChild(element('div', 'scanHost', '这个网段暂未发现 22 端口开放设备'));
      return;
    }
    result.data.hosts.forEach((host) => {
      const row = element('button', 'scanHost', `${host} 选择`);
      row.type = 'button';
      row.addEventListener('click', () => {
        $('machineHost').value = host;
        if (!$('machineName').value) $('machineName').value = `办公室 ${host.split('.').pop()}`;
        toast('已填入 SSH 地址');
      });
      container.appendChild(row);
    });
  }

  async function saveMachine(event) {
    event.preventDefault();
    const payload = {
      id: Number($('machineId').value || 0),
      name: $('machineName').value.trim(),
      host: $('machineHost').value.trim(),
      username: $('machineUsername').value.trim(),
      port: Number($('machinePort').value || 22),
      authType: state.authType,
      password: $('machinePassword').value,
      privateKey: $('machineKey').value
    };
    const saved = await call('saveMachine', '保存机器配置…', JSON.stringify(payload));
    if (!saved.ok) return;
    closeSheet('machineBackdrop');
    await loadState();
    const probe = await call('probeMachine', `正在连接 ${saved.data.machine.name}…`, saved.data.machine.id);
    if (probe.ok) toast(`${saved.data.machine.name} 已上线`);
    await loadState();
  }

  async function probeMachine(id) {
    await call('probeMachine', '正在测试 SSH 连接…', id);
    await loadState();
  }

  async function discoverMachine(id) {
    const result = await call('discoverTasks', '正在发现任务员工…', id);
    if (!await loadState()) return;
    if (result.ok) toast('已同步当前任务');
  }

  async function editMachine(id) {
    const machine = state.machines.find((item) => item.id === id);
    if (machine) openMachineSheet(machine);
  }

  async function deleteMachine(id) {
    const machine = state.machines.find((item) => item.id === id);
    if (!machine) return;
    if (!window.confirm(`删除「${machine.name}」和它的任务记录？`)) return;
    const deleted = await call('deleteMachine', '删除办公室…', id);
    if (deleted.ok) {
      state.tasks.filter(task => task.machineId === id).forEach(task => state.drafts.delete(task.id));
    }
    await loadState();
  }

  async function openTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    state.currentTaskId = id;
    renderTaskDetail();
    $('replyText').value = state.drafts.has(id) ? state.drafts.get(id) : task.suggestedReply || '';
    openSheet('taskBackdrop');
  }

  function renderTaskDetail() {
    const task = currentTask();
    $('sendTask').disabled = !task || state.sending;
    $('tailTask').disabled = !task;
    $('renameTask').disabled = !task;
    if (!task) {
      $('taskStatusLine').textContent = '本次未发现此会话，以下为上次记录';
      $('taskNeed').classList.add('hidden');
      return;
    }
    $('taskAvatar').className = 'taskAvatarWrap';
    $('taskAvatar').replaceChildren(employeeSprite(task.agentType, Number(String(task.id).replace(/\D/g, '')) % 3));
    const resumable = task.controlMode === 'process' ? task.externalSessionId : task.paneId;
    $('sendTask').disabled = !resumable || state.sending;
    $('taskMeta').textContent = `${agentNames[task.agentType] || task.agentType} · ${task.controlMode === 'process' ? '恢复会话' : 'tmux'} · ${resumable ? '可回复' : '待识别'}`;
    $('taskTitle').textContent = task.title;
    const machine = state.machines.find((item) => item.id === task.machineId);
    $('taskStatusLine').textContent = [
      taskStatusText(task),
      machine ? `${machine.name} · ${machineCheckText(machine)}` : '机器记录不存在',
      task.workspacePath
    ].filter(Boolean).join(' · ');
    $('workSummary').textContent = task.workSummary || task.requiredInput || '暂未读取到详细工作摘要。';
    $('taskNeed').textContent = task.requiredInput
      ? `${isRecordedTask(task) ? '上次待确认' : '需要你确认'}：${task.requiredInput}` : '';
    $('taskNeed').classList.toggle('hidden', !task.requiredInput);
    $('taskOutput').textContent = task.lastOutput || '暂无输出';
  }

  async function renameCurrentTask() {
    const value = window.prompt('新的任务名称', currentTask() ? currentTask().title : '');
    if (!value || !state.currentTaskId) return;
    const result = await call('renameTask', '修改员工名牌…', state.currentTaskId, value);
    if (result.ok) {
      $('taskTitle').textContent = result.data.task.title;
      await loadState();
    }
  }

  async function refreshCurrentTask() {
    if (!state.currentTaskId) return;
    await call('tailTask', '刷新任务输出…', state.currentTaskId);
    await loadState();
  }

  async function sendCurrentTask() {
    if (!state.currentTaskId || !currentTask() || state.sending) return;
    const value = $('replyText').value.trim();
    if (!value) {
      toast('先输入要发送回会话的内容');
      return;
    }
    const taskId = state.currentTaskId;
    state.sending = true;
    $('sendTask').disabled = true;
    let operation;
    try {
      const begin = await call('beginSendPrompt', '正在发送回原会话…', taskId, value, 'android');
      if (!begin.ok) return;
      operation = begin.data.operation;
      while (true) {
        let parsed;
        try {
          parsed = JSON.parse(AgentBridge.operationState(operation.id));
        } catch (error) {
          parsed = { ok: false, error: '无法读取发送状态' };
        }
        if (!parsed.ok) throw new Error(parsed.error || '无法读取发送状态');
        const current = parsed.data.operation;
        showBusy(current.message, (current.network || {}).summary || '');
        updateBusyElapsed(operation.startedAt);
        if (current.state !== 'running') {
          if (current.state === 'failed') throw new Error(current.message || '回复失败');
          break;
        }
        await sleep(500);
      }
      // A confirmed send must not leave a resendable draft if reloading records fails.
      state.drafts.set(taskId, '');
      $('replyText').value = '';
      if (!await loadState()) {
        toast('回复已发送，记录读取失败，请刷新后查看');
        return;
      }
      toast('已发送');
    } catch (error) {
      toast(error.message || String(error));
    } finally {
      if (operation) {
        try { AgentBridge.clearOperation(operation.id); } catch (error) { /* operation already cleared */ }
      }
      state.sending = false;
      renderTaskDetail();
      hideBusy();
    }
  }

  function currentTask() {
    return state.tasks.find((item) => item.id === state.currentTaskId);
  }

  function openMachineSheet(machine) {
    $('machineSheetTitle').textContent = machine ? `编辑 ${machine.name}` : '添加 SSH 机器';
    $('machineId').value = machine ? machine.id : '';
    $('machineName').value = machine ? machine.name : '';
    $('machineHost').value = machine ? machine.host : '';
    $('machineUsername').value = machine ? machine.username : '';
    $('machinePort').value = machine ? machine.port : 22;
    $('machinePassword').value = machine ? machine.password || '' : '';
    $('machineKey').value = machine ? machine.privateKey || '' : '';
    state.authType = machine && machine.authType === 'key' ? 'key' : 'password';
    document.querySelectorAll('[data-auth]').forEach((item) => item.classList.toggle('active', item.dataset.auth === state.authType));
    $('passwordLabel').classList.toggle('hidden', state.authType !== 'password');
    $('keyLabel').classList.toggle('hidden', state.authType !== 'key');
    $('scanResult').textContent = '';
    openSheet('machineBackdrop');
  }

  function openFrpSheet() {
    const server = state.frpServer;
    const machine = server ? state.machines.find((item) => item.id === server.machineId) : null;
    $('frpMachineId').value = machine ? machine.id : '';
    $('frpName').value = machine ? machine.name : '云端入口';
    $('frpHost').value = machine ? machine.host : '';
    $('frpUsername').value = machine ? machine.username : '';
    $('frpPort').value = machine ? machine.port : 22;
    $('frpPassword').value = machine ? machine.password || '' : '';
    $('frpKey').value = machine ? machine.privateKey || '' : '';
    state.frpAuthType = machine && machine.authType === 'key' ? 'key' : 'password';
    document.querySelectorAll('[data-frp-auth]').forEach((item) => item.classList.toggle('active', item.dataset.frpAuth === state.frpAuthType));
    $('frpPasswordLabel').classList.toggle('hidden', state.frpAuthType !== 'password');
    $('frpKeyLabel').classList.toggle('hidden', state.frpAuthType !== 'key');
    $('frpAdvanced').open = state.frpAuthType === 'key';
    $('frpPublicAddress').value = server ? server.publicAddress : '';
    $('frpBindPort').value = server ? server.bindPort : 7001;
    $('frpVersion').value = server ? server.version : '0.61.1';
    $('frpDownloadBase').value = server ? server.downloadBase : 'https://github.com/fatedier/frp/releases/download';
    $('frpExistingToken').value = '';
    openSheet('frpBackdrop');
  }

  async function saveFrpServer(event) {
    event.preventDefault();
    const payload = {
      machineId: Number($('frpMachineId').value || 0),
      host: $('frpHost').value.trim(),
      username: $('frpUsername').value.trim(),
      port: Number($('frpPort').value || 22),
      authType: state.frpAuthType,
      password: $('frpPassword').value,
      privateKey: $('frpKey').value,
      name: $('frpName').value.trim() || '云端入口',
      publicAddress: $('frpPublicAddress').value.trim() || $('frpHost').value.trim(),
      bindPort: Number($('frpBindPort').value || 7001),
      version: $('frpVersion').value.trim(),
      downloadBase: $('frpDownloadBase').value.trim(),
      existingToken: $('frpExistingToken').value
    };
    const result = await call('saveFrpServer', '保存公网入口…', JSON.stringify(payload));
    if (!result.ok) return;
    closeSheet('frpBackdrop');
    await loadState();
    const deployed = await call('deployFrpServer', '正在自动部署公网入口…');
    await loadState();
    toast(deployed.ok ? frpDeploymentToast(deployed.data.frpServer) : '入口已保存，请查看部署错误');
  }

  async function deployFrpServer() {
    const result = await call('deployFrpServer', '自动部署公网 FRP 服务端…');
    await loadState();
    if (result.ok) toast(frpDeploymentToast(result.data.frpServer));
  }

  function frpDeploymentToast(server) {
    if (server && server.deployment === 'adopted-existing') return '已复用服务器上的 FRP，请继续开通机器';
    if (server && server.deployment === 'reused') return 'Agent Bridge FRP 已复用，请继续开通机器';
    return '入口服务已启动，请继续开通机器';
  }

  function frpDeploymentText(server) {
    if (!server || !server.deployment) return '';
    if (server.deployment === 'adopted-existing') return ' · 复用已有 FRP';
    if (server.deployment === 'reused') return ' · 复用 Agent Bridge FRP';
    return '';
  }

  async function deployPublicRelay(machineId) {
    const result = await call('deployFrpRelay', '安装安全中转客户端…', machineId);
    await loadState();
    if (result.ok) toast('公网中转 SSH 验证通过');
  }

  async function disablePublicRelay(machineId) {
    if (!window.confirm('关闭这台机器的公网访问？关闭后出门时将不能远程操作它。')) return;
    const result = await call('disableFrpRelay', '关闭安全中转…', machineId);
    await loadState();
    if (result.ok) toast('公网访问已关闭');
  }

  async function setPublicMode(machineId, mode) {
    const result = await call('setMachinePublicMode', '切换公网模式…', machineId, mode);
    await loadState();
    if (result.ok) toast('公网模式已更新');
  }

  function renderPublic() {
    const container = $('public');
    container.textContent = '';
    const server = state.frpServer;
    const serverMachine = server ? state.machines.find((item) => item.id === server.machineId) : null;

    const entry = element('article', 'publicCard');
    const header = element('header', 'publicHeader');
    header.appendChild(element('p', 'eyebrow', 'SECURE PUBLIC ENTRY'));
    header.appendChild(element('h2', '', server ? server.publicAddress : '三步开通远程访问'));
    header.appendChild(element('p', 'publicMeta', server
      ? `SSH ${serverMachine ? serverMachine.username + '@' + serverMachine.host + ':' + serverMachine.port : '未配置'} · FRP ${server.bindPort} · ${frpStatusText(server.status)}${frpDeploymentText(server)}`
      : '填公网服务器、用户名、密码；优先复用已有 FRP，没有则自动部署；再给需要出门的机器一键开通。'));
    if (server && server.lastError) header.appendChild(element('p', 'deploymentError', server.lastError));
    const actions = element('div', 'officeActions');
    actions.appendChild(actionButton(server ? '快速配置' : '开始配置', openFrpSheet, server ? '' : 'dark'));
    if (server) actions.appendChild(actionButton(server.deployment === 'adopted-existing' ? '重新检查' : '重新部署', deployFrpServer));
    header.appendChild(actions);
    entry.appendChild(header);

    const body = element('div', 'publicBody');
    body.appendChild(element('p', 'securityNote', '安全默认：只暴露公网入口的 SSH 和 FRP 端口；目标机器不直接暴露 SSH，出门访问走 SSH + FRP STCP 加密隧道。'));
    if (!server) {
      const steps = element('div', 'officeEmpty');
      steps.textContent = '1. 添加一台公网 Linux 机器 → 2. 自动部署入口 → 3. 给办公室一键开通远程访问';
      body.appendChild(steps);
    } else {
      const candidates = state.machines.filter((item) => item.id !== server.machineId);
      if (!candidates.length) {
        body.appendChild(element('div', 'officeEmpty', '还没有可配置远程访问的私有机器。'));
      } else {
        candidates.forEach((machine) => {
          const relay = state.frpRelays.find((item) => item.machineId === machine.id);
          const enabled = server.status === 'online' && relay && relay.enabled && relay.status === 'online';
          const card = element('div', 'publicMachine');
          const title = element('div', 'publicMachineTitle');
          title.appendChild(element('strong', '', machine.name));
          title.appendChild(element('span', `stateChip ${enabled ? 'running' : 'idle'}`,
            server.status !== 'online' ? '入口未就绪' : relay ? frpStatusText(relay.status) : '未开通'));
          card.appendChild(title);
          card.appendChild(element('small', '', `${machine.username}@${machine.host}:${machine.port} · ${enabled
            ? relay.verifiedAt ? `上次验证 ${checkTime(relay.verifiedAt)}` : '旧配置，请重新验证'
            : '尚未验证公网连接'}`));
          const error = machine.publicAccessError || (relay && relay.lastError);
          if (error) card.appendChild(element('p', 'deploymentError', error));
          const row = element('div', 'officeActions');
          const deploy = actionButton(server.status !== 'online' ? '先部署公网入口' : enabled ? '重新配置' : '一键开通远程访问',
            () => deployPublicRelay(machine.id), 'dark');
          deploy.disabled = server.status !== 'online';
          row.appendChild(deploy);
          if (relay && relay.enabled) row.appendChild(actionButton('关闭远程', () => disablePublicRelay(machine.id), 'warn'));
          card.appendChild(row);

          const advanced = element('details', 'advancedDetails');
          const summary = element('summary', '', '连接模式');
          advanced.appendChild(summary);
          const advancedBody = element('div', 'advancedBody');
          const modes = element('div', 'modeRow');
          [['off', '不上公网'], ['auto', '自动'], ['public', '仅公网']].forEach(([mode, label]) => {
            modes.appendChild(actionButton(label, () => setPublicMode(machine.id, mode),
              (machine.publicMode || 'off') === mode ? 'dark' : ''));
          });
          advancedBody.appendChild(modes);
          advancedBody.appendChild(element('p', 'formNote', '自动：同 Wi-Fi 直连，出门走公网。仅公网：永远走公网入口。不上公网：关闭远程访问优先级。'));
          advanced.appendChild(advancedBody);
          card.appendChild(advanced);
          body.appendChild(card);
        });
      }
    }
    entry.appendChild(body);
    container.appendChild(entry);
  }

  function frpStatusText(status) {
    if (status === 'online') return '在线';
    if (status === 'deploying') return '部署中';
    if (status === 'error') return '错误';
    if (status === 'disabled') return '已关闭';
    return '未部署';
  }

  function publicModeText(mode) {
    if (mode === 'auto') return '自动';
    if (mode === 'public') return '仅公网';
    return '不上公网';
  }

  function render() {
    document.body.dataset.view = state.view;
    $('butlerChatDock').classList.toggle('hidden', state.view !== 'butler');
    $('butler').classList.toggle('hidden', state.view !== 'butler');
    $('offices').classList.toggle('hidden', state.view !== 'offices');
    $('todo').classList.toggle('hidden', state.view !== 'todo');
    $('public').classList.toggle('hidden', state.view !== 'public');
    $('taskCount').textContent = `${state.tasks.length} 位员工`;
    const attention = state.tasks.filter((task) => task.requiredInput).length;
    $('attentionCount').textContent = `${attention} 个待输入`;
    $('attentionCount').disabled = attention === 0;
    $('todoTab').textContent = attention ? `待输入 · ${attention}` : '待输入';
    $('networkLine').textContent = state.networkHint
      ? `${state.machines.length} 间办公室 · 手动刷新检查状态`
      : `${state.machines.length} 间办公室 · 未识别 Wi-Fi，可手动添加`;
    renderOffices();
    renderTodo();
    renderPublic();
    renderCloudState();
    if (state.view === 'butler') renderPiDetail();
    if (!$('taskBackdrop').classList.contains('hidden')) renderTaskDetail();
  }

  function renderOffices() {
    const container = $('offices');
    container.textContent = '';
    if (!state.machines.length) {
      const empty = element('div', 'empty');
      empty.innerHTML = '<div class="emptyAvatar"></div><h3>小镇还空着</h3><p>添加一台支持 SSH 的 Mac / Linux，<br>手机会直接去那里找 Claude 和 Codex 员工。</p>';
      container.appendChild(empty);
      return;
    }

    state.machines.forEach((machine) => {
      const office = element('article', 'office');
      const header = element('header', 'officeHeader');
      const title = element('div', 'officeTitle');
      title.appendChild(element('h2', '', machine.name));
      const titleMeta = element('p', 'officeMeta');
      titleMeta.appendChild(element('span', '', machineSubtitle(machine)));
      titleMeta.appendChild(element(
        'span',
        `officeStatus ${machine.lastStatus === 'online' ? 'online' : machine.lastStatus === 'offline' ? 'offline' : ''}`,
        machine.lastStatus === 'online' ? '在线' : machine.lastStatus === 'offline' ? '离线' : '未检查',
      ));
      const tools = machineToolsLabel(machine);
      if (tools) titleMeta.appendChild(element('span', 'officeTools', tools));
      title.appendChild(titleMeta);
      title.appendChild(element('p', `officeCheck${machine.lastStatus === 'offline' ? ' failed' : ''}`, machineCheckText(machine)));
      const actions = element('div', 'officeActions');
      actions.appendChild(actionButton('测试', () => probeMachine(machine.id), 'advancedAction'));
      actions.appendChild(actionButton('找任务', () => discoverMachine(machine.id), 'dark'));
      actions.appendChild(actionButton(isCollapsed(machine.id) ? '展开' : '收起', () => toggleSprites(machine.id), 'spriteToggle advancedAction'));
      actions.appendChild(actionButton('编辑', () => editMachine(machine.id), 'advancedAction'));
      actions.appendChild(actionButton('删除', () => deleteMachine(machine.id), 'warn advancedAction'));
      actions.appendChild(actionButton('更多', () => {
        office.classList.toggle('showAdvanced');
      }));
      header.appendChild(title);
      header.appendChild(actions);
      office.appendChild(header);

      const tasks = prioritizeTasks(state.tasks.filter((task) => task.machineId === machine.id));
      if (isCollapsed(machine.id)) {
        const attention = tasks.filter((task) => task.requiredInput).length;
        office.appendChild(element(
          'div',
          'officeCollapsedSummary',
          tasks.length
            ? `${tasks.length} 位员工已收起${attention ? ` · ${attention} 个待输入` : ''}`
            : '员工列表已收起',
        ));
      } else {
        const employees = element('div', 'employees');
        if (!tasks.length) {
          employees.appendChild(element('div', 'officeEmpty', '这间办公室还没有发现员工，点击“找任务”试试。'));
        } else {
          tasks.forEach((task) => employees.appendChild(employeeCard(task)));
        }
        office.appendChild(employees);
      }
      container.appendChild(office);
    });
  }

  function renderPiDetail() {
    const studio = state.studio || {};
    const hub = studio.hub || {};
    const model = studio.model || { ready: false, label: '' };
    const report = studio.report || {};
    const savedReport = studio.dailyReport && studio.dailyReport.content ? studio.dailyReport : studio.lastReport;
    const lastReport = savedReport && savedReport.content ? savedReport.content : null;
    const attention = state.tasks.filter(task => task.requiredInput);

    const aiTodayItems = lastReport
      ? [
          ...lastReport.completed.map(item => ({ title: item.text, label: '已做' })),
          ...lastReport.ongoing.map(item => ({ title: item.text, label: '推进中' })),
        ]
      : [];
    const aiTomorrowItems = lastReport && Array.isArray(lastReport.tomorrow)
      ? lastReport.tomorrow.map(item => ({ title: item.text, label: '明日建议' }))
      : [];
    const rawTodayItems = [
      ...(Array.isArray(report.completed) ? report.completed : []).map(item => ({
        title: item.title,
        label: item.label || item.source || '已做'
      })),
      ...(Array.isArray(report.ongoing) ? report.ongoing : []).map(item => ({
        title: item.title,
        label: item.label || item.source || '推进中'
      })),
    ];
    const rawTomorrowItems = (Array.isArray(report.suggestions) ? report.suggestions : []).map(item => ({
      title: item.title,
      label: item.next || '明日建议'
    }));
    const todayItems = state.butlerPlanMode === 'records' ? rawTodayItems : aiTodayItems;
    const tomorrowItems = state.butlerPlanMode === 'records' ? rawTomorrowItems : aiTomorrowItems;
    const suggestion = attention[0]
      ? `先处理「${attention[0].title}」：${attention[0].requiredInput}`
      : (tomorrowItems[0] ? `明天可以先做：${tomorrowItems[0].title}` : '当前没有高优先级待输入。');

    const modelText = model.label ? model.label.replace(/^Pi\s*[·:-]?\s*/u, '').trim() : '';
    $('piAvatar').replaceChildren(employeeSprite('pi', 2));
    $('piAvatar').appendChild(element('span', 'employeeBubble', attention.length ? `${attention.length} 个待输入` : '管家待命'));
    $('openCloudFromButler').textContent = hub.connected ? '模型设置' : '连接模型';
    $('piMeta').textContent = model.ready && modelText ? modelText : '模型未连接';
    $('piSheetTitle').textContent = '管家';
    $('butlerEmployeeName').textContent = attention.length
      ? `先处理 ${attention.length} 件紧急事项`
      : tomorrowItems.length ? '明日安排已准备' : '今日节奏清晰';
    $('butlerEmployeeSub').textContent = cleanButlerText(suggestion);
    document.querySelectorAll('[data-plan-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.planMode === state.butlerPlanMode);
    });
    $('butlerReportMeta').textContent = state.butlerPlanMode === 'records'
      ? `原始记录 · 已同步 ${(Array.isArray(report.completed) ? report.completed : []).length + (Array.isArray(report.ongoing) ? report.ongoing : []).length} 条`
      : lastReport
      ? `${savedReport.model || modelText || 'AI'} · ${checkTime(savedReport.generatedAt)}`
      : '尚未生成';
    $('butlerAiSummary').textContent = state.butlerPlanMode === 'records'
      ? '以下内容直接来自当前已同步任务记录，未经 AI 总结。空闲、执行中或待输入都不等同于人工验收完成。'
      : lastReport && lastReport.summary
      ? cleanButlerText(lastReport.summary)
      : '还没有 AI 总结。点击“重新生成日报”，管家会根据已同步任务整理今日与明日。';
    $('butlerMessageLabel').textContent = model.ready ? (modelText || '模型已连接') : '模型未连接';

    renderPlainRows($('piToday'), todayItems, 'today', state.butlerPlanMode === 'records'
      ? '当前没有可展示的今日记录。'
      : 'AI 总结生成后会显示已做与推进事项。');
    renderPlainRows($('piTomorrow'), tomorrowItems, 'tomorrow', state.butlerPlanMode === 'records'
      ? '当前没有可展示的明日建议。'
      : 'AI 总结生成后会显示明日建议。');
    renderPlainRows($('piAttention'), attention.map(task => ({
      title: task.title, label: task.requiredInput
    })), 'attention', '当前没有等待输入的事项。');

    $('piMessages').replaceChildren();
    const messages = Array.isArray(studio.messages) ? studio.messages.slice(-20) : [];
    if (!messages.length) {
      $('piMessages').appendChild(element('p', 'formNote', model.ready ? '还没有管家对话。' : '连接模型后可以问管家安排。'));
    } else {
      messages.forEach(message => {
        const row = element('div', `piMessage${message.role === 'user' ? ' user' : ''}`);
        row.appendChild(element('strong', '', message.role === 'user' ? '我' : '管家'));
        row.appendChild(element('span', '', message.content));
        $('piMessages').appendChild(row);
      });
    }
    $('sendPi').disabled = !hub.connected || !model.ready || state.sending || !$('piInput').value.trim();
    $('generateReport').disabled = !hub.connected || !model.ready;
    requestAnimationFrame(() => {
      const messages = $('piMessages');
      if (messages) messages.scrollTop = messages.scrollHeight;
    });
  }

  function renderPlainRows(container, items, kind, emptyText) {
    container.replaceChildren();
    if (!items || !items.length) {
      container.appendChild(element('p', 'formNote', emptyText || '暂无记录。'));
      return;
    }
    items.slice(0, kind === 'tomorrow' ? 4 : 3).forEach(item => {
      const row = element('div', `plainRow ${kind}`);
      row.appendChild(element('span', '', ''));
      const copy = element('div');
      copy.appendChild(element('strong', '', compactButlerText(item.title || item.text || '未命名事项', 72)));
      copy.appendChild(element('small', '', compactButlerText(item.label || item.next || item.source || '', 90)));
      row.appendChild(copy);
      container.appendChild(row);
    });
  }

  function renderCloudState() {
    const studio = state.studio || {};
    const hub = studio.hub || {};
    const model = studio.model || {};
    const ready = Boolean(hub.connected && model.ready);
    $('cloudState').textContent = ready ? '模型已连接' : '模型未连接';
    $('cloudState').classList.toggle('connected', ready);
  }

  function openCloudSheet() {
    const hub = state.studio && state.studio.hub ? state.studio.hub : {};
    $('cloudUrl').value = hub.baseUrl || '';
    $('cloudToken').value = '';
    $('cloudShare').checked = hub.connected ? Boolean(hub.shareTasks) : true;
    $('cloudHttp').checked = Boolean(hub.allowLocalHttp);
    const modelSettings = state.studio && state.studio.modelSettings ? state.studio.modelSettings : {};
    $('modelBaseUrl').value = modelSettings.baseUrl || '';
    $('modelId').value = modelSettings.modelId || '';
    $('modelApiKey').value = '';
    openSheet('cloudBackdrop');
  }

  async function saveCloudConnection(event) {
    event.preventDefault();
    const token = $('cloudToken').value;
    const nextUrl = $('cloudUrl').value.trim();
    if (!token && !hub.connected) {
      toast('首次连接需要 Hub Token');
      return;
    }
    if (!token && hub.baseUrl && nextUrl !== hub.baseUrl) {
      toast('更换 Hub 地址时需要重新输入 Token');
      return;
    }
    const payload = {
      baseUrl: nextUrl,
      token,
      shareTasks: $('cloudShare').checked,
      allowLocalHttp: $('cloudHttp').checked
    };
    let result = await call('saveStudioHub', '连接管家云端…', JSON.stringify(payload));
    if (!result.ok) return;
    state.studio = result.data;
    const baseUrl = $('modelBaseUrl').value.trim();
    const modelId = $('modelId').value.trim();
    const apiKey = $('modelApiKey').value;
    if (baseUrl && modelId) {
      const modelResult = await call('saveStudioModel', '保存 OpenAI 格式模型…', JSON.stringify({
        baseUrl, modelId, apiKey
      }));
      if (!modelResult.ok) return;
      state.studio = modelResult.data;
    }
    closeSheet('cloudBackdrop');
    render();
    toast('管家云端与模型已更新');
  }

  async function disconnectCloud() {
    const result = await call('disconnectStudioHub', '断开管家云端…');
    if (!result.ok) return;
    await loadStudio();
    closeSheet('cloudBackdrop');
    render();
    toast('管家云端已断开');
  }

  async function sendPiMessage() {
    if (state.sending) return;
    const value = $('piInput').value.trim();
    if (!value) {
      toast('先输入要问管家的内容');
      return;
    }
    state.sending = true;
    $('sendPi').disabled = true;
    $('piInput').value = '';
    autoResizeChatInput();
    appendChatMessage('user', value);
    setChatTyping(true);
    let operation;
    try {
      let parsed;
      try {
        parsed = JSON.parse(AgentBridge.beginStudioMessage(value));
      } catch (error) {
        parsed = { ok: false, error: '无法启动管家回复' };
      }
      if (!parsed.ok) throw new Error(parsed.error || '无法启动管家回复');
      operation = parsed.data.operation;
      while (true) {
        await sleep(220);
        let currentResult;
        try {
          currentResult = JSON.parse(AgentBridge.operationState(operation.id));
        } catch (error) {
          currentResult = { ok: false, error: '无法读取管家回复状态' };
        }
        if (!currentResult.ok) throw new Error(currentResult.error || '无法读取管家回复状态');
        const current = currentResult.data.operation;
        setChatTyping(true, current.message);
        if (current.state !== 'running') {
          if (current.state === 'failed') throw new Error(current.message || '管家回复失败');
          operation = current;
          break;
        }
      }
      state.studio = operation.studio || state.studio;
      setChatTyping(false);
      renderPiDetail();
      render();
      const messages = Array.isArray(state.studio.messages) ? state.studio.messages : [];
      const reply = messages[messages.length - 1];
      if (reply && reply.role === 'assistant' && state.voiceSpeakReply) {
        try { AgentBridge.speakText(reply.content); } catch (error) { /* Text reply remains available. */ }
      }
    } catch (error) {
      setChatTyping(false);
      appendChatNotice(error.message || String(error));
      toast(error.message || String(error));
    } finally {
      state.sending = false;
      if (operation) {
        try { AgentBridge.clearOperation(operation.id); } catch (error) { /* Already cleared. */ }
      }
      renderPiDetail();
    }
  }

  function appendChatMessage(role, content) {
    const row = element('div', `piMessage ${role === 'user' ? 'user' : ''}`);
    row.appendChild(element('strong', '', role === 'user' ? '我' : '管家'));
    row.appendChild(element('span', '', content));
    $('piMessages').appendChild(row);
    $('piMessages').scrollTop = $('piMessages').scrollHeight;
  }

  function appendChatNotice(content) {
    const row = element('div', 'chatNotice');
    row.textContent = content;
    $('piMessages').appendChild(row);
    $('piMessages').scrollTop = $('piMessages').scrollHeight;
  }

  function setChatTyping(typing, message) {
    const existing = document.getElementById('chatTyping');
    if (!typing) {
      existing?.remove();
      return;
    }
    if (!existing) {
      const row = element('div', 'piMessage typing');
      row.id = 'chatTyping';
      row.appendChild(element('strong', '', '管家'));
      row.appendChild(element('span', '', '正在思考…'));
      $('piMessages').appendChild(row);
    } else {
      existing.querySelector('span').textContent = message || '正在思考…';
    }
    $('piMessages').scrollTop = $('piMessages').scrollHeight;
  }

  function autoResizeChatInput() {
    const input = $('piInput');
    input.style.height = 'auto';
    input.style.height = `${Math.min(112, input.scrollHeight)}px`;
    $('sendPi').disabled = state.sending || !input.value.trim();
  }

  function toggleVoiceInput() {
    if (state.voiceRecording) {
      state.voiceRecording = false;
      updateVoiceUi('processing');
      updateVoiceUi('stopped');
      try { AgentBridge.stopVoiceInput(); } catch (error) { /* Native state callback handles errors. */ }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(AgentBridge.startVoiceInput(state.voiceAutoSend));
    } catch (error) {
      parsed = { ok: false };
    }
    if (!parsed.ok) {
      updateVoiceUi('error', '语音识别不可用');
      return;
    }
    state.voiceRecording = true;
    state.voiceStartedAt = Date.now();
    updateVoiceUi('ready');
  }

  function beginVoicePointer(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    voicePointer.id = event.pointerId;
    voicePointer.x = event.clientX;
    voicePointer.y = event.clientY;
    voicePointer.startedAt = Date.now();
    voicePointer.cancelArmed = false;
    try {
      $('voiceButton').setPointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture is only an enhancement; the pointerup listener still works.
    }
    toggleVoiceInput();
  }

  function moveVoicePointer(event) {
    if (voicePointer.id === null || event.pointerId !== voicePointer.id || !state.voiceRecording) return;
    voicePointer.cancelArmed = event.clientY < voicePointer.y - 68;
    updateVoiceUi(state.voiceRecording ? 'recording' : 'stopped');
  }

  function endVoicePointer(event) {
    if (voicePointer.id === null || event.pointerId !== voicePointer.id) return;
    const heldMs = Date.now() - voicePointer.startedAt;
    const shouldFinish = state.voiceRecording && (heldMs >= 260 || voicePointer.cancelArmed);
    const shouldCancel = voicePointer.cancelArmed;
    releaseVoicePointer(event.pointerId);
    if (!shouldFinish) {
      if (state.voiceRecording) updateVoiceUi('recording');
      return;
    }
    if (shouldCancel) {
      cancelVoiceInput();
      return;
    }
    finishVoiceInput();
  }

  function cancelVoicePointer(event) {
    if (voicePointer.id === null || event.pointerId !== voicePointer.id) return;
    releaseVoicePointer(event.pointerId);
    if (state.voiceRecording) cancelVoiceInput();
  }

  function releaseVoicePointer(pointerId) {
    try {
      if ($('voiceButton').hasPointerCapture(pointerId)) $('voiceButton').releasePointerCapture(pointerId);
    } catch (error) {
      // The pointer may already be released by WebView.
    }
    voicePointer.id = null;
    voicePointer.cancelArmed = false;
  }

  function finishVoiceInput() {
    state.voiceRecording = false;
    updateVoiceUi('processing');
    try { AgentBridge.stopVoiceInput(); } catch (error) {
      updateVoiceUi('error', '语音识别连接失败');
    }
  }

  function cancelVoiceInput() {
    state.voiceRecording = false;
    updateVoiceUi('stopped');
    try { AgentBridge.cancelVoiceInput(); } catch (error) {
      // Native cancellation is best-effort.
    }
  }

  function updateVoiceUi(type, text) {
    const labels = {
      ready: '正在听…轻点结束，或按住后松手',
      recording: '正在听…松手发送，上滑取消',
      partial: '正在识别…',
      processing: '正在整理…',
      'cloud-recording': '正在录音…松手转文字，上滑取消',
      'cloud-processing': '正在转文字…',
      final: '识别完成',
      stopped: '按住麦克风说话',
      error: text || '语音识别失败'
    };
    $('voiceStateText').textContent = labels[type] || labels.stopped;
    const listening = state.voiceRecording;
    document.body.classList.toggle('voice-listening', listening);
    $('voicePanel').classList.toggle('hidden', !listening);
    $('voicePanel').classList.toggle('cancel', Boolean(voicePointer.cancelArmed));
    $('voicePanelTitle').textContent = voicePointer.cancelArmed ? '松开取消' : '正在听…';
    $('voicePanelHint').textContent = voicePointer.cancelArmed
      ? '这次录音不会发给管家'
      : state.voiceAutoSend ? '松开后转文字并发送' : '松开后放入输入框';
    $('voiceButton').classList.toggle('recording', state.voiceRecording);
    $('voiceButton').style.setProperty('--voice-level', `${Math.max(12, Math.min(100, state.voiceLevel))}%`);
  }

  window.phoneVoice = {
    update(value) {
      const event = typeof value === 'string' ? JSON.parse(value) : value;
      state.voiceLevel = event.type === 'level' ? Number(event.text) || 0 : state.voiceLevel;
      if (event.type === 'partial' || event.type === 'final') {
        $('piInput').value = event.text || '';
        autoResizeChatInput();
      }
      if (event.type === 'recording' || event.type === 'ready' || event.type === 'cloud-recording') state.voiceRecording = true;
      if (event.type === 'cloud-processing') state.voiceRecording = false;
      if (event.type === 'final' || event.type === 'error' || event.type === 'stopped') state.voiceRecording = false;
      updateVoiceUi(event.type, event.text);
      if (event.type === 'final' && event.autoSend && event.text?.trim()) {
        setTimeout(() => void sendPiMessage(), 180);
      }
    }
  };

  async function generateTodayReport() {
    const date = state.studio && state.studio.date
      ? state.studio.date
      : new Date().toISOString().slice(0, 10);
    const result = await call('generateStudioReport', '正在生成今日日报…', date);
    if (!result.ok) return;
    state.studio = result.data;
    state.butlerPlanMode = 'ai';
    try {
      localStorage.setItem('butlerPlanMode', 'ai');
    } catch (error) {
      // Rendering still uses the in-memory mode.
    }
    renderPiDetail();
    render();
    toast('今日日报已生成');
  }

  function cleanButlerText(value) {
    return String(value || '')
      .replace(/\[Image:[^\]]+\]/giu, '图片')
      .replace(/\[Audio:[^\]]+\]/giu, '音频')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  function loadButlerPlanMode() {
    try {
      const value = localStorage.getItem('butlerPlanMode');
      return value === 'records' ? 'records' : 'ai';
    } catch (error) {
      return 'ai';
    }
  }

  function loadVoicePreference(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value === 'true';
    } catch (error) {
      return fallback;
    }
  }

  function toggleVoicePreference(key) {
    state[key] = !state[key];
    const button = $(key === 'voiceAutoSend' ? 'voiceAutoSend' : 'voiceSpeakReply');
    button.classList.toggle('active', state[key]);
    button.setAttribute('aria-pressed', String(state[key]));
    try {
      localStorage.setItem(key, String(state[key]));
    } catch (error) {
      // The current in-memory choice still applies.
    }
  }

  function compactButlerText(value, maximum) {
    const clean = cleanButlerText(value);
    return clean.length <= maximum ? clean : clean.slice(0, maximum - 1) + '…';
  }

  function renderTodo() {
    const container = $('todo');
    container.textContent = '';
    const tasks = prioritizeTasks(state.tasks.filter((task) => task.requiredInput));
    if (!tasks.length) {
      const empty = element('div', 'empty');
      empty.innerHTML = '<div class="emptyAvatar"></div><h3>暂无待输入记录</h3><p>点击顶部刷新，检查最新会话状态。</p>';
      container.appendChild(empty);
      return;
    }
    tasks.forEach((task) => {
      const card = element('button', 'todoCard');
      card.dataset.state = 'attention';
      card.dataset.record = isRecordedTask(task) ? 'true' : 'false';
      const avatar = element('div', 'todoAvatarWrap');
      avatar.append(employeeSprite(task.agentType, Number(String(task.id).replace(/\D/g, '')) % 3));
      const info = element('div');
      info.appendChild(element('strong', '', task.title));
      info.appendChild(element('p', 'employeeSub', `${agentNames[task.agentType] || task.agentType} · ${taskStatusText(task)}`));
      const machine = state.machines.find((item) => item.id === task.machineId);
      if (machine) info.appendChild(element('p', 'employeeSub', `${machine.name} · ${machineCheckText(machine)}`));
      info.appendChild(element('p', 'todoNeed', task.requiredInput));
      card.appendChild(avatar);
      card.appendChild(info);
      card.addEventListener('click', () => openTask(task.id));
      container.appendChild(card);
    });
  }

  function employeeCard(task) {
    const card = element('button', 'employee');
    const currentState = employeeState(task);
    card.dataset.state = currentState;
    card.dataset.agent = task.agentType;
    card.dataset.taskId = String(task.id);
    card.dataset.record = isRecordedTask(task) ? 'true' : 'false';
    const displayName = taskDisplayName(task);
    card.setAttribute('aria-label', `${displayName}，${taskStatusText(task)}`);
    const info = element('div', 'employeeInfo');
    const stage = element('span', 'employeeStage');
    stage.append(employeeSprite(task.agentType, Number(String(task.id).replace(/\D/g, '')) % 3));
    stage.append(element('span', 'employeeBubble', taskBubbleText(task, currentState)));
    card.appendChild(stage);
    info.appendChild(element('span', 'employeeName', displayName));
    info.appendChild(element('span', 'employeeSub', taskCardSummary(task)));
    info.appendChild(element('span', `stateChip ${currentState}`, `${agentNames[task.agentType] || task.agentType} · ${taskStatusText(task)}`));
    card.appendChild(info);
    card.addEventListener('click', () => openTask(task.id));
    return card;
  }

  function isRecordedTask(task) {
    const machine = state.machines.find(item => item.id === task.machineId);
    return !machine || machine.lastStatus !== 'online' || !checkTime(machine.lastCheckedAt);
  }

  function taskDisplayName(task) {
    const title = String(task.title || '未命名任务').trim();
    let normalized = title
      .replace(/^(?:Codex|Claude|Gemini)\s*·\s*/u, '')
      .replace(/\[Image:[^\]]*\]/giu, '图片输入')
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, '图片输入')
      .replace(/\s+/gu, ' ')
      .trim();
    if (/^\[Image:/iu.test(normalized)) normalized = '图片输入';
    return normalized || '未命名任务';
  }

  function taskCardSummary(task) {
    const source = String(task.workSummary || task.lastOutput || task.workspacePath || task.paneId || '');
    if (/\[Image:|!\[[^\]]*\]\([^)]*\)/u.test(`${task.title || ''}\n${source}`)) {
      return '收到一张图片输入，点击查看上下文。';
    }
    return source.trim() || '暂无工作摘要';
  }

  function taskBubbleText(task, currentState) {
    if (isRecordedTask(task)) return '上次';
    if (currentState === 'attention') return '举手';
    if (currentState === 'running') return '敲键盘';
    if (currentState === 'idle') return '空闲';
    return '记录';
  }

  function taskStatusText(task) {
    return `${isRecordedTask(task) ? '上次：' : ''}${statusText(task)}`;
  }

  function prioritizeTasks(tasks) {
    const rank = task => (task.requiredInput ? 0 : task.status === 'running' ? 2 : 4)
      + (isRecordedTask(task) ? 1 : 0);
    return tasks.slice().sort((left, right) => rank(left) - rank(right));
  }

  function loadCollapsedSprites() {
    try {
      const value = JSON.parse(localStorage.getItem('officeCollapseV2') || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (error) {
      return {};
    }
  }

  function isCollapsed(machineId) {
    return Boolean(state.collapsedSprites[String(machineId)]);
  }

  function toggleSprites(machineId) {
    const key = String(machineId);
    if (state.collapsedSprites[key]) delete state.collapsedSprites[key];
    else state.collapsedSprites[key] = true;
    try {
      localStorage.setItem('officeCollapseV2', JSON.stringify(state.collapsedSprites));
    } catch (error) {
      // Rendering still works if private storage is temporarily unavailable.
    }
    render();
  }

  function employeeState(task) {
    if (task.requiredInput) return 'attention';
    if (task.status === 'running') return 'running';
    if (task.status === 'idle') return 'idle';
    return 'finished';
  }

  function svgPixelNode() {
    return document.createElementNS('http://www.w3.org/2000/svg', 'svg');
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
      pi: { shirt: '#3f6b44', trim: '#315737' }
    };
    const palette = palettes[agentType] || { shirt: '#6d7f94', trim: '#546374' };
    const skin = '#f6d1ae';
    const outline = '#2f2a41';
    const hair = '#3b3348';
    const svg = svgPixelNode();
    svg.setAttribute('viewBox', '0 0 18 22');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('pixelAvatar');

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

  function machineSubtitle(machine) {
    return `${machine.username}@${machine.host}:${machine.port}`;
  }

  function machineToolsLabel(machine) {
    const tools = (machine.tools || []).map((tool) => agentNames[tool] || tool);
    if (!tools.length) return '';
    return tools.length <= 2 ? tools.join(' / ') : `${tools.slice(0, 2).join(' / ')} +${tools.length - 2}`;
  }

  function checkTime(value) {
    const date = new Date(value || '');
    if (!Number.isFinite(date.getTime())) return '';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function machineCheckText(machine) {
    const checked = checkTime(machine.lastCheckedAt);
    if (!checked) return '尚未检查 · 点击找任务';
    const status = machine.lastStatus === 'online' ? '上次连接正常'
      : machine.lastStatus === 'offline' ? '检查失败 · 保留旧记录' : '状态待确认';
    return `${status} · ${checked}`;
  }

  function statusText(task) {
    if (task.requiredInput) return '等待你输入';
    if (task.status === 'running') return '正在工作';
    if (task.status === 'idle') return '会话空闲';
    if (task.status === 'stopped') return '已停止';
    if (task.status === 'missing') return '已消失';
    return task.status || '未知';
  }

  function actionButton(label, handler, extra) {
    const button = element('button', `smallAction${extra ? ' ' + extra : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler();
    });
    return button;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  let busyCount = 0;
  function showBusy(text, network) {
    busyCount = Math.max(1, busyCount);
    $('busyText').textContent = text || '处理中…';
    $('busyNetwork').textContent = network || '';
    if (!network) $('busyElapsed').textContent = '';
    $('busy').classList.remove('hidden');
  }
  function hideBusy() {
    busyCount = Math.max(0, busyCount - 1);
    if (!busyCount) $('busy').classList.add('hidden');
  }

  function updateBusyElapsed(startedAt) {
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    $('busyElapsed').textContent = `已等待 ${elapsed} 秒`;
  }

  function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  let toastTimer = null;
  function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 2800);
  }

  window.phoneDebug = {
    loadStudio: () => loadStudio(),
    snapshot: () => ({
      studioLoading: state.studioLoading,
      studioModel: state.studio?.model || null,
      hub: state.studio?.hub || null,
      view: state.view
    })
  };

  loadState().then((ok) => {
    void loadStudio();
    const task = /^#task=([1-9]\d*)$/.exec(window.location.hash);
    if (ok && task && state.tasks.some(item => item.id === Number(task[1]))) {
      openTask(Number(task[1]));
    }
  });
})();
