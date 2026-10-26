// Request-local aliases for metadata only. Bodies, quotes, speaker evidence,
// timestamps and the underlying conversation store are never rewritten.
const referenceFields=new Set(['sourceKey','anchorSourceKey','replyToSourceKey','requestBeforeReplySourceKey','inReplyToSourceKey']);
const referenceLists=new Set(['sourceKeys','revisionSourceKeys']);
export function compactModelReferences(messages){
 const aliases=new Map(),restore={},originals=new Set();
 const collect=value=>{
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){
   if(referenceFields.has(key)&&typeof child==='string')originals.add(child);
   else if(referenceLists.has(key)&&Array.isArray(child)){for(const item of child)if(typeof item==='string')originals.add(item);}
   else collect(child);
  }
 };
 for(const message of messages){try{collect(JSON.parse(message.content));}catch{}}
 let sequence=0;
 const reference=value=>{
  if(typeof value!=='string'||value.length<=24)return value;
  if(!aliases.has(value)){let alias;do{alias=`ref_${++sequence}`;}while(originals.has(alias));aliases.set(value,alias);restore[alias]=value;}
  return aliases.get(value);
 };
 function walk(value){
  if(Array.isArray(value))return value.map(walk);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,
   referenceFields.has(key)?reference(child):referenceLists.has(key)&&Array.isArray(child)?child.map(reference):
   // Quotes and messages have their body in text. Never traverse text strings.
   walk(child)]));
 }
 const compact=messages.map(message=>{
  if(message.role!=='user'||typeof message.content!=='string')return message;
  let data;try{data=JSON.parse(message.content);}catch{return message;}
  if(!['observed_conversation','current_request','revised_pending_requests'].includes(data.type))return message;
  return {...message,content:JSON.stringify(walk(data))};
 });
 return {messages:compact,restore};
}
