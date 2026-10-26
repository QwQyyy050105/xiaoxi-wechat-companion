import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {GroupMediaInput,validateGroupImages} from '../src/group_media.mjs';
import {normalizeNativeMedia} from '../src/native_media.mjs';
import {MessageGate} from '../src/message_gate.mjs';
import {generate,imageMessages,modelMessages,stageModelImages} from '../src/model.mjs';

const session=(extra={})=>({id:'media_test_abao',channel:'desktop_wechat',peerId:'group_abao',accountId:'Example Account',title:'Example Group A',epoch:0,messages:[],...extra});
const bytes=Buffer.from('ffd8ff00112233','hex');
const image=(extra={})=>({targetId:'group_abao',peerId:'10000001@chatroom',source:'wechat_group_cache',messageBinding:'unresolved',sender:null,mime:'image/jpeg',quality:'wechat_compressed',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),width:10,height:10,cacheModifiedAt:100,...extra});
const voice=(id,text)=>({id,klass:'mmui::ChatVoiceItemView',text});
const text=(id,body)=>({id,klass:'mmui::ChatTextItemView',text:body});
const snap=messages=>({pid:1,created:2,hwnd:3,messages});

test('image packet rejects unapproved account, cross-group, cross-session, forged binding and changed bytes',()=>{
  assert.equal(validateGroupImages([image()],session())[0].sessionId,session().id);
  for(const row of [image({targetId:'group_family'}),image({peerId:'10000002@chatroom'}),image({sessionId:'another'}),image({messageBinding:'verified'}),image({sender:'奶奶'}),image({data:'eA=='}),image({quality:'unknown'}),image({width:0})])assert.throws(()=>validateGroupImages([row],session()));
  assert.throws(()=>validateGroupImages([image()],session({channel:'local'})));
  assert.throws(()=>validateGroupImages([image()],session({accountId:'Primary Account'})));
  assert.throws(()=>validateGroupImages([image(),image(),image()],session()));
});

test('no ordinary or negated chat invokes image reader; bounded followup reuses exact pixels and clears on reset',async()=>{
  let calls=0,now=1000;const input=new GroupMediaInput({root:process.cwd(),nowMs:()=>now,reader:async()=>{calls++;return {ok:true,images:[image()]};}});
  for(const body of ['今天天气怎么样','不要看图','有人说“看一下图片”'])assert.equal(input.wants(session(),{text:body}),false);
  const result=await input.prepare({session:session(),request:{text:'小汐看看这张图'}});assert.equal(result.images.length,1);assert.equal(calls,1);
  assert.equal(input.wants(session(),{text:'这是什么车'}),true);
  const follow=await input.prepare({session:session(),request:{text:'这是什么车'}});assert.deepEqual(follow.images,result.images);assert.equal(calls,1);
  assert.equal(input.wants(session(),{text:'为什么今天天气这么冷'}),false);
  now+=120001;assert.equal(input.wants(session(),{text:'这是什么车'}),false);
  assert.equal(input.status.last.ok,true);input.clear();assert.equal(input.recent.size,0);assert.equal(input.status.last,null);
});

test('abort during image resolve cannot populate followup cache',async()=>{
  const abort=new AbortController();const input=new GroupMediaInput({root:process.cwd(),reader:async()=>{abort.abort();return {ok:true,images:[image()]};}});
  await assert.rejects(input.prepare({session:session(),request:{text:'看图'},signal:abort.signal}));assert.equal(input.recent.size,0);
});

test('compatible provider receives actual image bytes and same persona; diagnostics contain hashes only',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let body,diag;
  globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'看见了'}}]}),{headers:{'content-type':'application/json'}});};
  const reply=await generate({settings:{provider:'compatible',baseUrl:'https://example.com',model:'vision'},root:process.cwd(),session:session({request:{text:'看这张图'}}),persona:{name:'小汐',preferences:{likes:['猫']}},memories:[],mediaInput:{images:[image()]},onPrepared:r=>{diag=r;}});
  assert.equal(reply.text,'看见了');assert.ok(body.messages[0].content.includes('猫'));
  assert.match(body.messages[0].content,/图片和气泡、发言者的对应关系尚未确认/);
  assert.equal(body.messages.at(-1).content.at(-1).image_url.url,`data:image/jpeg;base64,${image().data}`);
  assert.equal(diag.images[0].sha256,image().sha256);assert.ok(!JSON.stringify(diag).includes(image().data));
});

test('CLI image staging writes only its repository temp directory and removes files after use',async()=>{
  const root=process.cwd();
  const staged=await stageModelImages(root,[image()]);assert.ok(path.isAbsolute(staged.files[0]));assert.equal(path.dirname(path.dirname(staged.files[0])),path.join(root,'temp'));
  assert.deepEqual(await readFile(staged.files[0]),bytes);await staged.cleanup();
  await assert.rejects(readFile(staged.files[0]));
  const after=await readdir(path.join(root,'temp'));assert.ok(!after.includes(path.basename(path.dirname(staged.files[0]))));
});

test('platform transcript parsing preserves words, duration and uncertainty without treating typed imitation as audio',()=>{
  const body='小汐，帮我记一下，明天出门带伞。';
  const ready=normalizeNativeMedia(voice('v',`语音3"秒${body}`));assert.equal(ready.text,body);assert.equal(ready.inputModality.kind,'platform_transcript');assert.equal(ready.inputModality.uncertain,true);
  assert.deepEqual(normalizeNativeMedia(ready),ready);
  assert.equal(normalizeNativeMedia(text('fake',`语音3"秒${body}`)).inputModality,undefined);
  for(const state of ['未播放','已播放','转文字中','转换文字失败',''])assert.equal(normalizeNativeMedia(voice('v','语音3"秒'+state)).inputModality.kind,'voice_pending');
});

test('new voice converted behind a later message is delivered once; baseline, replay, gap and old conversions are not',()=>{
  let now=100;const gate=new MessageGate({nowMs:()=>now}),target={id:'group_abao'},a=text('a','hello'),v=voice('v','语音3"秒未播放'),done=voice('v','语音3"秒小汐，明天带伞'),b=text('b','later');
  gate.observe(target,snap([a]));gate.observe(target,snap([a,v]));gate.observe(target,snap([a,v,b]));
  assert.deepEqual(gate.observe(target,snap([a,done,b])).messages.map(x=>x.text),['小汐，明天带伞']);
  assert.equal(gate.observe(target,snap([a,done,b])).messages.length,0);
  gate.clear();gate.observe(target,snap([a,v]));assert.equal(gate.observe(target,snap([a,done])).messages.length,0);
  gate.clear();gate.observe(target,snap([a]));gate.observe(target,snap([a,v]));now+=300001;assert.equal(gate.observe(target,snap([a,done])).messages.length,0);
});

test('last voice label can update without creating a context gap or duplicate reply',()=>{
  const gate=new MessageGate(),target={id:'group_abao'},a=text('a','hi'),v=voice('v','语音3"秒未播放');
  gate.observe(target,snap([a]));gate.observe(target,snap([a,v]));
  const changed=gate.observe(target,snap([a,voice('v','语音3"秒小汐，你好')]));assert.equal(changed.gap,undefined);assert.equal(changed.messages[0].text,'小汐，你好');
  assert.equal(gate.observe(target,snap([a,voice('v','语音3"秒小汐，你好')])).messages.length,0);
});
