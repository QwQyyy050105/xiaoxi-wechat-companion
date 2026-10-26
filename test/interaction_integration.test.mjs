import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Companion} from '../src/core.mjs';
import {modelMessages,promptDiagnostics} from '../src/model.mjs';
import {REPLY_PART_SEPARATOR} from '../src/delivery_plan.mjs';
import {createWeatherConversation} from '../src/weather_conversation.mjs';
import {GroupMediaInput} from '../src/group_media.mjs';
import {createHash} from 'node:crypto';

const baseTime=Date.parse('2026-10-24T17:00:00+08:00');

test('reported screenshot calls enter the complete receive-model-send path with exact material',async t=>{
 const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'先核对最新这份开销'};}});
 f.ingest('background','最新材料：必要开销3000元','group_family');
 f.ingest('natural_call','小汐来看一下上下文回复一下','group_family');
 await waitFor(()=>f.core.processing.size===0&&calls.length===1);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].group,'Example Group B');
 assert.ok(calls[0].session.context.messages.some(row=>row.text==='最新材料：必要开销3000元'));
 const text='Member A：煤气、水电、物业、买菜、药费。　小汐，我说的是这段文，这些全部cover真的压力很大吗';
 f.ingest('material_then_call',text,'group_family');
 await waitFor(()=>f.core.processing.size===0&&calls.length===2);
 assert.equal(calls[1].session.request.text,text);assert.equal(f.sent.length,2);
 assert.equal(calls[1].settings.model,'gpt-6-astra');
 assert.equal(f.core.latency.decisions.at(-1).callEvidence,'embedded_address');
 assert.ok(!JSON.stringify(f.core.latency.decisions).includes('煤气'));
});

test('owner-selected Codex model is persisted without silent replacement',async t=>{
 const f=fixture(t);f.core.store.change(s=>{s.settings.model='gpt-6-luna';});
 const reopened=f.open();assert.equal(reopened.store.value.settings.model,'gpt-6-luna');
 await reopened.dispatch('settings.save',{provider:'codex',model:'gpt-6-luna',baseUrl:'https://example.com',apiKey:'',autoConnect:false});
 assert.equal(reopened.store.value.settings.model,'gpt-6-luna');
});

test('engaged image question reaches the existing persona model with bytes, without an extra vision call',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'像一辆奥迪'};}});
  const bytes=Buffer.from('ffd8ff001122','hex');
  f.core.groupMedia=new GroupMediaInput({root:f.root,reader:async()=>({ok:true,images:[{targetId:'group_abao',peerId:'10000001@chatroom',source:'wechat_group_cache',messageBinding:'unresolved',sender:null,mime:'image/jpeg',quality:'wechat_compressed',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),width:10,height:10,cacheModifiedAt:100}]})});
  const sid=f.core.sessionFor('group_abao').id;
  const answer=await f.core.reply(sid,{target:f.target(),request:{text:'看看这张图',sourceKey:'media_ask',engagement:{relation:'current_group_topic'}}});
  assert.equal(answer,'像一辆奥迪');assert.equal(calls.length,1);assert.equal(calls[0].mediaInput.images.length,1);assert.equal(calls[0].persona.name,'小汐');assert.equal(calls[0].session.taskInstruction.kind,'engaged');
});

test('voice pending state is silent and converted words become the ordinary conversation request with provenance',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'今天想聊点什么'};}});
  const native=(body)=>({id:'voice_new',key:body,klass:'mmui::ChatVoiceItemView',text:body});
  f.core.ingest(f.target(),native('语音3"秒未播放'),snapshot());assert.equal(calls.length,0);assert.equal(f.core.context.snapshot(f.core.sessionFor('group_abao').id).messages.length,0);
  f.core.ingest(f.target(),native('语音3"秒小汐，你在做什么'),snapshot());await waitFor(()=>f.core.processing.size===0);
  assert.equal(calls.length,1);assert.equal(calls[0].session.request.text,'小汐，你在做什么');
  assert.equal(calls[0].session.context.messages[0].inputModality.kind,'platform_transcript');assert.equal(f.sent.length,1);
  assert.match(JSON.stringify(modelMessages(calls[0].persona,calls[0].session,[])),/没有听到原声/);
});
const snapshot=(messages=[],hwnd=1)=>({pid:20,created:100,hwnd,messages});
const message=(id,text)=>({id,key:id,text,klass:'mmui::ChatTextItemView',sender:{evidence:'unknown'}});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function waitFor(condition,label='companion state') {
  const deadline=Date.now()+2000;
  while(!condition()) { if(Date.now()>deadline)assert.fail(`Timed out waiting for ${label}`); await new Promise(resolve=>setTimeout(resolve,5)); }
}
function fixture(t,{model=async()=>({text:'已收到'}),send=async()=>({status:'local_echo',ids:[]}),search=async()=>{throw Error('Unexpected search in interaction test');}}={}) {
  const tempParent=path.resolve('temp'); fs.mkdirSync(tempParent,{recursive:true});
  assert.ok(path.isAbsolute(tempParent));
  const root=fs.mkdtempSync(path.join(tempParent,'interaction_test_'));
  fs.mkdirSync(path.join(root,'temp')); fs.copyFileSync('character_card.json',path.join(root,'character_card.json'));
  const codec={encode:value=>Buffer.from(value),decode:buffer=>buffer.toString()};
  const clock={value:baseTime};const sent=[],instances=[];
  const dependencies={root,codec,model,nowMs:()=>clock.value,
    voice:{async status(){return {ready:false,voiceBubble:false,audioFile:false};},async generate(){throw Error('Unexpected voice generation in interaction test');}},
    media:{capabilities(){return {image:false,audio:false};},async analyze(){throw Error('Unexpected media processing in interaction test');}},
    search};
  function open(overrides={}) {
    const core=new Companion({...dependencies,...overrides});instances.push(core);core.schedule=()=>{};
    core.bridge={child:{},async kill(){this.child=null;},async stop(){this.child=null;},async call(command,fields={}){
      if(command==='send'){sent.push({...fields});return send(fields,sent.length,core);}
      if(command==='health')return {healthy:true};
      if(command==='read')return snapshot([]);
      throw Error(`Unexpected fake command: ${command}`);
    }};
    core.running=true;core.modelState={stage:'ready'};return core;
  }
  const core=open();
  t.after(async()=>{for(const value of instances)await value.stop();await turn();const resolved=path.resolve(root);assert.ok(resolved.startsWith(tempParent+path.sep));fs.rmSync(resolved,{recursive:true,force:true});});
  const target=(which='group_abao',value=core)=>value.store.value.targets.find(x=>x.id===which);
  const ingest=(id,text,which='group_abao')=>core.ingest(target(which),message(id,text),snapshot());
  return {core,root,codec,clock,sent,open,target,ingest};
}

test('unaddressed group discussion reaches the model as background, with exact current request and no cross-group facts',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'第二种费用更低。'};}});
  f.ingest('bg1','第一种方案要一千元');f.ingest('bg2','第二种方案只要五百元');
  f.ingest('family-secret','Example Group B的另一件私事','group_family');
  assert.equal(calls.length,0);assert.equal(f.sent.length,0);
  f.ingest('question','小汐，第二种方案多少钱？');await waitFor(()=>f.core.processing.size===0);
  assert.equal(calls.length,1);const args=calls[0];
  assert.equal(args.session.request.text,'小汐，第二种方案多少钱？');
  assert.deepEqual(args.session.context.messages.map(x=>x.text),['第一种方案要一千元','第二种方案只要五百元','小汐，第二种方案多少钱？']);
  const prompt=JSON.stringify(modelMessages(args.persona,args.session,args.memories));
  assert.ok(!prompt.includes('Example Group B的另一件私事'));assert.equal(f.sent.length,1);
});

test('unapproved WeChat target cannot seed, ingest, accept, model, search or send',async t=>{
  let models=0,searches=0;const f=fixture(t,{model:async()=>{models++;return {text:'unexpected'};},search:async()=>{searches++;return {text:'unexpected'};}});
  const other={id:'private_unapproved',name:'未授权会话',kind:'group',enabled:true,mode:'all'};
  f.core.store.change(s=>{s.targets.push(other);s.settings.allowSearch=true;});
  f.core.ensureSessions();assert.equal(f.core.sessionFor(other.id),undefined);
  const sid=f.core.store.createSession(other.name,'desktop_wechat','Example Account',other.id);
  f.core.seedVisibleBackground(other,snapshot([message('private_baseline','DO_NOT_READ_BASELINE')]));
  f.core.ingest(other,message('private_in','小汐，联网查 Node.js 最新版本'),snapshot());
  assert.equal(f.core.context.snapshot(sid).messages.length,0);
  assert.equal(f.core.store.value.inbox.length,0);
  await assert.rejects(f.core.reply(sid,{request:{text:'小汐，联网查 Node.js 最新版本'},target:other}),{code:'conversation_scope_denied'});
  await assert.rejects(f.core.serviceReply(sid,{text:'查资料 Node.js 最新版本'},{target:other}),{code:'conversation_scope_denied'});
  await assert.rejects(f.core.runModel({session:f.core.store.session(sid)}),{code:'conversation_scope_denied'});
  await assert.rejects(f.core.deliver(other,{sessionId:sid,text:'forbidden'},f.core.generation),{code:'conversation_scope_denied'});
  assert.equal(models,0);assert.equal(searches,0);assert.equal(f.sent.length,0);
});

test('connect and polling use only approved targets before any transport read',async t=>{
  const f=fixture(t);const calls=[];
  f.core.store.change(s=>s.targets.push({id:'unapproved',name:'未授权会话',kind:'group',enabled:true}));
  f.core.transportFactory=()=>({child:{},start(){},async stop(){this.child=null;},async kill(){this.child=null;},async call(command,fields={}){
    calls.push({command,fields});
    if(command==='connect')return {account:'Example Account',pid:20,created:100,version:'fixture'};
    if(command==='open'||command==='read')return {...snapshot(),windowBinding:`fixture:${fields.group}`};
    if(command==='health')return {healthy:true};
    throw Error(`Unexpected command ${command}`);
  }});
  await f.core.connect();await f.core.tick();
  const connected=calls.find(x=>x.command==='connect').fields.targets;
  assert.deepEqual(connected.map(x=>x.id),['group_abao','group_family']);
  assert.ok(calls.filter(x=>['open','read'].includes(x.command)).every(x=>['Example Group A','Example Group B'].includes(x.fields.group)));
  assert.equal(f.core.sessionFor('unapproved'),undefined);
});

test('an approved group cannot send the other approved session answer',async t=>{
  const f=fixture(t);const target=f.target(),other=f.core.sessionFor('group_family');
  const result=await f.core.deliver(target,{sessionId:other.id,text:'wrong group'},f.core.generation);
  assert.equal(result.status,'not_sent');assert.equal(f.sent.length,0);
  await assert.rejects(f.core.reply(other.id,{target,request:{text:'小汐，你好'}}),/授权目标不一致/);
});

test('native submission guard rechecks authorization after a target changes in the queue',async t=>{
  const f=fixture(t);const target=structuredClone(f.target()),session=f.core.sessionFor(target.id);
  const out={id:'privacy_queued',sessionId:session.id,text:'must not submit',status:'prepared'};
  f.core.store.change(s=>s.outbox.push(out));let guard;
  f.core.bridge.call=async(command,fields,timeout,options)=>{
    assert.equal(command,'send');guard=options.beforeSubmit;assert.equal(guard(),true);
    f.core.store.change(s=>s.targets.find(x=>x.id===target.id).name='未授权会话');
    assert.equal(guard(),false);return {status:'not_sent',ids:[],note:'scope changed'};
  };
  const result=await f.core.deliver(target,out,f.core.generation);assert.equal(result.status,'not_sent');assert.equal(f.sent.length,0);
});

test('online setting keeps local owner chat usable and search settings contain no credentials',async t=>{
  const calls=[],lookups=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'在，今天怎么啦'};},search:async args=>{lookups.push(args);return {text:'公开资料已查到'};}});
  f.core.store.change(s=>Object.assign(s.settings,{allowSearch:true,apiKey:'synthetic-secret-not-for-search'}));
  const sid=f.core.store.value.sessions.find(x=>x.channel==='local').id;
  f.core.store.change(s=>s.sessions.find(x=>x.id===sid).messages.push({role:'user',text:'今天有点开心'}));
  assert.equal(await f.core.reply(sid),'在，今天怎么啦');assert.equal(calls.length,1);
  const text=await f.core.reply(sid,{request:{text:'帮我联网查 Node.js 最新版本'}});
  assert.equal(text,'公开资料已查到');assert.equal(lookups.length,1);
  assert.deepEqual(Object.keys(lookups[0].settings).sort(),['model','provider','timeoutMs']);
  assert.equal(JSON.stringify(lookups[0]).includes('synthetic-secret-not-for-search'),false);
});

test('visible startup background never triggers calls or commands but is available to a new explicit request',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'从刚才那句看，他在关心大家'};}});
  const target=f.target(),session=f.core.sessionFor(target.id);
  const visible=[
    {...message('visible_speaker','大家路上注意安全'),own:false,sender:{label:'Member A',evidence:'display_name'}},
    message('visible_call','小汐，停止本轮'),
    {...message('visible_own','我先去忙了'),own:true},
    {...message('visible_assistant','以前的回复'),role:'assistant'}
  ];
  f.core.seedVisibleBackground(target,snapshot(visible));
  await turn();
  assert.equal(calls.length,0);assert.equal(f.sent.length,0);
  assert.equal(f.core.store.value.inbox.length,0);assert.equal(f.core.store.value.outbox.length,0);
  assert.equal(f.core.policy.state(session.id).engagement,null);
  assert.equal(f.core.policy.state(session.id).waiting,null);
  const background=f.core.context.snapshot(session.id).messages;
  assert.deepEqual(background.map(row=>row.text),['大家路上注意安全','小汐，停止本轮']);
  assert.equal(background[0].role,'user');assert.equal(background[1].role,'unknown');
  assert.ok(background.every(row=>row.observationMode==='baseline'&&row.timeSource==='observed'&&row.platformTime===null));
  f.ingest('new_evaluation','小汐，评价一下群里的Member A');await waitFor(()=>f.core.processing.size===0&&calls.length===1);
  const packet=modelMessages(calls[0].persona,calls[0].session,[]).map(row=>{try{return JSON.parse(row.content);}catch{return null;}}).find(row=>row?.type==='observed_conversation');
  assert.equal(packet.observations[0].sender.label,'Member A');assert.equal(packet.observations[0].sender.evidence,'display_name');
  assert.equal(packet.observations[0].observationMode,'baseline');assert.equal(packet.observations[1].role,'unknown');
  assert.equal(packet.observations[1].timeSource,'observed');assert.equal(packet.observations.at(-1).observationMode,'live');
  assert.equal(f.core.store.value.inbox.length,1);assert.equal(f.sent.length,1);
});

test('connect seeds visible background without queuing startup questions',async t=>{
  let calls=0;const f=fixture(t,{model:async()=>{calls++;return {text:'不应调用'};}});
  const visible=[{...message('startup_weather','天气怎么样'),own:false},message('startup_call','小汐')];
  f.core.transportFactory=()=>({child:{},start(){},async stop(){this.child=null;},async kill(){this.child=null;},async call(command,fields){
    if(command==='connect')return {account:'Example Account',pid:20,created:100,version:'fixture'};
    if(command==='open')return {...snapshot(fields.group===f.target().name?visible:[]),windowBinding:`fixture:${fields.group}`};
    if(command==='send'){f.sent.push(fields);return {status:'local_echo',ids:[]};}
    throw Error(`Unexpected command ${command}`);
  }});
  await f.core.connect();
  const session=f.core.sessionFor(f.target().id),rows=f.core.context.snapshot(session.id).messages;
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.observationMode==='baseline'));
  assert.equal(calls,0);assert.equal(f.sent.length,0);assert.equal(f.core.store.value.inbox.length,0);
  f.ingest('new_ping','小汐');await waitFor(()=>f.core.processing.size===0);
  assert.equal(calls,0);assert.deepEqual(f.sent.map(row=>row.text),['在呢']);
  // A fresh ping takes the local presence path; it cannot revive old weather.
  assert.equal(f.core.store.value.inbox.at(-1).directReply,'在呢');
});

test('a read gap clears the old generation then seeds only the new visible background without replay',async t=>{
  let release;const calls=[];const f=fixture(t,{model:args=>{calls.push(args);return new Promise(resolve=>{release=resolve;});}});
  const target=f.target(),session=f.core.sessionFor(target.id),old=message('old_question','小汐，旧问题怎么处理？');
  f.core.gate.observe(target,snapshot([old]));f.core.ingest(target,old,snapshot());await waitFor(()=>calls.length===1);
  const previousGeneration=f.core.context.generation(session.id);
  const visible=[message('visible_after_gap','小汐，新的窗口里已存在这句话'),{...message('visible_member','现在讨论的是午饭'),own:false,sender:{label:'Member A',evidence:'display_name'}}];
  const originalCall=f.core.bridge.call.bind(f.core.bridge);
  f.core.bridge.call=async(command,fields={})=>command==='read'?snapshot(fields.group===target.name?visible:[]):originalCall(command,fields);
  await f.core.tick();
  assert.ok(f.core.context.generation(session.id)>previousGeneration);
  const rows=f.core.context.snapshot(session.id).messages;
  assert.deepEqual(rows.map(row=>row.text),visible.map(row=>row.text));
  assert.ok(rows.every(row=>row.observationMode==='baseline'));
  assert.equal(f.core.policy.state(session.id).engagement,null);assert.equal(calls.length,1);
  release({text:'旧回答不可发'});await waitFor(()=>f.core.processing.size===0);
  assert.equal(f.sent.length,0);assert.equal(f.core.store.value.inbox.length,1);
  assert.equal(f.core.store.value.inbox[0].status,'skipped');
});

test('presence-only calls skip cloud inference and record bounded stage timings without conversation text',async t=>{
  let calls=0;const f=fixture(t,{model:async()=>{calls++;throw Error('Presence must not wait for cloud inference');}});
  f.ingest('presence','小汐呢');await waitFor(()=>f.core.processing.size===0);
  assert.equal(calls,0);assert.deepEqual(f.sent.map(row=>row.text),['在呢']);
  const timing=f.core.snapshot().latency.recent.at(-1);
  assert.equal(timing.responsePath,'presence');assert.equal(timing.status,'completed');
  assert.ok(timing.answerMs>=0);assert.ok(timing.deliveryMs>=0);assert.equal(JSON.stringify(timing).includes('小汐'),false);
});

test('the reported unpunctuated reply request takes the fast path and records its decision without plaintext',async t=>{
  let calls=0;const f=fixture(t,{model:async()=>{calls++;throw Error('A simple ping must not invoke the model');}});
  f.ingest('reported','小汐回复一句');await waitFor(()=>f.core.processing.size===0);
  assert.equal(calls,0);assert.deepEqual(f.sent.map(row=>row.text),['在呢']);
  assert.equal(f.core.targetStates.group_abao.lastDecision.action,'reply');
  assert.equal(f.core.targetStates.group_abao.lastDecision.reason,'social_summons');
  assert.equal(JSON.stringify(f.core.targetStates).includes('小汐回复一句'),false);
});

test('a reply invitation referring to an observed question retains that question instead of fast greeting',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'需要确认城市'};}});
  f.ingest('question','今天天气怎么样');f.ingest('reply','小汐回复一句');await waitFor(()=>f.core.processing.size===0);
  assert.equal(calls.length,1);assert.equal(f.sent.some(x=>x.text==='在呢'),false);
  const payload=JSON.parse(modelMessages(calls[0].persona,calls[0].session,[]).at(-1).content);
  assert.equal(payload.replyContext?.text,'今天天气怎么样');
});

test('the screenshot sequence answers the preceding public question instead of returning another presence reply',async t=>{
  const calls=[];let searches=0;
  const f=fixture(t,{model:async args=>{calls.push(args);return {text:'哪座城市'};},search:async()=>{searches++;throw Error('A contextual call must not authorize search');}});
  f.ingest('first','小汐呢');await waitFor(()=>f.core.processing.size===0);
  f.ingest('weather','今天天气怎么样');f.ingest('call','小汐');await waitFor(()=>f.core.processing.size===0);
  assert.equal(calls.length,1);assert.equal(searches,0);assert.deepEqual(f.sent.map(row=>row.text),['在呢','哪座城市']);
  const request=JSON.parse(modelMessages(calls[0].persona,calls[0].session,[]).at(-1).content);
  assert.equal(request.text,'今天天气怎么样');assert.equal(request.engagement.relation,'current_group_topic');
  assert.equal(request.sender.id,null);assert.equal(f.core.latency.coalescedSummons,1);
  f.ingest('city_after_redundant_ping','北京');await waitFor(()=>f.core.processing.size===0&&calls.length===2);
  assert.equal(calls[1].session.request.engagement.followupKind,'short_answer');
});

test('repeated pings share an in-flight answer without consuming more model turns or discarding a new question',async t=>{
  const calls=[];let release;
  const f=fixture(t,{model:args=>{calls.push(args);return calls.length===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({text:'第二个问题的回答'});}});
  f.ingest('weather','今天天气怎么样');f.ingest('call1','小汐');await waitFor(()=>calls.length===1);
  f.ingest('call2','@小汐');f.ingest('call3','小汐在吗');
  assert.equal(calls.length,1);assert.equal(f.core.latency.coalescedSummons,2);
  f.ingest('new_question','小汐，数学题怎么理解？');
  release({text:'哪座城市'});await waitFor(()=>f.core.processing.size===0&&calls.length===2);
  assert.deepEqual(f.sent.map(row=>row.text),['哪座城市','第二个问题的回答']);
  assert.equal(f.core.store.value.inbox.filter(row=>row.coalescedInto).length,2);
});

test('an unrelated summons cannot be silently merged into another pending question',async t=>{
  let release;const calls=[];const f=fixture(t,{model:args=>{calls.push(args);return new Promise(resolve=>{release=resolve;});}});
  const a={id:'member_a',evidence:'stable_id'},b={id:'member_b',evidence:'stable_id'};
  const old=message('old','小汐，今天天气怎么样');old.sender=a;
  f.core.ingest(f.target(),old,snapshot());await waitFor(()=>calls.length===1);
  const call=message('other','小汐');call.sender=b;f.core.ingest(f.target(),call,snapshot());
  assert.equal(f.core.latency.coalescedSummons,0);
  release({text:'哪座城市'});await waitFor(()=>f.core.processing.size===0);
  assert.deepEqual(f.sent.map(row=>row.text),['哪座城市','在呢']);
});

test('an engaged new question gets its own answer and a subsequent ping joins that question rather than older presence',async t=>{
  let release;const f=fixture(t,{send:(_fields,count)=>count===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({status:'local_echo',ids:[]})});
  f.ingest('first_ping','小汐');await waitFor(()=>f.sent.length===1);
  f.ingest('another_issue','我今天很烦怎么办');f.ingest('new_ping','小汐');
  assert.equal(f.core.latency.coalescedSummons,1);
  const followup=f.core.store.value.inbox.find(row=>row.event.text==='我今天很烦怎么办');
  assert.equal(f.core.store.value.inbox.find(row=>row.coalescedInto)?.coalescedInto,followup.id);
  release({status:'local_echo',ids:[]});await waitFor(()=>f.core.processing.size===0);
  assert.equal(f.sent.length,2);
});

test('a summons carrying a resolved quote still reaches the model instead of taking the presence shortcut',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'引用里说的是另一件事'};}});
  const quoted={...message('quoted_call','小汐'),quote:{sourceKey:'bot_before',status:'resolved',verified:true,authorIsBot:true,text:'一个需要解释的说法'}};
  f.core.ingest(f.target(),quoted,snapshot());await waitFor(()=>f.core.processing.size===0);
  assert.equal(calls.length,1);assert.equal(f.core.latency.recent.at(-1).responsePath,'model_or_service');
  assert.ok(JSON.stringify(modelMessages(calls[0].persona,calls[0].session,[])).includes('一个需要解释的说法'));
});

test('a summons opens natural conversation for an unnamed question and a short answer to the bot',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:calls.length===1?'哪座城市？':'北京的话，需要查实时天气'};}});
  f.ingest('call','小汐');await waitFor(()=>f.core.processing.size===0);
  f.ingest('question','天气怎么样');await waitFor(()=>f.core.processing.size===0&&calls.length===1);
  f.ingest('answer','北京');await waitFor(()=>f.core.processing.size===0&&calls.length===2);
  assert.deepEqual(f.sent.map(row=>row.text),['在呢','哪座城市？','北京的话，需要查实时天气']);
  for(const args of calls){
    assert.equal(args.session.request.engagement.relation,'current_group_topic');
    const request=JSON.parse(modelMessages(args.persona,args.session,[]).at(-1).content);
    assert.equal(request.engagement.relation,'current_group_topic');assert.equal(request.sender.id,null);
  }
  assert.equal(calls[1].session.request.text,'北京');
  assert.ok(calls[1].session.request.engagement.replyToSourceKey);
  f.ingest('other_room','天气怎么样','group_family');await turn();assert.equal(calls.length,2);
});

test('same-read summons followed by a question starts engagement before the presence bubble is confirmed',async t=>{
  let release;const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'先说哪座城市'};},
    send:(_fields,count)=>count===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({status:'local_echo',ids:[]})});
  f.ingest('hello','小汐');f.ingest('question','天气怎么样');await waitFor(()=>f.sent.length===1);
  release({status:'local_echo',ids:[]});await waitFor(()=>f.core.processing.size===0&&calls.length===1);
  assert.equal(calls[0].session.request.text,'天气怎么样');assert.deepEqual(f.sent.map(row=>row.text),['在呢','先说哪座城市']);
});

test('ordinary feelings and conversational statements continue after calling the bot without repeated names',async t=>{
  const requests=[];const f=fixture(t,{model:async args=>{requests.push(args.session.request);return {text:'今天够折腾的'};}});
  f.ingest('hello','小汐');await waitFor(()=>f.core.processing.size===0);
  for(const [index,text]of ['今天好累','刚下班','路上还下雨'].entries()){
    f.ingest('ordinary_'+index,text);await waitFor(()=>f.core.processing.size===0&&requests.length===index+1);
  }
  assert.deepEqual(requests.map(row=>row.text),['今天好累','刚下班','路上还下雨']);
  assert.ok(requests.every(row=>row.engagement.followupKind==='statement'));
});

test('automatic continuation never upgrades into a memory, search, reminder or voice operation',async t=>{
  let searches=0,voices=0;const f=fixture(t,{model:async()=>({text:'只聊这句话'}),search:async()=>{searches++;throw Error('uninvited search');}});
  f.core.voice.generate=async()=>{voices++;throw Error('uninvited voice');};
  const session=f.core.sessionFor('group_abao');
  for(const text of ['查资料：天气','记住本群周末聚餐','明天下午提醒聚餐','用语音回复']){
    await f.core.reply(session.id,{target:f.target(),request:{text,sourceKey:'synthetic',sender:{evidence:'unknown'},engagement:{relation:'current_group_topic'}}});
  }
  assert.equal(searches,0);assert.equal(voices,0);assert.equal(f.core.store.value.memoryCandidates.length,0);assert.equal(f.core.store.value.tasks.length,0);
});

test('model can stay silent for clearly unrelated group chatter without leaking a marker or leaving engagement open',async t=>{
  const f=fixture(t,{model:async()=>({text:'<xiaoxi-stay-silent/>'})});
  f.ingest('hello','小汐');await waitFor(()=>f.core.processing.size===0);
  f.ingest('ambiguous','天气怎么样');await waitFor(()=>f.core.processing.size===0);
  assert.deepEqual(f.sent.map(row=>row.text),['在呢']);
  assert.equal(f.core.policy.state(f.core.sessionFor('group_abao').id).engagement,null);
});

for(const [label,newMessage]of [['new_invitation','小汐，聊聊电影'],['accepted_followup','今天好累']])test(`late silence from an older turn preserves the ${label} engagement window`,async t=>{
  const calls=[];let release;
  const f=fixture(t,{model:args=>{calls.push(args);return calls.length===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({text:'接着聊'});}});
  f.ingest('hello','小汐');await waitFor(()=>f.core.processing.size===0);
  f.ingest('old','天气怎么样');await waitFor(()=>calls.length===1);
  f.ingest('new',newMessage);
  const sessionId=f.core.sessionFor('group_abao').id;
  const newerKey=f.core.policy.state(sessionId).engagement.lastAcceptedKey;
  assert.notEqual(newerKey,calls[0].session.request.sourceKey);
  release({text:'<xiaoxi-stay-silent/>'});await waitFor(()=>f.core.processing.size===0&&calls.length===2);
  assert.equal(f.core.policy.state(sessionId).engagement.lastAcceptedKey,newerKey);
  f.ingest('continue','还有点饿');await waitFor(()=>f.core.processing.size===0&&calls.length===3);
  assert.equal(calls[2].session.request.engagement.relation,'current_group_topic');
  assert.deepEqual(f.sent.map(row=>row.text),['在呢','接着聊','接着聊']);
});

test('the UI cancel action expires engagement and an aborted answer cannot reopen it',async t=>{
  const calls=[];let release;
  const f=fixture(t,{model:args=>{calls.push(args);return new Promise(resolve=>{release=resolve;});}});
  f.ingest('hello','小汐');await waitFor(()=>f.core.processing.size===0);
  f.ingest('question','天气怎么样');await waitFor(()=>calls.length===1);
  const sessionId=f.core.sessionFor('group_abao').id;
  await f.core.dispatch('cancel',{sessionId});
  assert.equal(calls[0].signal.aborted,true);assert.equal(f.core.policy.state(sessionId).engagement,null);
  release({text:'已取消的回答'});await waitFor(()=>f.core.processing.size===0);
  f.ingest('after_cancel','今天好累');await turn();
  assert.equal(calls.length,1);assert.deepEqual(f.sent.map(row=>row.text),['在呢']);
  assert.equal(f.core.policy.state(sessionId).engagement,null);
});

test('pausing and immediately resuming a group does not restore its earlier engagement window',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'可以继续聊'};}});
  f.ingest('hello','小汐');await waitFor(()=>f.core.processing.size===0);
  const sessionId=f.core.sessionFor('group_abao').id;assert.ok(f.core.policy.state(sessionId).engagement);
  await f.core.dispatch('target.pause',{id:'group_abao',paused:true});
  assert.equal(f.core.policy.state(sessionId).engagement,null);
  await f.core.dispatch('target.pause',{id:'group_abao',paused:false});
  f.ingest('not_invited_again','天气怎么样');await turn();assert.equal(calls.length,0);
  f.ingest('invite_again','小汐，继续聊吧');await waitFor(()=>f.core.processing.size===0&&calls.length===1);
  f.ingest('follow_again','今天好累');await waitFor(()=>f.core.processing.size===0&&calls.length===2);
  assert.equal(calls[1].session.request.engagement.relation,'current_group_topic');
});

test('polling never overlaps while targeting a one-second scan without a second three-second wait',async t=>{
  const f=fixture(t);let release,healthCalls=0;const scheduled=[];
  const original=f.core.bridge.call;
  f.core.bridge.call=async(command,fields)=>{
    if(command==='health'){healthCalls++;await new Promise(resolve=>{release=resolve;});return {healthy:true};}
    return original(command,fields);
  };
  f.core.schedule=ms=>scheduled.push(ms);
  const first=f.core.tick();await waitFor(()=>healthCalls===1);await f.core.tick();assert.equal(healthCalls,1);
  release();await first;
  assert.equal(scheduled[0],250);assert.ok(scheduled.at(-1)>=250&&scheduled.at(-1)<=1000);
  assert.equal(f.core.latency.poll.targetIntervalMs,1000);assert.equal(f.core.polling,false);
});

test('each model request loads the current valid persona and records hashes of the actual prepared input',async t=>{
  const calls=[];
  const f=fixture(t,{model:async args=>{calls.push(args);args.onPrepared(promptDiagnostics(args.persona,modelMessages(args.persona,args.session,args.memories)));return {text:'接到了'};}});
  f.ingest('first','小汐，说句招呼');await waitFor(()=>f.core.processing.size===0);
  const first=f.core.modelInput;
  const file=path.join(f.root,'character_card.json');const card=JSON.parse(fs.readFileSync(file,'utf8'));card.typing=['new expression marker'];
  fs.writeFileSync(file,JSON.stringify(card));
  f.ingest('second','小汐你好');await waitFor(()=>f.core.processing.size===0);
  assert.deepEqual(calls[1].persona.typing,['new expression marker']);
  assert.notEqual(first.sourceSha256,f.core.modelInput.sourceSha256);assert.notEqual(first.expressionSha256,f.core.modelInput.expressionSha256);
  assert.equal(f.core.modelInput.stage,'completed');assert.equal(f.core.modelInput.prepared,true);
  assert.equal(f.core.personaStatus.revision,2);assert.equal(f.core.personaStatus.lastError,null);
  assert.ok(!JSON.stringify(f.core.modelInput).includes('new expression marker'));
  fs.writeFileSync(file,'{"id":');
  f.ingest('third','小汐，说句话');await waitFor(()=>f.core.processing.size===0);
  assert.deepEqual(calls[2].persona.typing,['new expression marker']);assert.equal(f.core.personaStatus.reload,'retained_previous');
  assert.equal(f.core.personaStatus.lastError.code,'invalid_json');
});

test('changing topic with a new question cancels the old answer and generates only in the new context',async t=>{
  const calls=[];let release;
  const f=fixture(t,{model:args=>{calls.push(args);return calls.length===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({text:'喜欢雨后凉快一点。'});}});
  f.ingest('old','小汐，讨论旧话题');await waitFor(()=>calls.length===1);
  f.ingest('new','小汐，换个话题，你喜欢雨天吗');
  assert.equal(calls[0].signal.aborted,true);release({text:'这是旧答案'});
  await waitFor(()=>calls.length===2&&f.core.processing.size===0);
  assert.equal(calls[1].session.request.text,'你喜欢雨天吗');
  assert.ok(calls[1].session.context.generation>calls[0].session.context.generation);
  assert.deepEqual(calls[1].session.context.messages.map(x=>x.text),['你喜欢雨天吗']);
  assert.deepEqual(f.sent.map(x=>x.text),['喜欢雨后凉快一点。']);
});

test('local topic change retains the following question without the old conversation',async t=>{
  const prompts=[];const f=fixture(t,{model:async args=>{prompts.push(modelMessages(args.persona,args.session,args.memories));return {text:'新话题的回答'};}});
  const local=f.core.store.value.sessions.find(x=>x.channel==='local');
  await f.core.localChat(local.id,'这是旧话题');
  await f.core.localChat(local.id,'小汐，换个话题，你喜欢雨天吗');
  const serialized=JSON.stringify(prompts[1].slice(1));
  assert.ok(!serialized.includes('这是旧话题'));assert.ok(serialized.includes('你喜欢雨天吗'));
  assert.ok(!serialized.includes('换个话题'));
});

test('local compound topic change starts the new request while the aborted old model unwinds',async t=>{
  let release;const calls=[];const f=fixture(t,{model:args=>{calls.push(args);return calls.length===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({text:'新的回答'});}});
  const local=f.core.store.value.sessions.find(x=>x.channel==='local');
  const old=f.core.localChat(local.id,'之前的问题');await waitFor(()=>calls.length===1);
  assert.equal(await f.core.localChat(local.id,'小汐，换个话题，你喜欢什么'),'新的回答');
  assert.equal(calls[0].signal.aborted,true);release({text:'不应出现的旧答案'});assert.equal(await old,null);
  assert.deepEqual(f.core.store.session(local.id).messages.map(x=>x.text),['你喜欢什么','新的回答']);
});

test('negated or quoted media mentions reach conversation without a capability template or voice call',async t=>{
  let generated=0,voiced=0;
  const f=fixture(t,{model:async()=>{generated++;return {text:'明白，继续聊。'};}});
  f.core.voice={generate:async()=>{voiced++;throw Error('Unrequested voice');}};
  for(const [i,text] of ['小汐，我又没让你看图','小汐，别用语音了，用文字','小汐，别人说“这段语音”，我是在举例'].entries()){
    f.ingest('ordinary'+i,text);await waitFor(()=>f.core.processing.size===0);
  }
  assert.equal(generated,3);assert.equal(voiced,0);assert.deepEqual(f.sent.map(x=>x.text),Array(3).fill('明白，继续聊。'));
  f.ingest('image','小汐，别长篇解释，看看这张图');await waitFor(()=>f.core.processing.size===0);
  assert.equal(generated,3);assert.match(f.sent.at(-1).text,/图.*没取到/);assert.doesNotMatch(f.sent.at(-1).text,/已经看|看到了/);
});

for(const operation of ['change_topic','wait']) test(`slow generation is invalidated by ${operation}, never sent after the model finishes`,async t=>{
  const pending=[];const f=fixture(t,{model:args=>new Promise(resolve=>pending.push({args,resolve}))});
  f.ingest('slow','小汐，认真分析这个方案');await waitFor(()=>pending.length===1);
  const sessionId=f.core.sessionFor('group_abao').id;
  await f.core.dispatch('session.control',{sessionId,control:operation});
  assert.equal(pending[0].args.signal.aborted,true);
  pending[0].resolve({text:'这条旧答案不应发送'});await waitFor(()=>f.core.processing.size===0);
  assert.equal(f.sent.length,0);assert.equal(f.core.store.value.outbox.length,0);
  if(operation==='wait')assert.ok(f.core.policy.state(sessionId).waiting);
  else assert.equal(f.core.context.snapshot(sessionId).messages.length,0);
});

test('actual polling gap invalidates a slow model and its old context snapshot',async t=>{
  const pending=[];const f=fixture(t,{model:args=>new Promise(resolve=>pending.push({args,resolve}))});
  const a=f.target(), baseline=message('old-visible','之前可见');f.core.gate.observe(a,snapshot([baseline]));
  f.ingest('slow','小汐，解释上文');await waitFor(()=>pending.length===1);
  const original=f.core.bridge.call;f.core.bridge.call=async(command,fields)=>command==='read'?snapshot([message('entirely-new','可见窗口已跳到另一段')]):original(command,fields);
  await f.core.tick();assert.equal(pending[0].args.signal.aborted,true);
  pending[0].resolve({text:'缺口之前的旧答案'});await waitFor(()=>f.core.processing.size===0);
  assert.equal(f.sent.length,0);
  const afterGap=f.core.context.snapshot(f.core.sessionFor(a.id).id).messages;
  assert.deepEqual(afterGap.map(row=>row.text),['可见窗口已跳到另一段']);
  assert.ok(afterGap.every(row=>row.observationMode==='baseline'&&row.role==='unknown'));
});

test('a control received after generation cancels the confirmed-unsent deferred reply',async t=>{
  const f=fixture(t,{send:async()=>({status:'deferred',note:'用户有手动草稿',ids:[]})});
  f.ingest('ask','小汐，给个建议');await waitFor(()=>f.core.store.value.outbox.some(x=>x.status==='deferred'));
  f.ingest('cancel','小汐，停止本轮');await waitFor(()=>f.core.processing.size===0);
  assert.equal(f.sent.length,1);assert.equal(f.core.store.value.outbox[0].status,'not_sent');
});

test('group memory request needs owner approval, and edited/deleted facts cancel in-flight model work',async t=>{
  const pending=[];const f=fixture(t,{model:args=>new Promise(resolve=>pending.push({args,resolve}))});
  f.ingest('remember','小汐，记住本群周六晚八点讨论');await waitFor(()=>f.core.processing.size===0);
  assert.equal(pending.length,0);assert.equal(f.core.store.value.memories.length,0);
  const candidate=f.core.store.value.memoryCandidates[0];assert.equal(candidate.status,'pending');
  assert.match(f.sent[0].text,/确认前还不算长期记住/);
  await f.core.dispatch('memory.approve',{id:candidate.id});const saved=f.core.store.value.memories[0];
  f.ingest('ask','小汐，按共同约定给个建议');await waitFor(()=>pending.length===1);
  assert.equal(pending[0].args.memories[0].text,'本群周六晚八点讨论');
  await f.core.dispatch('memory.edit',{id:saved.id,text:'本群改在周日晚八点讨论'});
  assert.equal(pending[0].args.signal.aborted,true);pending[0].resolve({text:'使用错误周六时间的答案'});await waitFor(()=>f.core.processing.size===0);
  assert.equal(f.sent.length,1);
  f.ingest('ask2','小汐，再按共同约定给个建议');await waitFor(()=>pending.length===2);
  assert.equal(pending[1].args.memories[0].text,'本群改在周日晚八点讨论');
  await f.core.dispatch('memory.remove',{id:saved.id});assert.equal(pending[1].args.signal.aborted,true);
  pending[1].resolve({text:'引用已删除记忆的答案'});await waitFor(()=>f.core.processing.size===0);
  assert.equal(f.sent.length,1);assert.equal(f.core.store.value.memories[0].status,'deleted');
});

async function savedTask(f,{approve=true}={}) {
  const created=await f.core.dispatch('task.save',{targetId:'group_abao',text:'讨论方案',dueAt:'2026-10-24T17:01:00+08:00',timeZone:'Asia/Shanghai'});
  assert.equal(created.task.status,'proposed');
  if(approve)await f.core.dispatch('task.approve',{id:created.task.id});
  return created.task.id;
}
test('a local reminder is proposed first, explicit approval enables one durable due-time attempt',async t=>{
  const f=fixture(t);const id=await savedTask(f,{approve:false});f.clock.value+=60000;
  await f.core.runTasks();assert.equal(f.sent.length,0);
  f.clock.value-=60000;await f.core.dispatch('task.approve',{id});f.clock.value+=60000;
  await Promise.all([f.core.runTasks(),f.core.runTasks()]);await f.core.runTasks();
  assert.equal(f.sent.length,1);assert.equal(f.core.store.value.tasks.find(x=>x.id===id).status,'local_echo');
  assert.equal(f.core.store.value.outbox.filter(x=>x.taskId===id).length,1);
});
test('unknown reminder submission remains unknown and is not retried after reconstructing the core',async t=>{
  const f=fixture(t,{send:async()=>({status:'unknown',note:'提交后未确认',ids:[]})});const id=await savedTask(f);f.clock.value+=60000;
  await f.core.runTasks();assert.equal(f.core.store.value.tasks.find(x=>x.id===id).status,'unknown');
  await f.core.runTasks();assert.equal(f.sent.length,1);
  const restored=f.open();await restored.runTasks();assert.equal(f.sent.length,1);
  assert.equal(restored.store.value.tasks.find(x=>x.id===id).status,'unknown');
});
for(const state of ['disabled','paused','observe']) test(`due reminders cannot send to a ${state} target`,async t=>{
  const f=fixture(t);const id=await savedTask(f);
  if(state==='paused')await f.core.dispatch('target.pause',{id:'group_abao',paused:true});
  else f.core.store.change(s=>{const target=s.targets.find(x=>x.id==='group_abao');if(state==='disabled')target.enabled=false;else target.mode='observe';});
  f.clock.value+=60000;await f.core.runTasks();assert.equal(f.sent.length,0);
  assert.equal(f.core.store.value.tasks.find(x=>x.id===id).status,'scheduled');
  f.clock.value+=60001;await f.core.runTasks();assert.equal(f.sent.length,0);
  assert.equal(f.core.store.value.tasks.find(x=>x.id===id).status,'missed');
});

test('proactive participation defaults off, requires current-topic opt-in, and unknown attempts survive restart limits',async t=>{
  const modelCalls=[];const f=fixture(t,{model:async args=>{modelCalls.push(args);return {text:'可以先比较两个方案的总成本。'};},send:async()=>({status:'unknown',note:'提交情况不明',ids:[]})});
  f.ingest('off','大家觉得这个方案怎么样？');assert.equal(modelCalls.length,0);
  f.core.store.change(s=>{s.targets.find(x=>x.id==='group_abao').proactive={enabled:true,ownerApproved:true,quietHours:false};});
  f.ingest('ordinary','今天阳光很好');assert.equal(modelCalls.length,0);
  f.ingest('on','大家觉得这两个方案怎么选？');await waitFor(()=>f.core.processing.size===0);
  assert.equal(modelCalls.length,1);assert.equal(modelCalls[0].session.taskInstruction.kind,'proactive');
  const sessionId=f.core.sessionFor('group_abao').id;
  assert.equal(f.core.policy.state(sessionId).proactive.sent.length,1);assert.equal(f.core.store.value.sessions.find(x=>x.id===sessionId).proactiveUsage.sent[0].status,'unknown');
  f.ingest('other-room','大家觉得这两个方案怎么选？','group_family');assert.equal(modelCalls.length,1);
  const restored=f.open();const usage=restored.policy.state(sessionId).proactive;
  assert.equal(usage.sent.length,1);assert.equal(usage.awaitingResponse,true);
  restored.ingest(f.target('group_abao',restored),message('after-restart','大家觉得还有什么好办法？'),snapshot());
  await turn();assert.equal(modelCalls.length,1);assert.equal(f.sent.length,1);
});

test('two-bubble reply records the first success and never retries an unknown second bubble',async t=>{
  const f=fixture(t,{model:async()=>({text:`第一条已确定的内容${REPLY_PART_SEPARATOR}第二条补充内容`}),send:async(_fields,n)=>({status:n===1?'local_echo':'unknown',note:'结果',ids:[]})});
  f.core.store.change(s=>s.targets[0].preferences={splitReplies:true});f.ingest('two','小汐，分两点说');
  await waitFor(()=>f.core.processing.size===0);
  assert.deepEqual(f.sent.map(x=>x.text),['第一条已确定的内容','第二条补充内容']);
  assert.deepEqual(f.core.store.value.outbox.map(x=>x.status),['local_echo','unknown']);
  const context=f.core.context.snapshot(f.core.sessionFor('group_abao').id);
  assert.deepEqual(context.messages.filter(x=>x.role==='assistant').map(x=>x.text),['第一条已确定的内容']);
  const restored=f.open();await restored.runTasks();assert.equal(f.sent.length,2);
});

test('cancelling between two bubbles leaves the first local echo and suppresses the unsent second',async t=>{
  const f=fixture(t,{model:async()=>({text:`第一条${REPLY_PART_SEPARATOR}第二条不应发送`}),send:async(_fields,n,core)=>{
    if(n===1)await core.dispatch('session.control',{sessionId:core.sessionFor('group_abao').id,control:'stop_current'});
    return {status:'local_echo',ids:[]};
  }});
  f.core.store.change(s=>s.targets[0].preferences={splitReplies:true});f.ingest('two','小汐，分两点回答');
  await waitFor(()=>f.core.processing.size===0);
  assert.deepEqual(f.sent.map(x=>x.text),['第一条']);assert.equal(f.core.store.value.outbox.length,1);
  assert.equal(f.core.store.value.outbox[0].status,'local_echo');
});

test('unknown historical assistant text cannot leak back through the core-to-model prompt',async t=>{
  let prompt;const f=fixture(t,{model:async args=>{prompt=modelMessages(args.persona,args.session,args.memories);return {text:'只依据已见内容回答。'};}});
  const sessionId=f.core.sessionFor('group_abao').id;
  f.core.store.change(s=>s.sessions.find(x=>x.id===sessionId).messages.push({id:'unknown-history',role:'assistant',status:'unknown',text:'UNKNOWN_ASSISTANT_SECRET'}));
  assert.equal(f.core.context.observe(sessionId,{id:'unknown-buffer',text:'UNKNOWN_BUFFER_SECRET',role:'assistant',status:'unknown'}),null);
  f.ingest('fresh','小汐，请回答当前这句');await waitFor(()=>f.core.processing.size===0);
  assert.ok(!JSON.stringify(prompt).includes('UNKNOWN_ASSISTANT_SECRET'));
  assert.ok(!JSON.stringify(prompt).includes('UNKNOWN_BUFFER_SECRET'));
  assert.match(prompt.at(-1).content,/当前这句/);
});

test('a correction replaces an unfinished answer and preserves source identity in the combined request',async t=>{
  const pending=[];const f=fixture(t,{model:args=>new Promise(resolve=>pending.push({args,resolve}))});
  f.ingest('first','小汐，帮我算一下这顿饭的预算');await waitFor(()=>pending.length===1);
  f.clock.value+=1000;f.ingest('supplement','补充一下，五个人一共两百元');
  assert.equal(pending[0].args.signal.aborted,true);pending[0].resolve({text:'旧草稿不能发送'});
  await waitFor(()=>pending.length===2);
  assert.match(pending[1].args.session.request.text,/五个人/);
  const input=modelMessages(pending[1].args.persona,pending[1].args.session,[]);
  const revised=input.map(row=>{try{return JSON.parse(row.content);}catch{return null;}}).find(row=>row?.type==='revised_pending_requests');
  assert.equal(revised.observations[0].text,'小汐，帮我算一下这顿饭的预算');
  assert.equal(revised.observations[0].sender.evidence,'unknown');
  pending[1].resolve({text:'每人四十'});await waitFor(()=>!f.core.processing.size);
  assert.deepEqual(f.sent.map(row=>row.text),['每人四十']);assert.equal(f.core.latency.revisedReplies,1);
});

test('re-evaluation collapses a pending correction chain without three serial model calls',async t=>{
  const pending=[];const f=fixture(t,{model:args=>new Promise(resolve=>pending.push({args,resolve}))});
  f.ingest('first','小汐，评价这份清单');await waitFor(()=>pending.length===1);
  f.clock.value+=1000;f.ingest('revision','补充一下，刚才价格写错了');
  f.clock.value+=1000;f.ingest('refresh','小汐，重新评价上文');
  pending[0].resolve({text:'旧清单答案'});await waitFor(()=>pending.length===2);
  assert.equal(pending[1].args.session.request.text,'小汐，重新评价上文');
  assert.equal(pending[1].args.session.request.revisionSourceKeys.length,2);
  pending[1].resolve({text:'新清单答案'});await waitFor(()=>!f.core.processing.size);
  assert.deepEqual(f.sent.map(row=>row.text),['新清单答案']);assert.equal(pending.length,2);
});

test('different verified members retain separate turns even when asking to re-evaluate',async t=>{
  const pending=[];const f=fixture(t,{model:args=>new Promise(resolve=>pending.push({args,resolve}))});
  const send=(id,text,member)=>f.core.ingest(f.target(),{...message(id,text),sender:{id:member,evidence:'stable_id'}},snapshot());
  send('first','小汐，解释这份清单','a');await waitFor(()=>pending.length===1);
  f.clock.value+=1000;send('second','小汐，重新评价这份清单','b');assert.equal(pending[0].args.signal.aborted,false);
  pending[0].resolve({text:'给第一位的回答'});await waitFor(()=>pending.length===2);
  pending[1].resolve({text:'给第二位的回答'});await waitFor(()=>!f.core.processing.size);
  assert.equal(f.sent.length,2);
});

test('a revision during native submission never cancels or duplicates a committed send',async t=>{
  let resolveSend;const pending=[];const f=fixture(t,{model:async args=>{pending.push(args);return {text:'回答'+pending.length};},send:()=>new Promise(resolve=>resolveSend=resolve)});
  f.ingest('first','小汐，评价上文');await waitFor(()=>f.sent.length===1);
  f.clock.value+=1000;f.ingest('second','小汐，重新评价上文');assert.equal(pending[0].signal.aborted,false);
  resolveSend({status:'local_echo',ids:[]});await waitFor(()=>f.sent.length===2);
  resolveSend({status:'local_echo',ids:[]});await waitFor(()=>!f.core.processing.size);
  assert.deepEqual(f.sent.map(row=>row.text),['回答1','回答2']);
});

test('queued independent group requests each keep their own question instead of answering the latest one twice',async t=>{
  const pending=[];const f=fixture(t,{model:args=>new Promise(resolve=>pending.push({args,resolve}))});
  f.ingest('first','小汐，第一个问题是成本');await waitFor(()=>pending.length===1);
  f.ingest('second','小汐，第二个问题是时间');assert.equal(pending.length,1);
  assert.equal(pending[0].args.session.request.text,'小汐，第一个问题是成本');
  pending[0].resolve({text:'成本回答'});await waitFor(()=>pending.length===2);
  assert.equal(pending[1].args.session.request.text,'小汐，第二个问题是时间');
  pending[1].resolve({text:'时间回答'});await waitFor(()=>f.core.processing.size===0);
  assert.deepEqual(f.sent.map(x=>x.text),['成本回答','时间回答']);
  assert.deepEqual(f.core.store.value.inbox.map(x=>x.status),['completed','completed']);
});

test('owner cancellation aborts a claimed but unsent deferred reminder without a later retry',async t=>{
  const f=fixture(t,{send:async()=>({status:'deferred',note:'用户正在编辑',ids:[]})});
  const id=await savedTask(f);f.clock.value+=60000;
  const running=f.core.runTasks();await waitFor(()=>f.core.store.value.outbox.some(x=>x.status==='deferred'));
  assert.equal(f.core.store.value.tasks.find(x=>x.id===id).status,'claimed');
  const result=await f.core.dispatch('task.cancel',{id});assert.equal(result.code,'cancellation_requested');
  await running;await f.core.runTasks();
  assert.equal(f.sent.length,1);assert.equal(f.core.store.value.tasks.find(x=>x.id===id).status,'not_sent');
});

test('search is opt-in and uses only its explicit query; cancelling it prevents a late response',async t=>{
  const searches=[];const f=fixture(t,{search:args=>new Promise(resolve=>searches.push({args,resolve}))});
  f.ingest('search-disabled','小汐，搜索 Node 官方文档');await waitFor(()=>f.core.processing.size===0);
  assert.equal(searches.length,0);assert.match(f.sent[0].text,/联网查询尚未启用/);
  f.core.store.change(s=>{s.settings.allowSearch=true;});
  f.ingest('private-background','群里刚才聊到的私人事情');
  f.ingest('search-enabled','小汐，搜索 Node 官方文档');await waitFor(()=>searches.length===1);
  const sentBeforeCancellation=f.sent.length;
  assert.equal(searches[0].args.query,'Node 官方文档');
  assert.ok(!JSON.stringify(searches[0].args).includes('群里刚才聊到的私人事情'));
  f.ingest('cancel-search','小汐，停止本轮');assert.equal(searches[0].args.signal.aborted,true);
  searches[0].resolve({text:'迟到的检索结果'});await waitFor(()=>f.core.processing.size===0);
  assert.equal(f.sent.length,sentBeforeCancellation);assert.ok(f.sent.every(row=>row.text!=='迟到的检索结果'));
});

test('local natural-language memory edits and deletion cut off stale history while returning their own confirmation',async t=>{
  const prompts=[];const f=fixture(t,{model:async args=>{prompts.push(modelMessages(args.persona,args.session,args.memories));return {text:'按当前有效信息回答。'};}});
  const local=f.core.store.value.sessions.find(x=>x.channel==='local');
  await f.core.dispatch('memory.save',{sessionId:local.id,text:'本群暗号 OLD_FACT_MUST_DISAPPEAR'});
  const saved=f.core.store.value.memories.find(x=>x.sessionId===local.id);
  f.core.store.change(s=>s.sessions.find(x=>x.id===local.id).messages.push({id:'old-user',role:'user',text:'OLD_FACT_MUST_DISAPPEAR',createdAt:baseTime-1000},
    {id:'old-answer',role:'assistant',text:'OLD_FACT_MUST_DISAPPEAR',createdAt:baseTime-500}));
  const editResult=await f.core.localChat(local.id,`小汐，修改记忆 ${saved.id} 改成 本群暗号 NEW_FACT`);
  assert.equal(editResult,'记忆操作已保存。');assert.equal(f.core.store.session(local.id).historyCutoffAt,baseTime);
  f.core.store.change(s=>s.sessions.find(x=>x.id===local.id).messages.push({id:'same-millisecond-question',role:'user',text:'SAME_MILLISECOND_CURRENT_REQUEST',createdAt:baseTime}));
  await f.core.reply(local.id);
  assert.ok(!JSON.stringify(prompts[0]).includes('OLD_FACT_MUST_DISAPPEAR'));
  assert.ok(JSON.stringify(prompts[0]).includes('NEW_FACT'));
  assert.ok(JSON.stringify(prompts[0]).includes('SAME_MILLISECOND_CURRENT_REQUEST'));
  f.clock.value=Date.now()+10;
  const deleteResult=await f.core.localChat(local.id,`小汐，忘掉 ${saved.id}`);
  assert.equal(deleteResult,'记忆操作已保存。');assert.equal(f.core.store.session(local.id).historyCutoffAt,f.clock.value);
  f.core.store.change(s=>s.sessions.find(x=>x.id===local.id).messages.push({id:'after-delete-question',role:'user',text:'AFTER_DELETE_CURRENT_REQUEST',createdAt:f.clock.value}));
  await f.core.reply(local.id);
  assert.ok(!JSON.stringify(prompts[1]).includes('NEW_FACT'));
  assert.ok(JSON.stringify(prompts[1]).includes('AFTER_DELETE_CURRENT_REQUEST'));
  assert.equal(f.sent.length,0);
});

test('stop-current during the pre-model batch cancels the pending request and its same-member fragments',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'仅回复新的独立请求'};}});
  const stable=(id,text)=>({...message(id,text),sender:{id:'memberA',evidence:'stable_id'}});
  f.core.ingest(f.target(),stable('batched-first','小汐，帮我分析第一个方案'),snapshot());
  f.core.ingest(f.target(),stable('batched-fragment','小汐，补充一下，成本是两百'),snapshot());
  const sessionId=f.core.sessionFor('group_abao').id;
  assert.equal(calls.length,0);assert.equal(f.core.pending.get(sessionId).length,1);assert.ok(f.core.batchTimers.has(sessionId));
  assert.ok(f.core.store.value.inbox[0].supersededBy);assert.equal(f.core.context.snapshot(sessionId).messages.length,2);
  await f.core.dispatch('session.control',{sessionId,control:'stop_current'});
  assert.equal(f.core.pending.get(sessionId).length,0);assert.equal(f.core.batchTimers.has(sessionId),false);
  assert.deepEqual(f.core.store.value.inbox.map(x=>x.status),['skipped','skipped']);
  f.ingest('new-request','小汐，新的问题是第三个方案');await waitFor(()=>f.core.processing.size===0);
  assert.equal(calls.length,1);assert.equal(calls[0].session.request.text,'小汐，新的问题是第三个方案');assert.equal(f.sent.length,1);
});

test('stop-current before a batch starts preserves and schedules a later independent request',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'仅回答第二个问题'};}});
  f.core.ingest(f.target(),{...message('batch-a','小汐，第一个问题'),sender:{id:'memberA',evidence:'stable_id'}},snapshot());
  f.core.ingest(f.target(),{...message('batch-b','小汐，第二个独立问题'),sender:{id:'memberB',evidence:'stable_id'}},snapshot());
  const sessionId=f.core.sessionFor('group_abao').id;
  await f.core.dispatch('cancel',{sessionId});
  assert.equal(f.core.pending.get(sessionId).length,1);assert.ok(f.core.batchTimers.has(sessionId));
  await waitFor(()=>calls.length===1&&f.core.processing.size===0,'independent batched request');
  assert.equal(calls[0].session.request.text,'小汐，第二个独立问题');
  assert.deepEqual(f.core.store.value.inbox.map(x=>x.status),['skipped','completed']);assert.equal(f.sent.length,1);
});

test('malformed reminder send result reaches a durable unknown outcome instead of leaving claimed forever',async t=>{
  const f=fixture(t,{send:async()=>null});const id=await savedTask(f);f.clock.value+=60000;
  await f.core.runTasks();
  assert.equal(f.core.store.value.tasks.find(x=>x.id===id).status,'unknown');
  assert.equal(f.core.store.value.outbox.find(x=>x.taskId===id).status,'unknown');
  assert.equal(f.core.suspended.has('group_abao'),true);
  await f.core.runTasks();assert.equal(f.sent.length,1);
});

test('due reminder whose target was removed reaches an unsent terminal state',async t=>{
  const f=fixture(t);const id=await savedTask(f);
  f.core.store.change(s=>{s.targets=s.targets.filter(x=>x.id!=='group_abao');});f.clock.value+=60000;
  await f.core.runTasks();
  const task=f.core.store.value.tasks.find(x=>x.id===id);
  assert.equal(task.status,'not_sent');assert.equal(task.reason,'target_unavailable');assert.equal(task.attemptId,null);
  assert.equal(f.sent.length,0);assert.equal(f.core.store.value.outbox.length,0);
});

test('local topic change suppresses a late voice text fallback from the cancelled conversation',async t=>{
  let releaseVoice, voiceSignal;
  const f=fixture(t,{model:async args=>({text:args.session.messages.at(-1).text.includes('用语音')?'旧话题的答案':'新话题的答案'})});
  f.core.voice={generate:({signal})=>{voiceSignal=signal;return new Promise(resolve=>{releaseVoice=resolve;});}};
  const local=f.core.store.value.sessions.find(x=>x.channel==='local');
  const old=f.core.localChat(local.id,'小汐，用语音说给我听');
  await waitFor(()=>!!releaseVoice,'pending voice fallback');
  assert.equal(await f.core.localChat(local.id,'小汐，换个话题，你喜欢雨天吗'),'新话题的答案');
  assert.equal(voiceSignal.aborted,true);
  // A provider may settle after cancellation. The core still owns the final
  // decision to publish text, including its local UI/history publication.
  releaseVoice({kind:'text',text:'旧话题的答案'});
  assert.equal(await old,null);
  assert.deepEqual(f.core.store.session(local.id).messages.map(x=>x.text),['你喜欢雨天吗','新话题的答案']);
  assert.equal(f.sent.length,0);
});

test('a new explicit topic suppresses a late missing-city clarification without dropping the new request',async t=>{
  let release;const calls=[];
  const f=fixture(t,{model:args=>{calls.push(args);return calls.length===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({text:'我先看看这位群友的发言'});}});
  f.ingest('weather_first','小汐，天气怎么样');await waitFor(()=>!!release);
  f.ingest('new_topic','小汐，评价一下群里的Member A');
  release({text:'哪座城市？'});await waitFor(()=>f.core.processing.size===0&&calls.length===2);
  assert.deepEqual(f.sent.map(row=>row.text),['我先看看这位群友的发言']);
  assert.equal(f.core.store.value.inbox[0].status,'skipped');
  assert.equal(f.core.store.value.inbox[1].status,'completed');
});

test('new topic interrupts a clarification waiting for foreground release without replaying it',async t=>{
  let attempts=0;
  const f=fixture(t,{model:async args=>({text:args.session.request.text.includes('天气')?'哪座城市？':'新问题的回答'}),
    send:async fields=>{attempts++;return fields.text==='哪座城市？'?{status:'deferred',note:'manual draft'}:{status:'local_echo',ids:[]};}});
  f.ingest('waiting_weather','小汐，天气怎么样');await waitFor(()=>attempts===1);
  f.ingest('replace','小汐，解释一下数组引用');
  await waitFor(()=>f.core.processing.size===0&&f.sent.some(row=>row.text==='新问题的回答'));
  assert.equal(f.sent.filter(row=>row.text==='哪座城市？').length,1);
  assert.equal(f.core.store.value.outbox.filter(row=>row.status==='local_echo').length,1);
});

test('an accepted complete followup without the bot name replaces a deferred city question',async t=>{
  let attempts=0;const calls=[];
  const f=fixture(t,{model:async args=>{calls.push(args);return {text:args.session.request.text.includes('北京')?'北京天气的有效回答':'哪座城市？'};},
    send:async fields=>{attempts++;return fields.text==='哪座城市？'?{status:'deferred',note:'manual draft'}:{status:'local_echo',ids:[]};}});
  f.ingest('weather_unconfirmed','小汐，天气怎么样');await waitFor(()=>attempts===1);
  f.ingest('full_followup','北京今天天气怎么样');
  await waitFor(()=>f.core.processing.size===0&&calls.length===2);
  assert.equal(f.sent.filter(row=>row.text==='哪座城市？').length,1);
  assert.equal(f.sent.at(-1).text,'北京天气的有效回答');
});

test('online weather routing does not swallow an explicitly resumed multi-message request',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'预算五百，想要轻一点的，先按这两个条件选'};}});
  f.core.store.change(s=>s.settings.allowSearch=true);
  const known=(id,text)=>f.core.ingest(f.target(),{...message(id,text),sender:{id:'member_a',evidence:'stable_id'}},snapshot());
  known('wait_known','小汐，等我说完');known('budget_known','预算500');known('weight_known','还有要轻一点');
  assert.equal(calls.length,0);known('resume_known','小汐，我说完了');
  await waitFor(()=>f.core.processing.size===0&&calls.length===1);
  assert.match(calls[0].session.request.text,/预算500/);assert.match(calls[0].session.request.text,/轻一点/);
  assert.equal(f.sent.length,1);assert.equal(f.core.store.value.inbox.at(-1).status,'completed');
});

test('normal public current-fact questions use isolated search during unnamed engagement',async t=>{
  const calls=[];let modelCalls=0;
  const f=fixture(t,{model:async()=>{modelCalls++;return {text:'不该走普通模型'};},search:async args=>{calls.push(args);return {text:'官方发布信息：https://nodejs.org/en/blog/release/'};}});
  f.core.store.change(s=>{s.settings.allowSearch=true;});
  f.ingest('hello_online','小汐');await waitFor(()=>f.core.processing.size===0);
  f.ingest('current_fact','Node.js 最新版本是多少');await waitFor(()=>f.core.processing.size===0&&calls.length===1);
  assert.equal(modelCalls,0);assert.equal(calls[0].query,'Node.js 最新版本是多少');
  assert.equal(calls[0].session,undefined);assert.equal(calls[0].memories,undefined);assert.equal(calls[0].persona,undefined);
  assert.equal(f.core.latency.recent.at(-1).responsePath,'web_search');
  f.ingest('explicit_followup','帮我查一下 JavaScript 官方参考文档');await waitFor(()=>f.core.processing.size===0&&calls.length===2);
  assert.equal(calls[1].query,'JavaScript 官方参考文档');
});

test('contextual research actually searches first, then answers with persona and current-group evidence',async t=>{
  const order=[],searches=[],calls=[];
  const f=fixture(t,{search:async args=>{order.push('search');searches.push(args);return {text:'公共诊断要求 https://www.who.int/',searchUsed:true,sources:['https://www.who.int/']};},model:async args=>{order.push('answer');calls.push(args);return {text:'查到的概念能这样对照，但不等于确诊 https://www.who.int/'};}});
  f.core.store.change(s=>{s.settings.allowSearch=true;});
  f.ingest('other-room','不能混入的另一个群背景','group_abao');
  f.ingest('history','Member A认为送礼可以保证录取','group_family');
  f.ingest('research','小汐匹配一下Member A能对上的心理疾病','group_family');
  await waitFor(()=>f.core.processing.size===0&&calls.length===1);
  assert.deepEqual(order,['search','answer']);assert.equal(f.sent.length,1);
  const searchInput=JSON.stringify(searches[0]);
  for(const secret of ['Member A','保证录取','另一个群背景'])assert.ok(!searchInput.includes(secret));
  assert.equal(searches[0].settings.model,'gpt-6-astra');assert.equal(searches[0].session,undefined);
  assert.equal(calls[0].session.publicResearch.status,'completed');assert.equal(calls[0].persona.name,'小汐');
  assert.ok(JSON.stringify(calls[0].session.context).includes('Member A认为送礼'));
  assert.ok(!JSON.stringify(calls[0]).includes('另一个群背景'));
  assert.equal(f.core.latency.recent.at(-1).responsePath,'public_research');
  assert.equal(f.core.latency.recent.at(-1).research.status,'completed');
  f.ingest('repeat-research','小汐，分析一下这些表现是否符合人格障碍','group_family');
  await waitFor(()=>f.core.processing.size===0&&calls.length===2);
  assert.equal(searches.length,1);assert.equal(calls[1].session.publicResearch.reused,true);
  assert.equal(calls[1].settings.webSearch,false);
  f.ingest('gift-research','小汐，Member A说你不懂送礼，山东人特长就是送礼，请你搜集相关资料加深自己人格形象印象','group_family');
  await waitFor(()=>f.core.processing.size===0&&calls.length===3);
  assert.match(searches[1].query,/教育部/);assert.ok(!JSON.stringify(searches[1]).includes('山东'));
  assert.equal(f.core.store.value.memories.length,0);
});

test('failed or unverified research continues with explicit missing-evidence status, never fabricated sources',async t=>{
  const calls=[];const f=fixture(t,{search:async()=>({text:'我查过了 https://example.com/',sources:['https://example.com/'],searchUsed:false}),model:async args=>{calls.push(args);return {text:'此次查询没完成，已提供的行为仍可讨论'};}});
  f.core.store.change(s=>s.settings.allowSearch=true);
  f.ingest('failed-research','小汐，分析一下这些表现是否符合人格障碍');
  await waitFor(()=>f.core.processing.size===0&&calls.length===1);
  assert.deepEqual(calls[0].session.publicResearch,{topic:'personality_concepts',status:'failed',reason:'unverified'});
  assert.equal(f.sent.length,1);assert.ok(!JSON.stringify(calls[0]).includes('example.com'));
});

test('cancel during research prevents both a late analysis and late delivery',async t=>{
  let release,signal,models=0;
  const f=fixture(t,{search:args=>{signal=args.signal;return new Promise(resolve=>release=resolve);},model:async()=>{models++;return {text:'late'};}});
  f.core.store.change(s=>s.settings.allowSearch=true);
  f.ingest('research-cancel','小汐，匹配一下某人的心理疾病');await waitFor(()=>!!release);
  f.ingest('stop-research','小汐，停止本轮');assert.equal(signal.aborted,true);
  release({text:'通用资料',sources:['https://www.who.int/'],searchUsed:true});await waitFor(()=>f.core.processing.size===0);
  assert.equal(models,0);assert.equal(f.sent.length,0);
});

test('disabled contextual research makes no network call and ordinary chat does not gain extra calls',async t=>{
  let models=0,searches=0;const f=fixture(t,{search:async()=>{searches++;throw Error('unexpected');},model:async()=>{models++;return {text:'根据已经提供的材料回答'};}});
  f.ingest('disabled-clinical','小汐匹配一下某人的心理疾病');await waitFor(()=>f.core.processing.size===0);
  assert.equal(models,1);assert.equal(searches,0);
  f.core.store.change(s=>s.settings.allowSearch=true);
  f.ingest('ordinary-evaluation','小汐，这种行为你怎么看');await waitFor(()=>f.core.processing.size===0);
  assert.equal(models,2);assert.equal(searches,0);
});

test('search does not run for ordinary member discussion or a rejected private search',async t=>{
  let searches=0,models=0;
  const f=fixture(t,{model:async()=>{models++;return {text:'只根据这个群实际提供的发言聊'};},search:async()=>{searches++;throw Error('Unexpected private lookup');}});
  f.core.store.change(s=>{s.settings.allowSearch=true;});
  f.ingest('member','小汐，评价一下群里的Member A');await waitFor(()=>f.core.processing.size===0);
  f.ingest('private_lookup','小汐，搜索群里的Member A的手机号');await waitFor(()=>f.core.processing.size===0);
  assert.equal(models,1);assert.equal(searches,0);
  assert.match(f.sent.at(-1).text,/公开名称或关键词/);
});

test('cancelled public search cannot deliver its result after a new topic',async t=>{
  let release,signal;
  const f=fixture(t,{model:async()=>({text:'现在聊新话题'}),search:args=>{signal=args.signal;return new Promise(resolve=>{release=resolve;});}});
  f.core.store.change(s=>{s.settings.allowSearch=true;});
  f.ingest('lookup','小汐，查一下 Node.js 官方文档');await waitFor(()=>!!release);
  f.ingest('cancel_lookup','小汐，换个话题，聊聊音乐');assert.equal(signal.aborted,true);
  release({text:'旧搜索结果 https://nodejs.org'});await waitFor(()=>f.core.processing.size===0);
  assert.deepEqual(f.sent.map(row=>row.text),['现在聊新话题']);
});

test('weather question then city uses measured weather service without a model or generic search',async t=>{
  const queries=[];let models=0;
  const f=fixture(t,{model:async()=>{models++;return {text:'不该运行'};}});
  f.core.store.change(s=>{s.settings.allowSearch=true;});
  f.core.weather=createWeatherConversation({nowMs:()=>f.clock.value,service:{getWeather:async args=>{
    queries.push(args);return {status:'ok',dateOffset:args.dateOffset,location:{name:args.city},
      current:{temperatureC:18,apparentTemperatureC:17,description:'多云'},
      daily:{date:'2026-10-24',minimumC:12,maximumC:21,description:'多云',precipitationProbabilityMax:20},
      fetchedAt:new Date(f.clock.value).toISOString(),utcOffsetSeconds:28800,cacheHit:false};
  }}});
  f.ingest('weather_ping','小汐');await waitFor(()=>f.core.processing.size===0);
  f.ingest('weather_ask','天气怎么样');await waitFor(()=>f.core.processing.size===0&&f.sent.length===2);
  assert.equal(queries.length,0);assert.equal(f.sent.at(-1).text,'哪座城市？');
  f.ingest('weather_city','北京');await waitFor(()=>f.core.processing.size===0&&f.sent.length===3);
  assert.equal(models,0);assert.equal(queries.length,1);assert.equal(queries[0].city,'北京');
  assert.match(f.sent.at(-1).text,/北京现在多云/);assert.match(f.sent.at(-1).text,/Open-Meteo预报数据/);
  assert.equal(f.core.latency.recent.at(-1).responsePath,'weather');
});

test('ranking clarification resumes isolated search with confirmed parameters and no model round-trip',async t=>{
  const searches=[];let models=0;
  const f=fixture(t,{model:async()=>{models++;return {text:'unexpected'};},search:async args=>{searches.push(args);return {text:'合成查询结果 https://example.com/'};}});
  f.core.store.change(s=>{s.settings.allowSearch=true;});
  fs.copyFileSync('test/fixtures/group_profiles.json',path.join(f.root,'group_profiles.json'));
  f.ingest('rank_question','小汐查看一下互联网十大企业','group_family');await waitFor(()=>f.core.processing.size===0&&f.sent.length===1);
  assert.equal(searches.length,0);assert.match(f.sent[0].text,/国内.*全球.*市值/);
  assert.equal(f.core.latency.recent.at(-1).responsePath,'lookup_clarification');
  f.clock.value+=1000;f.ingest('rank_slots','国内吧，市值','group_family');await waitFor(()=>f.core.processing.size===0&&f.sent.length===2);
  assert.equal(searches.length,1);assert.equal(models,0);assert.match(searches[0].query,/中国上市互联网企业.*市值/);
  assert.equal(f.core.latency.recent.at(-1).responsePath,'web_search');
  assert.ok(!/Member A|设计人|groupProfile|Example Group B/.test(JSON.stringify(searches[0])));
});

test('family graph reaches only the family model and never grants unknown speakers an identity',async t=>{
  const calls=[];const f=fixture(t,{model:async args=>{calls.push(args);return {text:'给哪个小朋友吃的，有没有忌口？'};}});
  fs.copyFileSync('test/fixtures/group_profiles.json',path.join(f.root,'group_profiles.json'));
  f.ingest('meal','小汐给Member A定制一个小学生一周的食谱及做法','group_family');await waitFor(()=>f.core.processing.size===0);
  const family=calls[0];assert.equal(family.session.groupProfile.people.length,6);
  const packets=modelMessages(family.persona,family.session,[]);
  assert.equal(JSON.parse(packets.at(-1).content).addressing.speakerLabel,null);
  f.ingest('other_group','小汐，今天好累');await waitFor(()=>f.core.processing.size===0);
  const other=calls[1];assert.equal(other.session.groupProfile,null);
  assert.ok(!/Member A|Member D|Member C/.test(JSON.stringify(modelMessages(other.persona,other.session,[]))));
});
