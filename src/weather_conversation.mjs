import {createWeatherService,formatWeather} from './weather_service.mjs';
import {parseWeatherIntent,parseWeatherLocationAnswer,parseWeatherFollowup} from './weather_intent.mjs';
import {sameVerifiedSender,senderEvidence} from './conversation_context.mjs';
import {canMergeFragment,summonsReplyContext} from './reply_policy.mjs';

const WINDOW_MS=180000;
const FRAGMENT_GAP_MS=90000;
const key=event=>event?.sourceKey??event?.id;
const confirmed=row=>row?.role==='assistant'&&['local_echo','confirmed'].includes(row.deliveryStatus??row.status);
const superseded=()=>({text:null,status:'superseded'});
const stillCurrent=check=>{try{return !check||check()===true;}catch{return false;}};

function acceptedObservation(sessionId,request,snapshot,now){
  if(typeof sessionId!=='string'||!sessionId||snapshot?.sessionId!==sessionId||!Number.isInteger(snapshot.generation)||
      typeof key(request)!=='string'||!key(request)||typeof request.text!=='string'||request.observationMode==='baseline'||
      request.role==='assistant'||request.own===true||request.generation!==snapshot.generation||
      (request.sessionId!==undefined&&request.sessionId!==sessionId)||
      !Number.isFinite(request.receivedAt)||request.receivedAt>now||now-request.receivedAt>=WINDOW_MS)return null;
  const rows=Array.isArray(snapshot.messages)?snapshot.messages:[],matches=rows.filter(row=>key(row)===key(request));
  const row=matches[0];
  if(matches.length!==1||row.role!=='user'||row.observationMode!=='live'||row.generation!==snapshot.generation||
      (row.sessionId!==undefined&&row.sessionId!==sessionId))return null;
  if(request.fragments===undefined)return row.text===request.text?{merged:false}:null;

  // drain owns acceptance; this trusted observation snapshot supplies the
  // evidence for its merged request. Never accept a caller's replacement text
  // merely because its first source key exists, or merge uncertain identities.
  const fragments=request.fragments;
  if(!Array.isArray(fragments)||fragments.length<2||fragments.length>rows.length||
      fragments.some(value=>typeof value!=='string'||!value)||new Set(fragments).size!==fragments.length||
      fragments[0]!==key(request)||request.role!=='user'||request.observationMode!=='live'||
      request.textTruncated||request.receivedAt!==row.receivedAt||!sameVerifiedSender(row,request))return null;
  const observed=[];let previousIndex=-1;
  for(const sourceKey of fragments){
    const indices=rows.flatMap((candidate,index)=>key(candidate)===sourceKey?[index]:[]);
    if(indices.length!==1)return null;
    const index=indices[0],candidate=rows[index],previous=observed.at(-1);
    if((previous&&index!==previousIndex+1)||candidate.role!=='user'||candidate.observationMode!=='live'||
        candidate.generation!==snapshot.generation||(candidate.sessionId!==undefined&&candidate.sessionId!==sessionId)||
        candidate.own===true||candidate.textTruncated||typeof candidate.text!=='string'||!sameVerifiedSender(row,candidate)||
        !Number.isFinite(candidate.receivedAt)||candidate.receivedAt>now||now-candidate.receivedAt>=WINDOW_MS||
        (previous&&(candidate.receivedAt<previous.receivedAt||candidate.receivedAt-previous.receivedAt>=FRAGMENT_GAP_MS||
          !canMergeFragment(previous,candidate))))return null;
    observed.push(candidate);previousIndex=index;
  }
  return request.text===observed.map(candidate=>candidate.text).join('\n')?{merged:true}:null;
}

// An ignored/late provider promise must not hold cancellation open or yield a
// generic-model fallback. The real weather service has its own network timeout.
function queryWeather(service,query,signal){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',stop);error?reject(error):resolve(value);};
    const stop=()=>{const error=new Error('weather_cancelled');error.code='weather_cancelled';finish(error);};
    signal.addEventListener('abort',stop,{once:true});
    if(signal.aborted){stop();return;}
    Promise.resolve().then(()=>{signal.throwIfAborted();return service.getWeather({...query,signal});}).then(value=>finish(null,value),error=>finish(error));
  });
}

// A bounded public-weather dialogue, not a general-purpose tool router. The
// core calls reply only for accepted turns and supplies their observed snapshot.
export class WeatherConversation {
  constructor({service=createWeatherService(),nowMs=Date.now}={}){this.service=service;this.nowMs=nowMs;this.sessions=new Map();this.serial=0;}
  clear(sessionId){
    const state=this.sessions.get(sessionId);if(!state)return;
    this.sessions.delete(sessionId);state.detach?.();state.controller.abort();
  }
  clearAll(){for(const sessionId of [...this.sessions.keys()])this.clear(sessionId);}
  noteDelivery(sessionId,event,out,result){
    const state=this.sessions.get(sessionId);
    if(!state||state.requestKey!==key(event))return;
    if(this.nowMs()>=state.until||state.controller.signal.aborted||!stillCurrent(state.isCurrent)||
        (event.generation!==undefined&&event.generation!==state.generation)||
        (out?.sessionId!==undefined&&out.sessionId!==sessionId)||
        (out?.epoch!==undefined&&out.epoch!==state.epoch)||
        (out?.contextGeneration!==undefined&&out.contextGeneration!==state.generation)||
        !['local_echo','confirmed'].includes(result?.status)||typeof out?.id!=='string'||!out.id||
        !state.replyText||out.text!==state.replyText||state.phase==='querying'){
      this.clear(sessionId);return;
    }
    state.botKey=out.id;state.until=this.nowMs()+WINDOW_MS;
  }
  current(sessionId,request,snapshot,epoch){
    const state=this.sessions.get(sessionId);
    if(!state)return null;
    const invalid=()=>{this.clear(sessionId);return null;};
    if(this.nowMs()>=state.until||state.generation!==snapshot?.generation||state.epoch!==epoch||state.controller.signal.aborted)return invalid();
    const left=senderEvidence(state.sender),right=senderEvidence(request.sender);
    if(left.evidence==='stable_id'&&right.evidence==='stable_id'&&!sameVerifiedSender(left,right))return invalid();
    const rows=snapshot.messages,i=rows.findIndex(row=>key(row)===state.botKey),j=rows.findIndex(row=>key(row)===key(request));
    // Only the actual, immediately preceding confirmed bot question opens a
    // short-answer slot. Do not skip interjections to bind an old location.
    if(i<0||j!==i+1||!confirmed(rows[i])||rows[i].observationMode==='baseline'||
        rows[i].generation!==state.generation||rows[i].text!==state.replyText)return invalid();
    return state;
  }
  async reply({sessionId,request,snapshot,epoch,signal,isCurrent}){
    if(signal?.aborted||!stillCurrent(isCurrent)||!Number.isInteger(epoch))return superseded();
    const observation=acceptedObservation(sessionId,request,snapshot,this.nowMs());
    if(!observation)return superseded();
    // A replayed accepted key must not issue a second query or cancel the first.
    if(this.sessions.get(sessionId)?.requestKey===key(request))return superseded();
    // A valid merged turn must reach the normal model, not disappear as stale.
    // Weather corrections across multiple fragments are not parsed here yet:
    // do not guess a city, consume an old short-answer slot or issue a lookup.
    if(observation.merged){this.clear(sessionId);return null;}
    if(request.quote||request.attachments?.length||request.textTruncated){this.clear(sessionId);return null;}
    const previous=this.current(sessionId,request,snapshot,epoch);
    let intent=parseWeatherIntent(request.text);
    if(!intent&&request.replyContext){
      const linked=summonsReplyContext({sessionId,kind:'group'},request,snapshot,this.nowMs());
      if(linked&&linked.sourceKey===request.replyContext.sourceKey)intent=parseWeatherIntent(linked.text);
    }
    if(!intent&&previous){
      if(['need_city','ambiguous'].includes(previous.phase)){
        const city=parseWeatherLocationAnswer(request.text);
        if(city)intent={...previous.query,city};
      }else if(previous.phase==='ready'){
        const followup=parseWeatherFollowup(request.text);
        if(followup)intent={kind:'weather',city:followup.city??previous.query.city,dateOffset:followup.dateOffset??previous.query.dateOffset,period:followup.period};
      }
    }
    if(!intent){this.clear(sessionId);return null;}
    if(intent.unsupported){this.clear(sessionId);return {text:'我这条天气通道先支持今天、明天和后天，你想查哪一天？',kind:'clarification',status:'unsupported_date'};}
    const query={city:intent.city??(previous?.phase==='ready'?previous.query.city:null),dateOffset:intent.dateOffset,period:intent.period};
    this.clear(sessionId);
    const controller=new AbortController();
    const state={serial:++this.serial,requestKey:key(request),sender:senderEvidence(request.sender),generation:snapshot.generation,epoch,query,
      phase:query.city?'querying':'need_city',botKey:null,replyText:null,until:this.nowMs()+WINDOW_MS,controller,isCurrent};
    this.sessions.set(sessionId,state);
    const cancel=()=>{if(this.sessions.get(sessionId)===state)this.clear(sessionId);else controller.abort();};
    signal?.addEventListener('abort',cancel,{once:true});state.detach=()=>signal?.removeEventListener('abort',cancel);
    if(signal?.aborted||!stillCurrent(isCurrent)){cancel();return superseded();}
    const active=()=>this.sessions.get(sessionId)===state&&!controller.signal.aborted&&this.nowMs()<state.until&&stillCurrent(isCurrent);
    const response=value=>{state.replyText=value.text;return value;};
    if(!query.city)return response({text:'哪座城市？',kind:'clarification',status:'need_city'});
    const started=performance.now(),duration=()=>Math.round(performance.now()-started);
    try{
      const result=await queryWeather(this.service,{city:query.city,dateOffset:query.dateOffset},controller.signal);
      if(!active()){if(this.sessions.get(sessionId)===state)this.clear(sessionId);return superseded();}
      if(result.status==='not_found'){
        state.phase='need_city';
        return response({text:'没找到这个地点，发一下城市全名或省份加城市名？',kind:'clarification',status:'not_found',durationMs:duration()});
      }
      if(result.status==='ambiguous'){
        state.phase='ambiguous';
        const labels=(result.candidates??[]).slice(0,3).map(row=>row?.label).filter(value=>typeof value==='string'&&value.length<=160&&!/[\u0000-\u001f<>]/u.test(value));
        return response({text:`有几个同名地点${labels.length?'：'+labels.join('、'):''}。你指哪个？请带上省份或国家`,kind:'clarification',status:'ambiguous',durationMs:duration()});
      }
      if(result.status!=='ok')throw Error('weather_invalid_response');
      const text=formatWeather(result);state.phase='ready';
      return response({text,kind:'answer',status:'ok',durationMs:duration(),cacheHit:result.cacheHit===true,provider:'Open-Meteo',dataKind:'weather_model'});
    }catch(error){
      if(!active()||signal?.aborted||controller.signal.aborted){if(this.sessions.get(sessionId)===state)this.clear(sessionId);return superseded();}
      this.clear(sessionId);
      return {text:error.code==='weather_timeout'?'这次天气查询超时了，稍后可以再问我一次':'这次没取到可靠的天气数据，先不瞎报',kind:'answer',status:'unavailable',durationMs:duration()};
    }
  }
}

export function createWeatherConversation(options){return new WeatherConversation(options);}
