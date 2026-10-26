import fs from 'node:fs';
import path from 'node:path';
import {getAuthorizedWechatScopes,assertConversationScope} from './conversation_scope.mjs';
import {senderEvidence} from './conversation_context.mjs';

// Relationship facts are separate from the character's personality and are
// projected only into their originating group. A name is never authentication.
export function loadGroupProfile(root,session){
  if(session?.channel!=='desktop_wechat')return null;
  assertConversationScope(session,getAuthorizedWechatScopes());
  const file=path.join(root,'group_profiles.json');if(!fs.existsSync(file))return null;
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('群关系设定文件无效');
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(data.schemaVersion!==2)throw Error('群关系设定版本无效');
  const value=data.groups?.[session.peerId];if(!value)return null;
  if(value.title!==session.title)throw Error('群关系设定与会话不一致');
  const text=(x,max=500)=>{if(typeof x!=='string'||!x.trim()||x.length>max||/[\u0000-\u001f]/u.test(x))throw Error('群关系设定字段无效');return x;};
  const array=x=>{if(!Array.isArray(x)||x.length>30)throw Error('群关系设定数量无效');return x;};
  const people=array(value.people).map(x=>({id:text(x.id,100),displayName:text(x.displayName,100),notes:array(x.notes??[]).map(n=>text(n))}));
  const ids=new Set(people.map(x=>x.id));if(ids.size!==people.length||!ids.has(value.perspectivePersonId))throw Error('人物节点或视角无效');
  const relationships=array(value.relationships).map(x=>({from:text(x.from,100),to:text(x.to,100),type:text(x.type,100),label:text(x.label,100)}));
  if(relationships.some(x=>!ids.has(x.from)||!ids.has(x.to)||x.from===x.to))throw Error('人物关系引用无效');
  return {targetId:session.peerId,title:session.title,source:'owner_confirmed',perspectivePersonId:value.perspectivePersonId,people,relationships};
}

export function addressingEvidence(request,profile){
  const sender=senderEvidence(request?.sender);
  const named=typeof sender.label==='string'&&sender.label.trim()?sender.label.trim():null;
  const people=named?profile?.people?.filter(x=>x.displayName===named)??[]:[];
  const person=people.length===1?people[0]:null;
  const relationship=person?.id===profile?.perspectivePersonId?'主人本人':person?profile?.relationships?.find(x=>x.from===profile.perspectivePersonId&&x.to===person.id)?.label:null;
  return {speakerLabel:named,relationshipToOwner:relationship??null,source:named?'message_sender_label':'unavailable',
    mayUseNamedAddress:!!named,mayInferSpeakerFromMention:false};
}

// A tree is a derived presentation; repeated or cyclic relationships become a
// reference to the same canonical person instead of copying or inventing nodes.
export function familyTree(profile,rootId=profile?.perspectivePersonId){
  const people=new Map((profile?.people??[]).map(x=>[x.id,x]));
  const seen=new Set();
  const visit=id=>{
    const person=people.get(id);if(!person)return null;
    if(seen.has(id))return {personId:id,displayName:person.displayName,reference:true};
    seen.add(id);
    return {personId:id,displayName:person.displayName,children:(profile.relationships??[]).filter(x=>x.from===id).map(x=>({relationship:x.label,person:visit(x.to)}))};
  };
  return visit(rootId);
}
