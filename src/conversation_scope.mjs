import {deployment} from './deployment_config.mjs';
// Immutable authorization loaded from the local owner configuration; groups may be read or
// used as cloud context. Deployment code is the authority, never chat text,
// stored target configuration or a caller-provided additional allowlist.
// Future explicit owner grants can extend this versioned registry in a reviewed
// deployment; there is deliberately no runtime "add authorized target" API.
export const CONVERSATION_SCOPE_POLICY='owner_configured_targets_v1';
const APPROVED=Object.freeze(deployment.targets.map(target=>Object.freeze({...target})));
const own = (object,key) => {
  if(!object||typeof object!=='object'||Array.isArray(object))return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(object,key);
  return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
};
const denied = reason => ({allowed:false,reason,policy:CONVERSATION_SCOPE_POLICY});
function scopeError(reason) {
  const error=new Error('当前会话未获本机配置授权');
  error.code='conversation_scope_denied';error.reason=reason;return error;
}
function approvedFor(target) {
  return APPROVED.find(scope=>own(target,'id')===scope.id&&own(target,'name')===scope.name&&own(target,'kind')===scope.kind)??null;
}
function uniqueConfigured(target,targets) {
  const id=own(target,'id'),name=own(target,'name');
  return targets.filter(row=>own(row,'id')===id).length===1&&targets.filter(row=>own(row,'name')===name).length===1;
}

export function getAuthorizedWechatScopes() { return APPROVED.map(scope=>({...scope})); }
export function isAuthorizedWechatTarget(target) { return !!approvedFor(target); }
export function assertAuthorizedWechatTarget(target) {
  const scope=approvedFor(target);if(!scope)throw scopeError('wechat_target_unapproved');return {...scope};
}
export function filterAuthorizedWechatTargets(targets,{enabledOnly=false}={}) {
  if(!Array.isArray(targets))return [];
  return targets.filter(target=>approvedFor(target)&&uniqueConfigured(target,targets)&&(!enabledOnly||own(target,'enabled')===true)).map(target=>structuredClone(target));
}

/** Validate a stored session before accepting data, model/search work or send. */
export function inspectConversationScope(session,targets,{allowLocalOwner=false}={}) {
  if(!session||typeof own(session,'id')!=='string'||!own(session,'id'))return denied('session_missing');
  const channel=own(session,'channel');
  if(channel==='local'){
    if(allowLocalOwner!==true)return denied('local_owner_action_required');
    const messages=own(session,'messages');
    if(messages!==undefined&&!Array.isArray(messages))return denied('local_message_shape_invalid');
    if(own(session,'peerId')||own(session,'accountId')||own(session,'context')||(messages??[]).some(item=>own(item,'source')==='wechat'))return denied('local_contains_wechat_binding');
    return {allowed:true,kind:'local_owner',policy:CONVERSATION_SCOPE_POLICY};
  }
  if(channel!=='desktop_wechat'||!Array.isArray(targets))return denied('unsupported_channel');
  const candidates=targets.filter(target=>own(target,'id')===own(session,'peerId'));
  if(candidates.length!==1)return denied('target_mapping_ambiguous');
  const target=candidates[0],scope=approvedFor(target);
  if(!scope||!uniqueConfigured(target,targets))return denied('wechat_target_unapproved');
  if(own(session,'title')!==scope.name||own(session,'accountId')!==deployment.account.displayName)return denied('session_binding_mismatch');
  const context=own(session,'context'),request=own(session,'request');
  if(context&&own(context,'sessionId')!==own(session,'id')||request&&own(request,'sessionId')!==undefined&&own(request,'sessionId')!==own(session,'id'))return denied('context_scope_mismatch');
  return {allowed:true,kind:'wechat_group',scope:{...scope},policy:CONVERSATION_SCOPE_POLICY};
}
export function assertConversationScope(session,targets,options) {
  const result=inspectConversationScope(session,targets,options);if(!result.allowed)throw scopeError(result.reason);return result;
}

/** Validate immediately before serializing a native command. Connect callers
 * must retain target ids, not discard them in the name/kind/peerId projection. */
export function assertScopedNativeRequest(command,fields={}) {
  if(own(fields,'command')!==undefined&&own(fields,'command')!==command)throw scopeError('native_command_mismatch');
  if(command==='health'||command==='stop')return true;
  if(command==='connect'){
    const targets=own(fields,'targets');
    if(!Array.isArray(targets)||targets.length<1||targets.length>APPROVED.length)throw scopeError('native_targets_invalid');
    for(const target of targets)if(!approvedFor(target)||!uniqueConfigured(target,targets))throw scopeError('native_target_unapproved');
    return true;
  }
  if(['open','read','send','probe_input'].includes(command)){
    if(!APPROVED.some(scope=>scope.name===own(fields,'group')))throw scopeError('native_group_unapproved');
    return true;
  }
  throw scopeError('native_command_unapproved');
}
