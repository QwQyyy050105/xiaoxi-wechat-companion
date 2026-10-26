import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {DesktopTransport} from '../src/desktop_transport.mjs';

const root=path.resolve('.');
const nativePython=process.env.XIAOXI_TEST_PYTHON;const nativeAvailable=nativePython&&spawnSync(nativePython,['-B','-c','import psutil'],{windowsHide:true}).status===0;
const nativeOptions={skip:process.platform!=='win32'||!nativeAvailable?'Windows and Python psutil required for worker lifetime integration':false};
function fixture(t){
  const directory=fs.mkdtempSync(path.join(root,'temp/transport_worker_test_'));
  const workerPath=path.join(directory,'worker.py');
  fs.writeFileSync(workerPath,`import sys,json,time,os,pathlib,psutil
sys.stdout.reconfigure(encoding='utf-8')
token=sys.argv[sys.argv.index('--transport-token')+1]
p=psutil.Process()
print(json.dumps(dict(event='worker_ready',token=token,pid=os.getpid(),created=p.create_time(),ancestors=[dict(pid=a.pid,created=a.create_time()) for a in p.parents()])),flush=True)
for line in sys.stdin:
    r=json.loads(line)
    if r['command']=='read':
        time.sleep(1.2)
        pathlib.Path(__file__).with_suffix('.committed').write_text('must not run')
    print(json.dumps(dict(id=r['id'],result=dict(ok=True))),flush=True)
`);
  const transport=new DesktopTransport(root,{workerPath,pythonPath:nativePython});
  t.after(async()=>{
    await transport.kill();
    assert.equal(path.dirname(path.resolve(directory)),path.join(root,'temp'));
    assert.ok(path.basename(directory).startsWith('transport_worker_test_'));
    fs.rmSync(directory,{recursive:true,force:true});
  });
  return {transport,directory,workerPath};
}
function pidAlive(pid){try{process.kill(pid,0);return true;}catch{return false;}}

test('a timed-out blocked native worker and its venv redirector both terminate before a later commit',nativeOptions,async t=>{
  const {transport,workerPath}=fixture(t);
  const ready=once(transport,'worker');transport.start();
  const launcherPid=transport.child.pid;const [actual]=await ready;
  assert.ok(actual.pid>0); // global Python and venv redirectors are both supported.
  const terminated=once(transport,'terminated');
  await assert.rejects(transport.call('read',{group:'Example Group A'},150),/超时/);
  const [result]=await terminated;
  assert.equal(result.terminated,true,JSON.stringify(result));
  assert.equal(pidAlive(actual.pid),false);assert.equal(pidAlive(launcherPid),false);
  await new Promise(resolve=>setTimeout(resolve,1250));
  assert.equal(fs.existsSync(workerPath.replace(/\.py$/,'.committed')),false);
});

test('stopping one token-bound transport does not kill another Python transport',nativeOptions,async t=>{
  const a=fixture(t).transport,b=fixture(t).transport;
  const readyA=once(a,'worker'),readyB=once(b,'worker');a.start();b.start();
  const [[workerA],[workerB]]=await Promise.all([readyA,readyB]);
  const result=await a.kill();assert.equal(result.terminated,true);
  assert.equal(pidAlive(workerA.pid),false);assert.equal(pidAlive(workerB.pid),true);
  assert.equal((await b.call('health')).ok,true);
});

test('stopping immediately before the handshake still kills only its token-bound startup subtree',nativeOptions,async t=>{
  const a=fixture(t).transport;a.start();const launcher=a.child.pid;
  const result=await a.kill();assert.equal(result.terminated,true,JSON.stringify(result));
  assert.equal(pidAlive(launcher),false);
});

function wireFixture(t){
  const transport=new DesktopTransport(root),written=[];
  transport.child={stdin:{write:line=>written.push(JSON.parse(line))}};
  const release=()=>{const message=written.at(-1),waiting=transport.requests.get(message.id);clearTimeout(waiting.timer);transport.requests.delete(message.id);waiting.resolve({ok:true});};
  t.after(()=>{for(const task of transport.requests.values())clearTimeout(task.timer);transport.requests.clear();transport.child=null;});
  return {transport,written,release};
}
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
test('unauthorized reads, contact connects and id/name spoofing never reach worker stdin',async t=>{
  const {transport,written}=wireFixture(t);
  for(const [command,fields] of [
    ['read',{group:'私人联系人'}],['open',{group:'另一个群'}],['send',{group:'文件传输助手',text:'secret'}],
    ['connect',{targets:[{id:'friend',name:'朋友',kind:'contact'}]}],
    ['connect',{targets:[{id:'group_abao',name:'朋友',kind:'group'}]}],
    ['connect',{targets:[{name:'Example Group A',kind:'group'}]}]
  ])await assert.rejects(transport.call(command,fields),error=>error.code==='conversation_scope_denied'&&error.sendNotSubmitted===true);
  assert.equal(written.length,0);assert.equal(transport.requests.size,0);
});
test('authorization is rechecked after queued target data changes and cannot be replaced by fields.command',async t=>{
  const {transport,written,release}=wireFixture(t),blocker=transport.call('health');await nextTurn();
  const fields={group:'Example Group B'},pending=transport.call('read',fields);fields.group='未经授权的群';
  const denied=assert.rejects(pending,{code:'conversation_scope_denied'});release();await blocker;await denied;assert.equal(written.length,1);
  const safe=transport.call('health',{command:'read',id:999,group:'未经授权的群'});await nextTurn();assert.equal(written.at(-1).command,'health');assert.notEqual(written.at(-1).id,999);release();await safe;
});
test('both explicitly approved group triples can connect and continue to the named group',async t=>{
  const {transport,written,release}=wireFixture(t);
  const connect=transport.call('connect',{targets:[{id:'group_abao',name:'Example Group A',kind:'group',windowBinding:'known_a'},{id:'group_family',name:'Example Group B',kind:'group'}]});await nextTurn();assert.equal(written.length,1);release();await connect;
  const read=transport.call('read',{group:'Example Group B'});await nextTurn();assert.equal(written.at(-1).group,'Example Group B');release();await read;
});
