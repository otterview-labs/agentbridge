const labels = {
  starting: '启动中',
  busy: '工作中',
  active: '工作中',
  idle: '空闲',
  ready: '就绪',
  stopped: '已停止',
  error: '异常',
  missing_window: '会话丢失',
  trust_prompt: '等待确认',
  unknown: '待检查',
};

function timestamp(value) {
  return Date.parse(typeof value === 'string' && /^\d{4}-\d{2}-\d{2} /u.test(value)
    ? `${value.replace(' ', 'T')}Z` : value);
}

export function describeWork(session, snapshot, approvals = []) {
  // Terminal records and newer session updates must not be overwritten by old inspections.
  const canUseSnapshot = snapshot &&
    !['stopped', 'error'].includes(session.status) &&
    Math.max(timestamp(snapshot.checkedAt) || 0, timestamp(snapshot.session?.updatedAt) || 0)
      >= timestamp(session.updatedAt);
  const observed = canUseSnapshot && snapshot.observedState !== 'unknown'
    ? snapshot.observedState
    : session.status;
  const pending = approvals.filter((item) =>
    item.status === 'pending' && item.sessionName === session.name).length;
  const attention = pending > 0 || ['error', 'missing_window', 'trust_prompt'].includes(observed);
  const running = ['busy', 'active', 'starting'].includes(observed);
  const group = attention ? 'attention' : running ? 'running'
    : ['idle', 'ready'].includes(observed) ? 'idle'
      : observed === 'stopped' ? 'stopped' : 'unknown';
  return {
    observed,
    label: labels[observed] || '待检查',
    group,
    running,
    attention,
    pending,
    digest: session.lastOutputDigest || (canUseSnapshot && snapshot.note) || '暂无输出，等待下一次工作记录。',
  };
}

export function selectWorkRows(sessions, snapshots, approvals, filter = 'all', query = '') {
  const snapshotMap = new Map();
  for (const snapshot of snapshots) {
    const name = snapshot.session?.name;
    const previous = snapshotMap.get(name);
    if (!previous || Date.parse(snapshot.checkedAt) > Date.parse(previous.checkedAt)) {
      snapshotMap.set(name, snapshot);
    }
  }
  const needle = query.trim().toLowerCase();
  return sessions.map((session) => ({
    session,
    work: describeWork(session, snapshotMap.get(session.name), approvals),
  })).filter(({ session, work }) => {
    const matches = filter === 'all' || (filter === 'running' ? work.running : work.group === filter);
    return matches && `${session.name} ${session.workspacePath} ${session.agentType} ${work.digest}`
      .toLowerCase().includes(needle);
  }).sort((a, b) => {
    const ranks = { attention: 0, running: 1, idle: 2, unknown: 3, stopped: 4 };
    return ranks[a.work.group] - ranks[b.work.group] ||
      (Date.parse(b.session.lastActiveAt) || 0) - (Date.parse(a.session.lastActiveAt) || 0);
  });
}
