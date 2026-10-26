import {inspectWebIntent} from './web_intent.mjs';
import {senderEvidence,sameVerifiedSender} from './conversation_context.mjs';

const WINDOW_MS=180000;
const key=x=>x?.sourceKey??x?.id;
const area=text=>/国内|中国|我国/.test(text)?'中国':/全球|世界|国际/.test(text)?'全球':null;
const metric=text=>/市值/.test(text)?'市值':/营收|收入/.test(text)?'营业收入':/利润|盈利/.test(text)?'利润':null;
function ranking(text){
  const inspected=inspectWebIntent(text);
  if(inspected.blocked||!inspected.intent||!/(?:互联网|科技).*(?:企业|公司)/u.test(inspected.intent.query)||!/(?:十大|前十|前10|top\s*10|排名|排行)/iu.test(inspected.intent.query))return null;
  return {topic:/互联网/.test(text)?'互联网企业':'科技企业',area:area(text),metric:metric(text)};
}
function supplement(text){
  if(typeof text!=='string'||text.length>45||!text.trim()||inspectWebIntent('查一下 '+text).blocked)return null;
  const rest=text.replace(/国内|中国|我国|全球|世界|国际|总市值|市值|营业收入|营收|收入|利润|盈利|按|以|排|的|吧|就|先|看|好了|即可|[，,。！!？?、\s]/gu,'');
  return rest||!area(text)&&!metric(text)?null:{area:area(text),metric:metric(text)};
}
export class PublicLookupConversation{
  constructor({nowMs=Date.now}={}){this.nowMs=nowMs;this.sessions=new Map();}
  clear(id){this.sessions.delete(id);}clearAll(){this.sessions.clear();}
  noteDelivery(id,event,out,result){const s=this.sessions.get(id);if(!s||s.requestKey!==key(event))return;
    if(result?.status!=='local_echo'||out.text!==s.replyText||out.epoch!==s.epoch||out.contextGeneration!==s.generation){this.clear(id);return;}
    s.botKey=out.id;s.until=this.nowMs()+WINDOW_MS;
  }
  plan({sessionId,request,snapshot,epoch}){
    if(snapshot?.sessionId!==sessionId||request.generation!==snapshot.generation||request.quote||request.attachments?.length||request.textTruncated)return null;
    const rows=snapshot.messages??[],idx=rows.findIndex(x=>key(x)===key(request));
    if(idx<0||rows[idx].text!==request.text||rows[idx].role!=='user'||rows[idx].observationMode==='baseline')return null;
    let query=ranking(request.text);const prior=this.sessions.get(sessionId);
    if(!query&&prior){
      const at=rows.findIndex(x=>key(x)===prior.botKey),a=senderEvidence(prior.sender),b=senderEvidence(request.sender);
      const valid=prior.epoch===epoch&&prior.generation===snapshot.generation&&prior.until>this.nowMs()&&at>=0&&idx===at+1&&rows[at].role==='assistant'&&rows[at].deliveryStatus==='local_echo'&&rows[at].text===prior.replyText&&!(a.evidence==='stable_id'&&b.evidence==='stable_id'&&!sameVerifiedSender(a,b));
      const extra=valid?supplement(request.text):null;if(extra)query={...prior.query,area:extra.area??prior.query.area,metric:extra.metric??prior.query.metric};
    }
    this.clear(sessionId);if(!query)return null;
    if(query.area&&query.metric)return {kind:'search',query:`截至今天 ${query.area}${query.metric==='市值'?'上市':''}${query.topic} 按${query.metric}排名前十 统一货币并注明数据日期与来源`};
    const text=!query.area&&!query.metric?'国内还是全球，按市值还是营收？':!query.area?'国内还是全球？':'按市值还是营收？';
    this.sessions.set(sessionId,{requestKey:key(request),query,epoch,generation:snapshot.generation,sender:request.sender,until:this.nowMs()+WINDOW_MS,replyText:text,botKey:null});
    return {kind:'clarification',text};
  }
}
