import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {generate} from '../src/model.mjs';
const originalSpawn=childProcess.spawn,originalPath=process.env.CODEX_CLI_PATH;
let child,args;const spawned=[];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
before(()=>{
 process.env.CODEX_CLI_PATH=process.execPath;
 childProcess.spawn=(_executable,argv)=>{
  args=argv;spawned.push([...argv]);child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{child.killed=true;return true;};return child;
 };syncBuiltinESMExports();
});
after(()=>{childProcess.spawn=originalSpawn;syncBuiltinESMExports();if(originalPath===undefined)delete process.env.CODEX_CLI_PATH;else process.env.CODEX_CLI_PATH=originalPath;});
function emit(event){child.stdout.write(JSON.stringify(event)+'\n');}
async function start(overrides={}){
 child=null;let prepared;
 const promise=generate({settings:{provider:'codex',model:'',webSearch:false},persona:{name:'小汐'},session:{channel:'local',messages:[{role:'user',text:'你好'}]},memories:[],root:path.resolve('.'),onPrepared:d=>prepared=d,...overrides});
 const deadline=Date.now()+1000;while(!child){assert.ok(Date.now()<deadline);await tick();}
 return {promise,prepared};
}
test('committed answer resolves before slow child shutdown; partial items alone cannot deliver',async()=>{
 const {promise,prepared}=await start();let completed=false;promise.then(()=>completed=true);
 assert.equal(prepared.selectedModel,'gpt-6-astra');assert.equal(args[args.indexOf('--model')+1],'gpt-6-astra');
 assert.ok(args.some(a=>a.startsWith('model_instructions_file=')&&a.includes('src/chat_instructions.txt')));
 emit({type:'item.completed',item:{type:'agent_message',text:'完整正文'}});await tick();assert.equal(completed,false);
 const serialized=JSON.stringify({type:'turn.completed',usage:{output_tokens:4}})+'\n';
 child.stdout.write(serialized.slice(0,12));await tick();assert.equal(completed,false);
 child.stdout.write(serialized.slice(12));const result=await promise;
 assert.equal(result.text,'完整正文');assert.equal(result.usage.output_tokens,4);assert.ok(child.killed);
 assert.equal(result.timing.closeMs,undefined);child.emit('close',1);
});
test('truncated or failed processes do not publish an uncommitted draft',async()=>{
 for(const failure of [false,true]){
  const {promise}=await start();const rejected=assert.rejects(promise,/本轮未完成/);
  emit({type:'item.completed',item:{type:'agent_message',text:'草稿'}});
  if(failure)emit({type:'turn.failed'});child.emit('close',0);await rejected;
 }
});
test('cancellation kills the owned worker and rejects its late final result',async()=>{
 const controller=new AbortController();const {promise}=await start({signal:controller.signal});
 const rejected=assert.rejects(promise,/已停止/);controller.abort();
 emit({type:'item.completed',item:{type:'agent_message',text:'迟到正文'}});emit({type:'turn.completed'});
 await rejected;assert.ok(child.killed);
});
test('owner-selected models are respected for ordinary and search calls',async()=>{
 for(const settings of [{provider:'codex',model:'gpt-6-luna'},{provider:'codex',model:'',webSearch:true}]){
  const {promise,prepared}=await start({settings});
  assert.equal(prepared.selectedModel,settings.model||'gpt-6-astra');
  assert.equal(args[args.indexOf('--model')+1],settings.model||'gpt-6-astra');
  emit({type:'item.completed',item:{type:'web_search',status:'completed'}});
  emit({type:'item.completed',item:{type:'agent_message',text:'搜索结果'}});emit({type:'turn.completed'});
  assert.equal((await promise).searchUsed,true);
 }
});
test('image files remain until the worker closes, then are removed before returning',async()=>{
 const bytes=Buffer.from('ffd8ff001122','hex');
 const image={targetId:'group_abao',peerId:'10000001@chatroom',source:'wechat_group_cache',messageBinding:'unresolved',sender:null,mime:'image/jpeg',quality:'thumbnail',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),width:10,height:10,cacheModifiedAt:100};
 const {promise}=await start({session:{id:'synthetic_image',channel:'desktop_wechat',peerId:'group_abao',title:'Example Group A',accountId:'Example Account',request:{text:'看看图片'}},mediaInput:{images:[image]}});
 const file=args[args.indexOf('--image')+1];assert.ok(fs.existsSync(file));let completed=false;promise.then(()=>completed=true);
 emit({type:'item.completed',item:{type:'agent_message',text:'图片答案'}});emit({type:'turn.completed'});await tick();
 assert.ok(child.killed);assert.equal(completed,false);assert.ok(fs.existsSync(file));child.emit('close',1);
 assert.equal((await promise).text,'图片答案');assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(path.dirname(file)),false);
});

test('actual Codex spawn keeps user-config isolation, owner model, search and tool restrictions together',async()=>{
 const {promise}=await start({settings:{provider:'codex',model:'owner-configured-model',webSearch:true,timeoutMs:2000}});
 assert.equal(args.filter(x=>x==='--ignore-user-config').length,1);assert.equal(args[args.indexOf('--model')+1],'owner-configured-model');assert.ok(args.includes('web_search="live"'));assert.ok(args.includes('mcp_servers={}'));assert.ok(args.includes('approval_policy="never"'));assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
 for(const tool of ['shell_tool','unified_exec','apps','plugins','multi_agent','browser_use','computer_use','hooks'])assert.ok(args.some((x,i)=>x==='--disable'&&args[i+1]===tool));
 emit({type:'item.completed',item:{type:'agent_message',text:'synthetic committed answer'}});emit({type:'turn.completed'});assert.equal((await promise).text,'synthetic committed answer');
});
test('an older CLI rejecting ignore-user-config fails without retrying a less isolated command',async()=>{
 const before=spawned.length,{promise}=await start();const rejected=assert.rejects(promise,/本轮未完成/);
 child.stderr.write('error: unexpected argument --ignore-user-config');child.emit('close',2);await rejected;await tick();assert.equal(spawned.length,before+1);assert.ok(spawned.at(-1).includes('--ignore-user-config'));
});
