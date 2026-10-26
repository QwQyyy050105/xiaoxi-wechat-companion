import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=readdirSync(new URL('../test/',import.meta.url)).filter(x=>x.endsWith('.test.mjs')).map(x=>'test/'+x).sort();
const result=spawnSync(process.execPath,['--import','./test/bootstrap.mjs','--test',...process.argv.slice(2),...files],{cwd:new URL('../',import.meta.url),stdio:'inherit',env:process.env});
process.exitCode=result.status??1;
