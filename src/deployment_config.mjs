import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const DEPLOYMENT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const DEPLOYMENT_FILE=path.resolve(process.env.XIAOXI_CONFIG||path.join(DEPLOYMENT_ROOT,'deployment.local.json'));
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>Object.hasOwn(d,'value'));
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const id=v=>text(v,64)&&/^[a-z][a-z0-9_-]*$/.test(v);
export function validateAliases(value){if(!Array.isArray(value)||!value.length||value.length>12||value.some(x=>!text(x,64)||!x.trim())||new Set(value).size!==value.length)throw Error('character_aliases_invalid');return value.map(x=>x.trim());}
export function validateDeployment(value={}){
 if(!plain(value)||value.schemaVersion!==1)throw Error('deployment_schema_invalid');
 const account=value.account??{},targets=value.targets??[],character=value.character??{id:'xiaoxi',name:'小汐',aliases:['小汐']},native=value.native??{enabled:false};
 if(!plain(account)||!text(account.displayName??'',128)||!text(account.folder??'',128)||account.folder&&(!/^[A-Za-z0-9_.-]{1,128}$/.test(account.folder)||['.','..'].includes(account.folder))||!text(account.cacheRoot??'',1024)||!text(account.wxid??'',128))throw Error('deployment_account_invalid');
 if(account.cacheRoot&&!path.isAbsolute(account.cacheRoot))throw Error('cache_root_must_be_absolute');
 if(!Array.isArray(targets)||targets.length>64)throw Error('deployment_targets_invalid');
 const ids=new Set(),names=new Set();
 for(const t of targets){if(!plain(t)||!id(t.id)||!text(t.name,128)||!t.name.trim()||!['group','contact'].includes(t.kind)||ids.has(t.id)||names.has(t.name)||'peerId' in t||'windowBinding' in t||t.wechatPeerId!==undefined&&(!text(t.wechatPeerId,128)||!/^\d{1,32}@chatroom$/.test(t.wechatPeerId)))throw Error('deployment_target_invalid');ids.add(t.id);names.add(t.name);}
 if(!plain(character)||!id(character.id)||!text(character.name,64)||!character.name.trim())throw Error('deployment_character_invalid');
 const aliases=validateAliases(character.aliases??[character.name]);
 if(!plain(native)||native.enabled!==undefined&&typeof native.enabled!=='boolean'||native.mediaCache!==undefined&&typeof native.mediaCache!=='boolean'||native.allowModuleDataScan!==undefined&&typeof native.allowModuleDataScan!=='boolean')throw Error('native_config_invalid');
 if(native.enabled===true&&(!account.displayName?.trim()||!account.folder||!targets.length||targets.some(t=>t.kind!=='group')))throw Error('native_requires_account_and_group_scopes');
 if(native.mediaCache===true&&(!native.enabled||!account.cacheRoot||!account.wxid||targets.some(t=>!t.wechatPeerId)))throw Error('media_requires_explicit_account_cache_and_peers');
 if(native.allowModuleDataScan===true&&native.mediaCache!==true)throw Error('module_scan_requires_media_opt_in');
 const model=value.model??{provider:'mock',model:'mock'};
 if(!plain(model)||!['mock','compatible','codex'].includes(model.provider)||!text(model.model??'',100)||!text(model.baseUrl??'',2048)||!text(model.apiKeyEnv??'',128)||'apiKey' in model)throw Error('deployment_model_invalid');
 if(model.vision!==undefined&&typeof model.vision!=='boolean')throw Error('deployment_model_invalid');
 for(const [key,min,max] of [['timeoutMs',100,300000],['retries',0,2],['maxOutputTokens',0,128000]])if(model[key]!==undefined&&(!Number.isInteger(model[key])||model[key]<min||model[key]>max))throw Error('deployment_model_invalid');
 if(model.stream!==undefined&&typeof model.stream!=='boolean'||model.outputTokenField!==undefined&&!['max_tokens','max_completion_tokens'].includes(model.outputTokenField))throw Error('deployment_model_invalid');
 if(model.apiKeyEnv&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv))throw Error('deployment_model_invalid');
 const extensions=value.extensions??[];if(!Array.isArray(extensions)||extensions.length>16||extensions.some(x=>!plain(x)||typeof x.module!=='string'||!/^\.\/plugins\/[A-Za-z0-9_./-]+\.mjs$/.test(x.module)||x.module.split('/').includes('..')))throw Error('extensions_invalid');
 return structuredClone({schemaVersion:1,account:{displayName:account.displayName??'',folder:account.folder??'',cacheRoot:account.cacheRoot??'',wxid:account.wxid??''},targets:targets.map(t=>({id:t.id,name:t.name,kind:t.kind,...(t.wechatPeerId?{wechatPeerId:t.wechatPeerId}:{})})),character:{id:character.id,name:character.name,aliases},native:{enabled:native.enabled===true,mediaCache:native.mediaCache===true,allowModuleDataScan:native.allowModuleDataScan===true},model,extensions});
}
export function loadDeployment(file=DEPLOYMENT_FILE){
 if(!fs.existsSync(file))return validateDeployment({schemaVersion:1,account:{},targets:[]});
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('deployment_file_invalid');
 return validateDeployment(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));
}
export function saveDeployment(value,file=DEPLOYMENT_FILE){const next=validateDeployment(value);if(Buffer.byteLength(JSON.stringify(next))>65536)throw Error('deployment_file_too_large');fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('deployment_file_invalid');const temp=file+'.new';fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600,flush:true});fs.renameSync(temp,file);return {saved:true,restartRequired:true};}
function freeze(v){if(v&&typeof v==='object'){Object.freeze(v);Object.values(v).forEach(freeze);}return v;}
export const deployment=freeze(loadDeployment());
