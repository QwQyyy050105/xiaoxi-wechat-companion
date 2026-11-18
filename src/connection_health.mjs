const readableStages = new Set(['listening', 'gap', 'waiting_send', 'paused', 'waiting_input', 'observe_only']);

export function connectionHealth(connection, targets, states) {
  const enabled = targets.filter(target => target.enabled);
  const readable = connection.stage === 'connected'
    ? enabled.filter(target => readableStages.has(states[target.id]?.stage)).length : 0;
  const total = enabled.length;
  const health = { status: connection.stage, readable, total };
  if (connection.stage !== 'connected') return { ...connection, health };

  const summary = (status, label, message) => ({ ...connection, health: { status, readable, total, label }, message });
  if (!total) return summary('no_targets', '没有启用的会话', '请在会话管理中启用需要监听的会话。');
  if (!readable) return summary('unavailable', '会话窗口不可读',
    `账号已连接，${total} 个已启用会话均未读到。请检查各会话状态和独立窗口。`);

  const observeOnly = connection.nativeMode === 'uia_readonly';
  if (observeOnly) {
    const label = `${readable}/${total} 个会话可读，仅观察`;
    return summary(readable === total ? 'observe_only' : 'partial', label,
      `${label}。可观察已授权窗口中的消息和微信已有的语音转写，自动回复及后台发送尚未启用。`);
  }
  if (readable < total) return summary('partial', '部分会话窗口不可读',
    `${readable}/${total} 个已启用会话可读取，请查看其余会话的窗口状态。`);

  const paused = enabled.some(target => target.paused || target.quarantined || states[target.id]?.stage === 'waiting_send');
  return paused
    ? summary('attention', '会话已连接，部分回复暂停', '会话可读取。暂停或发送待确认的原因见下方。')
    : summary('ready', `${readable}/${total} 个会话监听中`, '仅处理连接后新出现的消息。');
}
