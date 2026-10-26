import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {MessageGate,shouldReply,recoverInterrupted} from '../src/message_gate.mjs';
import {Companion} from '../src/core.mjs';
const target={id:'group_abao',name:'Example Group A',enabled:true,kind:'group',mode:'mentions'};
const msg=(id,text='小汐，在吗')=>({id,text,klass:'mmui::ChatTextItemView'});
const snap=(messages,hwnd=1,created=100)=>({pid:20,created,hwnd,messages});
test('baseline, batch arrival, duplicate poll and replaced process never replay history',()=>{
 const gate=new MessageGate();assert.equal(gate.observe(target,snap([msg('a')])).messages.length,0);
 assert.deepEqual(gate.observe(target,snap([msg('a'),msg('b'),msg('c')])).messages.map(x=>x.id),['b','c']);
 assert.equal(gate.observe(target,snap([msg('b'),msg('c')])).messages.length,0);
 assert.equal(gate.observe(target,snap([msg('b'),msg('c'),msg('d')],1,200)).messages.length,0);
 assert.equal(gate.observe(target,snap([msg('b'),msg('c'),msg('d')],2,200)).messages.length,0);
});
test('lost visible anchor and edited text do not trigger an unsafe replay',()=>{
 const gate=new MessageGate();gate.observe(target,snap([msg('a')]));
 assert.equal(gate.observe(target,snap([msg('a','小汐，内容已改变')])).gap,true);
 assert.equal(gate.observe(target,snap([msg('z')])).gap,true);
});
test('only configured plain text triggers; contact routing does not enable group chatter',()=>{
 assert.equal(shouldReply(target,msg('a')),true);assert.equal(shouldReply(target,msg('a','旁人在讨论')),false);
 assert.equal(shouldReply(target,msg('a','小汐介绍一下自己')),true);
 assert.equal(shouldReply({...target,enabled:false},msg('a')),false);
 assert.equal(shouldReply({...target,mode:'observe'},msg('a')),false);
 assert.equal(shouldReply(target,{...msg('a'),klass:'mmui::ChatBubbleItemView'}),false);
 assert.equal(shouldReply({...target,mode:'all'},msg('a','你好')),false);
 assert.equal(shouldReply({...target,kind:'contact',mode:'all'},msg('a','你好')),true);
});
test('mode edits preserve the pin and an unapproved identity replacement is denied',async t=>{
 const {core}=fixture(t,async()=>({text:'好'}));
 core.store.change(s=>s.targets[0].windowBinding='ChatSingleWindow123@chatroom');
 await core.dispatch('target.save',{...target,mode:'observe'});
 assert.equal(core.store.value.targets[0].id,target.id);assert.equal(core.store.value.targets[0].windowBinding,'ChatSingleWindow123@chatroom');
 await assert.rejects(core.dispatch('target.save',{...target,name:'新的群'}),{code:'conversation_scope_denied'});
 assert.equal(core.store.value.targets[0].id,target.id);assert.equal(core.store.value.targets[0].windowBinding,'ChatSingleWindow123@chatroom');
 assert.equal(core.sessionFor(target.id).title,target.name);
});

test('a removed approved group can be restored only under its registered id',async t=>{
 const {core}=fixture(t,async()=>({text:'好'}));
 await core.dispatch('target.remove',{id:target.id});
 await core.dispatch('target.save',{name:target.name,kind:target.kind,mode:'mentions',enabled:true});
 assert.equal(core.store.value.targets.find(x=>x.name===target.name).id,target.id);
 await assert.rejects(core.dispatch('target.save',{name:'未授权的新群',kind:'group',mode:'mentions',enabled:true}),{code:'conversation_scope_denied'});
});
test('crash recovery skips unfinished input and quarantines ambiguous outbox without resending',()=>{
 const state={inbox:[{status:'queued'},{status:'generating'},{status:'completed'}],outbox:[{status:'prepared'},{status:'sending'},{status:'local_echo'}]};
 assert.equal(recoverInterrupted(state),4);assert.deepEqual(state.inbox.map(x=>x.status),['skipped','skipped','completed']);
 assert.deepEqual(state.outbox.map(x=>x.status),['unknown','unknown','local_echo']);assert.equal(recoverInterrupted(state),0);
});
function fixture(t,model){
 const root=fs.mkdtempSync(path.resolve('temp/core_test_'));fs.mkdirSync(path.join(root,'temp'));
 fs.copyFileSync('character_card.json',path.join(root,'character_card.json'));
 const codec={encode:s=>Buffer.from(s),decode:b=>b.toString()};
 const core=new Companion({root,codec,model});t.after(async()=>{await core.stop();fs.rmSync(root,{recursive:true,force:true});});
 return {core,root,codec};
}
test('memory stays inside its target and survives a fresh process-equivalent store',async t=>{
 let received;const {core,root,codec}=fixture(t,async args=>{received=args;return {text:'收到'};});
 const a=core.sessionFor('group_abao'),b=core.sessionFor('group_family');
 await core.dispatch('memory.save',{sessionId:a.id,text:'本群约定周六聊天'});
 await core.reply(b.id);assert.deepEqual(received.memories,[]);
 await core.reply(a.id);assert.equal(received.memories[0].text,'本群约定周六聊天');
 const restored=new Companion({root,codec,model:async()=>({text:'好'})});assert.equal(restored.store.value.memories.length,1);await restored.stop();
});
test('stop cancels generation before the WeChat send boundary',async t=>{
 let release;const {core}=fixture(t,()=>new Promise(resolve=>{release=resolve;}));
 let sends=0;core.bridge={kill(){},call(){sends++;return Promise.resolve({status:'local_echo',ids:[]});}};
 core.running=true;core.modelState={stage:'ready'};core.accept(target,{...msg('a'),key:'a'},snap([]));
 await core.stop();release({text:'不应发送'});await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(sends,0);assert.equal(core.store.value.outbox.length,0);
});
test('unknown sends are not automatically retried, including after restart',async t=>{
 const {core,root,codec}=fixture(t,async()=>({text:'你好'}));let sends=0;
 core.running=true;core.modelState={stage:'ready'};core.bridge={kill(){},call(){sends++;throw Error('提交后超时');}};
 core.accept(target,{...msg('a'),key:'a'},snap([]));await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal(sends,1);assert.equal(core.store.value.outbox[0].status,'unknown');
 const restored=new Companion({root,codec,model:async()=>({text:'好'})});assert.equal(restored.store.value.outbox[0].status,'unknown');assert.equal(sends,1);await restored.stop();
});
test('only confirmed unsent deferral is retried, without regenerating or creating duplicate output',async t=>{
 const {core}=fixture(t,async()=>({text:'好'}));core.running=true;let calls=0;
 const out={id:'defer',sessionId:core.sessionFor(target.id).id,text:'等你写完',status:'prepared'};
 core.store.change(s=>s.outbox.push(out));
 core.bridge={kill(){},async call(){return ++calls===1?{status:'deferred',note:'手动草稿'}:{status:'local_echo',ids:['sent']};}};
 const result=await core.deliver(target,out,core.generation,{retryMs:1,maxWaitMs:1000});
 assert.equal(result.status,'local_echo');assert.equal(calls,2);assert.equal(core.store.value.outbox.length,1);
});
test('stop during a deferred send never commits later and restart does not replay it',async t=>{
 const {core}=fixture(t,async()=>({text:'好'}));core.running=true;let calls=0;
 const out={id:'cancel_defer',sessionId:core.sessionFor(target.id).id,text:'不应发送',status:'prepared'};
 core.store.change(s=>s.outbox.push(out));
 core.bridge={kill(){},async call(){calls++;return {status:'deferred',note:'目标正在使用'};}};
 const pending=core.deliver(target,out,core.generation,{retryMs:100,maxWaitMs:1000});
 await new Promise(resolve=>setTimeout(resolve,10));await core.stop();
 assert.equal(await pending,null);assert.equal(calls,1);assert.equal(core.store.value.outbox[0].status,'not_sent');
});
test('ambiguous submission and explicit not-sent results are never retried',async t=>{
 const {core}=fixture(t,async()=>({text:'好'}));core.running=true;
 for(const status of ['unknown','not_sent']){
  let calls=0;const out={id:status,sessionId:core.sessionFor(target.id).id,text:'一次',status:'prepared'};core.store.change(s=>s.outbox.push(out));
  core.bridge={kill(){},async call(){calls++;return {status,note:'结果'};}};
  assert.equal((await core.deliver(target,out,core.generation,{retryMs:1,maxWaitMs:100})).status,status);assert.equal(calls,1);
 }
});
test('session reset cancels an unsent deferred response',async t=>{
 const {core}=fixture(t,async()=>({text:'好'}));core.running=true;let calls=0;const session=core.sessionFor(target.id);
 const out={id:'reset',sessionId:session.id,epoch:session.epoch,text:'旧回复',status:'prepared'};core.store.change(s=>s.outbox.push(out));
 core.bridge={kill(){},async call(){calls++;core.store.resetSession(session.id);return {status:'deferred',note:'草稿'};}};
 const result=await core.deliver(target,out,core.generation,{retryMs:1,maxWaitMs:100});
 assert.equal(result.status,'not_sent');assert.equal(calls,1);
});
test('an expired deferred response cannot reach the send boundary on its next attempt',async t=>{
 const {core}=fixture(t,async()=>({text:'好'}));core.running=true;let calls=0;
 const out={id:'expired',sessionId:core.sessionFor(target.id).id,text:'过期回复',status:'prepared'};core.store.change(s=>s.outbox.push(out));
 core.bridge={kill(){},async call(){calls++;return calls===1?{status:'deferred',note:'手动草稿'}:{status:'local_echo',ids:['late']};}};
 const result=await core.deliver(target,out,core.generation,{retryMs:30,maxWaitMs:10});
 assert.equal(result.status,'not_sent');assert.equal(calls,1);
});
test('stop resolves only after the native worker termination promise completes',async t=>{
 const {core}=fixture(t,async()=>({text:'好'}));let finishKill,finished=false;
 core.running=true;core.bridge={kill(){return new Promise(resolve=>{finishKill=resolve;});}};
 const stopped=core.stop().then(()=>{finished=true;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(core.running,false);assert.equal(core.bridge,null);assert.equal(finished,false);
 finishKill({terminated:true});await stopped;
 assert.equal(finished,true);assert.equal(core.connection.stage,'stopped');
});
test('rapid stop and start waits for termination and shares one stop operation',async t=>{
 const {core}=fixture(t,async()=>({text:'好'}));let finishKill,kills=0,starts=0;
 core.running=true;core.modelState={stage:'ready'};core.schedule=()=>{};
 core.bridge={kill(){kills++;return new Promise(resolve=>{finishKill=resolve;});}};
 const factory=fakeTransportFactory();core.transportFactory=()=>{starts++;return factory();};
 const stopping=core.stop();const duplicateStop=core.stop();const starting=core.start();
 assert.equal(stopping,duplicateStop);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(kills,1);assert.equal(starts,0);assert.equal(core.running,false);
 finishKill({terminated:true});await Promise.all([stopping,starting]);
 assert.equal(starts,1);assert.equal(core.running,true);assert.equal(core.connection.stage,'connected');assert.equal(core.stopping,null);
});
function fakeTransportFactory({messages=()=>[],onSend=()=>{}}={}){
 return ()=>({child:{},start(){},async kill(){this.child=null;return {terminated:true};},async stop(){await this.kill();},async call(command,fields={}){
  if(command==='connect')return {account:'Example Account',pid:20,created:100};
  if(command==='health')return {healthy:true};
  if(command==='open'||command==='read')return {...snap(messages(command,fields)),group:fields.group,windowBinding:`ChatSingleWindow${fields.group}@chatroom`,draft:false};
  if(command==='send'){onSend(fields);return {status:'local_echo',ids:['sent']};}
  throw Error('Unexpected test transport command: '+command);
 }});
}
async function waitFor(predicate){
 const deadline=Date.now()+2000;
 while(!predicate()){
  if(Date.now()>=deadline)assert.fail('Asynchronous companion state did not settle');
  await new Promise(resolve=>setTimeout(resolve,5));
 }
}
test('automatic reconnect retains ambiguous-send suspension until explicit reconnect',async t=>{
 const {core}=fixture(t,async()=>({text:'不应自动发出'}));let sends=0;const opened=[];
 core.transportFactory=fakeTransportFactory({messages:(command,fields)=>{
  if(command==='open'){opened.push(fields.allowForeground);return [msg('baseline')];}
  return fields.group===target.name?[msg('baseline'),msg('fresh')]:[msg('baseline')];
 },onSend:()=>{sends++;}});
 core.schedule=()=>{};core.running=true;core.modelState={stage:'ready'};core.suspended.add(target.id);
 await core.connect();assert.equal(core.suspended.has(target.id),true);assert.ok(opened.every(value=>value===false));
 await core.tick();assert.equal(sends,0);assert.equal(core.store.value.inbox.length,0);assert.equal(core.targetStates[target.id].stage,'error');
 await core.bridge.stop();core.bridge=null;
 await core.connect(true);assert.equal(core.suspended.has(target.id),false);assert.ok(opened.slice(-2).every(value=>value===true));
});
test('a late aborted generation releases its slot for fresh work after stop and start',async t=>{
 let finishOld,modelCalls=0;const sent=[];
 const {core}=fixture(t,()=>++modelCalls===1?new Promise(resolve=>{finishOld=resolve;}):Promise.resolve({text:'重连后的新回答'}));
 core.transportFactory=fakeTransportFactory({onSend:fields=>sent.push(fields)});core.schedule=()=>{};core.modelState={stage:'ready'};
 await core.start();core.accept(target,{...msg('old'),key:'old'},snap([]));assert.equal(modelCalls,1);
 await core.stop();await core.start();core.accept(target,{...msg('new'),key:'new'},snap([]));
 assert.equal(modelCalls,1);assert.equal(core.pending.get(core.sessionFor(target.id).id).length,1);
 finishOld({text:'停止前的旧回答'});await waitFor(()=>core.store.value.outbox.some(x=>x.status==='local_echo'));
 assert.equal(modelCalls,2);assert.deepEqual(sent.map(x=>x.text),['重连后的新回答']);
 assert.deepEqual(core.store.value.inbox.map(x=>x.status),['skipped','completed']);assert.equal(core.processing.size,0);
});
test('a stale drain does not revive a queue for a target whose bound identity changed',async t=>{
 let finishOld,modelCalls=0;const sent=[];
 const {core}=fixture(t,()=>++modelCalls===1?new Promise(resolve=>{finishOld=resolve;}):Promise.resolve({text:'不应发送'}));
 core.transportFactory=fakeTransportFactory({onSend:fields=>sent.push(fields)});core.schedule=()=>{};core.modelState={stage:'ready'};
 await core.start();const pinned={...core.store.value.targets.find(x=>x.id===target.id)};
 core.accept(pinned,{...msg('old'),key:'old'},snap([]));await core.stop();await core.start();core.accept(pinned,{...msg('new'),key:'new'},snap([]));
 core.store.change(s=>{s.targets.find(x=>x.id===target.id).windowBinding='ChatSingleWindowDifferent@chatroom';});
 finishOld({text:'旧回答'});await waitFor(()=>core.processing.size===0);
 assert.equal(modelCalls,1);assert.equal(sent.length,0);assert.equal(core.store.value.outbox.length,0);
});
