import {normalizeNativeMedia} from './native_media.mjs';
export class MessageGate {
  constructor({nowMs=Date.now}={}){this.rooms=new Map();this.nowMs=nowMs;}
  clear(){this.rooms.clear();}
  observe(target,snapshot){
    const generation=`${snapshot.pid}/${snapshot.created}/${snapshot.hwnd}`;
    const rows=snapshot.messages.map(normalizeNativeMedia).map(m=>({...m,key:`${m.id}/${m.klass}/${m.text}`}));
    const previous=this.rooms.get(target.id);
    const pending=new Map(previous?.generation===generation?previous.pending:[]);
    const at=this.nowMs();for(const [id,time] of pending)if(at-time>300000)pending.delete(id);
    this.rooms.set(target.id,{generation,keys:rows.map(m=>m.key),ids:rows.map(m=>m.id),pending});
    if(!previous||previous.generation!==generation||!rows.length||!previous.keys.length){pending.clear();return {baseline:true,messages:[]};}
    let index=rows.findIndex(m=>m.key===previous.keys.at(-1));
    // A newly received voice can finish conversion after later chat messages.
    // Only voices first seen LIVE in this process are eligible, once, for 5min.
    const converted=rows.filter(m=>pending.has(m.id)&&m.inputModality?.kind==='platform_transcript');
    if(index<0&&pending.has(previous.ids.at(-1)))index=rows.findIndex(m=>m.id===previous.ids.at(-1)&&['voice_pending','platform_transcript'].includes(m.inputModality?.kind));
    if(index<0){pending.clear();return {gap:true,messages:[]};}
    const fresh=rows.slice(index+1);
    for(const row of fresh)if(row.inputModality?.kind==='voice_pending')pending.set(row.id,at);
    for(const row of converted)pending.delete(row.id);
    const messages=[...converted,...fresh];
    return {messages:messages.filter((row,i)=>messages.findIndex(x=>x.key===row.key)===i)};
  }
}
export function shouldReply(target,message){
  if(!target.enabled||target.mode==='observe'||message.klass!=='mmui::ChatTextItemView')return false;
  if(!message.text.trim()||message.text.length>6000)return false;
  if(target.mode==='all'&&target.kind==='contact')return true;
  return /小汐|@Example Account/u.test(message.text);
}
export function recoverInterrupted(state){
  let count=0;
  for(const row of state.inbox)if(['queued','generating'].includes(row.status)){row.status='skipped';row.reason='上次运行中断，未自动补发';count++;}
  for(const row of state.outbox)if(['prepared','sending'].includes(row.status)){row.status='unknown';row.note='上次运行中断，发送结果未知，不自动重试';count++;}
  for(const row of state.outbox)if(row.status==='deferred'){row.status='not_sent';row.note='等待期间停止运行，本条未发送且不补发';count++;}
  return count;
}
