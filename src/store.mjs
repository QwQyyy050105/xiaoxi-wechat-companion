import {deployment} from './deployment_config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {CODEX_CHAT_MODEL} from './model_policy.mjs';

export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function initialState() {
  return {version:2, sessions:[], memories:[], memoryCandidates:[], tasks:[], accounts:[], inbox:[], outbox:[],targets:deployment.targets.map(t=>({...t,enabled:true,mode:'mentions'})),autoConnect:false,
    settings:{provider:deployment.model?.provider??'compatible',model:deployment.model?.model??'',baseUrl:deployment.model?.baseUrl??'https://api.openai.com/v1',apiKey:'',vision:deployment.model?.vision===true,maxOutputTokens:deployment.model?.maxOutputTokens??0,outputTokenField:deployment.model?.outputTokenField??'max_completion_tokens',apiKeyEnv:deployment.model?.apiKeyEnv??'',timeoutMs:deployment.model?.timeoutMs??120000,retries:deployment.model?.retries??1,stream:deployment.model?.stream!==false,aliases:deployment.character.aliases,webSearch:false},events:[]};
}
export class Store {
  constructor(file, codec) {
    this.file=file; this.codec=codec;
    fs.mkdirSync(path.dirname(file),{recursive:true});
    this.value=fs.existsSync(file) ? JSON.parse(codec.decode(fs.readFileSync(file))) : initialState();
    if(![1,2].includes(this.value.version)) throw new Error('不支持的数据版本，未覆盖原文件。');
    this.value.targets??=initialState().targets;this.value.autoConnect??=false;
    this.value.version=2;this.value.memoryCandidates??=[];this.value.tasks??=[];
    for(const target of this.value.targets){delete target.peerId;}
    for(const session of this.value.sessions){session.memoryEpoch??=0;session.epoch??=0;}
  }
  change(fn) {
    const next=structuredClone(this.value); const result=fn(next);
    next.inbox=next.inbox.slice(-1000);next.outbox=next.outbox.slice(-1000);
    next.memoryCandidates=next.memoryCandidates.slice(-500);
    // Keep active reminders and bounded completed receipts; never evict pending work.
    next.tasks=[...next.tasks.filter(x=>['scheduled','proposed','claimed','sending'].includes(x.status)),...next.tasks.filter(x=>!['scheduled','proposed','claimed','sending'].includes(x.status)).slice(-500)];
    for(const session of next.sessions)session.messages=session.messages.slice(-300);
    const temp=this.file+'.new';
    fs.writeFileSync(temp,this.codec.encode(JSON.stringify(next)),{mode:0o600,flush:true});
    fs.renameSync(temp,this.file); this.value=next; return result;
  }
  event(message) { this.change(s=>{s.events.push({time:now(),message});s.events=s.events.slice(-100);}); }
  session(id) {return this.value.sessions.find(x=>x.id===id);}
  createSession(title='和小汐聊聊', channel='local', accountId='', peerId='') {
    const row={id:uid(),title,channel,accountId,peerId,createdAt:now(),epoch:0,memoryEpoch:0,autoReply:false,messages:[]};
    this.change(s=>s.sessions.push(row)); return row.id;
  }
  snapshot() {
    const s=this.value;
    return {targets:s.targets,autoConnect:s.autoConnect,sessions:s.sessions.map(x=>({...x,messages:x.messages.slice(-300)})),memories:s.memories,memoryCandidates:s.memoryCandidates,tasks:s.tasks,
      accounts:s.accounts.map(({id,label,status,enabled,lastError})=>({id,label,status,enabled,lastError})),
      settings:{...s.settings,apiKey:undefined,hasApiKey:!!s.settings.apiKey||!!(s.settings.apiKeyEnv&&process.env[s.settings.apiKeyEnv])},events:s.events,
      inbox:s.inbox.map(({id,sessionId,status,reason})=>({id,sessionId,status,reason})),
      outbox:s.outbox.map(({id,sessionId,status,createdAt})=>({id,sessionId,status,createdAt}))};
  }
  resetSession(id) {
    this.change(s=>{const c=s.sessions.find(x=>x.id===id); if(!c)throw new Error('会话不存在');
      c.messages=[];c.epoch++;c.memoryEpoch++;c.autoReply=false;s.memories=s.memories.filter(x=>x.sessionId!==id);s.memoryCandidates=s.memoryCandidates.filter(x=>x.sessionId!==id);
      for(const i of s.inbox.filter(x=>x.sessionId===id&&x.status==='queued'))i.status='skipped';});
  }
}
