import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {DEPLOYMENT_ROOT,DEPLOYMENT_FILE,loadDeployment,saveDeployment} from '../src/deployment_config.mjs';
import {resolveCodex} from '../src/model.mjs';
import {createRuntime} from '../src/runtime.mjs';
import {startPanel} from '../src/panel_server.mjs';
const root=DEPLOYMENT_ROOT,command=process.argv[2]??'doctor',json=process.argv.includes('--json');
if(command!=='doctor')for(const name of ['temp','data','logs'])fs.mkdirSync(path.join(root,name),{recursive:true});
process.env.TEMP=path.join(root,'temp');process.env.TMP=process.env.TEMP;
if(command==='init'){
 if(fs.existsSync(DEPLOYMENT_FILE))console.log('Existing local configuration retained.');else{saveDeployment(JSON.parse(fs.readFileSync(path.join(root,'deployment.example.json'),'utf8')));console.log('Created deployment.local.json with no account, no target, and Mock only.');}
 console.log('Next: npm run demo (no login or API key needed). See README.md.');
}else if(command==='doctor'){
 const config=loadDeployment();let codex=false;try{codex=!!await resolveCodex();}catch{}
 const native=config.native.enabled&&process.platform==='win32';
 const report={ok:true,configuration:fs.existsSync(DEPLOYMENT_FILE)?'configured':'not_initialized',modelProvider:config.model.provider,credential:config.model.apiKeyEnv?(process.env[config.model.apiKeyEnv]?'environment_present':'environment_missing'):'not_configured',remoteCredentialUnconfigured:config.model.provider==='compatible'&&!config.model.apiKeyEnv,codexInstalled:codex,targets:config.targets.length,native:{status:native?'requires_explicit_connection_check':'disabled_or_unsupported',platform:process.platform,validatedWeChat:'4.1.15.56',validation:'not_connected_by_doctor'},demo:'available_offline',note:'Doctor does not log in, call a model, read chats, or change system settings.'};
 console.log(json?JSON.stringify(report):JSON.stringify(report,null,2));
}else if(command==='native-prepare'){
 if(process.platform!=='win32')throw Error('unsupported_platform: Windows required');
 const i=process.argv.indexOf('--dll'),dll=i>=0?process.argv[i+1]:'';if(!dll||!path.isAbsolute(dll))throw Error('Provide --dll with the full path to the installed WeChat DLL');
 const python=process.env.XIAOXI_PYTHON||path.join(root,'runtime/desktop_bridge/Scripts/python.exe');const result=spawnSync(python,['-B',path.join(root,'scripts/accessibility_compatibility.py'),'--dll',dll],{cwd:root,stdio:'inherit',windowsHide:true,env:process.env});process.exitCode=result.status??1;
}else if(['demo','panel'].includes(command)){
 const demo=command==='demo';const runtime=await createRuntime({root,codec:{encode:value=>Buffer.from(value),decode:value=>value.toString('utf8')},demo,stateFile:path.join(root,'data',demo?'demo':'panel','state.json')});
 if(demo&&runtime.extensions.manifests.length)throw Error('demo_requires_no_extensions: remove extensions from local config first');
 const portFlag=process.argv.indexOf('--port'),port=process.argv.includes('--smoke')?0:portFlag>=0?Number(process.argv[portFlag+1]):8765;
 const panel=await startPanel({core:runtime.core,root,port,demo});
 const close=async()=>{await panel.close();await runtime.close();};
 if(process.argv.includes('--smoke')){
  try{const initial=await fetch(panel.url+'/api/bootstrap').then(x=>x.json());const call=async(action,payload)=>{const response=await fetch(panel.url+'/api/call',{method:'POST',headers:{Origin:panel.url,'Content-Type':'application/json','X-Xiaoxi-Token':initial.token},body:JSON.stringify({action,payload})});if(!response.ok)throw Error(await response.text());return (await response.json()).result;};const state=await call('snapshot');const session=state.sessions.find(x=>x.channel==='local');const result=await call('chat',{sessionId:session.id,text:'你好'});if(typeof result!=='string'||!result.includes('演示'))throw Error('demo_reply_invalid');console.log(JSON.stringify({ok:true,mode:'mock',cloudCalls:0,chatMessagesSent:0,panel:true}));}finally{await close();}
 }else{console.log(`${demo?'Offline Mock demo':'Local owner panel'}: ${panel.url}\nCtrl+C to stop. Browser storage is local plain text; use apiKeyEnv for credentials. To use OS-encrypted storage open npm start.`);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close().then(()=>process.exit(0)));}
}else{console.error('Usage: npm run init | doctor -- --json | demo -- --smoke | panel -- --port 8765');process.exitCode=1;}
