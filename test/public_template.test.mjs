import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {validateDeployment,loadDeployment,saveDeployment} from '../src/deployment_config.mjs';
import {Companion} from '../src/core.mjs';
import {ExtensionHost,UnsupportedCapability} from '../src/extension_host.mjs';
import {callCompatible} from '../src/compatible_api.mjs';
import {startPanel} from '../src/panel_server.mjs';
import {createRuntime} from '../src/runtime.mjs';
const root=path.resolve('.');
const codec={encode:x=>Buffer.from(x),decode:x=>x.toString()};
const resources=new WeakMap();function cleanup(t,fn){if(!resources.has(t))resources.set(t,[]);resources.get(t).push(fn);}
function fixture(t){const dir=fs.mkdtempSync(path.join(root,'temp/public_contract_'));fs.copyFileSync(path.join(root,'character_card.json'),path.join(dir,'character_card.json'));t.after(async()=>{for(const fn of (resources.get(t)??[]).reverse())await fn();assert.equal(path.dirname(dir),path.join(root,'temp'));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
const config=()=>({schemaVersion:1,account:{},character:{id:'xiaoxi',name:'小汐',aliases:['小汐']},targets:[],native:{enabled:false},model:{provider:'mock',model:'mock'},extensions:[]});
const settings=(extra={})=>({provider:'compatible',model:'chosen-model',baseUrl:'https://model.invalid/v1',stream:false,retries:0,...extra});
const result=text=>new Response(JSON.stringify({choices:[{message:{content:text}}]}),{headers:{'content-type':'application/json'}});

test('new deployment is empty and authorization is persisted only in the explicit owner file',t=>{
 const dir=fixture(t),file=path.join(dir,'deployment.local.json');assert.equal(loadDeployment(file).targets.length,0);assert.equal(loadDeployment(file).native.enabled,false);
 const value=config();value.targets=[{id:'team',name:'Example Team',kind:'group'}];assert.deepEqual(saveDeployment(value,file),{saved:true,restartRequired:true});assert.equal(loadDeployment(file).targets[0].name,'Example Team');
 assert.throws(()=>saveDeployment({...value,targets:[...value.targets,...value.targets]},file),/target_invalid/);assert.equal(loadDeployment(file).targets.length,1);
});
test('owner configuration rejects native contacts, traversal folders, credentials and incomplete media opt-in',()=>{
 const c=config();for(const mutation of [v=>v.account.folder='..',v=>v.model.apiKey='secret',v=>v.character.aliases=[''],v=>v.extensions=[{module:'./plugins/../escape.mjs'}],v=>{v.native.mediaCache=true;},v=>{v.native.enabled=true;v.account={displayName:'Bot',folder:'wxid_example'};v.targets=[{id:'friend',name:'Friend',kind:'contact'}];}]){const v=structuredClone(c);mutation(v);assert.throws(()=>validateDeployment(v));}
});
test('persona card, custom calls and style survive reopening and enter actual model inputs',async t=>{
 const dir=fixture(t);let seen;
 const core=new Companion({root:dir,codec,model:async args=>{seen=args;return {text:'hello'};}});cleanup(t,()=>core.stop());
 const persona={...core.persona,name:'River',identity:'A friendly fictional companion',preferences:['Likes quiet mornings']};
 await core.dispatch('persona.save',{persona,aliases:['River','溪溪'],style:'concise'});
 const session=core.store.value.sessions.find(s=>s.channel==='local');await core.dispatch('chat',{sessionId:session.id,text:'你好'});assert.equal(seen.persona.name,'River');assert.equal(seen.session.preferences.style,'concise');assert.deepEqual(core.policy.names,['River','溪溪']);
 const reopened=new Companion({root:dir,codec,model:async()=>({text:'ok'})});cleanup(t,()=>reopened.stop());assert.equal(reopened.persona.name,'River');assert.deepEqual(reopened.policy.names,['River','溪溪']);
 const before=fs.readFileSync(path.join(dir,'character_card.local.json'),'utf8');await assert.rejects(core.dispatch('persona.save',{persona,aliases:['']}));assert.equal(fs.readFileSync(path.join(dir,'character_card.local.json'),'utf8'),before);
});
test('custom aliases invoke the group reply policy and per-target timing is validated',async t=>{
 const dir=fixture(t),core=new Companion({root:dir,codec,model:async()=>({text:'ok'})});cleanup(t,()=>core.stop());
 await core.dispatch('persona.save',{persona:{...core.persona,name:'River'},aliases:['River']});
 const target=core.store.value.targets[0],session=core.sessionFor(target.id),event={id:'custom',sourceKey:'custom',text:'River，hello',receivedAt:Date.now(),sender:{evidence:'unknown'}};
 core.context.observe(session.id,event);assert.equal(core.policy.decide({...target,sessionId:session.id},event,core.context).action,'reply');
 await assert.rejects(core.dispatch('target.save',{...target,participation:{idleMs:1,maxMs:1800000}}),/participation_invalid/);
 await core.dispatch('target.save',{...target,participation:{idleMs:45000,maxMs:600000},preferences:{style:'detailed'}});assert.equal(core.store.value.targets[0].participation.idleMs,45000);
});
test('plugin v1 registration validates manifests, conflicts and missing capabilities',async()=>{
 const host=new ExtensionHost({root});await assert.rejects(host.call('asr',{}),UnsupportedCapability);
 await assert.rejects(host.register({apiVersion:2,id:'bad',capabilities:['model'],setup(){}}),/manifest_invalid/);
 await assert.rejects(host.register({apiVersion:1,id:'missing',capabilities:['model'],setup(){return {};}}),/handler_missing/);
 let called=0;await host.register({apiVersion:1,id:'test.echo',capabilities:['model'],setup:()=>({model:async({text})=>{called++;return {text};}})});assert.equal((await host.call('model',{text:'actual handler'})).text,'actual handler');assert.equal(called,1);
 await assert.rejects(host.register({apiVersion:1,id:'other',capabilities:['model'],setup(){}}),/registration_conflict/);
 await assert.rejects(new ExtensionHost({root}).load([{module:'../outside.mjs'}]),/path_invalid/);
});
test('trusted plugin file is loaded by runtime bootstrap and answers an actual core chat',t=>{
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'plugins'));fs.copyFileSync(path.join(root,'plugins/example_model.mjs'),path.join(dir,'plugins/example_model.mjs'));
 const c=config();c.extensions=[{module:'./plugins/example_model.mjs',options:{prefix:'PLUGIN: '}}];const file=path.join(dir,'deployment.local.json');saveDeployment(c,file);
 const code=`import {createRuntime} from ${JSON.stringify(pathToFileURL(path.join(root,'src/runtime.mjs')).href)};const r=await createRuntime({root:${JSON.stringify(dir)},codec:{encode:x=>Buffer.from(x),decode:x=>x.toString()}});const id=r.core.snapshot().sessions.find(x=>x.channel==='local').id;const text=await r.core.dispatch('chat',{sessionId:id,text:'hi plugin'});console.log(JSON.stringify({text,plugins:r.extensions.snapshot().plugins}));await r.close();`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',cwd:dir,env:{...process.env,XIAOXI_CONFIG:file},timeout:10000,windowsHide:true});assert.equal(child.status,0,child.stderr);const body=JSON.parse(child.stdout);assert.equal(body.text,'PLUGIN: hi plugin');assert.equal(body.plugins[0].id,'example.echo');
});
test('media and ASR extensions run through attachment provenance checks, without native extraction',async t=>{
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'plugins'));
 const wave='524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000';
 fs.writeFileSync(path.join(dir,'plugins/media.mjs'),`export default {apiVersion:1,id:'test.audio',capabilities:['media','asr'],setup:()=>({media:async x=>({...x,source:'owner_upload',mime:'audio/wav',bytes:Buffer.from('${wave}','hex')}),asr:async()=>({text:'synthetic transcript',confidence:0.99})})};`);
 const host=new ExtensionHost({root:dir});await host.load([{module:'./plugins/media.mjs'}]);
 const {createMediaService}=await import('../src/media_service.mjs');const media=createMediaService({resolveAttachment:x=>host.call('media',x),asr:x=>host.call('asr',x)});
 const actual=await media.analyze({sessionId:'session',messageId:'message',handle:'handle',kind:'audio'});assert.equal(actual.ok,true);assert.equal(actual.text,'synthetic transcript');assert.equal(actual.evidence,true);
});
test('compatible API honors selected model, endpoint and env key without returning the secret',async()=>{
 let request;const response=await callCompatible({settings:settings({apiKeyEnv:'MY_TEMPLATE_KEY'}),messages:[{role:'user',content:'hi'}],env:{MY_TEMPLATE_KEY:'synthetic-private-key'},fetchImpl:async(url,options)=>{request={url,options};return result('hello');}});
 assert.equal(request.url,'https://model.invalid/v1/chat/completions');assert.equal(request.options.headers.Authorization,'Bearer synthetic-private-key');assert.equal(JSON.parse(request.options.body).model,'chosen-model');assert.equal(response.text,'hello');assert.ok(!JSON.stringify(response).includes('synthetic-private-key'));
 await assert.rejects(callCompatible({settings:settings({apiKeyEnv:'MISSING'}),messages:[],env:{},fetchImpl:()=>assert.fail('must not fetch')}),/environment_missing/);
});
test('SSE receives fragmented Unicode deltas and only returns a completed answer',async()=>{
 const wire='data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"呀"}}]}\n\ndata: [DONE]\n\n';const bytes=Buffer.from(wire);const chunks=[];
 const stream=new ReadableStream({start(controller){for(let n=0;n<bytes.length;n+=3)controller.enqueue(bytes.subarray(n,n+3));controller.close();}});
 const r=await callCompatible({settings:settings({stream:true}),messages:[],onDelta:x=>chunks.push(x),fetchImpl:async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})});assert.equal(r.text,'你好呀');assert.deepEqual(chunks,['你好','呀']);
 await assert.rejects(callCompatible({settings:settings({stream:true}),messages:[],fetchImpl:async()=>new Response('data: {"choices":[{"delta":{"content":"draft"}}]}\n',{headers:{'content-type':'text/event-stream'}})}),/stream_incomplete/);
});
test('retry is bounded before output and never duplicates a partial stream',async()=>{
 let calls=0;const r=await callCompatible({settings:settings({retries:1}),messages:[],fetchImpl:async()=>++calls===1?new Response('',{status:503}):result('retry ok')});assert.equal(r.text,'retry ok');assert.equal(calls,2);
 calls=0;await assert.rejects(callCompatible({settings:settings({retries:2,stream:true}),messages:[],fetchImpl:async()=>{calls++;return new Response('data: {"choices":[{"delta":{"content":"draft"}}]}\n',{headers:{'content-type':'text/event-stream'}});}}),/incomplete/);assert.equal(calls,1);
});
test('cancellation and timeout abort compatible requests rather than publishing a late result',async()=>{
 const wait=async(_url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 const controller=new AbortController(),pending=callCompatible({settings:settings(),messages:[],signal:controller.signal,fetchImpl:wait});controller.abort();await assert.rejects(pending,{name:'AbortError'});
 // Keep a ref'ed timer in this synthetic fetch; real network sockets keep the loop alive.
 const keeper=setTimeout(()=>{},2000);try{await assert.rejects(callCompatible({settings:settings({timeoutMs:100}),messages:[],fetchImpl:wait}),{name:'TimeoutError'});}finally{clearTimeout(keeper);}
});
test('browser panel enforces Host, Origin, token, size, secret masking and safe response headers',async t=>{
 const dir=fixture(t),runtime=await createRuntime({root:dir,codec,demo:true});const panel=await startPanel({root,core:runtime.core,port:0});cleanup(t,async()=>{await panel.close();await runtime.close();});
 const boot=await fetch(panel.url+'/api/bootstrap');assert.equal(boot.headers.get('x-frame-options'),'DENY');assert.equal(boot.headers.get('cross-origin-resource-policy'),'same-origin');const {token}=await boot.json();
 const post=(action,payload={},headers={})=>fetch(panel.url+'/api/call',{method:'POST',headers:{Origin:panel.url,'Content-Type':'application/json','X-Xiaoxi-Token':token,...headers},body:JSON.stringify({action,payload})});
 assert.equal((await post('snapshot',{}, {Origin:'https://outside.invalid'})).status,403);assert.equal((await post('snapshot',{}, {'X-Xiaoxi-Token':'bad'})).status,403);const rawStatus=headers=>new Promise((resolve,reject)=>{const req=http.get(panel.url+'/api/bootstrap',{headers},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(await rawStatus({Host:'outside.invalid'}),403);assert.equal(await rawStatus({'Sec-Fetch-Site':'cross-site'}),403);
 assert.equal((await post('snapshot',{text:'x'.repeat(270000)})).status,413);
 const saved=await post('settings.save',{provider:'compatible',model:'chosen-model',baseUrl:'https://model.invalid',apiKey:'synthetic-secret'});assert.equal(saved.status,400);assert.ok(!(await saved.text()).includes('synthetic-secret'));
 runtime.core.store.change(s=>{s.settings.apiKey='synthetic-secret';});const state=await post('snapshot').then(x=>x.json());assert.equal(state.result.settings.hasApiKey,true);assert.ok(!JSON.stringify(state).includes('synthetic-secret'));
 const html=await fetch(panel.url).then(x=>x.text());assert.match(html,/browser_bridge.js/);assert.match(html,/id="persona-form"/);assert.match(html,/id="deployment-form"/);
});
test('demo cannot be used to turn on cloud search or native transport',async t=>{
 const dir=fixture(t),runtime=await createRuntime({root:dir,codec,demo:true}),panel=await startPanel({core:runtime.core,root,port:0,demo:true});cleanup(t,async()=>{await panel.close();await runtime.close();});const {token}=await fetch(panel.url+'/api/bootstrap').then(x=>x.json());
 for(const [action,payload] of [['start',{}],['settings.save',{provider:'codex',model:'x'}],['settings.save',{provider:'mock',model:'mock',allowSearch:true}],['extension.call',{capability:'model'}]]){const res=await fetch(panel.url+'/api/call',{method:'POST',headers:{Origin:panel.url,'Content-Type':'application/json','X-Xiaoxi-Token':token},body:JSON.stringify({action,payload})});assert.equal(res.status,400);assert.match(await res.text(),/demo_mock_only/);}
});
test('Python owner registry reads the same file and remains empty without configuration',{skip:!process.env.XIAOXI_TEST_PYTHON?'Python unavailable':false},t=>{
 const dir=fixture(t),c=config();c.targets=[{id:'custom',name:'Synthetic Group',kind:'group'}];const file=path.join(dir,'deployment.local.json');saveDeployment(c,file);
 const code=`import sys,json;sys.path.insert(0,${JSON.stringify(path.join(root,'scripts'))});from owner_config import AUTHORIZED_GROUPS;print(json.dumps(AUTHORIZED_GROUPS))`;
 const run=cfg=>spawnSync(process.env.XIAOXI_TEST_PYTHON,['-B','-c',code],{encoding:'utf8',cwd:dir,env:{...process.env,XIAOXI_CONFIG:cfg},windowsHide:true,timeout:10000});let r=run(file);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{custom:'Synthetic Group'});r=run(path.join(dir,'missing.json'));assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{});
});

test('API JSON responses are bounded and configurable output-token fields pass through unchanged',async()=>{
 let wire;await callCompatible({settings:settings({maxOutputTokens:400,outputTokenField:'max_tokens'}),messages:[],fetchImpl:async(_u,o)=>{wire=JSON.parse(o.body);return result('ok');}});assert.equal(wire.max_tokens,400);assert.equal(wire.max_completion_tokens,undefined);
 await assert.rejects(callCompatible({settings:settings(),messages:[],fetchImpl:async()=>new Response('x'.repeat(2*1024*1024+1),{headers:{'content-type':'application/json'}})}),/api_output_limit/);
});

test('demo ignores configured plugin setup before any code can execute',t=>{
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'plugins'));fs.writeFileSync(path.join(dir,'plugins/must_not_run.mjs'),`throw Error('PLUGIN_WAS_EXECUTED');`);
 const c=config();c.extensions=[{module:'./plugins/must_not_run.mjs'}];const file=path.join(dir,'deployment.local.json');saveDeployment(c,file);
 const code=`import {createRuntime} from ${JSON.stringify(pathToFileURL(path.join(root,'src/runtime.mjs')).href)};const r=await createRuntime({root:${JSON.stringify(dir)},demo:true,codec:{encode:x=>Buffer.from(x),decode:x=>x.toString()}});console.log(JSON.stringify(r.extensions.snapshot()));await r.close();`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',cwd:dir,env:{...process.env,XIAOXI_CONFIG:file},timeout:10000,windowsHide:true});assert.equal(child.status,0,child.stderr);const body=JSON.parse(child.stdout);assert.deepEqual(body.plugins,[]);assert.equal(body.disabledConfiguredPlugins,1);
});

test('deployment cache IDs never become UIA window bindings and generation defaults retain token settings',t=>{
 const dir=fixture(t),c=config();c.account={displayName:'Example Account',folder:'wxid_example_0000',cacheRoot:path.join(dir,'cache'),wxid:'wxid_example'};c.targets=[{id:'team',name:'Synthetic Team',kind:'group',wechatPeerId:'10000001@chatroom'}];c.native={enabled:true,mediaCache:true,allowModuleDataScan:false};c.model={provider:'mock',model:'mock',maxOutputTokens:731,outputTokenField:'max_tokens'};
 const file=path.join(dir,'deployment.local.json');saveDeployment(c,file);assert.equal(loadDeployment(file).targets[0].wechatPeerId,'10000001@chatroom');assert.throws(()=>validateDeployment({...c,targets:[{...c.targets[0],peerId:'10000001@chatroom'}]}),/target_invalid/);
 const code=`import {initialState} from ${JSON.stringify(pathToFileURL(path.join(root,'src/store.mjs')).href)};const s=initialState();console.log(JSON.stringify({target:s.targets[0],settings:s.settings}));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',cwd:dir,env:{...process.env,XIAOXI_CONFIG:file},windowsHide:true,timeout:10000});assert.equal(child.status,0,child.stderr);const body=JSON.parse(child.stdout);assert.equal(body.target.wechatPeerId,'10000001@chatroom');assert.equal(body.target.windowBinding,undefined);assert.equal(body.target.peerId,undefined);assert.equal(body.settings.maxOutputTokens,731);assert.equal(body.settings.outputTokenField,'max_tokens');
 if(process.env.XIAOXI_TEST_PYTHON){const p=spawnSync(process.env.XIAOXI_TEST_PYTHON,['-B','-c',`import sys,json;sys.path.insert(0,${JSON.stringify(path.join(root,'scripts'))});from owner_config import CONFIG;print(json.dumps(CONFIG['targets'][0]))`],{encoding:'utf8',env:{...process.env,XIAOXI_CONFIG:file},windowsHide:true,timeout:10000});assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).wechatPeerId,'10000001@chatroom');}
});
test('unconfigured and demo snapshots do not advertise live image or transcript channels',async t=>{
 const dir=fixture(t),r=await createRuntime({root:dir,codec,demo:true});cleanup(t,()=>r.close());const c=r.core.snapshot().mediaCapabilities;assert.equal(c.imageInput,false);assert.equal(c.imageUnderstanding,false);assert.equal(c.groupCacheCandidates,false);assert.equal(c.platformTranscript,false);assert.equal(c.modelVision,false);assert.equal(c.nativeStatus,'disabled_demo');
});

test('media-enabled owner configuration connects using only runtime UIA binding while keeping cache ID separate',t=>{
 const dir=fixture(t),c=config();c.account={displayName:'Example Account',folder:'wxid_example_0000',cacheRoot:path.join(dir,'cache'),wxid:'wxid_example'};c.targets=[{id:'team',name:'Synthetic Team',kind:'group',wechatPeerId:'10000001@chatroom'}];c.native={enabled:true,mediaCache:true,allowModuleDataScan:false};const file=path.join(dir,'deployment.local.json');saveDeployment(c,file);
 const code=`import {Companion} from ${JSON.stringify(pathToFileURL(path.join(root,'src/core.mjs')).href)};import {EventEmitter} from 'node:events';const wire=[];class Bridge extends EventEmitter{start(){}async call(command,fields){wire.push({command,fields});if(command==='connect')return {account:'Example Account',pid:20,created:100};return {pid:20,created:100,hwnd:1,windowBinding:'ChatSingleWindow123',messages:[]};}async kill(){}};const core=new Companion({root:${JSON.stringify(dir)},codec:{encode:x=>Buffer.from(x),decode:x=>x.toString()},voice:{status:async()=>({ready:false})},model:async()=>({text:'mock'}),transportFactory:()=>new Bridge()});core.modelState.stage='ready';await core.start();const state=core.snapshot();console.log(JSON.stringify({wire,target:state.targets[0],session:state.sessions.find(s=>s.channel==='desktop_wechat'),capabilities:state.mediaCapabilities,connection:state.connection.stage}));await core.stop();`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',cwd:dir,env:{...process.env,XIAOXI_CONFIG:file},windowsHide:true,timeout:10000});assert.equal(child.status,0,child.stderr);const body=JSON.parse(child.stdout),connect=body.wire.find(x=>x.command==='connect');assert.equal(body.connection,'connected');assert.equal(connect.fields.targets[0].wechatPeerId,undefined);assert.equal(connect.fields.targets[0].peerId,undefined);assert.equal(body.target.windowBinding,'ChatSingleWindow123');assert.equal(body.target.wechatPeerId,'10000001@chatroom');assert.equal(body.session.peerId,'team');assert.equal(body.capabilities.groupCacheCandidates,false);assert.equal(body.capabilities.imageUnderstanding,false);
});

test('isolated Codex search keeps the owner model and timeout without forwarding secrets',async()=>{
 const {generateSearch}=await import('../src/model.mjs');let received;
 await generateSearch({query:'synthetic public query',settings:{provider:'codex',model:'owner-selected',timeoutMs:1234,apiKey:'private-key',baseUrl:'private-address'},root},async args=>{received=args;return {text:'MOCK evidence https://example.com/mock',searchUsed:true};});
 assert.equal(received.settings.model,'owner-selected');assert.equal(received.settings.timeoutMs,1234);assert.equal(received.settings.webSearch,true);assert.equal(received.settings.apiKey,undefined);assert.equal(received.settings.baseUrl,undefined);assert.deepEqual(received.memories,[]);assert.deepEqual(received.session.messages,[]);
});
test('registered search plugin serves compatible model queries and accurately changes model capability input',t=>{
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'plugins'));
 const modelUrl=pathToFileURL(path.join(root,'src/model.mjs')).href;
 fs.writeFileSync(path.join(dir,'plugins/search_model.mjs'),`import {modelMessages} from ${JSON.stringify(modelUrl)};let calls=0,last;export default {apiVersion:1,id:'test.search-model',capabilities:['search','model'],setup:()=>({search:async args=>{calls++;last=args;return {text:'MOCK SEARCH',query:args.query,sources:['https://example.com/mock'],searchedAt:new Date().toISOString(),searchUsed:true};},model:async args=>({text:JSON.stringify({calls,lastQuery:last?.query,lastSettings:last?.settings,webSearch:args.session.capabilities?.webSearch,promptHasSearch:modelMessages(args.persona,args.session,args.memories).some(x=>x.role==='system'&&x.content.includes('应用已启用公开资料联网查询'))})})})};`);
 const c=config();c.extensions=[{module:'./plugins/search_model.mjs'}];const file=path.join(dir,'deployment.local.json');saveDeployment(c,file);
 const code=`import {createRuntime} from ${JSON.stringify(pathToFileURL(path.join(root,'src/runtime.mjs')).href)};const r=await createRuntime({root:${JSON.stringify(dir)},codec:{encode:x=>Buffer.from(x),decode:x=>x.toString()}});r.core.store.change(s=>Object.assign(s.settings,{provider:'compatible',model:'owner-model',timeoutMs:3456,allowSearch:true,apiKey:'private-key'}));const id=r.core.snapshot().sessions.find(s=>s.channel==='local').id;const found=await r.core.dispatch('chat',{sessionId:id,text:'小汐，搜索 JavaScript 官方文档'});const enabled=JSON.parse(await r.core.dispatch('chat',{sessionId:id,text:'你能联网吗'}));r.core.store.change(s=>{s.settings.allowSearch=false;});const disabled=JSON.parse(await r.core.dispatch('chat',{sessionId:id,text:'你好'}));console.log(JSON.stringify({found,enabled,disabled}));await r.close();`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',cwd:dir,env:{...process.env,XIAOXI_CONFIG:file},windowsHide:true,timeout:10000});assert.equal(child.status,0,child.stderr);const body=JSON.parse(child.stdout);assert.equal(body.found,'MOCK SEARCH');assert.equal(body.enabled.calls,1);assert.equal(body.enabled.webSearch,true);assert.equal(body.enabled.promptHasSearch,true);assert.deepEqual(body.enabled.lastSettings,{provider:'compatible',model:'owner-model',timeoutMs:3456});assert.equal(body.disabled.webSearch,false);assert.equal(body.disabled.promptHasSearch,false);assert.equal(body.disabled.calls,1);assert.ok(!child.stdout.includes('private-key'));
});

test('provider parse and unknown errors are safe codes without upstream body or cancellation reason',async()=>{
 for(const [stream,body,contentType,expected] of [[false,'FIXTURE_JSON_synthetic-secret','application/json','api_invalid_json'],[true,'data: FIXTURE_SSE_synthetic-secret\n','text/event-stream','api_invalid_stream_packet']]){
  await assert.rejects(callCompatible({settings:settings({stream}),messages:[],fetchImpl:async()=>new Response(body,{headers:{'content-type':contentType}})}),error=>error.code===expected&&!error.message.includes('synthetic-secret'));
 }
 await assert.rejects(callCompatible({settings:settings(),messages:[],fetchImpl:async()=>{throw Error('UPSTREAM_synthetic-secret');}}),error=>error.code==='api_connection_failed'&&!error.message.includes('synthetic-secret'));
 const controller=new AbortController();controller.abort(Error('CANCEL_synthetic-secret'));
 await assert.rejects(callCompatible({settings:settings(),messages:[],signal:controller.signal,fetchImpl:()=>assert.fail('must not fetch')}),error=>error.name==='AbortError'&&error.message==='api_cancelled');
});
test('malformed provider JSON and SSE stay redacted through HTTP, model state and events',async t=>{
 const dir=fixture(t),runtime=await createRuntime({root:dir,codec}),panel=await startPanel({root,core:runtime.core,port:0});cleanup(t,async()=>{await panel.close();await runtime.close();});
 runtime.core.store.change(s=>Object.assign(s.settings,{provider:'compatible',model:'chosen-model',baseUrl:'https://model.invalid/v1',apiKey:'PRIVATE_TEST_KEY',retries:0}));
 const original=globalThis.fetch;let mode='json';globalThis.fetch=async(url,options)=>String(url).startsWith('https://model.invalid/')?new Response(mode==='json'?'FIXTURE_JSON_synthetic-secret':'data: FIXTURE_SSE_synthetic-secret\n',{headers:{'content-type':mode==='json'?'application/json':'text/event-stream'}}):original(url,options);cleanup(t,()=>{globalThis.fetch=original;});
 const {token}=await original(panel.url+'/api/bootstrap').then(x=>x.json());
 for(const [kind,code] of [['json','api_invalid_json'],['sse','api_invalid_stream_packet']]){
  mode=kind;runtime.core.store.change(s=>{s.settings.stream=kind==='sse';});
  const response=await original(panel.url+'/api/call',{method:'POST',headers:{Origin:panel.url,'Content-Type':'application/json','X-Xiaoxi-Token':token},body:JSON.stringify({action:'model.check'})});const body=await response.text();assert.equal(response.status,400);assert.match(body,new RegExp(code));assert.ok(!body.includes('synthetic-secret'));const snapshot=JSON.stringify(runtime.core.snapshot());assert.ok(!snapshot.includes('synthetic-secret'));assert.ok(!snapshot.includes('PRIVATE_TEST_KEY'));assert.equal(runtime.core.snapshot().modelState.message,code);assert.ok(runtime.core.snapshot().events.some(e=>e.message.includes(code)));
 }
});
