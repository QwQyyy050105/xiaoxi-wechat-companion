import {getAuthorizedWechatScopes, inspectConversationScope} from './conversation_scope.mjs';

const receiptStatuses = new Set(['prepared','deferred','sending','local_echo','unknown','not_sent']);
const taskStatuses = new Set(['proposed','scheduled','claimed','sending','local_echo','unknown','not_sent','missed','cancelled']);
const beijing = new Intl.DateTimeFormat('zh-CN', {
  timeZone:'Asia/Shanghai', year:'numeric', month:'long', day:'numeric', hour:'2-digit',
  minute:'2-digit', second:'2-digit', hourCycle:'h23',
});

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  return Date.parse(value);
}

export function validateReminderQuery({target, text, from, until} = {}) {
  if (typeof target !== 'string' || !getAuthorizedWechatScopes().some(scope=>scope.id===target && scope.kind==='group')) {
    throw Error('target_not_authorized');
  }
  if (typeof text !== 'string' || text !== text.trim() || !text || text.length>2000) throw Error('exact_task_text_required');
  const since = instant(from), before = instant(until);
  if (!Number.isFinite(since) || !Number.isFinite(before) || since>=before) throw Error('explicit_time_window_required');
  return {target,text,since,before};
}

/** Read-only projection. Never serialize the store, thread, request, or outbox text. */
export function queryReminderReceipt(state, input) {
  const {target, text, since, before} = validateReminderQuery(input);
  const sessions = state.sessions.filter(session=>session.channel==='desktop_wechat' && session.peerId===target);
  if (sessions.length!==1 || !inspectConversationScope(sessions[0],state.targets).allowed) throw Error('session_binding_unavailable');
  const sessionId = sessions[0].id;
  const matches = state.tasks.filter(task=>task.targetId===target && task.sessionId===sessionId &&
    task.kind==='reminder' && task.text===text && since<=instant(task.createdAt) && instant(task.createdAt)<before);
  if (matches.length!==1) return {result:matches.length?'ambiguous':'not_found',count:matches.length};
  const [task] = matches;
  if (!task.id || !taskStatuses.has(task.status) || !Number.isFinite(instant(task.dueAt))) throw Error('task_record_invalid');
  const when = beijing.format(new Date(task.dueAt)).replace(/:00$/u,'');
  // The incoming event's stable source key is stored on the task. Only read
  // the matching inbox item's ID; its text and session history are unnecessary.
  const sourceKey = task.source?.eventId || task.requestId;
  const requests = sourceKey ? state.inbox.filter(row=>row.sessionId===sessionId &&
    (row.event?.sourceKey===sourceKey || row.event?.fragments?.includes(sourceKey))).map(row=>row.id) : [];
  const acknowledgements = [], deliveries = [];
  for (const row of state.outbox) {
    if (row.sessionId!==sessionId || !receiptStatuses.has(row.status)) continue;
    if (row.kind==='reminder' && row.taskId===task.id &&
        (!row.attemptId || row.attemptId===task.attemptId)) {
      deliveries.push(row.status);
      continue;
    }
    if (requests.length===1 && row.kind==='reply' && row.requestIds?.includes(requests[0])) acknowledgements.push(row);
  }
  const reply = acknowledgements.map(row=>row.text ?? '').join('\n');
  return {result:'matched', count:1, dueBeijing:beijing.format(new Date(task.dueAt)), taskStatus:task.status,
    pendingApproval:task.status==='proposed', approvalRecorded:!!task.approvedAt || task.source?.kind==='local_owner',
    acknowledgement:acknowledgements.length ? {match:'request_id',containsTime:reply.includes(when),containsTaskText:reply.includes(text),
      receipts:acknowledgements.map(row=>row.status)} :
      {match:requests.length>1?'ambiguous':'not_linked',containsTime:null,containsTaskText:null,receipts:[]},
    execution:{taskStatus:task.status,receipts:deliveries,localEcho:task.status==='local_echo'||deliveries.includes('local_echo')}};
}
