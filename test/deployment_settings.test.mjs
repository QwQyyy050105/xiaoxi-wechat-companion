import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {applyDeploymentSettings} from '../src/deployment_settings.mjs';

function setup(t,grant){
  const parent=path.resolve('temp');assert.ok(path.isAbsolute(parent));fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'deployment_settings_test_'));
  t.after(()=>{assert.ok(root.startsWith(parent+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  if(grant!==undefined)fs.writeFileSync(path.join(root,'owner_feature_grant.json'),JSON.stringify(grant));
  const store={value:{settings:{allowSearch:false,apiKey:'synthetic-existing-key',provider:'compatible'},targets:[{id:'group_abao'}]},change(fn){const next=structuredClone(this.value);fn(next);this.value=next;}};
  return {root,store};
}
test('explicit deployment grant enables lookup once and preserves later owner choice',t=>{
  const {root,store}=setup(t,{schemaVersion:1,id:'public_lookup_2026_10_25',publicLookup:true});
  assert.equal(applyDeploymentSettings(store,root).applied,true);
  assert.equal(store.value.settings.allowSearch,true);
  assert.equal(store.value.settings.apiKey,'synthetic-existing-key');assert.equal(store.value.settings.provider,'compatible');
  assert.deepEqual(store.value.targets,[{id:'group_abao'}]);
  store.change(s=>s.settings.allowSearch=false);
  assert.equal(applyDeploymentSettings(store,root).reason,'already_applied');assert.equal(store.value.settings.allowSearch,false);
});
test('missing or invalid deployment grant cannot alter settings',t=>{
  const absent=setup(t);assert.equal(applyDeploymentSettings(absent.store,absent.root).reason,'no_grant');
  assert.equal(absent.store.value.settings.allowSearch,false);
  const invalid=setup(t,{schemaVersion:1,id:'grant_all',publicLookup:true,targets:['other']});
  assert.throws(()=>applyDeploymentSettings(invalid.store,invalid.root),/授权内容无效/);
  assert.equal(invalid.store.value.settings.allowSearch,false);
});
