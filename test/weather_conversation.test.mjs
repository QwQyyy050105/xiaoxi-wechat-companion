import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {WeatherConversation} from '../src/weather_conversation.mjs';
import {ConversationContext} from '../src/conversation_context.mjs';

const NOW=Date.parse('2026-10-25T06:30:00Z');
const known=id=>({id,evidence:'stable_id'});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
let originalFetch;
before(()=>{originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('External network is forbidden in weather-conversation tests');};});
after(()=>{globalThis.fetch=originalFetch;});
function weather(city='北京',dateOffset=0){return {status:'ok',dateOffset,location:{name:city},current:{description:'晴',temperatureC:18,apparentTemperatureC:17},daily:{description:'晴',date:`2026-10-${25+dateOffset}`,minimumC:12,maximumC:22,precipitationProbabilityMax:10},fetchedAt:new Date(NOW).toISOString(),utcOffsetSeconds:28800,cacheHit:false};}
function fixture(handler){
  let now=NOW,serial=0;const calls=[],context=new ConversationContext({nowMs:()=>now});
  const service={getWeather:async args=>{calls.push(args);return handler?handler(args,calls.length):weather(args.city,args.dateOffset);}};
  const flow=new WeatherConversation({service,nowMs:()=>now});
  const input=(text,{sessionId='group_a',epoch=1,sender={evidence:'unknown'},event={},signal,isCurrent}={})=>{
    const id=`input_${++serial}`,request=context.observe(sessionId,{id,sourceKey:id,text,role:'user',receivedAt:now,sender,...event});
    return {sessionId,epoch,request,snapshot:context.snapshot(sessionId),signal,isCurrent};
  };
  const ask=async(text,options)=>{const args=input(text,options);return {...args,result:await flow.reply(args)};};
  const deliver=(turn,{status='local_echo',outPatch={},eventPatch={}}={})=>{
    const id=`bot_${++serial}`,out={id,sessionId:turn.sessionId,text:turn.result?.text,epoch:turn.epoch,contextGeneration:context.generation(turn.sessionId),...outPatch};
    if(['local_echo','confirmed'].includes(status))context.observe(turn.sessionId,{id,sourceKey:id,text:out.text,role:'assistant',status,receivedAt:now});
    flow.noteDelivery(turn.sessionId,{...turn.request,...eventPatch},out,{status});return out;
  };
  return {flow,context,calls,input,ask,deliver,advance:ms=>{now+=ms;}};
}

function mergedInput(f,{texts=['小汐，帮我想一句招呼','补充一下：自然一点'],gap=100,sender=known('a')}={}){
  const turns=texts.map((text,index)=>{if(index)f.advance(gap);return f.input(text,{sender});});
  return {...turns[0],snapshot:turns.at(-1).snapshot,request:{...turns[0].request,
    text:turns.map(turn=>turn.request.text).join('\n'),fragments:turns.map(turn=>turn.request.sourceKey)}};
}

test('verified merged ordinary chat reaches the normal model instead of being superseded',async()=>{
  const f=fixture(),args=mergedInput(f,{texts:['小汐，帮我想一句招呼','补充一下：自然一点','更正：简短一点']});
  assert.equal(await f.flow.reply(args),null);assert.equal(f.calls.length,0);
});

test('merged fragment metadata must name unique exact observed keys and preserve the original text',async()=>{
  const patches=[
    args=>({fragments:null}),args=>({fragments:'input_1'}),args=>({fragments:[]}),
    args=>({fragments:[args.request.sourceKey]}),args=>({fragments:[args.request.sourceKey,args.request.sourceKey]}),
    args=>({fragments:[...args.request.fragments].reverse()}),args=>({fragments:[args.request.sourceKey,'unseen']}),
    args=>({fragments:[args.request.sourceKey,{sourceKey:args.request.fragments[1]}]}),
    args=>({text:'北京天气'}),args=>({text:args.request.text.replace('\n',' ')}),
    args=>({sourceKey:args.request.fragments[1]}),args=>({sender:known('other')}),
    args=>({sender:{label:'a',evidence:'display_name'}}),args=>({sender:{evidence:'unknown'}}),
    args=>({role:'unknown'}),args=>({observationMode:'baseline'}),args=>({own:true}),
    args=>({generation:99}),args=>({sessionId:'other'}),args=>({textTruncated:true}),
    args=>({receivedAt:args.request.receivedAt+1})
  ];
  for(const patch of patches){
    const f=fixture(),args=mergedInput(f);args.request={...args.request,...patch(args)};
    assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});assert.equal(f.calls.length,0);
  }
});

test('every merged observation must independently remain live, current, complete and from the verified sender',async()=>{
  const patches=[
    {role:'assistant'},{role:'unknown'},{observationMode:'baseline'},{generation:99},{sessionId:'other'},
    {sender:known('other')},{sender:{label:'a',evidence:'display_name'}},{sender:{evidence:'unknown'}},
    {own:true},{textTruncated:true},{text:null},{receivedAt:Infinity},{receivedAt:NOW+101},
    {receivedAt:NOW-1},{receivedAt:NOW-180000}
  ];
  for(const patch of patches){
    const f=fixture(),args=mergedInput(f);Object.assign(args.snapshot.messages[1],patch);
    assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'},JSON.stringify(patch));assert.equal(f.calls.length,0);
  }
  const f=fixture(),args=mergedInput(f);
  args.snapshot.messages[0].receivedAt=NOW-180001;
  assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});
});

test('merged fragments cannot skip intervening observations or match duplicated source keys',async()=>{
  for(const role of ['user','assistant']){
    const f=fixture(),first=f.input('小汐，帮我想一句招呼',{sender:known('a')});
    f.context.observe('group_a',{id:'interjection',text:'另一条话题',role,sender:known('a'),...(role==='assistant'?{status:'local_echo'}:{})});
    const last=f.input('补充一下：自然一点',{sender:known('a')});
    const args={...first,snapshot:last.snapshot,request:{...first.request,text:first.request.text+'\n'+last.request.text,fragments:[first.request.sourceKey,last.request.sourceKey]}};
    assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});assert.equal(f.calls.length,0);
  }
  const f=fixture(),args=mergedInput(f);args.snapshot.messages.push({...args.snapshot.messages[1]});
  assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});assert.equal(f.calls.length,0);
});

test('only the same verified member can merge, and subsequent rows must be actual correction fragments',async()=>{
  for(const sender of [{evidence:'unknown'},{label:'群友',evidence:'display_name'}]){
    const f=fixture(),args=mergedInput(f,{sender});
    assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});assert.equal(f.calls.length,0);
  }
  for(const text of ['上海天气','你好','北京']){
    const f=fixture(),args=mergedInput(f,{texts:['小汐，天气怎么样',text]});
    assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});assert.equal(f.calls.length,0);
  }
});

test('same-read timestamp ties are valid but stale, future and widely separated fragment batches are rejected',async()=>{
  for(const gap of [0,700,89999]){
    const f=fixture(),args=mergedInput(f,{gap});assert.equal(await f.flow.reply(args),null);assert.equal(f.calls.length,0);
  }
  for(const gap of [90000,180000]){
    const f=fixture(),args=mergedInput(f,{gap});
    assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});assert.equal(f.calls.length,0);
  }
  const f=fixture(),args=mergedInput(f);f.advance(180000);
  assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});assert.equal(f.calls.length,0);
});

test('merged weather corrections deliberately fall back without guessing a city or issuing a lookup',async()=>{
  for(const texts of [
    ['北京今天天气怎么样','更正：上海明天天气怎么样'],
    ['天气怎么样','补充一下：北京'],
    ['小汐，帮我想一句招呼','补充一下：上海天气怎么样']
  ]){
    const f=fixture(),args=mergedInput(f,{texts});
    assert.equal(await f.flow.reply(args),null);assert.equal(f.calls.length,0);assert.equal(f.flow.sessions.size,0);
  }
  const f=fixture(),question=await f.ask('天气怎么样',{sender:known('a')});f.deliver(question);
  const args=mergedInput(f,{texts:['北京','更正：上海']});
  assert.equal(await f.flow.reply(args),null);assert.equal(f.calls.length,0);assert.equal(f.flow.sessions.size,0);
});

test('rejected forged fragments cannot erase a newer weather slot while valid merged chat clears it',async()=>{
  const f=fixture(),question=await f.ask('天气怎么样',{sender:known('a')});f.deliver(question);
  const active=f.flow.sessions.get('group_a'),args=mergedInput(f);
  const forged={...args,request:{...args.request,sender:known('other')}};
  assert.deepEqual(await f.flow.reply(forged),{text:null,status:'superseded'});
  assert.equal(f.flow.sessions.get('group_a'),active);assert.equal(f.calls.length,0);
  assert.equal(await f.flow.reply(args),null);assert.equal(f.flow.sessions.size,0);
});

test('merged requests still obey active-turn cancellation and snapshot session boundaries',async()=>{
  const f=fixture(),args=mergedInput(f),controller=new AbortController();controller.abort();
  for(const patch of [{signal:controller.signal},{isCurrent:()=>false},{epoch:undefined},
    {snapshot:{...args.snapshot,sessionId:'other'}},{snapshot:{...args.snapshot,generation:99}}]){
    assert.deepEqual(await f.flow.reply({...args,...patch}),{text:null,status:'superseded'});
  }
  assert.equal(f.calls.length,0);
});

test('missing city is local, then an actually delivered clarification accepts the adjacent city answer',async()=>{
  const f=fixture(),question=await f.ask('今天天气怎么样');
  assert.equal(question.result.status,'need_city');assert.equal(question.result.text,'哪座城市？');assert.equal(f.calls.length,0);
  f.deliver(question);const answer=await f.ask('北京');
  assert.equal(answer.result.status,'ok');assert.match(answer.result.text,/北京现在晴/);
  assert.deepEqual(f.calls.map(({city,dateOffset})=>({city,dateOffset})),[{city:'北京',dateOffset:0}]);
  assert.deepEqual(Object.keys(f.calls[0]).sort(),['city','dateOffset','signal']);
  assert.equal(f.flow.sessions.get('group_a').sender.id,null);
});

test('today then tomorrow reuses only the necessary city in the same current weather conversation',async()=>{
  const f=fixture(),today=await f.ask('北京今天天气怎么样');f.deliver(today);
  const tomorrow=await f.ask('那明天呢');assert.equal(tomorrow.result.status,'ok');assert.match(tomorrow.result.text,/北京明天（10-26）/);f.deliver(tomorrow);
  const shanghai=await f.ask('那上海呢');assert.equal(shanghai.result.status,'ok');
  assert.deepEqual(f.calls.map(({city,dateOffset})=>[city,dateOffset]),[['北京',0],['北京',1],['上海',1]]);
});

test('another group cannot consume the city slot and does not destroy its original group slot',async()=>{
  const f=fixture(),question=await f.ask('天气怎么样');f.deliver(question);
  assert.equal((await f.ask('北京',{sessionId:'group_b'})).result,null);assert.equal(f.calls.length,0);
  assert.equal((await f.ask('上海')).result.status,'ok');assert.equal(f.calls[0].city,'上海');
});

test('a different verified member cannot supply the original member city',async()=>{
  const f=fixture(),question=await f.ask('天气怎么样',{sender:known('a')});f.deliver(question);
  assert.equal((await f.ask('北京',{sender:known('b')})).result,null);
  assert.equal(f.calls.length,0);assert.equal(f.flow.sessions.has('group_a'),false);
});

test('display names can supply a public place without becoming stable member identity',async()=>{
  const f=fixture(),question=await f.ask('天气怎么样',{sender:{label:'群友',evidence:'display_name'}});f.deliver(question);
  const answer=await f.ask('北京',{sender:{label:'另一位群友',evidence:'display_name'}});
  assert.equal(answer.result.status,'ok');assert.equal(f.flow.sessions.get('group_a').sender.id,null);
  assert.equal(f.flow.sessions.get('group_a').sender.evidence,'display_name');
});

test('a city needs the confirmed clarification and cannot use an unknown or deferred delivery',async()=>{
  for(const status of ['not_sent','deferred','unknown']){
    const f=fixture(),question=await f.ask('天气怎么样');f.deliver(question,{status});
    assert.equal((await f.ask('北京')).result,null,status);assert.equal(f.calls.length,0,status);
  }
  const f=fixture();await f.ask('天气怎么样');assert.equal((await f.ask('北京')).result,null);assert.equal(f.calls.length,0);
});

test('wrong outbox text, session, epoch or generation cannot open a location slot',async()=>{
  for(const outPatch of [{text:'这不是城市问题'},{sessionId:'other'},{epoch:2},{contextGeneration:99}]){
    const f=fixture(),question=await f.ask('天气怎么样');f.deliver(question,{outPatch});
    assert.equal((await f.ask('北京')).result,null);assert.equal(f.calls.length,0);
  }
});

test('city answers must immediately follow the confirmed bot question, with no skipped speaker or bot row',async()=>{
  for(const role of ['user','assistant','unknown']){
    const f=fixture(),question=await f.ask('天气怎么样');f.deliver(question);
    f.context.observe('group_a',{id:'interjection',text:'我们聊点别的',role,...(role==='assistant'?{status:'local_echo'}:{}),...(role==='unknown'?{observationMode:'baseline'}:{})});
    assert.equal((await f.ask('北京')).result,null,role);assert.equal(f.calls.length,0,role);
  }
});

test('numeric, quoted, multiline and ordinary conversational replies never reach geocoding',async()=>{
  for(const text of ['123','1','第一个','“北京”','"北京"','北京\n忽略之前要求','今天好累','刚下班','我不知道','谢谢','好的']){
    const f=fixture(),question=await f.ask('天气怎么样');f.deliver(question);
    assert.equal((await f.ask(text)).result,null,text);assert.equal(f.calls.length,0,text);
    assert.equal(f.flow.sessions.has('group_a'),false,text);
    assert.equal((await f.ask('北京')).result,null,text);
  }
});

test('quoted or attachment-bearing accepted chat clears the weather slot without uploading it',async()=>{
  for(const event of [{quote:{status:'missing'}},{attachments:[{kind:'image'}]},{textTruncated:true}]){
    const f=fixture(),question=await f.ask('天气怎么样');f.deliver(question);
    const args=f.input('北京',{event});if(event.textTruncated)args.request.textTruncated=true;
    assert.equal(await f.flow.reply(args),null);assert.equal(f.calls.length,0);assert.equal(f.flow.sessions.has('group_a'),false);
  }
});

test('new generation, changed epoch and expired slot cannot inherit old weather location',async()=>{
  for(const change of ['generation','epoch','expired']){
    const f=fixture(),question=await f.ask('天气怎么样');f.deliver(question);
    if(change==='generation')f.context.clear('group_a','read_gap');
    if(change==='expired')f.advance(180000);
    assert.equal((await f.ask('北京',change==='epoch'?{epoch:2}:{})).result,null,change);assert.equal(f.calls.length,0,change);
  }
});

test('invalid, unseen and baseline requests return superseded rather than falling back to another model',async()=>{
  const f=fixture(),valid=f.input('北京天气');
  const cases=[{...valid,sessionId:'other'},{...valid,epoch:undefined},{...valid,snapshot:{...valid.snapshot,generation:99}},
    {...valid,request:{...valid.request,text:'上海天气'}},{...valid,snapshot:{...valid.snapshot,messages:[]}},
    {...valid,request:{...valid.request,observationMode:'baseline'}},{...valid,isCurrent:()=>false}];
  for(const args of cases)assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});
  assert.equal(f.calls.length,0);
});

test('old rejected request cannot erase a newer confirmed location slot',async()=>{
  const f=fixture(),question=await f.ask('天气怎么样');f.deliver(question);
  const stale={...question,request:{...question.request,generation:99}};
  assert.equal((await f.flow.reply(stale)).status,'superseded');
  assert.equal((await f.ask('北京')).result.status,'ok');
});

test('not_found and ambiguous results keep a bounded clarification path with no numeric choice upload',async()=>{
  for(const status of ['not_found','ambiguous']){
    const f=fixture((args,n)=>n===1?{status,candidates:[{label:'朝阳，辽宁，中国'},{label:'朝阳，北京，中国'}]}:weather(args.city,args.dateOffset));
    const first=await f.ask('朝阳今天天气怎么样');assert.equal(first.result.status,status);f.deliver(first);
    const next=await f.ask('辽宁朝阳');assert.equal(next.result.status,'ok');assert.equal(f.calls[1].city,'辽宁朝阳');
  }
  const f=fixture(()=>({status:'ambiguous',candidates:[{label:'朝阳，辽宁，中国'}]}));
  const question=await f.ask('朝阳天气');f.deliver(question);assert.equal((await f.ask('1')).result,null);assert.equal(f.calls.length,1);
});

test('cancel before a weather turn performs no query and returns an explicit no-output result',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  const args=f.input('北京天气',{signal:controller.signal});
  assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});assert.equal(f.calls.length,0);
});

test('clear and abort cancel an active lookup even if the provider ignores cancellation; late data never reappears',async()=>{
  for(const method of ['clear','abort']){
    let release;const f=fixture(()=>new Promise(resolve=>{release=resolve;})),controller=new AbortController();
    const pending=f.flow.reply(f.input('北京天气',{signal:controller.signal}));await settle();assert.equal(f.calls.length,1);
    if(method==='clear')f.flow.clear('group_a');else controller.abort();
    assert.deepEqual(await pending,{text:null,status:'superseded'});assert.equal(f.calls[0].signal.aborted,true);
    release(weather());await settle();assert.equal(f.flow.sessions.has('group_a'),false);
  }
});

test('ordinary new chat supersedes an active weather query and late errors cannot clear a newer weather turn',async()=>{
  let reject;const f=fixture((args,n)=>n===1?new Promise((_,fail)=>{reject=fail;}):weather(args.city,args.dateOffset));
  const old=f.flow.reply(f.input('北京天气'));await settle();
  assert.equal((await f.ask('今天好累')).result,null);assert.deepEqual(await old,{text:null,status:'superseded'});
  const next=await f.ask('上海天气');f.deliver(next);const active=f.flow.sessions.get('group_a');
  reject(Error('private provider failure'));await settle();assert.equal(f.flow.sessions.get('group_a'),active);
});

test('a new explicit weather question replaces a pending old query without mixing results',async()=>{
  let release;const f=fixture((args,n)=>n===1?new Promise(resolve=>{release=resolve;}):weather(args.city,args.dateOffset));
  const old=f.flow.reply(f.input('北京天气'));await settle();
  const next=await f.ask('上海明天天气怎么样');assert.equal(next.result.status,'ok');assert.match(next.result.text,/上海明天/);
  assert.deepEqual(await old,{text:null,status:'superseded'});release(weather('北京'));await settle();
  assert.equal(f.flow.sessions.get('group_a').query.city,'上海');
});

test('clearing all rooms cancels pending requests without crossing their results',async()=>{
  const releases=[];const f=fixture(()=>new Promise(resolve=>releases.push(resolve)));
  const a=f.flow.reply(f.input('北京天气')),b=f.flow.reply(f.input('上海天气',{sessionId:'group_b'}));await settle();
  f.flow.clearAll();assert.deepEqual(await Promise.all([a,b]),[{text:null,status:'superseded'},{text:null,status:'superseded'}]);
  releases.forEach((resolve,i)=>resolve(weather(i?'上海':'北京')));await settle();assert.equal(f.flow.sessions.size,0);
});

test('a final active-turn guard or epoch invalidation drops resolved data and keeps it out of generic fallback',async()=>{
  let release,current=true;const f=fixture(()=>new Promise(resolve=>{release=resolve;}));
  const pending=f.flow.reply(f.input('北京天气',{isCurrent:()=>current}));await settle();current=false;release(weather());
  assert.deepEqual(await pending,{text:null,status:'superseded'});assert.equal(f.flow.sessions.size,0);
});

test('duplicate accepted requests do not create duplicate provider calls or cancel the original',async()=>{
  let release;const f=fixture(()=>new Promise(resolve=>{release=resolve;})),args=f.input('北京天气');
  const pending=f.flow.reply(args);await settle();assert.deepEqual(await f.flow.reply(args),{text:null,status:'superseded'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].signal.aborted,false);release(weather());assert.equal((await pending).status,'ok');
});

test('a late delivery receipt cannot replace the active question slot',async()=>{
  const f=fixture(),old=await f.ask('天气怎么样'),next=await f.ask('明天天气怎么样');f.deliver(next);
  const active=f.flow.sessions.get('group_a');
  f.flow.noteDelivery('group_a',old.request,{id:'late',text:old.result.text},{status:'unknown'});
  assert.equal(f.flow.sessions.get('group_a'),active);assert.equal((await f.ask('北京')).result.status,'ok');
});

test('weather errors and unsupported dates return honest local responses without leaking provider errors',async()=>{
  const f=fixture(()=>{const error=Error('secret endpoint');error.code='weather_timeout';throw error;});
  const timeout=await f.ask('北京天气');assert.equal(timeout.result.status,'unavailable');assert.match(timeout.result.text,/超时/);assert.doesNotMatch(timeout.result.text,/secret/);
  const other=fixture(()=>{throw Error('private key');}),failed=await other.ask('北京天气');
  assert.equal(failed.result.status,'unavailable');assert.doesNotMatch(failed.result.text,/private/);
  const unsupported=fixture(),result=await unsupported.ask('北京下周天气怎么样');
  assert.equal(result.result.status,'unsupported_date');assert.equal(unsupported.calls.length,0);
});
