import { createApiTokenState } from './api-token-state.js';
import { describeWork, selectWorkRows } from './work-status.js';
import { createCommandCenter } from './command-center.js';

class ApiResponseError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
  }
}

const mobileMedia = window.matchMedia('(max-width: 1080px)');
const apiTokenState = createApiTokenState({ localStorage, sessionStorage });
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('layout') === 'app' || mobileMedia.matches) {
  document.body.classList.add('appShell');
  document.querySelector('.brandTitle').textContent = '工作台';
}

const state = {
  actorId: localStorage.getItem('asb.actorId') || 'web-ui',
  approvals: [],
  butlerDoctor: null,
  butlerOverview: null,
  butlerServiceLogs: null,
  butlerServiceStatus: null,
  chatMessages: [],
  eventSource: null,
  lastEventId: '',
  health: null,
  gitStatus: null,
  gitDiff: null,
  machines: [],
  machinesLoaded: false,
  machinesError: false,
  notificationPermission:
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  selectedFilePath: '',
  selectedDiffPath: '',
  filePreview: null,
  refreshTimer: null,
  selectedManagedServer: localStorage.getItem('asb.selectedManagedServer') || '',
  selectedManagedServiceKey: localStorage.getItem('asb.selectedManagedServiceKey') || '',
  selectedName: localStorage.getItem('asb.selectedName') || '',
  sessions: [],
  sessionFilter: '',
  sheetOpen: false,
  snapshots: [],
  terminalCommands: [],
  voiceListening: false,
  voiceRecognition: null,
  workspaceBrowserPath: '',
  workspaceEntries: [],
  workFilter: 'all',
  workQuery: '',
  workLoaded: false,
  workError: '',
  workSyncedAt: null,
  approvalsLoaded: false,
  approvalsError: false,
  pendingApprovals: [],
  view: 'overview',
};

const elements = {
  agentTypeSelect: document.querySelector('#agentTypeSelect'),
  actorEcho: document.querySelector('#actorEcho'),
  actorInput: document.querySelector('#actorInput'),
  apiTokenInput: document.querySelector('#apiTokenInput'),
  approvalsList: document.querySelector('#approvalsList'),
  approvalsRefreshButton: document.querySelector('#approvalsRefreshButton'),
  butlerDoctorButton: document.querySelector('#butlerDoctorButton'),
  butlerExecButton: document.querySelector('#butlerExecButton'),
  butlerExecForm: document.querySelector('#butlerExecForm'),
  butlerExecInput: document.querySelector('#butlerExecInput'),
  butlerLogsButton: document.querySelector('#butlerLogsButton'),
  butlerPendingCount: document.querySelector('#butlerPendingCount'),
  butlerPreviewContent: document.querySelector('#butlerPreviewContent'),
  butlerPreviewTitle: document.querySelector('#butlerPreviewTitle'),
  butlerRefreshButton: document.querySelector('#butlerRefreshButton'),
  butlerRuntimeCount: document.querySelector('#butlerRuntimeCount'),
  butlerRuntimeList: document.querySelector('#butlerRuntimeList'),
  butlerServerCount: document.querySelector('#butlerServerCount'),
  butlerServerList: document.querySelector('#butlerServerList'),
  butlerServiceCount: document.querySelector('#butlerServiceCount'),
  butlerServiceList: document.querySelector('#butlerServiceList'),
  butlerServiceMeta: document.querySelector('#butlerServiceMeta'),
  butlerServiceStatusPill: document.querySelector('#butlerServiceStatusPill'),
  butlerServiceSummary: document.querySelector('#butlerServiceSummary'),
  butlerServiceTitle: document.querySelector('#butlerServiceTitle'),
  butlerStartButton: document.querySelector('#butlerStartButton'),
  butlerStatusButton: document.querySelector('#butlerStatusButton'),
  butlerStatusPill: document.querySelector('#butlerStatusPill'),
  butlerStopButton: document.querySelector('#butlerStopButton'),
  butlerRestartButton: document.querySelector('#butlerRestartButton'),
  chatComposerForm: document.querySelector('#chatComposerForm'),
  chatFeed: document.querySelector('#chatFeed'),
  chatInput: document.querySelector('#chatInput'),
  closeFiltersButton: document.querySelector('#closeFiltersButton'),
  conversationSessionPill: document.querySelector('#conversationSessionPill'),
  conversationStatusPill: document.querySelector('#conversationStatusPill'),
  conversationWorkspacePill: document.querySelector('#conversationWorkspacePill'),
  createSessionForm: document.querySelector('#createSessionForm'),
  currentCommandButton: document.querySelector('#currentCommandButton'),
  currentQuickButton: document.querySelector('#currentQuickButton'),
  healthBadge: document.querySelector('#healthBadge'),
  heroActor: document.querySelector('#heroActor'),
  heroSessionMeta: document.querySelector('#heroSessionMeta'),
  heroSessionTitle: document.querySelector('#heroSessionTitle'),
  heroStatus: document.querySelector('#heroStatus'),
  heroWorkspacePath: document.querySelector('#heroWorkspacePath'),
  inspectButton: document.querySelector('#inspectButton'),
  lastCompleted: document.querySelector('#lastCompleted'),
  listCommandButton: document.querySelector('#listCommandButton'),
  openFiltersButton: document.querySelector('#openFiltersButton'),
  machinesList: document.querySelector('#machinesList'),
  machinesRefreshButton: document.querySelector('#machinesRefreshButton'),
  notificationButton: document.querySelector('#notificationButton'),
  pwaStatus: document.querySelector('#pwaStatus'),
  refreshButton: document.querySelector('#refreshButton'),
  selectedBadge: document.querySelector('#selectedBadge'),
  selectedContext: document.querySelector('#selectedContext'),
  selectedDigest: document.querySelector('#selectedDigest'),
  workspaceCurrentPath: document.querySelector('#workspaceCurrentPath'),
  workspaceDiffContent: document.querySelector('#workspaceDiffContent'),
  workspaceDiffTitle: document.querySelector('#workspaceDiffTitle'),
  workspaceFilePreviewContent: document.querySelector('#workspaceFilePreviewContent'),
  workspaceFilePreviewTitle: document.querySelector('#workspaceFilePreviewTitle'),
  workspaceFilesList: document.querySelector('#workspaceFilesList'),
  workspaceGitBranch: document.querySelector('#workspaceGitBranch'),
  workspaceGitStatusList: document.querySelector('#workspaceGitStatusList'),
  workspaceRefreshButton: document.querySelector('#workspaceRefreshButton'),
  workspaceUpButton: document.querySelector('#workspaceUpButton'),
  selectedLastActive: document.querySelector('#selectedLastActive'),
  selectedMachineMeta: document.querySelector('#selectedMachineMeta'),
  selectedTitle: document.querySelector('#selectedTitle'),
  selectedWorkspaceMeta: document.querySelector('#selectedWorkspaceMeta'),
  sendButton: document.querySelector('#sendButton'),
  sessionMachineSelect: document.querySelector('#sessionMachineSelect'),
  sessionCount: document.querySelector('#sessionCount'),
  sessionFilterInput: document.querySelector('#sessionFilterInput'),
  sessionNameInput: document.querySelector('#sessionNameInput'),
  sessionsList: document.querySelector('#sessionsList'),
  sheetBackdrop: document.querySelector('#sheetBackdrop'),
  filterSheet: document.querySelector('#filterSheet'),
  sidebarLiveCount: document.querySelector('#sidebarLiveCount'),
  sidebarSelectedName: document.querySelector('#sidebarSelectedName'),
  sidebarSessionCount: document.querySelector('#sidebarSessionCount'),
  supervisorQuickButton: document.querySelector('#supervisorQuickButton'),
  stopButton: document.querySelector('#stopButton'),
  supervisorPill: document.querySelector('#supervisorPill'),
  tailQuickButton: document.querySelector('#tailQuickButton'),
  targetPill: document.querySelector('#targetPill'),
  tailButton: document.querySelector('#tailButton'),
  testNotificationButton: document.querySelector('#testNotificationButton'),
  terminalCommandsList: document.querySelector('#terminalCommandsList'),
  terminalForm: document.querySelector('#terminalForm'),
  terminalInput: document.querySelector('#terminalInput'),
  terminalRefreshButton: document.querySelector('#terminalRefreshButton'),
  terminalRiskHint: document.querySelector('#terminalRiskHint'),
  terminalRunButton: document.querySelector('#terminalRunButton'),
  inspectQuickButton: document.querySelector('#inspectQuickButton'),
  useButton: document.querySelector('#useButton'),
  voiceButton: document.querySelector('#voiceButton'),
  watchRunButton: document.querySelector('#watchRunButton'),
  workspaceInput: document.querySelector('#workspaceInput'),
};

const commandCenter = createCommandCenter({
  getState: () => state, apiGet, apiPost, selectSession, showView,
  getApiToken: () => apiTokenState.get(),
  refreshAll: () => refreshAll({ silent: true }),
});

elements.actorInput.value = state.actorId;
elements.apiTokenInput.value = apiTokenState.get();
elements.actorEcho.textContent = state.actorId;
elements.heroActor.textContent = state.actorId;

bindEvents();
showView('overview');
syncResponsiveChrome();
connectEventStream();
registerPwa();
syncNotificationStatus();
void refreshAll();

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view));
  });
  document.querySelectorAll('[data-work-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.workFilter = button.dataset.workFilter;
      renderWorkOverview();
    });
  });
  document.querySelector('#workSearch').addEventListener('input', (event) => {
    state.workQuery = event.target.value;
    renderWorkOverview();
  });
  document.querySelector('#newWorkButton').addEventListener('click', () => {
    document.querySelector('#createSessionDetails').open = true;
    setSheetOpen(true);
    elements.sessionNameInput.focus();
  });
  document.querySelector('#workInspectButton').addEventListener('click', () => {
    void runSupervisor();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSheetOpen(false);
  });
  elements.actorInput.addEventListener('input', () => {
    state.actorId = elements.actorInput.value.trim() || 'web-ui';
    localStorage.setItem('asb.actorId', state.actorId);
    elements.actorEcho.textContent = state.actorId;
    elements.heroActor.textContent = state.actorId;
  });

  elements.apiTokenInput.addEventListener('change', () => {
    apiTokenState.set(elements.apiTokenInput.value);
    commandCenter.reset();
    connectEventStream();
    void refreshAll();
  });

  elements.notificationButton.addEventListener('click', () => {
    void requestNotificationPermission();
  });

  elements.testNotificationButton.addEventListener('click', () => {
    void sendNotificationTest();
  });

  elements.sessionFilterInput.addEventListener('input', () => {
    state.sessionFilter = elements.sessionFilterInput.value.trim().toLowerCase();
    renderSessions();
  });

  elements.chatInput.addEventListener('input', autoResizeComposer);
  elements.chatInput.addEventListener('keydown', (event) => {
    if (event.isComposing) {
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleComposerSubmit();
    }
  });

  elements.openFiltersButton.addEventListener('click', () => {
    setSheetOpen(true);
  });

  elements.closeFiltersButton.addEventListener('click', () => {
    setSheetOpen(false);
  });

  elements.sheetBackdrop.addEventListener('click', () => {
    setSheetOpen(false);
  });

  elements.refreshButton.addEventListener('click', () => {
    appendMessage('system', '刷新', '正在刷新服务状态和会话列表...');
    void refreshAll();
  });

  elements.listCommandButton.addEventListener('click', () => {
    void runRawCommand('/list');
  });

  elements.currentCommandButton.addEventListener('click', () => {
    void runRawCommand('/current');
  });

  elements.currentQuickButton.addEventListener('click', () => {
    void runRawCommand('/current');
  });

  elements.watchRunButton.addEventListener('click', () => {
    void runSupervisor();
  });

  elements.workspaceRefreshButton.addEventListener('click', () => {
    void refreshWorkspacePanel();
  });

  elements.approvalsRefreshButton.addEventListener('click', () => {
    void refreshApprovals();
  });

  elements.machinesRefreshButton.addEventListener('click', () => {
    void refreshMachines();
  });

  elements.butlerRefreshButton.addEventListener('click', () => {
    void refreshButler();
  });

  elements.butlerStatusButton.addEventListener('click', () => {
    void refreshSelectedManagedServiceStatus();
  });

  elements.butlerLogsButton.addEventListener('click', () => {
    void refreshSelectedManagedServiceLogs();
  });

  elements.butlerDoctorButton.addEventListener('click', () => {
    void runSelectedManagedServerDoctor();
  });

  elements.butlerStartButton.addEventListener('click', () => {
    void requestManagedServiceAction('start');
  });

  elements.butlerStopButton.addEventListener('click', () => {
    void requestManagedServiceAction('stop');
  });

  elements.butlerRestartButton.addEventListener('click', () => {
    void requestManagedServiceAction('restart');
  });

  elements.terminalRefreshButton.addEventListener('click', () => {
    void refreshTerminalCommands();
  });

  elements.terminalForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitTerminalCommand();
  });

  elements.butlerExecForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitManagedServiceCommand();
  });

  elements.voiceButton.addEventListener('click', () => {
    toggleVoiceInput();
  });

  elements.workspaceUpButton.addEventListener('click', () => {
    if (!state.workspaceBrowserPath) {
      return;
    }

    state.workspaceBrowserPath = getParentWorkspacePath(state.workspaceBrowserPath);
    state.selectedFilePath = '';
    state.filePreview = null;
    void refreshWorkspacePanel();
  });

  elements.supervisorQuickButton.addEventListener('click', () => {
    void runSupervisor();
  });

  elements.useButton.addEventListener('click', () => {
    const session = requireSelectedSession();

    if (!session) {
      return;
    }

    void runRawCommand(`/use ${quoteArg(session.name)}`);
  });

  elements.inspectButton.addEventListener('click', () => {
    const session = requireSelectedSession();

    if (!session) {
      return;
    }

    void runRawCommand(`/inspect ${quoteArg(session.name)}`);
  });

  elements.inspectQuickButton.addEventListener('click', () => {
    const session = requireSelectedSession();

    if (!session) {
      return;
    }

    void runRawCommand(`/inspect ${quoteArg(session.name)}`);
  });

  elements.tailButton.addEventListener('click', () => {
    const session = requireSelectedSession();

    if (!session) {
      return;
    }

    void runRawCommand(`/tail ${quoteArg(session.name)}`);
  });

  elements.tailQuickButton.addEventListener('click', () => {
    const session = requireSelectedSession();

    if (!session) {
      return;
    }

    void runRawCommand(`/tail ${quoteArg(session.name)}`);
  });

  elements.stopButton.addEventListener('click', () => {
    const session = requireSelectedSession();

    if (!session) {
      return;
    }

    const shouldStop = window.confirm(`确认停止会话 "${session.name}" 吗？`);

    if (!shouldStop) {
      return;
    }

    void runRawCommand(`/stop ${quoteArg(session.name)}`, {
      afterSuccess: refreshAll,
    });
  });

  elements.createSessionForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const sessionName = elements.sessionNameInput.value.trim();
    const workspacePath = elements.workspaceInput.value.trim();
    const agentType = elements.agentTypeSelect.value || 'codex';
    const machineId = elements.sessionMachineSelect.value.trim();

    if (!sessionName || !workspacePath) {
      appendMessage('system', '创建失败', '请先填写会话名和工作目录。');
      return;
    }

    void createSession({
      agentType,
      machineId,
      sessionName,
      workspacePath,
    });
  });

  elements.chatComposerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void handleComposerSubmit();
  });

  mobileMedia.addEventListener('change', () => {
    syncResponsiveChrome();
  });

  window.addEventListener('online', () => {
    appendMessage('system', '网络恢复', '已重新联网，正在同步最新状态。');
    void refreshAll();
  });

  window.addEventListener('offline', () => {
    appendMessage('system', '离线模式', '当前网络离线，PWA 会尽量展示最近缓存。');
  });
}

async function handleComposerSubmit() {
  const rawInput = elements.chatInput.value.trim();

  if (!rawInput) {
    return;
  }

  elements.chatInput.value = '';
  autoResizeComposer();

  if (rawInput.startsWith('/')) {
    appendMessage('user', '命令', rawInput);
    await runRawCommand(rawInput, { silentUserEcho: true });
    return;
  }

  const session = requireSelectedSession();

  if (!session) {
    appendMessage('system', '未选择机器', '请先从左侧会话导航里选择一个目标会话。');
    return;
  }

  appendMessage('user', session.name, rawInput);

  try {
    const command = `/send ${quoteArg(session.name)} ${quoteArg(normalizePrompt(rawInput))}`;
    const payload = await apiPost('/command', {
      actorId: state.actorId,
      command,
    });

    appendMessage('assistant', '桥接器', payload.output || `已发送到 ${session.name}`);

    await refreshAll();
    void fetchTailAfterPrompt(session.name);
  } catch (error) {
    appendMessage('assistant', '执行失败', formatError(error));
  }
}

async function fetchTailAfterPrompt(sessionName) {
  await delay(1400);

  try {
    const payload = await apiPost('/command', {
      actorId: state.actorId,
      command: `/tail ${quoteArg(sessionName)}`,
    });

    if (payload.output && payload.output !== '(no output yet)') {
      appendMessage('assistant', `${sessionName} · 最近输出`, payload.output);
    }
  } catch (error) {
    appendMessage('system', '查看输出失败', formatError(error));
  }
}

async function refreshAll(options = {}) {
  if (!options.silent) {
    setBusy(true);
  }

  try {
    const health = await apiGet('/health');
    const sessionsPayload = await apiGet('/sessions');

    state.health = health;
    state.sessions = Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions : [];
    state.snapshots = Array.isArray(sessionsPayload.snapshots) ? sessionsPayload.snapshots : [];
    state.workLoaded = true;
    state.workError = '';
    state.workSyncedAt = new Date();

    if (state.selectedName && !state.sessions.some((session) => session.name === state.selectedName)) {
      state.selectedName = '';
      localStorage.removeItem('asb.selectedName');
      state.chatMessages = [];
    }

    render();

    if (state.selectedName && state.chatMessages.length === 0) {
      await hydrateSelectedSessionMessages();
    }

    await Promise.all([
      refreshApprovals({ silent: true }),
      refreshButler({ silent: true }),
      refreshMachines({ silent: true }),
      refreshTerminalCommands({ silent: true }),
      commandCenter.refresh(),
    ]);
    commandCenter.render();
    await refreshWorkspacePanel({ silent: options.silent });
  } catch (error) {
    const needsToken = error instanceof ApiResponseError && error.status === 401;
    state.workError = needsToken ? '需要访问令牌，请在左侧访问配置中输入 API Token。'
      : '无法连接服务。请检查后端是否启动，然后刷新。';
    if (needsToken) {
      state.sessions = [];
      state.snapshots = [];
      state.approvals = [];
      state.pendingApprovals = [];
      state.workLoaded = false;
      state.approvalsLoaded = false;
      document.querySelector('#accessDetails').open = true;
    }
    renderWorkOverview();
    commandCenter.invalidate(needsToken);
    setPillState(
      elements.healthBadge,
      needsToken ? 'warn' : 'danger',
      needsToken ? '需要 API Token' : '接口离线',
    );
    if (!options.silent) {
      appendMessage(
        'system',
        needsToken ? '需要 API Token' : '刷新失败',
        needsToken
          ? '请在访问配置中输入 Token。Token 仅保存在当前页面内存中。'
          : formatError(error),
      );
    }
  } finally {
    if (!options.silent) {
      setBusy(false);
    }
  }
}

async function runSupervisor() {
  appendMessage('system', '巡检', '正在执行一次 Supervisor 巡检...');

  try {
    const payload = await apiPost('/supervisor/run', {});
    await refreshAll();
    appendMessage('assistant', '巡检结果', renderJson(payload));
  } catch (error) {
    appendMessage('assistant', '巡检失败', formatError(error));
  }
}

async function runRawCommand(command, options = {}) {
  if (!options.silentUserEcho) {
    appendMessage('user', '命令', command);
  }

  try {
    const payload = await apiPost('/command', {
      actorId: state.actorId,
      command,
    });

    appendMessage('assistant', '桥接器', payload.output || '(empty)');

    if (options.afterSuccess) {
      await options.afterSuccess();
    } else {
      await refreshAll();
    }
  } catch (error) {
    appendMessage('assistant', '执行失败', formatError(error));
  }
}

async function createSession({ agentType, machineId, sessionName, workspacePath }) {
  appendMessage(
    'system',
    '创建会话',
    `正在创建 ${sessionName} · ${machineId || 'local'} · ${workspacePath}`,
  );

  try {
    const payload = machineId
      ? await apiPost(`/machines/${encodeURIComponent(machineId)}/spawn`, {
          actorId: state.actorId,
          agentType,
          name: sessionName,
          workspacePath,
        })
      : await apiPost('/sessions', {
          actorId: state.actorId,
          agentType,
          name: sessionName,
          workspacePath,
        });

    selectSession(payload.session.name);
    elements.sessionNameInput.value = '';
    appendMessage('assistant', '桥接器', `已创建会话 ${payload.session.name}`);
    await refreshAll();
  } catch (error) {
    appendMessage('assistant', '创建失败', formatError(error));
  }
}

async function sendNotificationTest() {
  try {
    const payload = await apiPost('/notifications/test', {
      actorId: state.actorId,
    });
    appendMessage(
      'system',
      '通知测试',
      `通知测试已触发，已投递 ${payload.result?.delivered ?? 0} 个 Feishu 目标。`,
    );
    notifyUser('ASB 通知测试', '浏览器通知链路正常');
    speakBrief('通知测试已发送');
  } catch (error) {
    appendMessage('assistant', '通知失败', formatError(error));
  }
}

function render() {
  const supervisor = state.health?.supervisor;

  setPillState(
    elements.healthBadge,
    state.health?.ok ? 'ok' : 'danger',
    state.health?.ok ? '接口正常' : '接口异常',
  );

  setPillState(
    elements.supervisorPill,
    supervisor?.enabled ? (supervisor.isRunning ? 'warn' : 'ok') : 'muted',
    supervisor?.enabled ? (supervisor.isRunning ? '巡检运行中' : '巡检已启用') : '巡检未启用',
  );

  elements.sessionCount.textContent = String(state.sessions.length);
  elements.sidebarSessionCount.textContent = String(state.sessions.length);
  elements.sidebarLiveCount.textContent = String(getLiveSessionsCount());
  elements.sidebarSelectedName.textContent = state.selectedName || '未选择';
  elements.lastCompleted.textContent = formatDate(supervisor?.lastCompletedAt);
  elements.actorEcho.textContent = state.actorId;
  elements.heroActor.textContent = state.actorId;

  renderSelectedSession();
  renderSessions();
  renderChatFeed();
  renderWorkspacePanel();
  renderApprovals();
  renderButler();
  renderMachines();
  renderTerminalCommands();
}

function renderSelectedSession() {
  const session = getSelectedSession();

  if (!session) {
    elements.selectedTitle.textContent = '未选择机器';
    elements.selectedContext.textContent = '未选择机器';
    elements.selectedMachineMeta.textContent = '未选择机器';
    elements.selectedWorkspaceMeta.textContent = '-';
    elements.selectedLastActive.textContent = '-';
    elements.selectedDigest.textContent = '-';
    elements.heroSessionTitle.textContent = '未选择会话';
    elements.heroSessionMeta.textContent = '先从左侧选一条线程，再开始对话、查看 diff 或处理审批。';
    elements.heroStatus.textContent = '未选择';
    elements.heroWorkspacePath.textContent = '-';
    setContextPill(elements.conversationSessionPill, '线程', '未选择');
    setContextPill(elements.conversationStatusPill, '状态', '待命');
    setContextPill(elements.conversationWorkspacePill, '目录', '-');
    setPillState(elements.selectedBadge, 'muted', '未选择');
    setPillState(elements.targetPill, 'muted', '未选择机器');
    elements.chatInput.placeholder = '输入消息，Enter 发送，Shift + Enter 换行';
    return;
  }

  const snapshot = findSnapshot(session.name);
  const work = describeWork(session, snapshot, state.pendingApprovals);
  const observed = work.observed;
  const label = `目标：${session.name}`;
  const activeText = formatDate(session.lastActiveAt);
  const digest = session.lastOutputDigest || snapshot?.note || '暂无输出摘要';

  elements.selectedTitle.textContent = session.name;
  elements.selectedContext.textContent = session.name;
  elements.selectedMachineMeta.textContent = `${session.name} · ${session.workspacePath}`;
  elements.selectedWorkspaceMeta.textContent = session.workspacePath;
  elements.selectedLastActive.textContent = activeText;
  elements.selectedDigest.textContent = digest;
  elements.heroSessionTitle.textContent = session.name;
  elements.heroSessionMeta.textContent = `最近活跃 ${activeText} · ${digest}`;
  elements.heroStatus.textContent = work.label;
  elements.heroWorkspacePath.textContent = session.workspacePath;
  setContextPill(elements.conversationSessionPill, '线程', session.name);
  setContextPill(elements.conversationStatusPill, '状态', work.label, badgeClass(observed));
  setContextPill(elements.conversationWorkspacePill, '目录', session.workspacePath);
  elements.chatInput.placeholder = `发送给 ${session.name}，Enter 发送`;

  setPillState(elements.selectedBadge, badgeClass(observed), work.label);
  setPillState(elements.targetPill, badgeClass(observed), label);
}

function showView(view) {
  state.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (mobileMedia.matches) setSheetOpen(false);
  commandCenter.render();
}

function workElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderWorkOverview() {
  const all = selectWorkRows(state.sessions, state.snapshots, state.pendingApprovals);
  const rows = selectWorkRows(state.sessions, state.snapshots, state.pendingApprovals, state.workFilter, state.workQuery);
  const setText = (id, value) => { document.getElementById(id).textContent = value; };
  setText('workTotal', state.workLoaded ? String(all.length) : '—');
  setText('workRunning', state.workLoaded ? String(all.filter(({ work }) => work.running).length) : '—');
  setText('workAttention', state.workLoaded ? String(all.filter(({ work }) => work.attention).length) : '—');
  setText('workPending', state.approvalsLoaded
    ? `${state.pendingApprovals.length}${state.pendingApprovals.length >= 200 ? '+' : ''}` : '—');
  setText('workResultCount', String(rows.length));
  const sync = document.querySelector('#workSyncLabel');
  sync.classList.toggle('isStale', Boolean(state.workError || state.approvalsError));
  sync.textContent = state.workError
    ? `${state.workError}${state.workLoaded ? ' 当前显示上次同步数据。' : ''}`
    : state.approvalsError ? '审批加载失败，审批标记可能不是最新状态。'
      : state.workSyncedAt ? `最近同步 ${state.workSyncedAt.toLocaleTimeString()} · 事件驱动更新`
        : '正在连接本机服务…';
  document.querySelectorAll('[data-work-filter]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.workFilter === state.workFilter));
  });
  const tbody = document.querySelector('#workTableBody');
  tbody.replaceChildren();
  for (const { session, work } of rows) {
    const row = workElement('tr', session.name === state.selectedName ? 'selectedWork' : '');
    const nameCell = workElement('td', 'workIdentity');
    const nameButton = workElement('button', 'workName', session.name);
    nameButton.type = 'button';
    nameButton.addEventListener('click', () => selectSession(session.name));
    const path = workElement('span', 'workPath', session.workspacePath);
    path.title = session.workspacePath;
    nameCell.append(nameButton, path);
    const statusCell = workElement('td', 'workState');
    statusCell.append(
      workElement('span', `workStatus ${work.group}`, work.label),
      workElement('span', 'workAgent', session.agentType || 'codex'),
    );
    const outputCell = workElement('td', 'workOutput');
    const digest = workElement('p', 'workDigest', work.digest);
    digest.title = work.digest;
    outputCell.append(digest);
    if (work.pending) {
      const approvalButton = workElement('button', 'approvalLink', `${work.pending} 项待审批 →`);
      approvalButton.type = 'button';
      approvalButton.addEventListener('click', () => showView('approvals'));
      outputCell.append(approvalButton);
    }
    const timeCell = workElement('td', 'workTime', formatCompactDate(session.lastActiveAt));
    timeCell.title = formatDate(session.lastActiveAt);
    const actionCell = workElement('td', 'workAction');
    const open = workElement('button', 'textBtn', '打开 ↗');
    open.type = 'button';
    open.setAttribute('aria-label', `打开会话 ${session.name}`);
    open.addEventListener('click', () => selectSession(session.name));
    actionCell.append(open);
    row.append(nameCell, statusCell, outputCell, timeCell, actionCell);
    tbody.append(row);
  }
  const empty = document.querySelector('#workEmpty');
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    const title = !state.workLoaded
      ? state.workError ? '服务尚未连接' : '正在读取工作情况'
      : all.length ? '没有匹配的工作' : '还没有工作会话';
    const copy = !state.workLoaded
      ? state.workError || '连接后，会话状态与最近输出会显示在这里。'
      : all.length ? '试试其他状态，或调整搜索关键词。'
        : '点击「新建会话」，选择 Agent 和工作目录，开始第一项工作。';
    empty.querySelector('h3').textContent = title;
    empty.querySelector('p').textContent = copy;
  }
}

function renderSessions() {
  renderWorkOverview();
  elements.sessionsList.replaceChildren();

  const sessions = getFilteredSessions();

  if (sessions.length === 0) {
    elements.sessionsList.className = 'sessionsList empty';
    elements.sessionsList.textContent = '没有匹配到会话。';
    return;
  }

  elements.sessionsList.className = 'sessionsList';

  for (const session of sessions) {
    const snapshot = findSnapshot(session.name);
    const work = describeWork(session, snapshot, state.pendingApprovals);
    const observed = work.observed;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sessionCard ${session.name === state.selectedName ? 'active' : ''}`;
    button.dataset.tone = badgeClass(observed);
    button.addEventListener('click', () => {
      selectSession(session.name);

      if (mobileMedia.matches) {
        setSheetOpen(false);
      }
    });

    const head = document.createElement('div');
    head.className = 'sessionHead';

    const name = document.createElement('div');
    name.className = 'sessionName';
    name.textContent = session.name;

    const badges = document.createElement('div');
    badges.className = 'sessionBadges';
    badges.append(createMiniPill(work.label));

    if (session.defaultForActor) {
      badges.append(createMiniPill('当前', true));
    }

    head.append(name, badges);

    const workspace = document.createElement('div');
    workspace.className = 'sessionPath';
    workspace.textContent = session.workspacePath;

    const meta = document.createElement('div');
    meta.className = 'sessionMeta';
    meta.textContent = `${formatCompactDate(session.lastActiveAt)} · ${observed}`;

    const digest = document.createElement('div');
    digest.className = 'sessionDigest';
    digest.textContent = session.lastOutputDigest || snapshot?.note || '暂无输出摘要';

    button.append(head, workspace, meta, digest);
    elements.sessionsList.append(button);
  }
}

function renderChatFeed() {
  elements.chatFeed.replaceChildren();

  if (state.chatMessages.length === 0) {
    elements.chatFeed.append(createEmptyState());
    return;
  }

  for (const item of state.chatMessages) {
    const article = document.createElement('article');
    article.className = `message ${item.role}`;

    const avatar = document.createElement('div');
    avatar.className = 'messageAvatar';
    avatar.textContent = avatarLabel(item.role);

    const body = document.createElement('div');
    body.className = 'messageBody';

    const header = document.createElement('div');
    header.className = 'messageHeader';
    header.textContent = `${item.title} · ${item.time}`;

    const bubble = document.createElement('div');
    bubble.className = 'messageBubble';
    bubble.textContent = item.content;

    body.append(header, bubble);
    article.append(avatar, body);
    elements.chatFeed.append(article);
  }

  elements.chatFeed.scrollTop = elements.chatFeed.scrollHeight;
}

function createEmptyState() {
  const wrapper = document.createElement('div');
  wrapper.className = 'emptyState';

  const card = document.createElement('section');
  card.className = 'emptyStateCard';

  const title = document.createElement('h3');
  title.className = 'emptyStateTitle';
  title.textContent = state.selectedName ? `准备开始：${state.selectedName}` : '先选一条线程开始';

  const copy = document.createElement('p');
  copy.className = 'emptyStateCopy';
  copy.textContent = state.selectedName
    ? '当前工作区已经就绪。直接在下方输入 prompt，或者先执行 /inspect /tail 了解上下文。'
    : '从左侧线程列表选择一个会话，或者新建一个会话后，再把自然语言 prompt 发给它。';

  const shortcuts = document.createElement('div');
  shortcuts.className = 'shortcutGrid';
  shortcuts.append(
    createShortcutButton('/list', () => runRawCommand('/list')),
    createShortcutButton('/current', () => runRawCommand('/current')),
    createShortcutButton('/watch run', () => runSupervisor()),
  );

  if (state.selectedName) {
    shortcuts.append(
      createShortcutButton('/inspect', () => runRawCommand(`/inspect ${quoteArg(state.selectedName)}`)),
      createShortcutButton('/tail', () => runRawCommand(`/tail ${quoteArg(state.selectedName)}`)),
    );
  }

  card.append(title, copy, shortcuts);
  wrapper.append(card);
  return wrapper;
}

function createShortcutButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'shortcutBtn';
  button.textContent = label;
  button.addEventListener('click', () => {
    void onClick();
  });
  return button;
}

function appendMessage(role, title, content) {
  state.chatMessages.push({
    content,
    role,
    time: new Date().toLocaleTimeString(),
    title,
  });

  if (state.chatMessages.length > 80) {
    state.chatMessages = state.chatMessages.slice(-80);
  }

  renderChatFeed();
}

function selectSession(sessionName) {
  state.selectedName = sessionName;
  state.chatMessages = [];
  state.filePreview = null;
  state.gitDiff = null;
  state.gitStatus = null;
  state.terminalCommands = [];
  state.selectedDiffPath = '';
  state.selectedFilePath = '';
  state.workspaceBrowserPath = '';
  state.workspaceEntries = [];
  localStorage.setItem('asb.selectedName', sessionName);
  showView('conversation');
  renderSelectedSession();
  renderSessions();
  renderChatFeed();
  renderWorkspacePanel();
  renderTerminalCommands();
  void hydrateSelectedSessionMessages(true);
  void refreshWorkspacePanel({ silent: true });
  void refreshTerminalCommands({ silent: true });
}

function setSheetOpen(isOpen) {
  state.sheetOpen = isOpen;
  syncResponsiveChrome();
}

function syncResponsiveChrome() {
  if (document.body.classList.contains('appShell')) {
    elements.filterSheet.classList.remove('hidden');
    elements.sheetBackdrop.classList.add('hidden');
  } else if (mobileMedia.matches) {
    elements.filterSheet.classList.toggle('hidden', !state.sheetOpen);
    elements.sheetBackdrop.classList.toggle('hidden', !state.sheetOpen);
  } else {
    elements.filterSheet.classList.remove('hidden');
    elements.sheetBackdrop.classList.add('hidden');
  }
}

function autoResizeComposer() {
  const textarea = elements.chatInput;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

function getFilteredSessions() {
  if (!state.sessionFilter) {
    return state.sessions;
  }

  return state.sessions.filter((session) => {
    const haystack = `${session.name} ${session.workspacePath}`.toLowerCase();
    return haystack.includes(state.sessionFilter);
  });
}

function createMiniPill(label, active = false) {
  const pill = document.createElement('span');
  pill.className = `miniPill ${active ? 'active' : ''}`;
  pill.textContent = label;
  return pill;
}

function avatarLabel(role) {
  if (role === 'user') {
    return '你';
  }

  if (role === 'assistant') {
    return '桥';
  }

  if (role === 'system') {
    return '系';
  }

  if (role === 'approval') {
    return '审';
  }

  if (role === 'tool') {
    return '工';
  }

  return '•';
}

function findSnapshot(sessionName) {
  return state.snapshots.find((snapshot) => snapshot?.session?.name === sessionName) || null;
}

function getSelectedSession() {
  return state.sessions.find((session) => session.name === state.selectedName) || null;
}

function getManagedServers() {
  return Array.isArray(state.butlerOverview?.managedServers) ? state.butlerOverview.managedServers : [];
}

function getManagedServices(serverName = state.selectedManagedServer) {
  const server = getManagedServers().find((item) => item.name === serverName);
  return Array.isArray(server?.projects) ? server.projects : [];
}

function getSelectedManagedServer() {
  return getManagedServers().find((server) => server.name === state.selectedManagedServer) || null;
}

function getSelectedManagedService() {
  const [serverName = '', projectName = ''] = state.selectedManagedServiceKey.split(':');
  return (
    getManagedServers()
      .find((server) => server.name === serverName)
      ?.projects?.find((project) => project.projectName === projectName) || null
  );
}

function getSelectedManagedServiceStatus() {
  const service = getSelectedManagedService();

  if (!service) {
    return null;
  }

  if (
    state.butlerServiceStatus &&
    state.butlerServiceStatus.serverName === service.serverName &&
    state.butlerServiceStatus.projectName === service.projectName
  ) {
    return state.butlerServiceStatus;
  }

  return service.lastStatus || null;
}

function requireSelectedManagedService(silent = false) {
  const service = getSelectedManagedService();

  if (!service && !silent) {
    appendMessage('system', '未选择服务', '请先在 Butler 区域选择一个服务。');
  }

  return service;
}

function requireSelectedSession() {
  const session = getSelectedSession();

  if (!session) {
    appendMessage('system', '未选择机器', '请先从左侧会话导航里选择一个目标会话。');
    return null;
  }

  return session;
}

function selectManagedServer(serverName) {
  state.selectedManagedServer = serverName;
  localStorage.setItem('asb.selectedManagedServer', serverName);
  state.butlerDoctor = null;

  const services = getManagedServices(serverName);
  const currentService = getSelectedManagedService();

  if (!currentService || currentService.serverName !== serverName) {
    if (services[0]) {
      state.selectedManagedServiceKey = `${serverName}:${services[0].projectName}`;
      localStorage.setItem('asb.selectedManagedServiceKey', state.selectedManagedServiceKey);
    } else {
      state.selectedManagedServiceKey = '';
      localStorage.removeItem('asb.selectedManagedServiceKey');
    }
  }

  renderButler();

  if (getSelectedManagedService()) {
    void refreshSelectedManagedServiceStatus({ silent: true });
    void refreshSelectedManagedServiceLogs(160, { silent: true });
  }
}

function selectManagedService(serverName, projectName) {
  state.selectedManagedServer = serverName;
  state.selectedManagedServiceKey = `${serverName}:${projectName}`;
  state.butlerDoctor = null;
  localStorage.setItem('asb.selectedManagedServer', serverName);
  localStorage.setItem('asb.selectedManagedServiceKey', state.selectedManagedServiceKey);
  renderButler();
  void refreshSelectedManagedServiceStatus({ silent: true });
  void refreshSelectedManagedServiceLogs(160, { silent: true });
}

function updateManagedServiceStatusCache(status) {
  const servers = getManagedServers();

  for (const server of servers) {
    if (server.name !== status.serverName || !Array.isArray(server.projects)) {
      continue;
    }

    for (const project of server.projects) {
      if (project.projectName === status.projectName) {
        project.lastStatus = status;
      }
    }
  }
}

function setManagedControlsDisabled(isDisabled) {
  [
    elements.butlerDoctorButton,
    elements.butlerExecButton,
    elements.butlerLogsButton,
    elements.butlerRestartButton,
    elements.butlerStartButton,
    elements.butlerStatusButton,
    elements.butlerStopButton,
  ].forEach((control) => {
    if (control) {
      control.disabled = isDisabled;
    }
  });

  if (elements.butlerExecInput) {
    elements.butlerExecInput.disabled = isDisabled;
  }
}

async function apiGet(pathname) {
  return api(pathname, { method: 'GET' });
}

async function apiPost(pathname, body) {
  return api(pathname, {
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
}

async function api(pathname, options) {
  const headers = new Headers(options.headers || {});

  const apiToken = apiTokenState.get();
  if (apiToken) {
    headers.set('Authorization', `Bearer ${apiToken}`);
  }

  const response = await fetch(pathname, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('Content-Type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? payload.error
        : `HTTP ${response.status}`;
    throw new ApiResponseError(response.status, String(message));
  }

  return payload;
}

async function hydrateSelectedSessionMessages(force = false) {
  if (!state.selectedName) {
    return;
  }

  if (!force && state.chatMessages.length > 0) {
    return;
  }

  try {
    const payload = await apiGet(`/sessions/${encodeURIComponent(state.selectedName)}/messages?limit=80`);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    state.chatMessages = messages.map(mapPersistedMessage);
    renderChatFeed();
  } catch (error) {
    appendMessage('system', '历史加载失败', formatError(error));
  }
}

async function refreshWorkspacePanel(options = {}) {
  if (!state.selectedName) {
    state.workspaceEntries = [];
    state.gitStatus = null;
    state.selectedFilePath = '';
    state.filePreview = null;
    renderWorkspacePanel();
    return;
  }

  try {
    const [listing, gitStatus] = await Promise.all([
      apiGet(
        `/sessions/${encodeURIComponent(state.selectedName)}/files?path=${encodeURIComponent(
          state.workspaceBrowserPath,
        )}`,
      ),
      apiGet(`/sessions/${encodeURIComponent(state.selectedName)}/git/status`),
    ]);

    state.workspaceEntries = Array.isArray(listing.entries) ? listing.entries : [];
    state.workspaceBrowserPath = typeof listing.path === 'string' ? listing.path : '';
    state.gitStatus = gitStatus;

    if (
      state.selectedFilePath &&
      !state.workspaceEntries.some(
        (entry) => entry.path === state.selectedFilePath && !entry.isDirectory,
      )
    ) {
      state.selectedFilePath = '';
      state.filePreview = null;
    }

    if (!state.selectedFilePath) {
      const firstFile = state.workspaceEntries.find((entry) => !entry.isDirectory);

      if (firstFile) {
        state.selectedFilePath = firstFile.path;
      }
    }

    if (state.selectedFilePath) {
      await loadFilePreview(state.selectedFilePath, { silent: true });
    } else {
      state.filePreview = null;
    }

    if (
      !state.selectedDiffPath &&
      gitStatus?.available &&
      Array.isArray(gitStatus.entries) &&
      gitStatus.entries[0]?.path
    ) {
      await loadGitDiff(gitStatus.entries[0].path, { silent: true });
    } else if (!gitStatus?.available || gitStatus?.clean) {
      state.gitDiff = null;
      state.selectedDiffPath = '';
    } else if (state.selectedDiffPath) {
      await loadGitDiff(state.selectedDiffPath, { silent: true });
    }

    renderWorkspacePanel();
  } catch (error) {
    if (!options.silent) {
      appendMessage('system', 'Workspace 加载失败', formatError(error));
    }
  }
}

async function loadFilePreview(relativePath, options = {}) {
  if (!state.selectedName || !relativePath) {
    state.filePreview = null;
    renderWorkspacePanel();
    return;
  }

  try {
    const preview = await apiGet(
      `/sessions/${encodeURIComponent(state.selectedName)}/file?path=${encodeURIComponent(
        relativePath,
      )}`,
    );
    state.selectedFilePath = relativePath;
    state.filePreview = preview;
    renderWorkspacePanel();
  } catch (error) {
    if (!options.silent) {
      appendMessage('system', '文件预览失败', formatError(error));
    }
  }
}

async function loadGitDiff(relativePath = '', options = {}) {
  if (!state.selectedName) {
    state.gitDiff = null;
    state.selectedDiffPath = '';
    renderWorkspacePanel();
    return;
  }

  try {
    const query = relativePath ? `?path=${encodeURIComponent(relativePath)}` : '';
    const diff = await apiGet(
      `/sessions/${encodeURIComponent(state.selectedName)}/git/diff${query}`,
    );
    state.selectedDiffPath = relativePath || '';
    state.gitDiff = diff;
    renderWorkspacePanel();
  } catch (error) {
    if (!options.silent) {
      appendMessage('system', 'Diff 加载失败', formatError(error));
    }
  }
}

async function refreshApprovals(options = {}) {
  try {
    const [payload, pendingPayload] = await Promise.all([
      apiGet('/approvals?status=all&limit=30'),
      apiGet('/approvals?status=pending&limit=200'),
    ]);
    state.pendingApprovals = Array.isArray(pendingPayload.approvals) ? pendingPayload.approvals : [];
    const recent = Array.isArray(payload.approvals) ? payload.approvals : [];
    state.approvals = [...new Map([...state.pendingApprovals, ...recent].map((item) => [item.id, item])).values()];
    state.approvalsLoaded = true;
    state.approvalsError = false;
    renderApprovals();
  } catch (error) {
    state.approvalsError = true;
    renderWorkOverview();
    if (!options.silent) {
      appendMessage('system', '审批加载失败', formatError(error));
    }
  }
}

async function resolveApproval(id, action) {
  try {
    const payload = await apiPost(`/approvals/${id}/${action}`, {
      actorId: state.actorId,
    });
    const label = action === 'approve' ? '已批准' : '已拒绝';
    appendMessage('system', '审批处理', `${label} #${id}`);
    notifyUser('审批已处理', `${label} #${id}`);
    speakBrief(`${label} ${id}`);
    await refreshApprovals({ silent: true });
    await refreshAll({ silent: true });
    return payload;
  } catch (error) {
    appendMessage('assistant', '审批失败', formatError(error));
    return null;
  }
}

async function refreshMachines(options = {}) {
  try {
    const payload = await apiGet('/machines');
    state.machines = Array.isArray(payload.machines) ? payload.machines : [];
    state.machinesLoaded = true;
    state.machinesError = false;
    renderMachines();
  } catch (error) {
    state.machinesError = true;
    commandCenter.render();
    if (!options.silent) {
      appendMessage('system', '机器加载失败', formatError(error));
    }
  }
}

async function refreshButler(options = {}) {
  try {
    state.butlerOverview = await apiGet('/butler/overview');
    normalizeButlerSelection();
    renderButler();

    if (getSelectedManagedService() && !getSelectedManagedServiceStatus()) {
      void refreshSelectedManagedServiceStatus({ silent: true });
    }
  } catch (error) {
    if (!options.silent) {
      appendMessage('system', 'Butler 加载失败', formatError(error));
    }
  }
}

async function refreshTerminalCommands(options = {}) {
  if (!state.selectedName) {
    state.terminalCommands = [];
    renderTerminalCommands();
    return;
  }

  try {
    const payload = await apiGet(
      `/sessions/${encodeURIComponent(state.selectedName)}/terminal/commands?limit=20`,
    );
    state.terminalCommands = Array.isArray(payload.commands) ? payload.commands : [];
    renderTerminalCommands();
  } catch (error) {
    if (!options.silent) {
      appendMessage('system', '终端历史加载失败', formatError(error));
    }
  }
}

async function refreshSelectedManagedServiceStatus(options = {}) {
  const service = requireSelectedManagedService(options.silent);

  if (!service) {
    return;
  }

  try {
    const status = await apiGet(
      `/butler/services/${encodeURIComponent(service.serverName)}/${encodeURIComponent(
        service.projectName,
      )}/status`,
    );
    state.butlerServiceStatus = status;
    updateManagedServiceStatusCache(status);
    renderButler();
  } catch (error) {
    if (!options.silent) {
      appendMessage('assistant', '服务状态失败', formatError(error));
    }
  }
}

async function refreshSelectedManagedServiceLogs(lines = 160, options = {}) {
  const service = requireSelectedManagedService(options.silent);

  if (!service) {
    return;
  }

  try {
    const logs = await apiGet(
      `/butler/services/${encodeURIComponent(service.serverName)}/${encodeURIComponent(
        service.projectName,
      )}/logs?lines=${encodeURIComponent(String(lines))}`,
    );
    state.butlerServiceLogs = logs;
    renderButler();
  } catch (error) {
    if (!options.silent) {
      appendMessage('assistant', '服务日志失败', formatError(error));
    }
  }
}

async function runSelectedManagedServerDoctor() {
  const server = getSelectedManagedServer();

  if (!server) {
    appendMessage('system', '未选择服务器', '请先在 Butler 区域选择一个服务器。');
    return;
  }

  try {
    state.butlerDoctor = await apiGet(
      `/butler/servers/${encodeURIComponent(server.name)}/doctor`,
    );
    renderButler();
    appendMessage('system', 'Butler 诊断', `已完成 ${server.name} 的连通性检查。`);
  } catch (error) {
    appendMessage('assistant', '诊断失败', formatError(error));
  }
}

async function requestManagedServiceAction(action) {
  const service = requireSelectedManagedService();

  if (!service) {
    return;
  }

  try {
    const payload = await apiPost(
      `/butler/services/${encodeURIComponent(service.serverName)}/${encodeURIComponent(
        service.projectName,
      )}/actions/${encodeURIComponent(action)}`,
      {
        actorId: state.actorId,
      },
    );
    appendMessage(
      'approval',
      'Butler 审批',
      `${renderManagedActionLabel(action)} 已进入审批：${service.serverName}/${service.projectName}\n审批 #${payload.approval?.id ?? '-'}`,
    );
    notifyUser('Butler 动作待审批', `${service.projectName} · ${renderManagedActionLabel(action)}`);
    await Promise.all([
      refreshApprovals({ silent: true }),
      refreshButler({ silent: true }),
    ]);
  } catch (error) {
    appendMessage('assistant', 'Butler 动作失败', formatError(error));
  }
}

async function submitManagedServiceCommand() {
  const service = requireSelectedManagedService();
  const command = elements.butlerExecInput.value.trim();

  if (!service || !command) {
    return;
  }

  elements.butlerExecInput.value = '';

  try {
    const payload = await apiPost(
      `/butler/services/${encodeURIComponent(service.serverName)}/${encodeURIComponent(
        service.projectName,
      )}/exec`,
      {
        actorId: state.actorId,
        command,
      },
    );

    if (payload.requiresApproval) {
      appendMessage(
        'approval',
        'Butler 审批',
        `远程命令需要审批：${command}\n审批 #${payload.approval?.id ?? '-'}`,
      );
      notifyUser('Butler 远程命令待审批', command);
      await Promise.all([
        refreshApprovals({ silent: true }),
        refreshButler({ silent: true }),
      ]);
      return;
    }

    state.butlerDoctor = null;
    state.butlerServiceLogs = {
      content: payload.result?.rawOutput || '(empty)',
      fetchedAt: payload.result?.executedAt || new Date().toISOString(),
      lines: 0,
      projectName: service.projectName,
      serverName: service.serverName,
    };
    renderButler();
    appendMessage('tool', 'Butler 执行', `已执行：${command}`);
  } catch (error) {
    appendMessage('assistant', 'Butler 执行失败', formatError(error));
  }
}

async function submitTerminalCommand() {
  const session = requireSelectedSession();
  const command = elements.terminalInput.value.trim();

  if (!session || !command) {
    return;
  }

  elements.terminalInput.value = '';
  elements.terminalRiskHint.textContent = '正在提交命令...';

  try {
    const payload = await apiPost(
      `/sessions/${encodeURIComponent(session.name)}/terminal/commands`,
      {
        actorId: state.actorId,
        command,
      },
    );

    if (payload.requiresApproval) {
      const approvalId = payload.approval?.id;
      appendMessage(
        'approval',
        '终端审批',
        `命令需要审批：${command}${approvalId ? `\n审批 #${approvalId}` : ''}`,
      );
      elements.terminalRiskHint.textContent = payload.risk?.reason || '命令需要审批';
      notifyUser('终端命令待审批', command);
      speakBrief('有一个终端命令等待审批');
    } else {
      appendMessage('tool', '终端', `已开始执行：${command}`);
      elements.terminalRiskHint.textContent = payload.risk?.reason || '命令已开始执行';
    }

    await Promise.all([
      refreshApprovals({ silent: true }),
      refreshTerminalCommands({ silent: true }),
    ]);
  } catch (error) {
    appendMessage('assistant', '终端执行失败', formatError(error));
    elements.terminalRiskHint.textContent = formatError(error);
  }
}

function normalizeButlerSelection() {
  const servers = getManagedServers();

  if (servers.length === 0) {
    state.selectedManagedServer = '';
    state.selectedManagedServiceKey = '';
    state.butlerDoctor = null;
    state.butlerServiceLogs = null;
    state.butlerServiceStatus = null;
    localStorage.removeItem('asb.selectedManagedServer');
    localStorage.removeItem('asb.selectedManagedServiceKey');
    return;
  }

  const selectedServer = servers.find((server) => server.name === state.selectedManagedServer) || servers[0];

  if (selectedServer) {
    state.selectedManagedServer = selectedServer.name;
    localStorage.setItem('asb.selectedManagedServer', selectedServer.name);
  }

  const services = getManagedServices(selectedServer?.name);
  const selectedService = services.find(
    (service) => `${service.serverName}:${service.projectName}` === state.selectedManagedServiceKey,
  ) || services[0];

  if (selectedService) {
    state.selectedManagedServiceKey = `${selectedService.serverName}:${selectedService.projectName}`;
    localStorage.setItem('asb.selectedManagedServiceKey', state.selectedManagedServiceKey);
  } else {
    state.selectedManagedServiceKey = '';
    localStorage.removeItem('asb.selectedManagedServiceKey');
  }
}

function renderButler() {
  const overview = state.butlerOverview;
  const servers = getManagedServers();
  const runtimes = Array.isArray(overview?.runtimes) ? overview.runtimes : [];
  const selectedServer = getSelectedManagedServer();
  const selectedService = getSelectedManagedService();
  const selectedStatus = getSelectedManagedServiceStatus();
  const serviceCount = servers.reduce(
    (count, server) => count + (Array.isArray(server.projects) ? server.projects.length : 0),
    0,
  );

  elements.butlerServerCount.textContent = String(servers.length);
  elements.butlerServiceCount.textContent = String(serviceCount);
  elements.butlerRuntimeCount.textContent = String(runtimes.length);
  elements.butlerPendingCount.textContent = String(overview?.pendingApprovals ?? 0);

  setPillState(
    elements.butlerStatusPill,
    overview ? (overview.serverManager?.available ? 'ok' : 'danger') : 'muted',
    overview?.serverManager?.available
      ? 'server-manager 已接入'
      : overview?.serverManager?.reason || (overview ? 'server-manager 未接入' : '正在加载服务状态'),
  );

  renderButlerRuntimes(runtimes);
  renderButlerServers(servers);
  renderButlerServices(selectedServer);
  renderButlerDetail(selectedService, selectedStatus);
}

function renderButlerRuntimes(runtimes) {
  elements.butlerRuntimeList.replaceChildren();

  if (!Array.isArray(runtimes) || runtimes.length === 0) {
    elements.butlerRuntimeList.className = 'runtimeList empty';
    elements.butlerRuntimeList.textContent = '暂无运行时信息';
    return;
  }

  elements.butlerRuntimeList.className = 'runtimeList';

  for (const runtime of runtimes) {
    const article = document.createElement('article');
    article.className = `runtimeChip ${runtime.installed ? 'isReady' : 'isMissing'}`;

    const head = document.createElement('div');
    head.className = 'runtimeChipHead';

    const title = document.createElement('strong');
    title.textContent = runtime.title;

    const badge = createMiniPill(runtime.installed ? '可用' : '缺失', runtime.installed);

    head.append(title, badge);

    const meta = document.createElement('div');
    meta.className = 'runtimeChipMeta';
    meta.textContent = `${runtime.command} · ${runtime.sessionCount} 个会话`;

    const hint = document.createElement('div');
    hint.className = 'runtimeChipHint';
    hint.textContent = runtime.detectedPath || runtime.summary;

    article.append(head, meta, hint);
    elements.butlerRuntimeList.append(article);
  }
}

function renderButlerServers(servers) {
  elements.butlerServerList.replaceChildren();

  if (!servers.length) {
    elements.butlerServerList.className = 'stackedList empty';
    elements.butlerServerList.textContent = '暂无已接入服务器';
    return;
  }

  elements.butlerServerList.className = 'stackedList';

  for (const server of servers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `stackItemButton ${server.name === state.selectedManagedServer ? 'active' : ''}`;
    button.addEventListener('click', () => {
      selectManagedServer(server.name);
    });

    const title = document.createElement('div');
    title.className = 'stackItemTitle';
    title.textContent = server.name;

    const meta = document.createElement('div');
    meta.className = 'stackItemMeta';
    meta.textContent = `${server.host}:${server.port} · ${server.projects.length} 个服务`;

    const summary = document.createElement('div');
    summary.className = 'stackItemSummary';
    summary.textContent = server.description || server.tags.join(' · ') || '已接入 server-manager';

    button.append(title, meta, summary);
    elements.butlerServerList.append(button);
  }
}

function renderButlerServices(server) {
  elements.butlerServiceList.replaceChildren();

  if (!server) {
    elements.butlerServiceList.className = 'stackedList empty';
    elements.butlerServiceList.textContent = '先选择一个服务器';
    return;
  }

  if (!Array.isArray(server.projects) || server.projects.length === 0) {
    elements.butlerServiceList.className = 'stackedList empty';
    elements.butlerServiceList.textContent = '这个服务器还没有配置项目';
    return;
  }

  elements.butlerServiceList.className = 'stackedList';

  for (const service of server.projects) {
    const selected = `${service.serverName}:${service.projectName}` === state.selectedManagedServiceKey;
    const status = selected ? getSelectedManagedServiceStatus() : service.lastStatus;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `stackItemButton ${selected ? 'active' : ''}`;
    button.dataset.tone = statusBadgeClass(status?.status || 'configured');
    button.addEventListener('click', () => {
      selectManagedService(service.serverName, service.projectName);
    });

    const head = document.createElement('div');
    head.className = 'stackItemHead';

    const title = document.createElement('div');
    title.className = 'stackItemTitle';
    title.textContent = service.projectName;

    const badge = createMiniPill(status?.summary || '待检查', !!status);

    head.append(title, badge);

    const meta = document.createElement('div');
    meta.className = 'stackItemMeta';
    meta.textContent = renderManagedServiceMeta(service);

    const summary = document.createElement('div');
    summary.className = 'stackItemSummary';
    summary.textContent = service.description || service.remotePath || '已配置远程服务';

    button.append(head, meta, summary);
    elements.butlerServiceList.append(button);
  }
}

function renderButlerDetail(service, status) {
  if (!service) {
    elements.butlerServiceTitle.textContent = '未选择服务';
    elements.butlerServiceMeta.textContent = '请选择左侧服务查看详情。';
    setPillState(elements.butlerServiceStatusPill, 'muted', '未检查');
    renderButlerSummary(null, null);
    elements.butlerPreviewTitle.textContent = '未选择服务';
    elements.butlerPreviewContent.textContent = '服务状态、日志与诊断输出会显示在这里。';
    setManagedControlsDisabled(true);
    return;
  }

  setManagedControlsDisabled(false);
  elements.butlerServiceTitle.textContent = service.projectName;
  elements.butlerServiceMeta.textContent = `${service.serverName} · ${service.host}:${service.sshPort}`;
  setPillState(
    elements.butlerServiceStatusPill,
    statusBadgeClass(status?.status || 'configured'),
    status?.summary || '待检查',
  );
  renderButlerSummary(service, status);

  const preview = getManagedPreview(service);
  elements.butlerPreviewTitle.textContent = preview.title;
  elements.butlerPreviewContent.textContent = preview.content;
}

function renderButlerSummary(service, status) {
  elements.butlerServiceSummary.replaceChildren();

  const label = document.createElement('span');
  label.className = 'summaryLabel';
  label.textContent = '服务摘要';

  const list = document.createElement('div');
  list.className = 'butlerSummaryList';

  const lines = service
    ? [
        `位置：${service.serverName} · ${service.host}:${service.sshPort}`,
        `端口：${service.port || '未配置'}${service.frpRemotePort ? ` · FRP ${service.frpRemotePort}` : ''}`,
        `路径：${service.remotePath || '未配置'}`,
        `日志：${service.logFile || '未配置'}${service.healthCheckUrl ? ` · 健康 ${service.healthCheckUrl}` : ''}`,
        `状态：${status?.summary || '尚未拉取实时状态'}`,
      ]
    : ['选择服务后查看端口、路径、日志和健康检查信息。'];

  for (const line of lines) {
    const item = document.createElement('div');
    item.className = 'butlerSummaryItem';
    item.textContent = line;
    list.append(item);
  }

  elements.butlerServiceSummary.append(label, list);
}

function getManagedPreview(service) {
  if (
    state.butlerDoctor &&
    state.butlerDoctor.serverName === service.serverName
  ) {
    return {
      content: state.butlerDoctor.rawOutput || state.butlerDoctor.summary || '(empty)',
      title: `${service.serverName} · doctor`,
    };
  }

  if (
    state.butlerServiceLogs &&
    state.butlerServiceLogs.serverName === service.serverName &&
    state.butlerServiceLogs.projectName === service.projectName
  ) {
    return {
      content: state.butlerServiceLogs.content || '(empty)',
      title: `${service.projectName} · logs`,
    };
  }

  if (
    state.butlerServiceStatus &&
    state.butlerServiceStatus.serverName === service.serverName &&
    state.butlerServiceStatus.projectName === service.projectName
  ) {
    return {
      content: state.butlerServiceStatus.rawOutput || state.butlerServiceStatus.summary || '(empty)',
      title: `${service.projectName} · status`,
    };
  }

  return {
    content: '点击“状态”或“日志”拉取实时信息，点击“诊断”检查当前服务器 SSH 连通性。',
    title: `${service.projectName} · preview`,
  };
}

async function cancelTerminalCommand(id) {
  try {
    await apiPost(`/terminal/commands/${id}/cancel`, {
      actorId: state.actorId,
    });
    appendMessage('system', '终端', `已请求取消命令 #${id}`);
    await refreshTerminalCommands({ silent: true });
  } catch (error) {
    appendMessage('assistant', '取消失败', formatError(error));
  }
}

function connectEventStream() {
  state.eventSource?.close();
  const controller = new AbortController();
  state.eventSource = {
    close: () => controller.abort(),
  };
  void consumeEventStream(controller.signal);
}

async function consumeEventStream(signal) {
  const headers = new Headers({
    Accept: 'text/event-stream',
  });

  const apiToken = apiTokenState.get();
  if (apiToken) {
    headers.set('Authorization', `Bearer ${apiToken}`);
  }

  if (state.lastEventId) {
    headers.set('Last-Event-ID', state.lastEventId);
  }

  try {
    const response = await fetch('/events', {
      cache: 'no-store',
      headers,
      signal,
    });

    if (response.status === 401) {
      setPillState(elements.healthBadge, 'warn', '需要 API Token');
      return;
    }

    if (!response.ok || !response.body) {
      throw new Error(`Event stream failed with HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = consumeSseBlocks(buffer);

      if (done) {
        break;
      }
    }
  } catch (error) {
    if (signal.aborted) {
      return;
    }

    console.warn('Event stream disconnected', error);
  }

  if (!signal.aborted) {
    scheduleRefreshAll();
    window.setTimeout(() => {
      if (!signal.aborted) {
        connectEventStream();
      }
    }, 3000);
  }
}

function consumeSseBlocks(buffer) {
  let boundary = buffer.search(/\r?\n\r?\n/u);

  while (boundary >= 0) {
    const block = buffer.slice(0, boundary);
    const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] || '\n\n';
    buffer = buffer.slice(boundary + separator.length);
    consumeSseBlock(block);
    boundary = buffer.search(/\r?\n\r?\n/u);
  }

  return buffer;
}

function consumeSseBlock(block) {
  const dataLines = [];
  let eventId = '';

  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    const separatorIndex = line.indexOf(':');
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'id') {
      eventId = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (eventId) {
    state.lastEventId = eventId;
  }

  if (dataLines.length === 0) {
    return;
  }

  try {
    handleRealtimePayload(JSON.parse(dataLines.join('\n')));
  } catch {
    // Ignore malformed or partial event payloads and keep the stream alive.
  }
}

function handleRealtimePayload(payload) {
  scheduleRefreshAll();

  if (payload?.eventType === 'message.created' && state.selectedName) {
    void hydrateSelectedSessionMessages(true);
  }

  if (payload?.eventType === 'approval.requested') {
    void refreshApprovals({ silent: true });
    void refreshButler({ silent: true });
    notifyUser('有新的审批请求', payload.payload?.title || '请打开 ASB 处理审批');
    speakBrief('有新的审批请求');
  }

  if (payload?.eventType === 'approval.resolved') {
    void refreshApprovals({ silent: true });
    void refreshButler({ silent: true });
  }

  if (payload?.eventType?.startsWith('terminal.')) {
    void refreshTerminalCommands({ silent: true });

    if (payload.eventType === 'terminal.command.completed') {
      notifyUser('终端命令已完成', payload.payload?.command || '命令执行结束');
    }
  }

  if (payload?.eventType?.startsWith('machine.')) {
    void refreshMachines({ silent: true });
  }
}

function scheduleRefreshAll() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }

  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    void refreshAll({ silent: true });
  }, 250);
}

function setBusy(isBusy) {
  const controls = [
    elements.refreshButton,
    elements.openFiltersButton,
    elements.sendButton,
    elements.currentQuickButton,
    elements.inspectQuickButton,
    elements.tailQuickButton,
    elements.supervisorQuickButton,
    elements.tailButton,
    elements.watchRunButton,
    elements.workspaceRefreshButton,
    elements.workspaceUpButton,
    elements.approvalsRefreshButton,
    elements.butlerDoctorButton,
    elements.butlerExecButton,
    elements.butlerLogsButton,
    elements.butlerRefreshButton,
    elements.butlerRestartButton,
    elements.butlerStartButton,
    elements.butlerStatusButton,
    elements.butlerStopButton,
    elements.machinesRefreshButton,
    elements.testNotificationButton,
    elements.terminalRefreshButton,
    elements.terminalRunButton,
    elements.useButton,
    elements.inspectButton,
    elements.stopButton,
  ];

  for (const control of controls) {
    if (control) {
      control.disabled = isBusy;
    }
  }
}

function setPillState(element, tone, label) {
  element.className = `pill ${tone}`;
  element.innerHTML = '<span class="dot"></span><span></span>';
  const textNode = element.querySelector('span:last-child');

  if (textNode) {
    textNode.textContent = label;
  }
}

function renderWorkspacePanel() {
  if (!state.selectedName) {
    elements.workspaceCurrentPath.textContent = '/';
    elements.workspaceGitBranch.textContent = '未选择会话';
    elements.workspaceGitStatusList.className = 'stackedList empty';
    elements.workspaceGitStatusList.textContent = '未选择会话';
    elements.workspaceDiffTitle.textContent = '-';
    elements.workspaceDiffContent.textContent = '选择 Git 变更查看 diff';
    elements.workspaceFilesList.className = 'stackedList empty';
    elements.workspaceFilesList.textContent = '未选择会话';
    elements.workspaceFilePreviewTitle.textContent = '-';
    elements.workspaceFilePreviewContent.textContent = '选择一个文件查看内容';
    elements.workspaceUpButton.disabled = true;
    return;
  }

  elements.workspaceCurrentPath.textContent = state.workspaceBrowserPath || '/';
  elements.workspaceGitBranch.textContent = formatGitBranch(state.gitStatus);
  elements.workspaceUpButton.disabled = !state.workspaceBrowserPath;

  renderGitStatusList();
  renderGitDiff();
  renderFilesList();
  renderFilePreview();
}

function renderGitStatusList() {
  const container = elements.workspaceGitStatusList;
  container.replaceChildren();

  if (!state.gitStatus) {
    container.className = 'stackedList empty';
    container.textContent = '正在加载 Git 状态...';
    return;
  }

  if (!state.gitStatus.available) {
    container.className = 'stackedList empty';
    container.textContent = state.gitStatus.reason || '当前目录不是 Git 仓库';
    return;
  }

  if (!Array.isArray(state.gitStatus.entries) || state.gitStatus.entries.length === 0) {
    container.className = 'stackedList empty';
    container.textContent = '工作区干净，没有未提交改动。';
    return;
  }

  container.className = 'stackedList';

  for (const entry of state.gitStatus.entries.slice(0, 20)) {
    const item = document.createElement('div');
    item.className = 'stackItemStatic';
    item.dataset.tone = toneForGitStatus(entry.status);
    item.tabIndex = 0;
    item.role = 'button';
    item.addEventListener('click', () => {
      void loadGitDiff(entry.path);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void loadGitDiff(entry.path);
      }
    });

    const titleRow = document.createElement('div');
    titleRow.className = 'stackItemTitleRow';

    const title = document.createElement('div');
    title.className = 'stackItemTitle';
    title.textContent = entry.path;

    const badge = document.createElement('span');
    badge.className = 'stackItemBadge';
    badge.textContent = entry.status;

    titleRow.append(title, badge);

    const meta = document.createElement('div');
    meta.className = 'stackItemMeta';
    meta.textContent = entry.renameFrom
      ? `rename from ${entry.renameFrom}`
      : gitStatusLabel(entry.status);

    item.append(titleRow, meta);
    container.append(item);
  }
}

function renderFilesList() {
  const container = elements.workspaceFilesList;
  container.replaceChildren();

  if (!Array.isArray(state.workspaceEntries) || state.workspaceEntries.length === 0) {
    container.className = 'stackedList empty';
    container.textContent = state.selectedName
      ? '当前目录没有可展示文件。'
      : '未选择会话';
    return;
  }

  container.className = 'stackedList';

  for (const entry of state.workspaceEntries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `stackItemButton ${
      !entry.isDirectory && entry.path === state.selectedFilePath ? 'active' : ''
    }`;

    button.addEventListener('click', () => {
      if (entry.isDirectory) {
        state.workspaceBrowserPath = entry.path;
        state.selectedFilePath = '';
        state.filePreview = null;
        void refreshWorkspacePanel();
        return;
      }

      void loadFilePreview(entry.path);
    });

    const titleRow = document.createElement('div');
    titleRow.className = 'stackItemTitleRow';

    const title = document.createElement('div');
    title.className = 'stackItemTitle';
    title.textContent = `${entry.isDirectory ? '📁' : '📄'} ${entry.name}`;

    const badge = document.createElement('span');
    badge.className = 'stackItemBadge';
    badge.textContent = entry.isDirectory ? 'dir' : formatFileSize(entry.size);

    titleRow.append(title, badge);

    const meta = document.createElement('div');
    meta.className = 'stackItemMeta';
    meta.textContent = formatCompactDate(entry.modifiedAt);

    button.append(titleRow, meta);
    container.append(button);
  }
}

function renderFilePreview() {
  if (!state.filePreview) {
    elements.workspaceFilePreviewTitle.textContent = '-';
    elements.workspaceFilePreviewContent.textContent = '选择一个文件查看内容';
    return;
  }

  elements.workspaceFilePreviewTitle.textContent = state.filePreview.path;

  if (state.filePreview.isBinary) {
    elements.workspaceFilePreviewContent.textContent =
      '二进制文件，暂不支持直接预览。';
    return;
  }

  const content = state.filePreview.content || '';
  elements.workspaceFilePreviewContent.textContent = state.filePreview.isTruncated
    ? `${content}\n\n[预览已截断]`
    : content || '(empty file)';
}

function renderGitDiff() {
  if (!state.selectedName) {
    elements.workspaceDiffTitle.textContent = '-';
    elements.workspaceDiffContent.textContent = '选择 Git 变更查看 diff';
    return;
  }

  if (!state.gitDiff) {
    elements.workspaceDiffTitle.textContent = state.selectedDiffPath || '-';
    elements.workspaceDiffContent.textContent = state.gitStatus?.clean
      ? '工作区干净，没有 diff。'
      : '选择 Git 变更查看 diff';
    return;
  }

  elements.workspaceDiffTitle.textContent = state.gitDiff.path || '全部变更';

  if (!state.gitDiff.available) {
    elements.workspaceDiffContent.textContent = state.gitDiff.reason || 'git diff 不可用';
    return;
  }

  const suffix = state.gitDiff.isTruncated ? '\n\n[Diff 已截断]' : '';
  elements.workspaceDiffContent.textContent = state.gitDiff.content
    ? `${state.gitDiff.content}${suffix}`
    : '(no diff)';
}

function renderApprovals() {
  renderWorkOverview();
  const container = elements.approvalsList;
  container.replaceChildren();

  const pending = state.approvals.filter((approval) => approval.status === 'pending');
  const recent = [
    ...pending,
    ...state.approvals.filter((approval) => approval.status !== 'pending').slice(0, 5),
  ];

  if (recent.length === 0) {
    container.className = 'stackedList empty';
    container.textContent = '暂无待审批';
    return;
  }

  container.className = 'stackedList';

  for (const approval of recent) {
    const item = document.createElement('div');
    item.className = 'stackItemStatic approvalItem';
    item.dataset.tone = toneForApproval(approval);

    const titleRow = document.createElement('div');
    titleRow.className = 'stackItemTitleRow';

    const title = document.createElement('div');
    title.className = 'stackItemTitle';
    title.textContent = `#${approval.id} ${approval.title}`;

    const badge = document.createElement('span');
    badge.className = 'stackItemBadge';
    badge.textContent = approval.status;

    titleRow.append(title, badge);

    const meta = document.createElement('div');
    meta.className = 'stackItemMeta';
    meta.textContent = `${approval.riskLevel} · ${approval.sessionName || '全局'} · ${formatCompactDate(approval.createdAt)}`;

    const description = document.createElement('div');
    description.className = 'stackItemMeta';
    description.textContent = approval.description;

    item.append(titleRow, meta, description);

    if (approval.status === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'miniActionRow';

      const approveButton = document.createElement('button');
      approveButton.type = 'button';
      approveButton.className = 'primaryBtn compactBtn';
      approveButton.textContent = '批准';
      approveButton.addEventListener('click', () => {
        void resolveApproval(approval.id, 'approve');
      });

      const denyButton = document.createElement('button');
      denyButton.type = 'button';
      denyButton.className = 'dangerBtn compactBtn';
      denyButton.textContent = '拒绝';
      denyButton.addEventListener('click', () => {
        void resolveApproval(approval.id, 'deny');
      });

      actions.append(approveButton, denyButton);
      item.append(actions);
    }

    container.append(item);
  }
}

function renderMachines() {
  commandCenter.render();
  const container = elements.machinesList;
  container.replaceChildren();
  renderMachineOptions();

  if (!Array.isArray(state.machines) || state.machines.length === 0) {
    container.className = 'stackedList empty';
    container.textContent = '暂无机器';
    return;
  }

  container.className = 'stackedList';

  for (const machine of state.machines) {
    const item = document.createElement('div');
    item.className = 'stackItemStatic';
    item.dataset.tone = machine.status === 'online' ? 'good' : 'bad';

    const titleRow = document.createElement('div');
    titleRow.className = 'stackItemTitleRow';

    const title = document.createElement('div');
    title.className = 'stackItemTitle';
    title.textContent = machine.name;

    const badge = document.createElement('span');
    badge.className = 'stackItemBadge';
    badge.textContent = machine.status;

    titleRow.append(title, badge);

    const meta = document.createElement('div');
    meta.className = 'stackItemMeta';
    meta.textContent = `${machine.host || '-'} · ${machine.labels?.join(', ') || '-'}`;

    item.append(titleRow, meta);
    container.append(item);
  }
}

function renderMachineOptions() {
  const select = elements.sessionMachineSelect;

  if (!select) {
    return;
  }

  const previous = select.value;
  select.replaceChildren();

  const fallbackOption = document.createElement('option');
  fallbackOption.value = '';
  fallbackOption.textContent = '自动选择本机';
  select.append(fallbackOption);

  for (const machine of state.machines) {
    const option = document.createElement('option');
    option.value = String(machine.id);
    option.textContent = `${machine.name} · ${machine.status}`;
    if (machine.status !== 'online' || machine.name !== 'local') {
      option.disabled = true;
      if (machine.name !== 'local') option.textContent += ' · 远程执行未接通';
    }
    select.append(option);
  }

  const localMachine = state.machines.find((machine) => machine.name === 'local');
  select.value = previous || (localMachine ? String(localMachine.id) : '');
}

function renderTerminalCommands() {
  const container = elements.terminalCommandsList;
  container.replaceChildren();

  if (!state.selectedName) {
    container.className = 'stackedList empty';
    container.textContent = '未选择会话';
    elements.terminalInput.disabled = true;
    elements.terminalRunButton.disabled = true;
    return;
  }

  elements.terminalInput.disabled = false;
  elements.terminalRunButton.disabled = false;

  if (!Array.isArray(state.terminalCommands) || state.terminalCommands.length === 0) {
    container.className = 'stackedList empty';
    container.textContent = '暂无终端命令';
    return;
  }

  container.className = 'stackedList';

  for (const command of state.terminalCommands) {
    const item = document.createElement('div');
    item.className = 'stackItemStatic terminalItem';
    item.dataset.tone = toneForTerminal(command.status);

    const titleRow = document.createElement('div');
    titleRow.className = 'stackItemTitleRow';

    const title = document.createElement('div');
    title.className = 'stackItemTitle';
    title.textContent = `#${command.id} ${command.command}`;

    const badge = document.createElement('span');
    badge.className = 'stackItemBadge';
    badge.textContent = command.status;

    titleRow.append(title, badge);

    const meta = document.createElement('div');
    meta.className = 'stackItemMeta';
    meta.textContent = `${formatCompactDate(command.createdAt)}${command.exitCode !== null ? ` · exit ${command.exitCode}` : ''}`;

    item.append(titleRow, meta);

    const output = [command.stdoutTail, command.stderrTail].filter(Boolean).join('\n');
    if (output.trim()) {
      const pre = document.createElement('pre');
      pre.className = 'terminalOutput';
      pre.textContent = output;
      item.append(pre);
    }

    if (command.status === 'running') {
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'dangerBtn compactBtn';
      cancelButton.textContent = '取消';
      cancelButton.addEventListener('click', () => {
        void cancelTerminalCommand(command.id);
      });
      item.append(cancelButton);
    }

    container.append(item);
  }
}

function setContextPill(element, label, value, tone = 'muted') {
  const variant = element.dataset.variant ? ` ${element.dataset.variant}` : '';
  element.className = `contextPill${variant} ${tone}`;
  element.innerHTML = `<span class="contextLabel"></span><strong></strong>`;
  const labelNode = element.querySelector('.contextLabel');
  const valueNode = element.querySelector('strong');

  if (labelNode) {
    labelNode.textContent = label;
  }

  if (valueNode) {
    valueNode.textContent = value;
    valueNode.title = value;
  }
}

function badgeClass(value) {
  if (['ready', 'idle'].includes(value)) {
    return 'ok';
  }

  if (['active', 'busy', 'starting', 'trust_prompt'].includes(value)) {
    return 'warn';
  }

  if (['missing_window', 'error', 'stopped'].includes(value)) {
    return 'danger';
  }

  return 'muted';
}

function statusBadgeClass(value) {
  if (['running'].includes(value)) {
    return 'ok';
  }

  if (['configured', 'unknown'].includes(value)) {
    return 'warn';
  }

  if (['connection_failed', 'error', 'stopped'].includes(value)) {
    return 'danger';
  }

  return 'muted';
}

function renderManagedServiceMeta(service) {
  const portText = service.port ? `:${service.port}` : '无业务端口';
  return `${service.serverName} · ${service.host}${portText}`;
}

function renderManagedActionLabel(action) {
  if (action === 'start') {
    return '启动';
  }

  if (action === 'stop') {
    return '停止';
  }

  if (action === 'restart') {
    return '重启';
  }

  return action;
}

function getLiveSessionsCount() {
  return state.sessions.filter((session) => {
    const snapshot = findSnapshot(session.name);
    const observed = snapshot?.observedState || session.status;
    return ['ready', 'idle', 'active', 'busy', 'starting', 'trust_prompt'].includes(observed);
  }).length;
}

function formatDate(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatCompactDate(value) {
  if (!value) {
    return '最近活跃未知';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString([], {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
  });
}

function formatError(error) {
  return error instanceof Error ? `执行失败：${error.message}` : '执行失败：未知错误';
}

function formatGitBranch(gitStatus) {
  if (!gitStatus) {
    return '加载中';
  }

  if (!gitStatus.available) {
    return gitStatus.reason || '非 Git 仓库';
  }

  return gitStatus.branch || 'Git 仓库';
}

function toneForGitStatus(status) {
  if (status.includes('??')) {
    return 'warn';
  }

  if (status.includes('D')) {
    return 'bad';
  }

  return 'good';
}

function toneForApproval(approval) {
  if (approval.status === 'pending') {
    return approval.riskLevel === 'high' ? 'bad' : 'warn';
  }

  if (approval.status === 'approved') {
    return 'good';
  }

  if (approval.status === 'denied') {
    return 'bad';
  }

  return 'muted';
}

function toneForTerminal(status) {
  if (status === 'succeeded') {
    return 'good';
  }

  if (status === 'running' || status === 'queued') {
    return 'warn';
  }

  if (status === 'failed' || status === 'cancelled') {
    return 'bad';
  }

  return 'muted';
}

function gitStatusLabel(status) {
  if (status === '??') {
    return '未跟踪文件';
  }

  if (status.includes('M')) {
    return '内容已修改';
  }

  if (status.includes('A')) {
    return '新文件';
  }

  if (status.includes('D')) {
    return '文件删除';
  }

  if (status.includes('R')) {
    return '文件重命名';
  }

  return '工作区变更';
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mapPersistedMessage(message) {
  return {
    content: typeof message.content === 'string' ? message.content : '',
    role: normalizeMessageRole(message.role),
    time: formatDate(message.createdAt),
    title: resolveMessageTitle(message),
  };
}

function normalizeMessageRole(role) {
  return ['user', 'assistant', 'system', 'tool', 'approval'].includes(role) ? role : 'system';
}

function resolveMessageTitle(message) {
  if (message.role === 'user') {
    return message.actorId || '用户';
  }

  if (message.role === 'assistant') {
    return message.source === 'tmux-tail'
      ? `${state.selectedName || '会话'} · 最近输出`
      : '会话输出';
  }

  if (message.role === 'approval') {
    return '审批';
  }

  if (message.role === 'tool') {
    return '工具';
  }

  return '系统';
}

function renderJson(value) {
  return JSON.stringify(value, null, 2);
}

function normalizePrompt(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function quoteArg(value) {
  return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getParentWorkspacePath(value) {
  if (!value) {
    return '';
  }

  const parts = value.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function registerPwa() {
  if (!('serviceWorker' in navigator)) {
    elements.pwaStatus.textContent = '当前浏览器不支持 Service Worker';
    return;
  }

  navigator.serviceWorker
    .register('/service-worker.js')
    .then(() => {
      elements.pwaStatus.textContent = 'PWA 已启用，可添加到桌面';
    })
    .catch((error) => {
      elements.pwaStatus.textContent = `PWA 初始化失败：${error.message}`;
    });
}

async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') {
    state.notificationPermission = 'unsupported';
    syncNotificationStatus();
    return;
  }

  state.notificationPermission = await Notification.requestPermission();
  syncNotificationStatus();
}

function syncNotificationStatus() {
  if (!elements.notificationButton) {
    return;
  }

  if (typeof Notification === 'undefined') {
    elements.notificationButton.textContent = '浏览器不支持通知';
    elements.notificationButton.disabled = true;
    return;
  }

  state.notificationPermission = Notification.permission;
  elements.notificationButton.textContent =
    Notification.permission === 'granted'
      ? '浏览器通知已启用'
      : Notification.permission === 'denied'
        ? '通知已被浏览器拒绝'
        : '启用浏览器通知';
  elements.notificationButton.disabled = Notification.permission === 'denied';
}

function notifyUser(title, body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return;
  }

  if (!document.hidden) {
    return;
  }

  new Notification(title, {
    body: String(body || ''),
    icon: '/icon.svg',
  });
}

function toggleVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!Recognition) {
    appendMessage('system', '语音不可用', '当前浏览器不支持 Web Speech API。');
    return;
  }

  if (state.voiceListening && state.voiceRecognition) {
    state.voiceRecognition.stop();
    return;
  }

  const recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = false;
  recognition.continuous = false;

  state.voiceRecognition = recognition;
  state.voiceListening = true;
  elements.voiceButton.textContent = '聆听中';

  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || '')
      .join('')
      .trim();

    if (transcript) {
      handleVoiceTranscript(transcript);
    }
  };

  recognition.onerror = (event) => {
    appendMessage('system', '语音识别失败', event.error || '识别失败');
  };

  recognition.onend = () => {
    state.voiceListening = false;
    elements.voiceButton.textContent = '语音';
  };

  recognition.start();
}

function handleVoiceTranscript(transcript) {
  appendMessage('system', '语音识别', transcript);

  const pendingApproval = state.approvals.find((approval) => approval.status === 'pending');

  if (/^(同意|批准|通过|approve)/iu.test(transcript) && pendingApproval) {
    void resolveApproval(pendingApproval.id, 'approve');
    return;
  }

  if (/^(拒绝|否决|deny)/iu.test(transcript) && pendingApproval) {
    void resolveApproval(pendingApproval.id, 'deny');
    return;
  }

  const shouldSend = /(发送|提交)$/u.test(transcript);
  elements.chatInput.value = shouldSend
    ? transcript.replace(/(发送|提交)$/u, '').trim()
    : transcript;
  autoResizeComposer();

  if (shouldSend) {
    void handleComposerSubmit();
  }
}

function speakBrief(text) {
  if (!('speechSynthesis' in window)) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}
