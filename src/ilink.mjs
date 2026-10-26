// Independent implementation of Tencent/openclaw-weixin documented text protocol.
// Reference pinned in research_evidence.json. No desktop-account control implied.
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import JSONbig from 'json-bigint';
const parse=JSONbig({storeAsString:true,protoAction:'error',constructorAction:'error'}).parse;
export const DEFAULT_BASE='https://ilinkai.weixin.qq.com';
const baseInfo={channel_version:'2.4.10',bot_agent:'Xiaoxi/0.1.0'};
export function trustedBase(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!(u.hostname==='ilinkai.weixin.qq.com'||u.hostname.endsWith('.ilinkai.weixin.qq.com'))||!['','/'].includes(u.pathname)||u.search||u.hash)
    throw new Error('微信返回了未受信任的服务器地址，已停止连接');
  return u.origin;
}
export class ILink {
  constructor(fetcher=fetch){this.fetcher=fetcher;}
  async request(base,endpoint,body,token='',signal,timeout=40000) {
    const headers={'iLink-App-Id':'bot','iLink-App-ClientVersion':String((2<<16)+(4<<8)+10)};
    if(body!==undefined){headers['Content-Type']='application/json';headers.AuthorizationType='ilink_bot_token';headers['X-WECHAT-UIN']=Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');}
    if(token)headers.Authorization=`Bearer ${token}`;
    const response=await this.fetcher(trustedBase(base)+endpoint,{method:body===undefined?'GET':'POST',headers,
      body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeout)])});
    if(!response.ok)throw new Error(`微信接口 HTTP ${response.status}`);
    const raw=await response.text();if(raw.length>2*1024*1024)throw new Error('微信接口响应过大');
    const result=parse(raw);
    if(result.ret&&Number(result.ret)!==0||result.errcode&&Number(result.errcode)!==0){const e=new Error(`微信接口错误 ${result.errcode||result.ret}`);e.code=Number(result.errcode||result.ret);throw e;}
    return result;
  }
  qr(signal){return this.request(DEFAULT_BASE,'/ilink/bot/get_bot_qrcode?bot_type=3',{local_token_list:[]},'',signal);}
  qrStatus(qrcode,base=DEFAULT_BASE,verify='',signal){return this.request(base,`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${verify?'&verify_code='+encodeURIComponent(verify):''}`,undefined,'',signal);}
  updates(account,signal){return this.request(account.base,'/ilink/bot/getupdates',{get_updates_buf:account.cursor||'',base_info:baseInfo},account.token,signal);}
  send(account,peer,context,text,clientId=randomUUID(),signal){
    if(!context)throw new Error('缺少当前会话回复凭据，需要对方先发一条新消息');
    return this.request(account.base,'/ilink/bot/sendmessage',{msg:{from_user_id:'',to_user_id:peer,client_id:clientId,message_type:2,message_state:2,context_token:context,item_list:[{type:1,text_item:{text}}]},base_info:baseInfo},account.token,signal);
  }
}
export function inbound(message,accountId){
  if(Number(message.message_type)!==1||Number(message.message_state)!==2||message.group_id||!message.from_user_id)return null;
  const items=Array.isArray(message.item_list)?message.item_list:[];
  const text=items.filter(i=>Number(i.type)===1).map(i=>i.text_item?.text||'').join('\n').trim();
  // Incomplete or unsupported media is shown honestly; never fabricate its contents.
  const media=items.some(i=>Number(i.type)!==1);
  const id=message.message_id??message.client_id??message.seq;
  if(id==null)return null;
  return {key:createHash('sha256').update(`${accountId}\0${message.from_user_id}\0${id}`).digest('hex'),peer:String(message.from_user_id),text:text.slice(0,16000),context:message.context_token||'',media};
}
