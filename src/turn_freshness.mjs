import {sameVerifiedSender,senderEvidence} from './conversation_context.mjs';
import {classifyAddress,directText} from './reply_policy.mjs';

// Revise only an explicitly linked, unsent public-chat answer. This is a
// conversation relationship, never evidence that two unknown speakers match.
export function replyRevision(previous,next) {
  if(!previous?.event||!next?.event||previous.kind!=='reply'||next.kind!=='reply')return null;
  const a=previous.event,b=next.event;
  if(a.generation!==b.generation||a.sourceKey===b.sourceKey||b.receivedAt<a.receivedAt||b.receivedAt-a.receivedAt>180000)return null;
  const left=senderEvidence(a.sender),right=senderEvidence(b.sender);
  if(left.evidence==='stable_id'&&right.evidence==='stable_id'&&!sameVerifiedSender(a,b))return null;
  if(b.quote||b.attachments?.length||b.textTruncated||next.directReply)return null;
  if(!['direct_address','engaged_group_followup','verified_member_followup'].includes(next.replyReason))return null;
  const body=directText(classifyAddress(b.text).text).trim();
  if(/^(?:(?:请|再|再次)\s*)?(?:重新(?:评价|分析|回答|看)|(?:分析|评价|看看?|看一下)(?:上文|以上|上面|刚才|最新)|(?:按|根据)(?:刚才|最新|补充).*(?:回答|分析|评价))/u.test(body))return 'refresh';
  const supplement=/^(?:补充(?:一下)?|再补充|更正|我改一下|刚才说错了|条件(?:改成|改为))[，,：:\s]/u.test(body);
  const linked=b.engagement?.relation==='current_group_topic'&&b.engagement.sourceKey===b.sourceKey&&
    (b.engagement.anchorSourceKey===a.sourceKey||b.engagement.anchorSourceKey===a.engagement?.anchorSourceKey)&&
    b.engagement.followupKind==='supplement';
  if(supplement&&(sameVerifiedSender(a,b)||linked)||linked)return 'supplement';
  return null;
}

export function isMissingDetailQuestion(text) {
  const value=String(text??'').trim();
  if(value.length>150||value.includes('\n')||!/[?？]$/.test(value))return false;
  return /^(?:请问)?哪(?:座|个)?城市[呀啊呢]?\s*[?？]$|^(?:你(?:是|想|要)?(?:说|指|问)的?是)?哪(?:句|一句|条|一条|个地方|个城市|座城市|个人|一个人).{0,45}[?？]$/u.test(value);
}

// A new explicit request can replace a stale clarification. Independent full
// answers and requests from known different people keep their own queue slots.
export function supersedesClarification(previous,next) {
  if(!previous?.event||!next?.event)return false;
  const followup=next.replyReason==='engaged_group_followup'&&next.event.engagement?.relation==='current_group_topic'&&next.event.engagement.sourceKey===next.event.sourceKey&&next.event.engagement.followupKind==='question';
  if(!followup&&!['direct_address','new_request_replaces_waiting'].includes(next.replyReason))return false;
  if(previous.event.generation!==next.event.generation||previous.event.sourceKey===next.event.sourceKey)return false;
  const a=senderEvidence(previous.event.sender),b=senderEvidence(next.event.sender);
  if(a.evidence==='stable_id'&&b.evidence==='stable_id'&&!sameVerifiedSender(a,b))return false;
  return true;
}
