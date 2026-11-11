// One live bubble per request, retained in memory for the receiver's delayed
// transcript window. No database lookups, sender inference or native actions.
const lifetime = 5 * 60 * 1000;
const maxVoices = 16;
const prefixWords = /能不能|能否|麻烦|可以|请|你|帮我|帮忙|把|将|给我|听一听|听一下|听听|听下|听|转写|识别|读一下|看看|看下|复述|说说|转成文字|转文字|刚才|刚刚|刚发来|刚发|最新|最后|上一|上|这|那|发的|的|一|段|条|个|[，,\s]/gu;
const suffixWords = /里面|里|中|说的|讲的|说|讲|的|了|是|什么|啥|内容|转写|转成文字|转文字|文字|听听|听一下|一下|给我|看看|吗|嘛|呢|呀|啊|吧|字|[，,。！？!?\s]/gu;

export function wantsVoiceReadback(body,names=[]) {
  if(typeof body!=='string'||body.length>120)return false;
  let text=body.trim().replace(/^@/u,'');
  const alias=[...names].sort((a,b)=>b.length-a.length).find(name=>name && text.startsWith(name));
  if(alias)text=text.slice(alias.length).replace(/^[，,:：\s]+/u,'');
  const parts=text.split(/语音|录音/u);
  return parts.length===2 && parts[0].replace(prefixWords,'')==='' && parts[1].replace(suffixWords,'')==='';
}
const quoteTranscript = text => '这条语音转出来是「'+(text.length>600?text.slice(0,600)+'…':text)+'」';

export class LiveVoiceReadback {
  constructor(nowMs=Date.now) {this.nowMs=nowMs;this.rooms=new Map();}
  recent(sessionId) {
    const now=this.nowMs(), records=this.rooms.get(sessionId)??new Map();
    for(const [id,row] of records) if(now-row.at>lifetime || now<row.at) records.delete(id);
    if(!records.size)this.rooms.delete(sessionId);
    return records;
  }
  observe(sessionId,message) {
    const modality=message.inputModality;
    if(!message.id||message.own===true||message.role==='assistant'||
        !['voice_pending','platform_transcript','asr_transcript'].includes(modality?.kind))return null;
    const records=this.recent(sessionId);
    const row=records.get(message.id)??{at:this.nowMs(),seconds:modality.durationSeconds};
    if(modality.kind==='voice_pending') {
      row.stage=row.text?'ready':modality.stage??'waiting';
    }else{
      if(row.text)return null;
      row.stage='ready';row.text=message.text;
    }
    records.set(message.id,row);
    if(records.size>maxVoices)records.delete(records.keys().next().value);
    this.rooms.set(sessionId,records);
    if(row.text && row.requested){row.requested=false;return quoteTranscript(row.text);}
    return null;
  }
  latest(sessionId) {return Array.from(this.recent(sessionId).values()).at(-1);}
  request(sessionId) {
    const row=this.latest(sessionId);
    if(!row)return {text:'我这里还没收到这个群新发的语音'};
    if(row.text)return {text:quoteTranscript(row.text)};
    const label=row.seconds?'这条 '+row.seconds+' 秒的语音':'这条语音';
    const text=label+(row.stage==='failed'?'转文字失败了':'还没出文字')+'，这几分钟转出来我就贴在这儿';
    return {text,wait:()=>{row.requested=true;}};
  }
  cancel(sessionId) {for(const row of this.rooms.get(sessionId)?.values()??[])row.requested=false;}
  clear(sessionId) {if(sessionId)this.rooms.delete(sessionId);else this.rooms.clear();}
}
