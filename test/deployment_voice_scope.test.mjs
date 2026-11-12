import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {loadDeployment, saveDeployment, validateDeployment} from '../src/deployment_config.mjs';

const base = {schemaVersion: 1, targets: [
  {id: 'club', name: 'Example Club', kind: 'group'},
  {id: 'friend', name: 'Example Friend', kind: 'contact'}
]};

test('saving and reopening preserves the distinction between omitted, empty and selected native voice scopes', t => {
  fs.mkdirSync('temp', {recursive: true});
  const dir = fs.mkdtempSync(path.resolve('temp/voice_scope_'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'owner.json');
  for (const native of [{}, {voiceTargetIds: []}, {voiceTargetIds: ['club']}]) {
    saveDeployment({...base, native}, file);
    const stored = loadDeployment(file).native;
    assert.equal(Object.hasOwn(stored, 'voiceTargetIds'), Object.hasOwn(native, 'voiceTargetIds'));
    assert.deepEqual(stored.voiceTargetIds, native.voiceTargetIds);
  }
});

test('window recovery requires explicitly selected group IDs', () => {
  assert.equal(validateDeployment(base).native.backgroundRestoreTargetIds,undefined);
  for (const ids of [[],['club']]) assert.deepEqual(validateDeployment({...base,native:{backgroundRestoreTargetIds:ids}}).native.backgroundRestoreTargetIds,ids);
  for (const ids of [null,'club',['missing'],['club','club'],['friend'],[42]]) {
    assert.throws(()=>validateDeployment({...base,native:{backgroundRestoreTargetIds:ids}}), /native_restore_targets_invalid/);
  }
});

test('panel deployment validation rejects unknown, duplicate, contact and malformed voice scopes', () => {
  for (const value of [null, 'club', ['missing'], ['club', 'club'], ['friend'], [42]]) {
    assert.throws(() => validateDeployment({...base, native: {voiceTargetIds: value}}), /native_voice_targets_invalid/);
  }
});

// Run the delivered panel's load, change and submit handlers. Only the DOM and
// desktop IPC are substituted; saves go through the actual owner-file codec.
async function openPanel(file){
  class Element {
    children=[]; dataset={}; value=''; checked=false;
    append(...items){for(const item of items){item.parent=this;this.children.push(item);}}
    remove(){this.parent.children=this.parent.children.filter(item=>item!==this);}
    addEventListener(type,fn){this['on'+type]=fn;}
    querySelectorAll(selector){
      const key=selector==='[data-scope]'?'scope':'receiveVoice';
      return this.children.flatMap(child=>[...(key in child.dataset?[child]:[]),...child.querySelectorAll(selector)]);
    }
    querySelector(selector){return this.querySelectorAll(selector)[0];}
  }
  const fields=new Map();
  const byId=id=>{if(!fields.has(id))fields.set(id,new Element());return fields.get(id);};
  const document={createElement:()=>new Element(),getElementById:byId,querySelectorAll:()=>[]};
  const calls=[];
  const window={xiaoxi:{subscribe(){},async call(action,payload){
    if(action==='deployment.get')return loadDeployment(file);
    if(action==='deployment.save'){calls.push(action);return saveDeployment(payload,file);}
    if(action==='snapshot')return new Promise(()=>{});
    throw Error('Unexpected panel action: '+action);
  }}};
  vm.runInNewContext(fs.readFileSync(new URL('../public/client.js',import.meta.url),'utf8'),{document,window});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  await tick();
  return {rows:byId('scope-list').children,add:()=>byId('scope-add').onclick(),
    async save(){byId('deployment-form').onsubmit();await tick();assert.deepEqual(calls,['deployment.save']);return loadDeployment(file);}};
}

test('panel displays legacy group selections, removes deleted scopes and preserves text/image authorization', async t=>{
  fs.mkdirSync('temp',{recursive:true});
  const dir=fs.mkdtempSync(path.resolve('temp/voice_panel_'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'owner.json');
  const original={id:'club',kind:'group',name:'Example Club',wechatPeerId:'1234@chatroom'};
  saveDeployment({...base,targets:[original,{id:'old',kind:'group',name:'Old group'},base.targets[1]]},file);
  const panel=await openPanel(file),[club,old,contact]=panel.rows;
  const voice=row=>row.querySelector('[data-receive-voice]');
  assert.equal(voice(club).checked,true);
  assert.equal(voice(old).checked,true);
  assert.equal(voice(contact).disabled,true);
  assert.equal(voice(contact).checked,false);
  old.children.at(-1).onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const kind=club.querySelectorAll('[data-scope]')[2];
  kind.value='contact';kind.onchange();
  assert.equal(voice(club).disabled,true);
  kind.value='group';kind.onchange();
  assert.equal(voice(club).checked,false);
  const saved=await panel.save();
  assert.deepEqual(saved.native.voiceTargetIds,[]);
  assert.deepEqual(saved.targets,[original,base.targets[1]]);
  const reopened=await openPanel(file);
  assert.equal(voice(reopened.rows[0]).checked,false);
  voice(reopened.rows[0]).checked=true;
  assert.deepEqual((await reopened.save()).native.voiceTargetIds,['club']);
});

test('adding a new group starts with voice off and preserves pre-existing empty scope on save', async t=>{
  fs.mkdirSync('temp',{recursive:true});
  const dir=fs.mkdtempSync(path.resolve('temp/voice_panel_new_'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'owner.json');
  saveDeployment({schemaVersion:1,targets:[],native:{voiceTargetIds:[]}},file);
  const panel=await openPanel(file);
  panel.add();
  const [row]=panel.rows;
  const [id,name]=row.querySelectorAll('[data-scope]');
  id.value='new_group';name.value='Example Group';
  assert.equal(row.querySelector('[data-receive-voice]').checked,false);
  const saved=await panel.save();
  assert.deepEqual(saved.native.voiceTargetIds,[]);
  assert.equal(saved.targets[0].id,'new_group');
});
