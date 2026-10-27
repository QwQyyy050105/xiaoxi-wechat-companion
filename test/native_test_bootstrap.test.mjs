import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve('.'),python=process.env.XIAOXI_TEST_PYTHON;
const skip=!python?'Python is not installed; native test bootstrap unavailable':false;
test('native runner installs its committed fixture with no owner env and rejects dependence on caller owner config',{skip},t=>{
 const dir=fs.mkdtempSync(path.join(root,'temp/native_bootstrap_'));t.after(()=>{assert.equal(path.dirname(dir),path.join(root,'temp'));fs.rmSync(dir,{recursive:true,force:true});});
 const invalid=path.join(dir,'invalid_owner.json');fs.writeFileSync(invalid,'not an owner configuration');
 for(const owner of [undefined,invalid]){const env={...process.env};if(owner===undefined)delete env.XIAOXI_CONFIG;else env.XIAOXI_CONFIG=owner;
  const run=spawnSync(python,['-B','scripts/test_native.py','--check'],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),{ok:true,mode:'synthetic_fixture',authorizedGroups:2,nativeEnabled:false,ownerConfigUsed:false});}
});
test('production Python registry still has zero authorized groups when its explicit owner config is absent',{skip},()=>{
 const env={...process.env,XIAOXI_CONFIG:path.join(root,'temp/missing_runtime_owner_for_bootstrap_test.json')};
 const code="import sys,json;sys.path.insert(0,'scripts');from owner_config import AUTHORIZED_GROUPS,CONFIG;print(json.dumps({'targets':len(AUTHORIZED_GROUPS),'native':CONFIG.get('native',{}).get('enabled') is True}))";
 const run=spawnSync(python,['-B','-c',code],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),{targets:0,native:false});
});
