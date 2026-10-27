import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {callCompatible} from '../src/compatible_api.mjs';
import {deployment} from '../src/deployment_config.mjs';
import {Companion} from '../src/core.mjs';
import {ModelHealth,ModelCallError,classifyModelFailure} from '../src/model_health.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(condition){const end=Date.now()+2000;while(!condition()){assert.ok(Date.now()<end,'synthetic core completion timeout');await tick();}}
function fixture(t,model){
 const root=fs.mkdtempSync(path.join(path.resolve('temp'),'model_recovery_'));
 fs.mkdirSync(path.join(root,'temp'));fs.writeFileSync(path.join(root,'character_card.json'),JSON.stringify({schema_version:1,id:'xiaoxi',name:'小汐',identity:'Synthetic test character',core:['Synthetic fixture'],voice:['Direct']}));
 const clock={now:Date.parse('2026-10-26T12:00:00Z')},sent=[],models=[];
 const core=new Companion({root,codec:{encode:x=>Buffer.from(x),decode:x=>x.toString()},nowMs:()=>clock.now,model:async args=>{models.push(args.settings.model);return model(args);},weather:null,voice:{status:async()=>({ready:false}),generate:async()=>({kind:'none'})}});
 core.store.change(s=>{s.settings.model='owner-recovery-model';});
 core.schedule=()=>{};core.running=true;core.modelState={stage:'ready'};
 core.bridge={child:{},async kill(){this.child=null;},async call(command,fields){if(command==='send'){sent.push(fields);return {status:'local_echo',ids:[`fake-${sent.length}`]};}return {healthy:true};}};
 const snap={pid:20,created:100,hwnd:1,messages:[]};
 const ingest=(id,which=0)=>core.ingest(core.store.value.targets[which],{id,text:`小汐，回答新的测试问题 ${id}`,klass:'mmui::ChatTextItemView'},snap);
 t.after(async()=>{await core.stop();await tick();assert.equal(path.dirname(root),path.resolve('temp'));fs.rmSync(root,{recursive:true,force:true});});
 return {core,clock,sent,models,ingest,done:()=>until(()=>core.processing.size===0)};
}
test('short model outage recovers on a later fresh group request without manual check or replay',async t=>{
 let calls=0;const seen=[];const f=fixture(t,async args=>{calls++;seen.push(args.session.request?.text);if(calls===1)throw Error('Connection error SYNTHETIC_PRIVATE');return {text:'仅回答这条新请求'};});
 await assert.rejects(f.core.checkModel(),error=>error.code==='model_network_error');assert.equal(f.core.modelState.stage,'error');assert.equal(f.core.snapshot().modelHealth.retryAfterMs,2000);
 f.ingest('during_backoff');await f.done();assert.equal(calls,1);assert.equal(f.core.store.value.inbox.at(-1).status,'skipped');assert.equal(f.sent.length,0);
 f.clock.now+=2000;f.ingest('after_network_recovered');await f.done();assert.equal(calls,2);assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,'仅回答这条新请求');assert.match(seen.at(-1),/after_network_recovered/);assert.ok(!seen.at(-1).includes('during_backoff'));assert.equal(f.core.pending.get(f.core.sessionFor('group_abao').id)?.length??0,0);
 const health=f.core.snapshot().modelHealth;assert.equal(health.phase,'closed');assert.equal(health.failures,0);assert.ok(health.lastSuccessAt);assert.ok(health.lastFailureAt);assert.equal(health.lastFailureCode,'model_network_error');assert.equal(f.core.modelState.stage,'ready');assert.deepEqual(new Set(f.models),new Set(['owner-recovery-model']));assert.ok(!JSON.stringify(f.core.snapshot()).includes('SYNTHETIC_PRIVATE'));
});
test('repeated failures back off no longer than 30 seconds and never self-poll or post errors',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;throw Object.assign(Error('network synthetic-sensitive'),{code:'ECONNRESET'});});
 await assert.rejects(f.core.checkModel());
 for(let i=0;i<8;i++){
  const before=calls,health=f.core.snapshot().modelHealth;assert.ok(health.retryAfterMs>0&&health.retryAfterMs<=30000);f.clock.now=health.retryAt;f.ingest(`attempt_${i}`);await f.done();assert.equal(calls,before+1);const failed=f.core.snapshot().modelHealth;assert.equal(failed.phase,'open');assert.ok(failed.retryAfterMs<=30000);f.ingest(`blocked_${i}`);await f.done();assert.equal(calls,before+1);assert.equal(f.sent.length,0);
 }
 const last=calls;await tick();await tick();assert.equal(calls,last);assert.equal(f.core.snapshot().modelHealth.retryAfterMs,30000);assert.ok(!JSON.stringify(f.core.store.value.events).includes('synthetic-sensitive'));
});
test('half-open recovery permits only one model request across both authorized groups',async t=>{
 let calls=0,resolveRecovery;const f=fixture(t,async()=>{calls++;if(calls===1)throw Error('Connection error');if(calls===2)return new Promise(resolve=>{resolveRecovery=resolve;});return {text:'新一轮恢复后的回答'};});
 await assert.rejects(f.core.checkModel());f.clock.now=f.core.snapshot().modelHealth.retryAt;f.ingest('half_open_A',0);await until(()=>calls===2);assert.equal(f.core.snapshot().modelHealth.phase,'half_open');f.ingest('concurrent_B',1);await tick();assert.equal(calls,2);assert.equal(f.core.store.value.inbox.at(-1).status,'skipped');
 resolveRecovery({text:'半开成功'});await f.done();assert.equal(f.sent.length,1);await tick();assert.equal(calls,2,'the skipped old request must not replay');f.ingest('new_B_after_success',1);await f.done();assert.equal(calls,3);assert.equal(f.sent.length,2);assert.equal(f.core.snapshot().modelHealth.phase,'closed');
});
test('stop aborts half-open recovery, does not count a failure, and suppresses late send',async t=>{
 let calls=0,resolveRecovery,activeSignal;const f=fixture(t,async args=>{calls++;if(calls===1)throw Error('Connection error');activeSignal=args.signal;return new Promise(resolve=>{resolveRecovery=resolve;});});
 await assert.rejects(f.core.checkModel());const before=f.core.snapshot().modelHealth;f.clock.now=before.retryAt;f.ingest('will_be_cancelled');await until(()=>calls===2);await f.core.stop();assert.equal(activeSignal.aborted,true);assert.notEqual(f.core.snapshot().modelHealth.phase,'half_open');resolveRecovery({text:'迟到正文不得发送'});await f.done();assert.equal(f.sent.length,0);const after=f.core.snapshot().modelHealth;assert.equal(after.failures,before.failures);assert.equal(after.lastFailureAt,before.lastFailureAt);assert.equal(after.lastSuccessAt,null);assert.equal(f.core.store.value.inbox.at(-1).status,'skipped');
});
test('authentication and unknown failures are action-required, safe, and explicit checks can restore them',async t=>{
 for(const [error,code] of [[Error('401 invalid token SECRET'),'model_auth_required'],[Error('unexpected response SECRET'),'model_generation_failed']]){
  let bad=true,calls=0;const f=fixture(t,async()=>{calls++;if(bad)throw error;return {text:'恢复确认'};});await assert.rejects(f.core.checkModel(),e=>e.code===code);assert.equal(f.core.snapshot().modelHealth.phase,'action_required');f.clock.now+=600000;f.ingest(`blocked_${code}`);await f.done();assert.equal(calls,1);assert.equal(f.sent.length,0);assert.ok(!JSON.stringify(f.core.snapshot()).includes('SECRET'));bad=false;await f.core.checkModel();assert.equal(calls,2);assert.equal(f.core.modelState.stage,'ready');
 }
});
test('safe failure categories and circuit timing retain no external error body',()=>{
 assert.equal(classifyModelFailure('stream disconnected before completion: SECRET'),'model_network_error');assert.equal(classifyModelFailure('Cloudflare edge 403 SECRET'),'model_network_error');assert.equal(classifyModelFailure('当前模型超过两分钟未完成'),'model_timeout');assert.equal(classifyModelFailure('unexpected argument --bad SECRET'),'model_configuration_error');
 let now=0;const h=new ModelHealth({nowMs:()=>now});let token=h.begin();h.failure(token,new ModelCallError('model_network_error'));assert.throws(()=>h.begin(),e=>e.code==='model_backoff');now=2000;token=h.begin();assert.throws(()=>h.begin(),e=>e.code==='model_recovery_busy');h.success(token);assert.equal(h.snapshot().phase,'closed');
});

test('startup connects local transport immediately with zero cloud self-check calls',async t=>{
 let models=0;const f=fixture(t,async()=>{models++;return {text:'新输入的真实模型回答'};});f.core.running=false;f.core.modelState={stage:'unchecked'};const commands=[];
 f.core.transportFactory=()=>({child:{},start(){commands.push('start');},async kill(){this.child=null;},async call(command,fields){commands.push(command);if(command==='connect')return {account:deployment.account.displayName,pid:20,created:100,version:'4.1.15.56'};if(command==='send'){f.sent.push(fields);return {status:'local_echo',ids:['synthetic-start-send']};}return {pid:20,created:100,hwnd:fields?.group===deployment.targets[0].name?1:2,windowBinding:'ChatSingleWindowSynthetic'+fields?.group,messages:[]};}});
 await f.core.start();assert.equal(models,0);assert.equal(f.core.connection.stage,'connected');assert.equal(f.core.modelState.stage,'unchecked');assert.equal(f.core.activeModelCalls.size,0);assert.ok(commands.includes('connect'));assert.equal(commands.filter(x=>x==='open').length,2);
 // Use the established local bindings; the first real new request does the only model verification.
 f.ingest('first_real_new_request');await f.done();assert.equal(models,1);assert.equal(f.sent.length,1);assert.equal(f.core.store.value.inbox.at(-1).status,'completed');assert.equal(f.core.modelState.stage,'ready');assert.ok(f.core.snapshot().modelHealth.lastSuccessAt);assert.equal(f.core.snapshot().modelHealth.lastFailureAt,null);
});
test('unchecked ordinary chat keeps cross-group concurrency and rejects duplicate manual self-check',async t=>{
 const releases=[];let calls=0;const f=fixture(t,async()=>{calls++;return new Promise(resolve=>releases.push(resolve));});f.core.modelState={stage:'unchecked'};
 f.ingest('new_A',0);await until(()=>calls===1);assert.equal(f.core.modelState.stage,'unchecked');await assert.rejects(f.core.checkModel(),e=>e.code==='model_busy');assert.equal(calls,1);assert.equal(f.core.controllers.has('model_check'),false);
 f.ingest('new_B',1);await until(()=>calls===2);assert.equal(f.core.activeModelCalls.size,2);releases.forEach(resolve=>resolve({text:'合成正常答复'}));await f.done();assert.equal(calls,2);assert.equal(f.sent.length,2);assert.equal(f.core.modelState.stage,'ready');
});
test('explicit self-check stays available, mutually excludes chat, and emits safe skip reason',async t=>{
 let release,calls=0;const f=fixture(t,async()=>{calls++;return new Promise(resolve=>{release=resolve;});});f.core.modelState={stage:'unchecked'};const checking=f.core.checkModel();await until(()=>calls===1);assert.equal(f.core.modelState.stage,'checking');
 f.ingest('during_explicit_selfcheck');await tick();assert.equal(calls,1);assert.equal(f.core.store.value.inbox.at(-1).status,'skipped');assert.equal(f.core.store.value.inbox.at(-1).reason,'model_self_check_busy');const local=f.core.store.value.sessions.find(s=>s.channel==='local');await assert.rejects(f.core.localChat(local.id,'合成新问题'),e=>e.code==='model_self_check_busy');assert.equal(calls,1);
 release({text:'独立自检成功'});await checking;assert.equal(f.core.modelState.stage,'ready');assert.equal(f.sent.length,0);assert.equal(f.core.controllers.has('model_check'),false);assert.equal(f.core.activeModelCalls.size,0);
});

test('compatible API transient HTTP failures recover through the same core on fresh input',async t=>{
 let calls=0;const submitted=[];
 const f=fixture(t,args=>callCompatible({settings:args.settings,messages:[],signal:args.signal,env:{},fetchImpl:async(_url,options)=>{calls++;submitted.push(JSON.parse(options.body));return calls===1?new Response('synthetic-secret',{status:503}):new Response(JSON.stringify({choices:[{message:{content:'API recovery answer'}}]}),{headers:{'content-type':'application/json'}});}}));
 f.core.store.change(s=>Object.assign(s.settings,{provider:'compatible',model:'owner-api-model',baseUrl:'http://127.0.0.1:9999/v1',apiKey:'',apiKeyEnv:'',retries:0,stream:false,maxOutputTokens:234,outputTokenField:'max_tokens'}));
 await assert.rejects(f.core.checkModel(),{code:'model_api_http_503'});assert.equal(f.core.snapshot().modelHealth.actionRequired,false);assert.ok(!JSON.stringify(f.core.snapshot()).includes('synthetic-secret'));
 f.clock.now=f.core.snapshot().modelHealth.retryAt;f.ingest('api_network_restored');await f.done();assert.equal(calls,2);assert.equal(f.sent.length,1);assert.equal(f.core.modelState.stage,'ready');assert.equal(f.core.snapshot().modelHealth.phase,'closed');assert.ok(submitted.every(x=>x.model==='owner-api-model'&&x.max_tokens===234));
});
test('safe API categories preserve diagnostics and distinguish transient errors from owner action',()=>{
 for(const code of ['api_timeout','api_connection_failed','api_stream_incomplete','model_api_http_429','model_api_http_502']){const h=new ModelHealth({nowMs:()=>0});h.failure(h.begin(),Object.assign(Error('sensitive'),{code}));assert.equal(h.snapshot().lastErrorCode,code);assert.equal(h.snapshot().actionRequired,false);assert.equal(h.snapshot().retryAfterMs,2000);}
 for(const code of ['api_invalid_json','api_invalid_stream_packet','api_key_environment_missing','model_api_http_401','model_api_http_403','model_api_http_404']){const h=new ModelHealth({nowMs:()=>0});h.failure(h.begin(),Object.assign(Error('sensitive'),{code}));assert.equal(h.snapshot().lastErrorCode,code);assert.equal(h.snapshot().actionRequired,true);}
 assert.equal(classifyModelFailure(Object.assign(Error('sensitive body'),{name:'TimeoutError'})),'model_timeout');assert.equal(classifyModelFailure(Object.assign(Error('sensitive body'),{code:'external_secret_code'})),'model_generation_failed');
});
test('saving owner model settings clears stale backend failure without cloud calls or changing authorization',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;if(calls===1)throw Error('401 synthetic-secret');return {text:'new provider success'};});await assert.rejects(f.core.checkModel());assert.equal(f.core.snapshot().modelHealth.actionRequired,true);const targets=structuredClone(f.core.store.value.targets);
 await f.core.dispatch('settings.save',{provider:'mock',model:'owner-new-model',aliases:['小汐'],allowSearch:false});assert.equal(calls,1);assert.equal(f.core.modelState.stage,'unchecked');assert.equal(f.core.snapshot().modelHealth.phase,'unverified');assert.deepEqual(f.core.store.value.targets,targets);
 const local=f.core.store.value.sessions.find(s=>s.channel==='local');await f.core.localChat(local.id,'synthetic new settings request');assert.equal(calls,2);assert.equal(f.models.at(-1),'owner-new-model');assert.equal(f.core.modelState.stage,'ready');
});

test('capacity, quota and HTTP500 are recoverable safe categories for generic providers',()=>{
 for(const message of ['Selected model is at capacity','server busy','upstream overloaded','usage limit reached','insufficient_quota']){assert.equal(classifyModelFailure(message),'model_rate_limited');const h=new ModelHealth({nowMs:()=>0});h.failure(h.begin(),Error(message));assert.equal(h.snapshot().actionRequired,false);assert.equal(h.snapshot().retryAfterMs,2000);}
 assert.equal(classifyModelFailure('HTTP 500'),'model_network_error');
});
