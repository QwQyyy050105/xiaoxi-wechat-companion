import {randomUUID} from 'node:crypto';

// No timers, transport, network, or file I/O: commit each transition via Store.change.
const owner = actor => actor?.isOwner === true;
const stamp = value => new Date(value ?? Date.now()).toISOString();
const clean = value => String(value ?? '').trim();
const fail = code => ({ok:false,code});
const bodyOf = text => clean(text).replace(/^小汐[，,:：\s]*/u,'').replace(/^请/u,'');
const mutable = row => ['proposed','scheduled'].includes(row.status);
function zoneValid(zone) { try { new Intl.DateTimeFormat('en',{timeZone:zone}).format(); return typeof zone==='string' && !!zone; } catch { return false; } }
function validDate(value) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value ?? '')) return false;
  const ms=Date.parse(value); if(!Number.isFinite(ms)) return false;
  const [y,m,d,h,min]=value.match(/\d+/g).map(Number);
  return m>=1 && m<=12 && d>=1 && d<=new Date(Date.UTC(y,m,0)).getUTCDate() && h<=23 && min<=59;
}
function zoneMatches(value,zone) {
  const pieces = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
  const p=Object.fromEntries(pieces.map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===value.slice(0,16);
}
function validate(state,options) {
  const session=(state.sessions ?? []).find(x=>x.id===options.sessionId);
  if(!session) return 'session_not_found';
  if(options.expectedEpoch != null && (session.epoch ?? 0)!==options.expectedEpoch) return 'stale_epoch';
  if(!clean(options.targetId)) return 'target_required';
  if(Array.isArray(state.targets) && !state.targets.some(x=>x.id===options.targetId)) return 'target_not_found';
  if(session.channel==='desktop_wechat' && session.peerId!==options.targetId) return 'target_session_mismatch';
  if(!clean(options.text) || clean(options.text).length>2000) return 'invalid_text';
  if(!zoneValid(options.timeZone)) return 'time_zone_required';
  if(!validDate(options.dueAt)) return 'explicit_datetime_required';
  if(!zoneMatches(options.dueAt,options.timeZone)) return 'timezone_mismatch';
  if(Date.parse(options.dueAt)<=Date.parse(stamp(options.now))) return 'time_not_future';
  return null;
}

export function parseTaskIntent(text,{timeZone='Asia/Shanghai'}={}) {
  const body=bodyOf(text);
  if(/^(?:提醒列表|查看提醒|有哪些提醒)[？?。]?$/u.test(body)) return {type:'list'};
  let match=body.match(/^(?:取消提醒|删除提醒)[：:\s]*([A-Za-z0-9_-]+)[。]?$/u);
  if(match) return {type:'cancel',id:match[1]};
  match=body.match(/^(?:查资料|搜索一下|搜索|查一下)[：:\s]*(.+)$/u);
  if(match) return {type:'search',query:match[1].trim().slice(0,500)};
  if(/^(?:总结|回顾|概括)(?:一下)?(?:刚才|这段|本次|今天|昨天|最近|过去|讨论|群聊)/u.test(body)) return {type:'summary',request:body};
  // Relative dates are deliberately clarified; no implicit tomorrow/time-of-day guess.
  match=body.match(/^(?:在\s*)?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?\s*(?:提醒(?:我|大家|本群)?)[：:\s]*(.+)$/u);
  if(!match) match=body.match(/^提醒(?:我|大家|本群)?[：:\s]*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?[，,：:\s]+(.+)$/u);
  if(match) {
    const offset=match[3] || (timeZone==='Asia/Shanghai'?'+08:00':null);
    if(!offset) return {type:'clarify',code:'explicit_offset_required',message:'请给出明确日期、时间和时区偏移。'};
    const dueAt=`${match[1]}T${match[2]}${offset}`;
    if(!validDate(dueAt) || !zoneValid(timeZone) || !zoneMatches(dueAt,timeZone)) return {type:'clarify',code:'invalid_datetime',message:'这个日期、时间或时区不一致，请提供明确日期和当地时间。'};
    return {type:'reminder',text:match[4].trim(),dueAt,timeZone};
  }
  if(/^(?:提醒|在.+提醒|明天.+提醒|后天.+提醒|下周.+提醒)/u.test(body)) return {type:'clarify',code:'explicit_datetime_required',message:'请给出完整日期、时间、时区和提醒内容，例如“2026-10-25 20:00 提醒本群讨论方案”（北京时间）。'};
  return null;
}

export function createReminder(state,options) {
  state.tasks ??= []; const problem=validate(state,options); if(problem) return fail(problem);
  const duplicate=options.requestId && state.tasks.find(x=>x.sessionId===options.sessionId && x.requestId===options.requestId);
  if(duplicate) return {ok:true,code:'already_created',task:structuredClone(duplicate)};
  const row={id:randomUUID(),kind:'reminder',sessionId:options.sessionId,targetId:clean(options.targetId),text:clean(options.text),
    dueAt:options.dueAt,timeZone:options.timeZone,status:owner(options.actor)?'scheduled':'proposed',version:1,createdAt:stamp(options.now),
    epoch:(state.sessions ?? []).find(x=>x.id===options.sessionId).epoch ?? 0,requestId:options.requestId ?? null,
    source:{kind:owner(options.actor)?'local_owner':'group_candidate',eventId:options.source?.eventId ?? null},attemptId:null};
  state.tasks.push(row); return {ok:true,code:row.status==='proposed'?'pending_approval':'created',task:structuredClone(row)};
}
function getTask(state,id,options={}) { return (state.tasks ?? []).find(x=>x.id===id && (!options.sessionId || x.sessionId===options.sessionId)); }
export function approveReminder(state,id,options={}) {
  if(!owner(options.actor)) return fail('owner_required');
  const row=getTask(state,id,options); if(!row || row.status!=='proposed') return fail('candidate_not_found');
  const problem=validate(state,{...row,now:options.now,expectedEpoch:row.epoch}); if(problem) return fail(problem);
  row.status='scheduled'; row.approvedAt=stamp(options.now); row.version++;
  return {ok:true,code:'approved',task:structuredClone(row)};
}
export function editReminder(state,id,options={}) {
  if(!owner(options.actor)) return fail('owner_required');
  const row=getTask(state,id,options); if(!row) return fail('task_not_found');
  if(!mutable(row)) return fail('task_already_committed');
  if(options.expectedVersion!=null && options.expectedVersion!==row.version) return fail('stale_version');
  const proposed={...row,...options,sessionId:row.sessionId}; const problem=validate(state,proposed); if(problem) return fail(problem);
  for(const key of ['targetId','text','dueAt','timeZone']) row[key]=proposed[key];
  row.version++; row.updatedAt=stamp(options.now);
  return {ok:true,code:'updated',task:structuredClone(row)};
}
export function cancelReminder(state,id,options={}) {
  if(!owner(options.actor)) return fail('owner_required');
  const row=getTask(state,id,options); if(!row) return fail('task_not_found');
  if(row.status==='cancelled') return {ok:true,code:'already_cancelled',task:structuredClone(row)};
  if(!mutable(row)) return fail('task_already_committed');
  row.status='cancelled'; row.cancelledAt=stamp(options.now); row.version++;
  return {ok:true,code:'cancelled',task:structuredClone(row)};
}
export function queryTasks(state,{sessionId}={}) { return (state.tasks ?? []).filter(x=>x.sessionId===sessionId).map(x=>structuredClone(x)); }
export function recoverTasks(state,{now}={}) {
  const recovered=[]; const ms=Date.parse(stamp(now));
  for(const row of state.tasks ?? []) {
    if(['claimed','sending'].includes(row.status)) { row.status='unknown'; row.reason='interrupted_after_claim'; }
    else if(row.status==='scheduled' && Date.parse(row.dueAt)<=ms) { row.status='missed'; row.reason='offline_at_due_time'; }
    else continue;
    row.updatedAt=stamp(now); recovered.push(row.id);
  }
  return recovered;
}
export function claimReminder(state,id,{now,lateWindowMs=60000}={}) {
  const row=getTask(state,id); if(!row || row.status!=='scheduled') return fail('not_scheduled');
  const ms=Date.parse(stamp(now)), due=Date.parse(row.dueAt);
  if(!Number.isFinite(due)) return fail('invalid_datetime');
  if(ms<due) return fail('not_due');
  if(ms-due>Math.max(0,Math.min(Number(lateWindowMs)||0,60000))) { row.status='missed'; row.reason='late_before_claim'; row.updatedAt=stamp(now); return fail('missed'); }
  row.status='claimed'; row.attemptId=randomUUID(); row.claimedAt=stamp(now);
  return {ok:true,code:'claimed',task:structuredClone(row)};
}
export function settleReminder(state,id,{status,attemptId,now}={}) {
  const row=getTask(state,id); if(!row || row.status!=='claimed') return fail('not_claimed');
  if(!attemptId || attemptId!==row.attemptId) return fail('stale_attempt');
  if(!['local_echo','unknown','not_sent','deferred'].includes(status)) return fail('invalid_result');
  row.status=status==='deferred'?'not_sent':status; row.completedAt=stamp(now);
  row.reason=status==='local_echo'?'local_echo_only':status==='deferred'?'deferred_without_retry':status;
  return {ok:true,code:row.status,task:structuredClone(row)};
}
