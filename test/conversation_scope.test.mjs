import test from 'node:test';
import assert from 'node:assert/strict';
import {CONVERSATION_SCOPE_POLICY,getAuthorizedWechatScopes,isAuthorizedWechatTarget,assertAuthorizedWechatTarget,filterAuthorizedWechatTargets,inspectConversationScope,assertConversationScope,assertScopedNativeRequest} from '../src/conversation_scope.mjs';

const targets=()=>getAuthorizedWechatScopes().map(target=>({...target,enabled:true,mode:'mentions'}));
const session=(extra={})=>({id:'session_abao',title:'Example Group A',channel:'desktop_wechat',accountId:'Example Account',peerId:'group_abao',messages:[],...extra});

test('only exact authorized id/name/group triples match; settings and approvals on a target cannot broaden scope',()=>{
  assert.match(CONVERSATION_SCOPE_POLICY,/owner_configured_targets_v1/);
  for(const target of targets())assert.equal(isAuthorizedWechatTarget(target),true);
  for(const target of [null,{id:'group_abao',name:'另一个群',kind:'group'},{id:'other',name:'Example Group A',kind:'group'},{id:'group_abao',name:'Example Group A',kind:'contact'},{id:'group_abao',name:'Example Group A ',kind:'group'},{id:'friend',name:'朋友',kind:'contact',ownerApproved:true,authorized:true,allowCloud:true},{id:'group_family',name:'Example Group A',kind:'group'}])assert.equal(isAuthorizedWechatTarget(target),false,JSON.stringify(target));
  assert.throws(()=>assertAuthorizedWechatTarget({id:'x',name:'private value',kind:'group'}),error=>error.code==='conversation_scope_denied'&&!error.message.includes('private value'));
});
test('returned registry and filter results cannot mutate authorization',()=>{
  const grants=getAuthorizedWechatScopes();grants[0].name='第三个群';grants.push({id:'x',name:'第三个群',kind:'group'});assert.equal(isAuthorizedWechatTarget(grants[0]),false);assert.equal(getAuthorizedWechatScopes().length,2);
  const original=targets(),filtered=filterAuthorizedWechatTargets(original);filtered[0].name='changed';assert.equal(original[0].name,'Example Group A');assert.equal(getAuthorizedWechatScopes()[0].name,'Example Group A');
});
test('filter excludes unauthorized, disabled when requested, and ambiguous duplicate configuration',()=>{
  assert.deepEqual(filterAuthorizedWechatTargets(undefined),[]);
  const all=[...targets(),{id:'other',name:'其他',kind:'group',enabled:true}];assert.equal(filterAuthorizedWechatTargets(all).length,2);
  all[1].enabled=false;assert.equal(filterAuthorizedWechatTargets(all,{enabledOnly:true}).length,1);assert.equal(filterAuthorizedWechatTargets(all).length,2);
  const duplicate=[...targets(),{id:'group_abao',name:'改名目标',kind:'group'}];assert.deepEqual(filterAuthorizedWechatTargets(duplicate).map(t=>t.id),['group_family']);
  const nameClash=[...targets(),{id:'other',name:'Example Group B',kind:'contact'}];assert.deepEqual(filterAuthorizedWechatTargets(nameClash).map(t=>t.id),['group_abao']);
});
test('session cloud context requires exact group mapping, account and current title',()=>{
  const scopes=targets();assert.equal(inspectConversationScope(session(),scopes).allowed,true);
  for(const change of [{title:'其他群'},{accountId:'Primary Account'},{peerId:'other'},{channel:'qq'},{id:''}])assert.equal(inspectConversationScope(session(change),scopes).allowed,false);
  assert.equal(inspectConversationScope(session(),[...scopes,{...scopes[0]}]).allowed,false);
  assert.throws(()=>assertConversationScope(session({peerId:'other'}),scopes),{code:'conversation_scope_denied'});
});
test('different context/request session ids cannot be smuggled through an approved destination',()=>{
  assert.equal(inspectConversationScope(session({context:{sessionId:'session_abao'},request:{text:'hello'}}),targets()).allowed,true);
  assert.equal(inspectConversationScope(session({context:{sessionId:'private_session'}}),targets()).allowed,false);
  assert.equal(inspectConversationScope(session({request:{sessionId:'private_session',text:'private'}}),targets()).allowed,false);
});
test('local manual owner chat is separate and does not authorize copied WeChat bindings or origin',()=>{
  const local={id:'local',channel:'local',title:'试聊',peerId:'',accountId:'',messages:[]};
  assert.equal(inspectConversationScope(local,targets()).allowed,false);assert.equal(inspectConversationScope(local,targets(),{allowLocalOwner:true}).allowed,true);
  for(const extra of [{peerId:'group_abao'},{accountId:'Example Account'},{context:{sessionId:'local'}},{messages:[{source:'wechat',text:'copied'}]}])assert.equal(inspectConversationScope({...local,...extra},targets(),{allowLocalOwner:true}).allowed,false);
});
test('native connect needs explicit ids and permits only one or both approved unique targets',()=>{
  assert.equal(assertScopedNativeRequest('connect',{targets:targets()}),true);assert.equal(assertScopedNativeRequest('connect',{targets:targets().slice(0,1)}),true);
  for(const supplied of [[],[{name:'Example Group B',kind:'group'}],[...targets(),{id:'other',name:'其他群',kind:'group'}],[targets()[0],targets()[0]]])assert.throws(()=>assertScopedNativeRequest('connect',{targets:supplied}),{code:'conversation_scope_denied'});
});
test('native read/open/send cannot use partial names, contacts, extra targets or unknown commands',()=>{
  for(const command of ['read','open','send','probe_input'])for(const target of targets())assert.equal(assertScopedNativeRequest(command,{group:target.name}),true);
  for(const command of ['read','open','send','probe_input'])for(const group of ['合家','Example Group B ','其他群','文件传输助手','Example Group A(8)'])assert.throws(()=>assertScopedNativeRequest(command,{group}),{code:'conversation_scope_denied'});
  for(const command of ['health','stop'])assert.equal(assertScopedNativeRequest(command),true);
  assert.throws(()=>assertScopedNativeRequest('dump_all_chats',{}),{code:'conversation_scope_denied'});
});
test('prototype values and getters are not accepted as scope identity fields',()=>{
  const inherited=Object.create(targets()[0]);assert.equal(isAuthorizedWechatTarget(inherited),false);
  const getter={name:'Example Group B',kind:'group',get id(){throw Error('must not call');}};assert.equal(isAuthorizedWechatTarget(getter),false);
});
