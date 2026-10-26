import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {generate,generateSearch,modelMessages} from '../src/model.mjs';
import {getAuthorizedWechatScopes} from '../src/conversation_scope.mjs';

const compatible={provider:'compatible',model:'offline-mock',baseUrl:'https://model.invalid'};
const codex={provider:'codex',model:'offline-mock',webSearch:false};
let originalFetch,originalSpawn,fetches,spawns,prepared,wire,fetchReply;
before(()=>{
  originalFetch=globalThis.fetch;originalSpawn=childProcess.spawn;
  globalThis.fetch=async(url,options)=>{
    fetches++;wire={url,options,body:JSON.parse(options.body)};
    if(!fetchReply)throw Error('Unexpected fetch: external network is forbidden');
    return fetchReply(url,options);
  };
  childProcess.spawn=()=>{spawns++;throw Error('Unexpected spawn: external model execution is forbidden');};
  syncBuiltinESMExports();
});
after(()=>{globalThis.fetch=originalFetch;childProcess.spawn=originalSpawn;syncBuiltinESMExports();});
beforeEach(()=>{fetches=0;spawns=0;prepared=0;wire=null;fetchReply=null;});

function group(index=0,overrides={}) {
  const target=getAuthorizedWechatScopes()[index],id=`session_${target.id}`;
  return {id,channel:'desktop_wechat',peerId:target.id,title:target.name,accountId:'Example Account',
    messages:[],context:{sessionId:id,generation:1,messages:[{sourceKey:'q',role:'user',text:'本群测试',generation:1}]},
    request:{sourceKey:'q',text:'本群测试',generation:1},...overrides};
}
function fakeReply(text='离线回答') {
  fetchReply=async()=>new Response(JSON.stringify({choices:[{message:{content:text}}]}),{headers:{'content-type':'application/json'}});
}
async function denied(session,memories=[]) {
  for(const settings of [compatible,codex]) {
    await assert.rejects(generate({settings,session,memories,root:'D:/offline_scope_test',onPrepared:()=>{prepared++;}}),{code:'conversation_scope_denied'});
  }
  assert.equal(fetches,0);assert.equal(spawns,0);assert.equal(prepared,0);
}

test('direct generate denies unregistered, renamed, cross-account and unbound WeChat inputs before either provider',async()=>{
  for(const changed of [
    {peerId:'unapproved_group',title:'第三群'},
    {peerId:'group_abao',title:'同名但未授权的群'},
    {peerId:'group_family',title:'Example Group A'},
    {accountId:'另一个微信号'},
    {id:undefined},
    {peerId:undefined},
    {channel:'wechat'},
    {channel:'qq'},
  ])await denied(group(0,changed));
  await denied(null);await denied([]);
});

test('caller allowlists cannot extend the compiled two-group model authorization',async()=>{
  const privateSession=group(0,{peerId:'group_other',title:'第三群'});
  for(const settings of [compatible,codex])await assert.rejects(generate({settings,session:privateSession,memories:[],
    authorizedTargets:[{id:'group_other',name:'第三群',kind:'group'}],allowedGroups:['第三群'],
    onPrepared:()=>{prepared++;}}),{code:'conversation_scope_denied'});
  assert.equal(fetches,0);assert.equal(spawns,0);assert.equal(prepared,0);
});

test('accessor identities and payloads are rejected without invoking getters',async()=>{
  let accessed=0;
  const input=group();
  Object.defineProperty(input,'peerId',{enumerable:true,get(){accessed++;return 'group_abao';}});
  await denied(input);
  const source={};Object.defineProperty(source,'sessionId',{enumerable:true,get(){accessed++;return 'session_group_abao';}});
  await denied(group(),[{text:'mock',source}]);
  assert.equal(accessed,0);
});

test('local or missing-channel input cannot hide context, a WeChat binding or nested WeChat provenance',async()=>{
  for(const channel of ['local',undefined]) {
    for(const extra of [
      {context:{sessionId:'local_test',messages:[]}},
      {context:null},
      {peerId:'group_abao'},
      {accountId:'Example Account'},
      {messages:[{role:'user',source:'wechat',text:'copied'}]},
      {request:{source:'wechat',text:'copied'}},
      {request:{text:'copied',quote:{source:{kind:'wechat_message'}}}},
      {source:{channel:'desktop_wechat'}},
      {request:{text:'copied',attachments:[{platform:'wechat'}]}},
    ])await denied({id:'local_test',channel,messages:[],...extra});
  }
  await denied({channel:'local',messages:[]},[{text:'copied',source:{kind:'wechat'}}]);
});

test('context, request and nested observation references cannot point into another session',async()=>{
  await denied(group(0,{context:{sessionId:'session_group_family',messages:[]}}));
  await denied(group(0,{request:{text:'copied',sessionId:'session_group_family'}}));
  const input=group();
  input.context.messages[0].sessionId='session_group_family';await denied(input);
  const quoted=group();quoted.request.quote={text:'copied',source:{sessionId:'session_group_family'}};await denied(quoted);
});

test('explicit memory session ownership must match even for inactive or nested memory source rows',async()=>{
  for(const sessionId of ['session_group_family','unknown',null,undefined]) {
    await denied(group(),[{sessionId,text:'cross-session memory'}]);
  }
  await denied(group(),[{sessionId:'session_group_family',status:'deleted',text:'do not transmit'}]);
  await denied(group(),[{text:'copied',source:{sessionId:'session_group_family'}}]);
  await denied({id:'owner_local',channel:'local',messages:[]},[{sessionId:'session_group_abao',text:'group memory'}]);
  await denied(group(),{text:'not an array'});
});

test('both approved group bindings reach only the mocked provider with matching context and memory',async()=>{
  fakeReply();
  for(let index=0;index<2;index++) {
    const input=group(index);
    const result=await generate({settings:compatible,persona:{},session:input,memories:[
      {sessionId:input.id,text:'同群约定',source:{sessionId:input.id},status:'approved'},
      {text:'没有来源字段的纯合成测试'},
    ],onPrepared:()=>{prepared++;}});
    assert.equal(result.text,'离线回答');
    const observed=wire.body.messages.map(row=>{try{return JSON.parse(row.content);}catch{return null;}}).find(row=>row?.type==='observed_conversation');
    assert.equal(observed.sessionId,input.id);
    assert.ok(JSON.stringify(wire.body).includes('同群约定'));
  }
  assert.equal(fetches,2);assert.equal(prepared,2);assert.equal(spawns,0);
});

test('self-check and isolated local requests may omit id without mutating the caller',async()=>{
  fakeReply();
  const selfCheck={messages:[{role:'user',text:'介绍自己'}]};
  const local={channel:'local',messages:[],request:{text:'合成搜索问题'}};
  for(const input of [selfCheck,local]) {
    const before=structuredClone(input);
    assert.equal((await generate({settings:compatible,session:input,memories:[]})).text,'离线回答');
    assert.deepEqual(input,before);assert.equal(Object.hasOwn(input,'id'),false);
  }
  assert.equal(fetches,2);assert.equal(spawns,0);
});

test('the actual model request uses the detached checked data if the caller mutates it during preparation',async()=>{
  fakeReply();const input=group(),memories=[{sessionId:input.id,text:'同群记忆'}];
  await generate({settings:compatible,persona:{},session:input,memories,onPrepared:()=>{
    input.peerId='group_other';input.context.messages[0].text='迟到的第三群标记';memories[0].text='迟到的另一群记忆';
  }});
  const json=JSON.stringify(wire.body);
  assert.ok(json.includes('本群测试'));assert.ok(json.includes('同群记忆'));
  assert.ok(!json.includes('迟到的'));assert.equal(spawns,0);
});

test('generateSearch builds a clean synthetic request and the real generate guard accepts it',async()=>{
  fakeReply('合成结果 https://example.com/source');let isolated;
  const result=await generateSearch({query:'公开资料关键词',settings:{provider:'codex',model:'offline'},
    session:group(0,{request:{text:'不可带入的群聊天'}}),memories:[{text:'不可带入的群记忆'}],
    context:{messages:[{text:'不可带入的背景'}]},persona:{name:'不可带入的角色私有字段'},
  },async args=>{
    isolated=structuredClone(args);
    const reply=await generate({...args,settings:compatible});
    return {...reply,searchUsed:true};
  });
  assert.equal(result.query,'公开资料关键词');assert.equal(isolated.session.channel,'local');
  assert.deepEqual(isolated.session.messages,[]);assert.deepEqual(isolated.memories,[]);
  assert.equal(isolated.session.context,undefined);
  const json=JSON.stringify(wire.body);assert.ok(!json.includes('不可带入'));assert.ok(json.includes('公开资料关键词'));
  assert.equal(fetches,1);assert.equal(spawns,0);
});

test('modelMessages remains a pure offline renderer for intentionally incomplete synthetic fixtures',()=>{
  const input={channel:'desktop_wechat',request:{text:'合成的离线评估'},context:{messages:[]}};
  assert.ok(JSON.stringify(modelMessages({},input,[])).includes('合成的离线评估'));
  assert.equal(fetches,0);assert.equal(spawns,0);
});

test('pre-aborted generation still stops before normalizing or inspecting scope',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(generate({session:group(0,{peerId:'other'}),signal:controller.signal}),{name:'AbortError'});
  assert.equal(fetches,0);assert.equal(spawns,0);
});
