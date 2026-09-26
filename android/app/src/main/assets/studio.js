(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const native = Boolean(window.AgentBridge);
  let token = '';
  let snapshot = null;
  let selectedMachine = null;
  let loading = false;
  let sending = false;
  let mutating = false;
  let generation = 0;
  let hub = { connected: false, deviceId: '', shareTasks: false };
  let reporting = false;
  const callbacks = new Map();
  const requestPrefix = `p${Date.now()}${Math.floor(Math.random() * 100000)}`;
  let requestSequence = 0;
  const shared = () => !native || hub.connected;
  window.studioHubResponse = (id, response) => {
    const callback = callbacks.get(id);
    if (!callback) return;
    callbacks.delete(id); clearTimeout(callback.timer);
    if (response.ok) callback.resolve(response.data);
    else callback.reject(new Error(response.error || 'Hub 请求失败'));
  };
  function hubCall(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = `${requestPrefix}-${++requestSequence}`;
      const timer = setTimeout(() => { callbacks.delete(id); reject(new Error('Hub 请求超时，结果未知；请刷新核对，勿重复操作。')); }, 160000);
      callbacks.set(id, { resolve, reject, timer });
      try { window.AgentBridge[method](id, ...args); }
      catch { clearTimeout(timer); callbacks.delete(id); reject(new Error('手机 Hub 接口不可用，请更新应用。')); }
    });
  }
  if (native && typeof window.AgentBridge.studioHubSettings === 'function') {
    try { hub = nativeCall('studioHubSettings'); } catch (error) { failure(error); }
  }
  const agents = { codex: 'Codex', 'claude-code': 'Claude Code', gemini: 'Gemini' };
  const finished = task => ['completed', 'cancelled'].includes(task.status);
  const attention = task => task.needsAttention ?? (!finished(task) && !['running', 'queued'].includes(task.status));
  const consoleUrl = native ? './phone.html' : './index.html';
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  try {
    localStorage.removeItem('asb.apiToken');
    sessionStorage.removeItem('asb.apiToken');
  } catch { /* Storage can be unavailable in private WebViews. Tokens remain in memory. */ }
  $('consoleLink').href = consoleUrl;
  function notice(text) { $('notice').textContent = text; }
  function failure(error) {
    $('errorBanner').textContent = error.message || '操作失败，请重试。';
    $('errorBanner').hidden = false;
  }
  function clearError() { $('errorBanner').hidden = true; $('errorBanner').textContent = ''; }
  function view(name) {
    document.querySelectorAll('.view').forEach(p => { p.hidden = p.id !== `view-${name}`; });
    document.querySelectorAll('[data-view]').forEach(b => {
      if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (matchMedia('(max-width:760px)').matches) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => view(b.dataset.view)));
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => view(b.dataset.go)));
  function dateLabel(value) {
    if (!value) return '未检查';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未知'
      : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function nativeCall(method, ...args) {
    const response = JSON.parse(window.AgentBridge[method](...args));
    if (!response.ok) throw new Error(response.error || '手机存储读取失败。');
    return response.data;
  }
  async function request(path, method = 'GET', body) {
    if (native) {
      if (!hub.connected) throw new Error('请先连接 Hub 管家。');
      return hubCall('beginStudioHubRequest', path.replace(/^\./, ''), method, body ? JSON.stringify(body) : '');
    }
    const response = await fetch(path, {
      method, cache: 'no-store',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(method === 'POST' ? 70_000 : 15_000),
    });
    if (response.status === 401) {
      $('connection').hidden = false;
      $('connectionToggle').setAttribute('aria-expanded', 'true');
      throw new Error('连接需要有效的 Hub API Token，请在连接设置中填写。');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
    return result;
  }
  function nativeSnapshot() {
    const data = nativeCall('studioState');
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
    const tasks = data.tasks.map(t => ({
      ...t, id: `S-${t.id}`, label: t.requiredInput ? '待输入'
        : ({ running: '执行中', idle: '空闲，待核实', stopped: '已停止', missing: '未发现' })[t.status] || '待核实',
      next: '进入手机控制台查看输出后处理。当前手机记录没有人工验收信息。',
      source: '手机 SSH 会话记录', completedToday: false,
      needsAttention: Boolean(t.requiredInput) || t.status !== 'running',
    }));
    return {
      generatedAt: new Date().toISOString(), date: day.format(new Date()),
      tomorrow: day.format(new Date(Date.now() + 86400000)), timeZone: 'Asia/Shanghai',
      scope: '当前手机的 SSH 记录与本机记忆；尚未同步到 Hub，未接入 Pi 模型。',
      model: { ready: false, label: 'Pi 未连接' }, machines: data.machines,
      tasks, memories: data.memories, messages: [],
      report: {
        completed: [], ongoing: tasks,
        suggestions: tasks.map(t => ({ taskId: t.id, title: t.title, next: t.next })),
      },
    };
  }
  async function load() {
    if (loading || mutating || sending || reporting) return;
    loading = true;
    const version = generation;
    $('refresh').disabled = true;
    $('refresh').textContent = '读取中';
    try {
      const data = shared() ? await request('./studio/state') : nativeSnapshot();
      if (version !== generation) return;
      snapshot = data;
      if (!data.machines.some(m => m.id === selectedMachine)) selectedMachine = data.machines[0]?.id ?? null;
      render();
      renderHubSettings();
      clearError();
    } catch (error) {
      if (version !== generation) return;
      failure(error);
      $('dateLabel').textContent = snapshot ? '刷新失败 · 以下是上次读取记录' : '尚未连接 · 无可用数据';
    } finally {
      loading = false; $('refresh').disabled = false; $('refresh').textContent = '刷新';
    }
  }
  function office(machine, preview) {
    const tasks = snapshot.tasks.filter(t => t.machineId === machine.id);
    const active = tasks.filter(t => !finished(t));
    const button = el('button', 'office');
    button.type = 'button';
    button.dataset.status = machine.status;
    button.dataset.attention = String(active.some(attention));
    button.setAttribute('aria-pressed', String(machine.id === selectedMachine));
    const head = el('div', 'office-head');
    const status = ({ online: '在线记录', offline: '离线记录', unknown: '未检查' })[machine.status] || '待核实';
    head.append(el('span', 'office-name', machine.name), el('span', 'office-status', status));
    const room = el('div', 'room'); room.setAttribute('aria-hidden', 'true');
    room.append(el('div', 'desk'));
    if (tasks.length) room.append(el('div', 'employee'));
    room.append(el('div', 'bubble', active.some(attention) ? '等你来看看' : active.length ? '工作记录中' : tasks.length ? '已结束跟踪' : '还没有员工'));
    const names = [...new Set(tasks.map(t => agents[t.agentType] || t.agentType))].join(' / ');
    button.append(head, room, el('div', 'office-foot', `${tasks.length} 位任务员工${names ? ` · ${names}` : ' · 尚未发现任务'}`));
    button.addEventListener('click', () => { selectedMachine = machine.id; renderOffices(); if (preview) view('town'); });
    return button;
  }
  function renderOffices() {
    $('officeList').replaceChildren();
    $('officePreview').replaceChildren();
    if (!snapshot.machines.length) {
      for (const id of ['officeList', 'officePreview']) {
        const empty = el('div', 'empty', '还没有接入办公室。');
        const link = el('a', 'quiet', '添加 / 管理机器'); link.href = consoleUrl;
        $(id).append(empty, link);
      }
    }
    snapshot.machines.forEach(m => {
      $('officeList').append(office(m, false));
      $('officePreview').append(office(m, true));
    });
    const machine = snapshot.machines.find(m => m.id === selectedMachine);
    $('selectedOffice').textContent = machine ? `${machine.name} 的员工` : '等待接入机器';
    const tools = (machine?.tools || []).map(t => agents[t] || t).join(' / ');
    $('machineFreshness').textContent = machine
      ? `已检测工具：${tools || '暂无检测记录'}。最近检查：${dateLabel(machine.lastSeenAt)}；刷新本页不会主动探测 SSH。` : '';
    const tasks = snapshot.tasks.filter(t => t.machineId === selectedMachine);
    $('taskList').replaceChildren();
    tasks.forEach(t => {
      const row = el('article', 'task-row');
      const portrait = el('div', 'task-portrait');
      portrait.dataset.attention = String(attention(t));
      portrait.setAttribute('aria-hidden', 'true');
      portrait.append(el('div', 'employee'));
      const content = el('div', 'task-content');
      const title = el('div', 'task-title');
      title.append(el('strong', '', t.title), el('small', '', t.label));
      content.append(title, el('div', 'source', `${t.id} · ${agents[t.agentType] || t.agentType} · ${t.source}`), el('p', '', t.next));
      const localTask = native && (!hub.connected || t.deviceId === hub.deviceId);
      const link = el(localTask || !native ? 'a' : 'span', 'text-button', native && !localTask ? '请在来源手机或 Web 控制台处理' : '进入控制台处理');
      if (localTask) link.href = `./phone.html#task=${t.localTaskId || t.id.slice(2)}`;
      else if (!native) link.href = consoleUrl;
      content.append(link);
      row.append(portrait, content);
      $('taskList').append(row);
    });
    if (machine && !tasks.length) $('taskList').append(el('p', 'empty', '这间办公室还没有任务，请在控制台发现会话或创建任务。'));
  }
  function renderMessages() {
    $('messages').replaceChildren();
    snapshot.messages.forEach(m => {
      if (m.role === 'user') { $('messages').append(el('div', 'user', m.content)); return; }
      const row = el('div', 'assistant');
      const body = el('div', 'assistant-body');
      body.append(el('p', 'byline', `Pi 管家 · ${dateLabel(m.createdAt)}`), el('p', 'message-content', m.content));
      row.append(el('span', 'avatar', 'π'), body); $('messages').append(row);
    });
  }
  function reportList(id, items, empty, suggestion) {
    $(id).replaceChildren();
    if (!items.length) { $(id).append(el('p', 'empty', empty)); return; }
    items.forEach(t => {
      const row = el('div', 'report-row');
      row.append(el('strong', '', t.title));
      if (suggestion) row.append(el('p', '', t.next), el('div', 'source', `${t.taskId} · 状态规则建议 · 未派发`));
      else row.append(el('div', 'source', `${t.id} · ${t.source} · ${t.label}`));
      $(id).append(row);
    });
  }
  function renderMemories() {
    $('memoryList').replaceChildren();
    if (!snapshot.memories.length) $('memoryList').append(el('p', 'empty', '还没有保存偏好。你确认一条，我再记住一条。'));
    snapshot.memories.forEach(m => {
      const row = el('div', 'memory'), text = el('div', '', m.content);
      text.append(el('small', '', `用户确认 · ${dateLabel(m.createdAt)}`));
      const button = el('button', 'text-button', '忘记');
      button.type = 'button'; button.setAttribute('aria-label', `忘记偏好：${m.content}`);
      button.addEventListener('click', async () => {
        if (mutating || loading) return;
        if (!window.confirm('确定忘记这条偏好吗？')) return;
        mutating = true;
        button.disabled = true;
        try {
          if (!shared()) nativeCall('deleteStudioMemory', m.id);
          else await request(`./studio/memories/${encodeURIComponent(m.id)}`, 'DELETE');
          snapshot.memories = snapshot.memories.filter(x => x.id !== m.id);
          renderMemories(); clearError(); notice('已删除这条偏好。既往对话中的内容不会一并删除。');
        } catch (error) { failure(error); button.disabled = false; }
        finally { mutating = false; }
      });
      row.append(text, button); $('memoryList').append(row);
    });
  }
  function render() {
    const pending = snapshot.tasks.filter(attention);
    const ongoing = snapshot.report.ongoing;
    $('modelLabel').textContent = snapshot.model.label;
    $('dateLabel').textContent = `${snapshot.date} · 北京时间 · ${shared() ? 'Hub 共享' : '手机本机'}记录`;
    $('scopeLabel').textContent = snapshot.scope;
    $('scopeAside').textContent = snapshot.scope;
    $('officeCount').textContent = `${snapshot.machines.length} 台机器`;
    $('townCount').textContent = `${snapshot.machines.length} 间办公室 · ${snapshot.tasks.length} 位任务员工`;
    $('attentionLine').textContent = pending.length ? `${pending.length} 项需要关注，点开查看` : '点击查看机器、任务和最近记录';
    $('brief').textContent = snapshot.tasks.length
      ? `今天有 ${snapshot.report.completed.length} 项任务有人工验收记录，${ongoing.length} 项仍未验收或需处理。`
      : '还没有工作记录。先到控制台接入机器、发现会话或创建任务，这里就能汇总大家的进展。';
    $('briefFacts').replaceChildren();
    [...snapshot.report.completed, ...pending, ...ongoing].filter((t, i, all) => all.findIndex(x => x.id === t.id) === i).slice(0, 3).forEach(t => {
      const li = el('li', '', `${t.title} · ${t.label}`);
      li.append(el('small', '', `${t.id} · ${t.source}`)); $('briefFacts').append(li);
    });
    $('pending').hidden = !pending.length;
    $('pendingText').textContent = pending.length ? `${pending[0].title}：${pending[0].next}` : '';
    $('send').disabled = !snapshot.model.ready || sending;
    $('chatInput').disabled = !snapshot.model.ready || sending;
    $('chatHint').textContent = snapshot.model.ready
      ? '发送时会将任务摘要、近期对话和已确认偏好交给配置的模型。不提供命令执行工具。'
      : !shared() ? '本机尚未连接 Hub 管家。请在「连接与模型」中接入。'
        : 'Pi 尚未配置。打开「连接与模型 → Pi 模型接入」保存配置，即可对话和生成任务规划。';
    $('memoryScope').textContent = !shared() ? '保存在这台手机的应用私有存储，尚未与 Hub 同步。' : '保存在 Hub；Web 和已连接的手机使用同一份记忆。';
    $('reportDate').textContent = `${snapshot.date} · Asia/Shanghai · 基于已保存记录`;
    $('tomorrowDate').textContent = snapshot.tomorrow;
    renderOffices(); renderMessages(); renderMemories();
    reportList('reportCompleted', snapshot.report.completed, native ? '手机记录尚无人工验收信息，不推断已完成。' : '今天还没有人工验收通过的记录。');
    reportList('reportOngoing', ongoing, '没有待跟踪任务。');
    reportList('reportNext', snapshot.report.suggestions, '暂时没有可依据的任务，请先创建任务。', true);
    $('reportPicker').replaceChildren();
    const dates = [...new Set([snapshot.date, ...(snapshot.reportHistory || []).map(r => r.date)])];
    dates.forEach(date => { const option = el('option', '', date === snapshot.date ? `${date} · 今天` : date); option.value = date; $('reportPicker').append(option); });
    renderDaily(snapshot.dailyReport);
    $('generateReport').disabled = !shared() || !snapshot.model.ready || reporting;
  }
  $('refresh').addEventListener('click', load);
  $('connectionToggle').addEventListener('click', async () => {
    $('connection').hidden = !$('connection').hidden;
    $('connectionToggle').setAttribute('aria-expanded', String(!$('connection').hidden));
    if (!$('connection').hidden && shared()) await loadModelSettings();
  });
  $('tokenForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (loading || sending || mutating || reporting) { notice('请等当前请求结束后再切换连接。'); return; }
    token = $('apiToken').value.trim(); $('apiToken').value = '';
    generation += 1; snapshot = null; selectedMachine = null;
    clearPrivateView();
    for (const id of ['messages', 'briefFacts', 'officeList', 'officePreview', 'taskList', 'memoryList', 'reportCompleted', 'reportOngoing', 'reportNext']) $(id).replaceChildren();
    $('pending').hidden = true; $('send').disabled = true; $('chatInput').value = ''; $('memoryInput').value = '';
    $('brief').textContent = '正在读取新连接…'; $('townCount').textContent = '正在读取办公室';
    $('attentionLine').textContent = '等待记录'; $('selectedOffice').textContent = '等待连接'; $('machineFreshness').textContent = '';
    await load();
    if (snapshot) await loadModelSettings();
  });
  $('chatForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (loading || sending || reporting || mutating || !snapshot?.model.ready) return;
    const content = $('chatInput').value.trim(); if (!content) return;
    sending = true; $('send').disabled = true; $('chatInput').disabled = true; $('send').textContent = '回复中';
    notice('Pi 正在整理回复，请稍候。');
    try {
      const result = await request('./studio/messages', 'POST', { content });
      snapshot.messages = result.messages; $('chatInput').value = ''; renderMessages(); clearError(); notice('回复已保存到 Hub。');
    } catch (error) { failure(error); notice('草稿已保留，未自动重试。'); }
    finally { sending = false; $('send').textContent = '发送'; $('send').disabled = !snapshot?.model.ready; $('chatInput').disabled = !snapshot?.model.ready; }
  });
  $('memoryForm').addEventListener('submit', async event => {
    event.preventDefault(); const content = $('memoryInput').value.trim();
    if (!content || !snapshot || loading || mutating || $('remember').disabled) return;
    mutating = true;
    $('remember').disabled = true;
    try {
      const result = !shared() ? nativeCall('addStudioMemory', content) : await request('./studio/memories', 'POST', { content });
      snapshot.memories.push(result.memory); $('memoryInput').value = ''; renderMemories(); clearError(); notice('已保存你确认的偏好。');
    } catch (error) { failure(error); }
    finally { mutating = false; $('remember').disabled = false; }
  });
  if (native) {
    $('tokenForm').hidden = true;
    $('hubForm').hidden = false;
    $('connection').querySelector('p:last-child').textContent = 'SSH 与公网配置仍在手机控制台管理。';
  }
  function renderDaily(report) {
    $('dailyReport').replaceChildren();
    if (!report) {
      $('dailyReport').append(el('p', 'empty', '这个日期还没有任务规划。接入模型后，Pi 会整理可执行、可验收的一句话事项。'));
      return;
    }
    $('dailyReport').append(el('p', 'byline', `${report.date} · ${report.model} · 生成于 ${dateLabel(report.generatedAt)}`),
      el('p', 'report-summary', report.content.summary));
    for (const [key, title] of [['completed', '已验收成果'], ['ongoing', '推进中的工作'], ['blockers', '阻塞与风险'], ['tomorrow', '明日优先事项'], ['decisions', '需要你决定']]) {
      if (!report.content[key]?.length) continue;
      const list = el('ul');
      for (const item of report.content[key]) {
        const row = el('li', '', item.text);
        row.append(el('span', 'source', item.taskIds.map(id => {
          const source = report.sources.find(s => s.id === id);
          return `${id} · ${source?.title || '记录'} · ${source?.source || ''}`;
        }).join('；') || '管家归纳 / 建议'));
        list.append(row);
      }
      $('dailyReport').append(el('h2', '', title), list);
    }
    $('dailyReport').append(el('p', 'footnote', `${report.coverage} 明日事项是建议，不会自动派发。`));
  }
  $('reportPicker').addEventListener('change', async () => {
    if (!shared() || reporting || mutating || loading) return;
    mutating = true;
    const date = $('reportPicker').value;
    $('generateReport').disabled = date !== snapshot.date || !snapshot.model.ready;
    $('reportPicker').disabled = true;
    try { const result = await request(`./studio/reports?date=${encodeURIComponent(date)}`); renderDaily(result.reports[0]); clearError(); }
    catch (error) { failure(error); $('dailyReport').replaceChildren(el('p', 'empty', '该日期任务规划读取失败，请重新选择日期重试。')); }
    finally { mutating = false; $('reportPicker').disabled = false; }
  });
  $('generateReport').addEventListener('click', async () => {
    if (!shared() || !snapshot?.model.ready || reporting || sending || mutating || loading) return;
    reporting = true; $('generateReport').disabled = true; $('reportPicker').disabled = true;
    $('generateReport').textContent = '正在生成规划…'; notice('正在分析任务、今日对话和用户偏好。生成成功后会保存一份新任务规划，旧版本保留。');
    try {
      const result = await request('./studio/reports', 'POST', { date: snapshot.date });
      snapshot.dailyReport = result.report; renderDaily(result.report); clearError(); notice('任务规划已保存，Web 和已连接的手机都可查看。');
    } catch (error) { failure(error); notice('没有替换旧任务规划，也没有自动重试。'); }
    finally { reporting = false; $('generateReport').disabled = !snapshot.model.ready; $('reportPicker').disabled = false; $('generateReport').textContent = '重新生成任务规划'; }
  });
  const providerUrls = { anthropic: 'https://api.anthropic.com', openrouter: 'https://openrouter.ai/api/v1', 'openai-compatible': 'https://api.openai.com/v1' };
  $('modelProvider').addEventListener('change', () => { $('modelBaseUrl').value = providerUrls[$('modelProvider').value]; $('modelKey').value = ''; $('modelStatus').textContent = '已更换提供商，请重新输入此地址使用的密钥。'; });
  async function loadModelSettings() {
    if (!shared()) return;
    const version = generation;
    try {
      const config = await request('./studio/model');
      if (version !== generation) return;
      $('modelEnabled').checked = config.enabled; $('modelProvider').value = config.provider;
      $('modelId').value = config.modelId; $('modelBaseUrl').value = config.baseUrl || providerUrls[config.provider];
      $('modelKey').value = ''; $('modelStatus').textContent = `${config.hasApiKey ? '已存密钥，不回显' : '尚未配置密钥'} · ${config.source === 'saved' ? 'Hub 保存配置' : '环境变量配置'}。修改后需保存；连接可单独测试。`;
    } catch (error) { if (version === generation) failure(error); }
  }
  const modelInput = () => ({ enabled: $('modelEnabled').checked, provider: $('modelProvider').value, modelId: $('modelId').value.trim(), baseUrl: $('modelBaseUrl').value.trim(), apiKey: $('modelKey').value.trim() });
  async function modelAction(testOnly) {
    if (!shared() || mutating || loading || sending || reporting) return;
    if (testOnly && !window.confirm('测试会向所填 API 地址发送密钥并产生一次模型调用，不发送工作记录。继续吗？')) return;
    mutating = true; $('saveModel').disabled = true; $('testModel').disabled = true;
    const input = modelInput();
    let succeeded = false;
    $('modelStatus').textContent = testOnly ? '正在测试模型…' : '正在保存…';
    try {
      await request(testOnly ? './studio/model/test' : './studio/model', testOnly ? 'POST' : 'PUT', input);
      succeeded = true;
      if (!testOnly) $('modelKey').value = '';
      $('modelStatus').textContent = testOnly ? '连接测试通过；此测试没有保存更改，请点击保存配置。' : '配置已加密保存并立即生效，无需重启 Hub。';
      clearError();
    } catch (error) { failure(error); $('modelStatus').textContent = '操作失败，未显示为成功，请检查输入后重试。'; }
    finally { mutating = false; $('saveModel').disabled = false; $('testModel').disabled = false; }
    if (!testOnly && succeeded) await load();
  }
  $('modelForm').addEventListener('submit', e => { e.preventDefault(); void modelAction(false); });
  $('testModel').addEventListener('click', () => { void modelAction(true); });
  function renderHubSettings() {
    if (!native) return;
    $('hubUrl').value = hub.baseUrl || ''; $('hubShare').checked = Boolean(hub.shareTasks); $('hubHttp').checked = Boolean(hub.allowLocalHttp);
    $('hubStatus').textContent = hub.connected ? '已连接 Hub：对话、记忆和任务规划共享。任务摘要仅在允许同步时上传。' : '尚未连接 Hub，当前只使用本机记录。';
    $('importMemories').disabled = !hub.connected;
    $('hubDisconnect').disabled = !hub.connected;
    $('modelDetails').hidden = !hub.connected;
  }
  $('hubForm').addEventListener('submit', async event => {
    event.preventDefault(); if (loading || mutating || sending || reporting) return;
    mutating = true; $('hubConnect').disabled = true;
    let succeeded = false;
    try {
      hub = await hubCall('beginStudioHubConnect', JSON.stringify({ baseUrl: $('hubUrl').value.trim(), token: $('hubToken').value.trim(), shareTasks: $('hubShare').checked, allowLocalHttp: $('hubHttp').checked }));
      succeeded = true;
      $('hubToken').value = ''; snapshot = null; generation++; clearPrivateView(); notice('已连接共享 Hub。');
    } catch (error) { failure(error); }
    finally { mutating = false; $('hubConnect').disabled = false; }
    if (succeeded) { renderHubSettings(); await load(); await loadModelSettings(); }
  });
  function clearPrivateView() {
    for (const id of ['messages', 'briefFacts', 'officeList', 'officePreview', 'taskList', 'memoryList', 'reportCompleted', 'reportOngoing', 'reportNext', 'dailyReport']) $(id).replaceChildren();
    $('modelKey').value = ''; $('chatInput').value = ''; $('memoryInput').value = ''; $('send').disabled = true; $('generateReport').disabled = true;
    $('modelId').value = ''; $('modelBaseUrl').value = ''; $('modelStatus').textContent = '请连接 Hub 后读取模型配置。';
    $('pending').hidden = true; $('brief').textContent = '正在读取连接…'; $('modelLabel').textContent = '读取中';
  }
  $('hubDisconnect').addEventListener('click', async () => {
    if (loading || sending || reporting || mutating || !window.confirm('仅断开这台手机；已上传到 Hub 的记录和记忆会保留。继续吗？')) return;
    try { nativeCall('disconnectStudioHub'); hub = { connected: false }; snapshot = null; generation++; clearPrivateView(); renderHubSettings(); await load(); }
    catch (error) { failure(error); }
  });
  $('importMemories').addEventListener('click', async () => {
    if (!hub.connected || mutating || loading || sending || reporting || !window.confirm('将本机确认过的偏好合并到当前 Hub？不会上传 SSH 凭据；重复合并不会重复创建已导入条目。')) return;
    mutating = true;
    let succeeded = false;
    try {
      const result = await request(`./studio/devices/${hub.deviceId}/memories`, 'POST', { memories: nativeCall('studioState').memories });
      succeeded = true;
      notice(`已合并 ${result.imported} 条本机偏好。`); clearError();
    } catch (error) { failure(error); }
    finally { mutating = false; }
    if (succeeded) await load();
  });
  renderHubSettings();
  $('chatInput').disabled = true;
  void load();
  setInterval(() => {
    if (document.hidden || !$('connection').hidden || document.activeElement?.matches('input,textarea,select')
        || $('chatInput').value.trim() || $('memoryInput').value.trim()
        || (snapshot && $('reportPicker').value !== snapshot.date)) return;
    void load();
  }, 30000);
})();
