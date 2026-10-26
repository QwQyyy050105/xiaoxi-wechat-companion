import path from 'node:path';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
process.env.XIAOXI_CONFIG=path.resolve('test/fixtures/deployment.json');
process.env.TEMP=path.resolve('temp');process.env.TMP=process.env.TEMP;
fs.mkdirSync(process.env.TEMP,{recursive:true});
for(const command of [process.env.XIAOXI_PYTHON,'python','python3'].filter(Boolean)){
 const probe=spawnSync(command,['-B','-c','import sys;print(sys.executable)'],{encoding:'utf8',windowsHide:true,timeout:10000});
 if(probe.status===0){process.env.XIAOXI_TEST_PYTHON=probe.stdout.trim();break;}
}
