import {deployment} from './deployment_config.mjs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertConversationScope,getAuthorizedWechatScopes} from './conversation_scope.mjs';
import {classifyMediaRequest} from './media_intent.mjs';

const PEERS=Object.freeze(Object.fromEntries(deployment.targets.map(t=>[t.id,t.wechatPeerId])));
const MAX_IMAGE=4*1024*1024;
export function validateGroupImages(value,session){
  assertConversationScope(session,getAuthorizedWechatScopes());
  if(!Array.isArray(value)||value.length>2)throw Error('media_packet_invalid');
  return value.map(row=>{
    if(row.sessionId!==undefined&&row.sessionId!==session.id||row.targetId!==session.peerId||row.peerId!==PEERS[session.peerId]||row.source!=='wechat_group_cache'||row.messageBinding!=='unresolved'||row.sender!==null||row.mime!=='image/jpeg'||!['original','wechat_compressed','thumbnail'].includes(row.quality))throw Error('media_scope_mismatch');
    if(typeof row.data!=='string'||row.data.length>MAX_IMAGE*4/3+4||!/^[A-Za-z0-9+/]+={0,2}$/.test(row.data))throw Error('media_bytes_invalid');
    const bytes=Buffer.from(row.data,'base64');
    if(!bytes.length||bytes.length>MAX_IMAGE||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('media_integrity_invalid');
    if(!Number.isFinite(row.cacheModifiedAt)||!Number.isInteger(row.width)||!Number.isInteger(row.height)||row.width<1||row.height<1||row.width*row.height>24000000)throw Error('media_metadata_invalid');
    return {...row,data:bytes.toString('base64'),sessionId:session.id};
  });
}

export function readGroupImages({root,session,connection,signal}){
  assertConversationScope(session,getAuthorizedWechatScopes());
  if(!deployment.native.mediaCache||connection?.stage!=='connected'||connection.account!==deployment.account.displayName||!Number.isInteger(connection.pid)||!Number.isFinite(connection.created))return Promise.resolve({ok:false,reason:'media_connection_unverified',images:[]});
  signal?.throwIfAborted();
  return new Promise(resolve=>{
    const child=spawn(process.env.XIAOXI_PYTHON||path.join(root,process.platform==='win32'?'runtime/desktop_bridge/Scripts/python.exe':'runtime/desktop_bridge/bin/python'),['-B',path.join(root,'scripts/wechat_media_cache.py')],{cwd:root,windowsHide:true,env:{...process.env,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','ignore']});
    let output='',done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolve(result);};
    const cancel=()=>{child.kill();finish({ok:false,reason:'media_cancelled',images:[]});};
    const timer=setTimeout(()=>{child.kill();finish({ok:false,reason:'media_timeout',images:[]});},15000);
    signal?.addEventListener('abort',cancel,{once:true});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>12*1024*1024){child.kill();finish({ok:false,reason:'media_output_limit',images:[]});}});
    child.stdin.on('error',()=>{});child.on('error',()=>finish({ok:false,reason:'media_worker_unavailable',images:[]}));
    child.on('close',()=>{try{const result=JSON.parse(output);finish({ok:result.ok===true,reason:result.reason??null,images:result.ok?validateGroupImages(result.images,session):[]});}catch{finish({ok:false,reason:'media_packet_invalid',images:[]});}});
    child.stdin.end(JSON.stringify({targetId:session.peerId,pid:connection.pid,created:connection.created})+'\n');
    if(signal?.aborted)cancel();
  });
}

export class GroupMediaInput {
  constructor({root,reader=readGroupImages,nowMs=Date.now}={}){this.root=root;this.reader=reader;this.nowMs=nowMs;this.recent=new Map();this.status={image:'ready_on_request',voice:'platform_transcript_only',last:null};}
  clear(sessionId){for(const [id,row] of this.recent)if(!sessionId||id===sessionId){clearTimeout(row.timer);this.recent.delete(id);}if(!sessionId)this.status.last=null;}
  wants(session,request){
    if(session.channel!=='desktop_wechat')return false;
    const intent=classifyMediaRequest(request.text),prior=this.recent.get(session.id);
    if(intent.voiceInput)return false;
    const reference=/^(?:小汐[，,\s]*)?(?:这|那|它|哪个|哪张|什么车|是什么车|你确定)/u.test(request.text.trim());
    return intent.image||!!(prior&&prior.epoch===session.epoch&&this.nowMs()-prior.at<120000&&reference);
  }
  async prepare({session,request,connection,signal}){
    if(session.channel!=='desktop_wechat')return null;
    assertConversationScope(session,getAuthorizedWechatScopes());
    const intent=classifyMediaRequest(request.text);
    if(intent.voiceInput)return null;
    const prior=this.recent.get(session.id);
    const reference=/^(?:小汐[，,\s]*)?(?:这|那|它|哪个|哪张|什么车|是什么车|你确定)/u.test(request.text.trim());
    const continuation=prior&&prior.epoch===session.epoch&&this.nowMs()-prior.at<120000&&reference;
    if(!intent.image&&!continuation)return null;
    if(continuation&&!intent.image)return {images:prior.images,relation:'group_cache_candidates'};
    const started=this.nowMs();
    const result=await this.reader({root:this.root,session,connection,signal});
    signal?.throwIfAborted();
    this.status.last={targetId:session.peerId,at:new Date(this.nowMs()).toISOString(),elapsedMs:this.nowMs()-started,ok:result.ok,count:result.images?.length??0,reason:result.reason??null};
    if(!result.ok||!result.images.length){this.recent.delete(session.id);return {images:[],reason:result.reason||'media_cache_empty'};}
    const images=validateGroupImages(result.images,session);
    this.clear(session.id);
    const entry={epoch:session.epoch,at:this.nowMs(),images};
    entry.timer=setTimeout(()=>{if(this.recent.get(session.id)===entry)this.recent.delete(session.id);},120000);entry.timer.unref?.();
    this.recent.set(session.id,entry);
    return {images,relation:'group_cache_candidates'};
  }
}
