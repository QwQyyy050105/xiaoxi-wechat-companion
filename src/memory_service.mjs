import {randomUUID} from 'node:crypto';

// Pure state helpers. The caller owns durable Store.change() transactions.
const stamp = value => new Date(value ?? Date.now()).toISOString();
const clean = value => String(value ?? '').trim();
const owner = actor => actor?.isOwner === true;
const fail = code => ({ok:false,code});
const session = (state,id) => (state.sessions ?? []).find(x => x.id === id);
function init(state) { state.memories ??= []; state.memoryCandidates ??= []; }
function epoch(state,id) { return session(state,id)?.memoryEpoch ?? 0; }
function guard(state,options) {
  const row = session(state,options.sessionId);
  if(!row) return 'session_not_found';
  if(options.expectedEpoch != null && (row.epoch ?? 0) !== options.expectedEpoch) return 'stale_epoch';
  if(options.expectedMemoryEpoch != null && epoch(state,row.id) !== options.expectedMemoryEpoch) return 'stale_memory_epoch';
  return null;
}
function publicRow(row) {
  return (!row.status || row.status === 'approved') && (!row.scope || row.scope === 'session') &&
    (!row.visibility || ['public','session','shared'].includes(row.visibility)) && !row.private && !row.ownerOnly;
}
function normalized(row) {
  return {...structuredClone(row),scope:row.scope ?? 'session',status:row.status ?? 'approved',version:row.version ?? 1,
    source:typeof row.source === 'object' && row.source !== null ? structuredClone(row.source) :
      {kind:'legacy_owner',label:'本机主人保存，具体成员未知',note:clean(row.source),eventId:null,senderId:null}};
}
function target(state,id) { return state.memories.find(x => x.id === id && publicRow(x)); }
function bump(state,id) { session(state,id).memoryEpoch = epoch(state,id) + 1; }
function stripCall(text) { return clean(text).replace(/^(?:小汐[，,:：\s]*)(?:请)?/u,'').replace(/^请/u,''); }

export function parseMemoryIntent(text) {
  const body = stripCall(text);
  if(/^(?:你(?:还)?记得什么|查看记忆|查询记忆|记忆列表|你记住了什么)[？?。！!]?$/u.test(body)) return {type:'query'};
  let match = body.match(/^(?:记住|记一下|记下)[：:\s]*(.+)$/u);
  if(match) return {type:'propose',action:'add',text:match[1].trim()};
  match = body.match(/^(?:修改记忆|更正记忆|记错了)[：:\s]*([A-Za-z0-9_-]+)[，,:：\s]+(?:改成|改为)?[：:\s]*(.+)$/u);
  if(match) return {type:'edit',action:'edit',id:match[1],memoryId:match[1],text:match[2].trim()};
  match = body.match(/^(?:删除记忆|忘记记忆|忘掉)[：:\s]*([A-Za-z0-9_-]+)[。！!]?$/u);
  if(match) return {type:'delete',action:'delete',id:match[1],memoryId:match[1]};
  if(/^(?:记错了|改成|改为|忘掉|忘记这|删除记忆|更正记忆)/u.test(body))
    return {type:'clarify',code:'memory_id_required',message:'请先查看记忆，再给出要修改或删除的条目编号。'};
  return null;
}

function classify(text,scope) {
  if(scope && scope !== 'session') return 'personal_memory_unavailable';
  if(/(?:假如|假设|如果|假使|据说|听说|他说|她说|别人说|开玩笑|比如说)/u.test(text)) return 'not_confirmed_fact';
  if(/(?:今天好烦|今天很烦|现在好烦|一时生气|此刻心情)/u.test(text)) return 'temporary_state';
  if(/(?:我(?!们)|我的|本人|个人|手机号|电话|住址|身份证)/u.test(text)) return 'personal_memory_unavailable';
  if(!/(?:本群|群规|群里|大家|我们|共同|全群)/u.test(text) &&
    /(?:^我|我的|本人|个人|喜欢|爱吃|不吃|讨厌|生日|手机号|电话|住址|身份证)/u.test(text)) return 'personal_memory_unavailable';
  return null;
}

export function proposeMemory(state,options) {
  init(state);
  const problem = guard(state,options); if(problem) return fail(problem);
  const action = options.action ?? 'add';
  if(!['add','edit','delete'].includes(action)) return fail('invalid_action');
  const text = clean(options.text);
  if(action !== 'delete') {
    if(!text || text.length > 2000) return fail('invalid_text');
    const classification = classify(text,options.scope); if(classification) return fail(classification);
    if(!owner(options.actor) && !/(?:本群|群规|群里|大家|我们|共同|全群)/u.test(text)) return fail('shared_scope_required');
  }
  const existing = action === 'add' ? null : target(state,options.memoryId);
  if(action !== 'add' && (!existing || existing.sessionId !== options.sessionId)) return fail('memory_not_found');
  const eventId = clean(options.source?.eventId) || null;
  const duplicate = eventId && state.memoryCandidates.find(x => x.sessionId === options.sessionId && x.source?.eventId === eventId && x.action === action);
  if(duplicate) return {ok:true,code:'already_proposed',candidate:structuredClone(duplicate)};
  const senderVerified = ['stable','stable_id'].includes(options.sender?.evidence) && clean(options.sender?.id);
  const candidate = {id:randomUUID(),sessionId:options.sessionId,scope:'session',action,memoryId:existing?.id ?? null,text,
    status:'pending',createdAt:stamp(options.now),epoch:session(state,options.sessionId).epoch ?? 0,memoryEpoch:epoch(state,options.sessionId),
    source:{kind:owner(options.actor)?'local_owner':'group_request',eventId,originalText:clean(options.source?.originalText ?? text).slice(0,3000),
      senderId:senderVerified ? options.sender.id : null,senderEvidence:senderVerified ? 'stable_id' : 'unknown'},
    targetVersion:existing?.version ?? (existing ? 1 : null)};
  state.memoryCandidates.push(candidate);
  return {ok:true,code:'pending_approval',candidate:structuredClone(candidate)};
}

function mutationGuard(state,row,options) {
  if(!owner(options.actor)) return 'owner_required';
  if(!row) return 'memory_not_found';
  if(options.sessionId && options.sessionId !== row.sessionId) return 'memory_not_found';
  return guard(state,{...options,sessionId:row.sessionId});
}
export function editMemory(state,id,options={}) {
  init(state); const row = target(state,id); const problem = mutationGuard(state,row,options); if(problem) return fail(problem);
  const text = clean(options.text); if(!text || text.length > 2000) return fail('invalid_text');
  const classification = classify(text,options.scope); if(classification) return fail(classification);
  if(options.expectedVersion != null && (row.version ?? 1) !== options.expectedVersion) return fail('stale_version');
  row.history ??= []; row.history.push({version:row.version ?? 1,text:row.text,source:structuredClone(normalized(row).source),replacedAt:stamp(options.now)});
  row.text=text; row.version=(row.version ?? 1)+1; row.status='approved'; row.scope='session'; row.updatedAt=stamp(options.now);
  row.source=options.source ? structuredClone(options.source) : {kind:'local_owner_edit',eventId:null,senderId:null,originalText:text};
  return {ok:true,code:'updated',memory:normalized(row),invalidateSession:true};
}
export function deleteMemory(state,id,options={}) {
  init(state); const row = target(state,id); const problem = mutationGuard(state,row,options); if(problem) return fail(problem);
  if(options.expectedVersion != null && (row.version ?? 1) !== options.expectedVersion) return fail('stale_version');
  // Keep only a content-free tombstone; late extraction cannot recreate deleted content.
  const tombstone = {id:row.id,sessionId:row.sessionId,scope:'session',status:'deleted',version:(row.version ?? 1)+1,deletedAt:stamp(options.now)};
  state.memories[state.memories.indexOf(row)] = tombstone;
  for(const candidate of state.memoryCandidates.filter(x => x.memoryId === id || x.approvedMemoryId === id)) {
    candidate.status='superseded'; delete candidate.text; delete candidate.source;
  }
  bump(state,row.sessionId);
  return {ok:true,code:'deleted',id};
}
export function approveMemory(state,id,options={}) {
  init(state); if(!owner(options.actor)) return fail('owner_required');
  const candidate = state.memoryCandidates.find(x => x.id === id && x.status === 'pending');
  if(!candidate || (options.sessionId && options.sessionId !== candidate.sessionId)) return fail('candidate_not_found');
  const problem = guard(state,{sessionId:candidate.sessionId,expectedEpoch:candidate.epoch,expectedMemoryEpoch:candidate.memoryEpoch});
  if(problem) return fail(problem);
  let result;
  const mutation = {...options,sessionId:candidate.sessionId,expectedVersion:candidate.targetVersion,text:candidate.text,source:candidate.source};
  if(candidate.action === 'edit') result=editMemory(state,candidate.memoryId,mutation);
  else if(candidate.action === 'delete') result=deleteMemory(state,candidate.memoryId,mutation);
  else {
    const row={id:randomUUID(),sessionId:candidate.sessionId,scope:'session',status:'approved',version:1,text:candidate.text,
      source:structuredClone(candidate.source),createdAt:stamp(options.now),approvedAt:stamp(options.now),history:[]};
    state.memories.push(row); result={ok:true,code:'approved',memory:normalized(row)};
  }
  if(!result.ok) return result;
  candidate.status='approved'; candidate.resolvedAt=stamp(options.now); candidate.approvedMemoryId=result.memory?.id ?? candidate.memoryId;
  return result;
}
export function rejectMemory(state,id,options={}) {
  init(state); if(!owner(options.actor)) return fail('owner_required');
  const candidate=state.memoryCandidates.find(x=>x.id===id && x.status==='pending');
  if(!candidate || (options.sessionId && candidate.sessionId!==options.sessionId)) return fail('candidate_not_found');
  candidate.status='rejected'; candidate.resolvedAt=stamp(options.now);
  return {ok:true,code:'rejected',id};
}
export function queryMemories(state,{sessionId,actor,includeCandidates=false}={}) {
  const rows=(state.memories ?? []).filter(x=>x.sessionId===sessionId && publicRow(x)).map(normalized);
  // History and original source sentences are owner-only. Filter before model access.
  if(!owner(actor)) for(const row of rows) { delete row.history; row.source={kind:row.source.kind,eventId:row.source.eventId ?? null}; }
  if(includeCandidates && owner(actor)) return {memories:rows,candidates:(state.memoryCandidates ?? []).filter(x=>x.sessionId===sessionId && x.status==='pending').map(x=>structuredClone(x))};
  return rows;
}
