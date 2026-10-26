export function eligibleTestMessage(message, owner, nonce) {
  if(typeof owner!=='string'||!owner||typeof nonce!=='string'||!nonce)return false;
  if(Number(message.message_type)!==1||Number(message.message_state)!==2||message.group_id)return false;
  if(String(message.from_user_id)!==owner||typeof message.context_token!=='string'||!message.context_token)return false;
  const items=message.item_list;
  if(!Array.isArray(items)||!items.length||items.some(x=>Number(x.type)!==1))return false;
  return items.map(x=>x.text_item?.text||'').join('\n').trim()===nonce;
}
export function sendAccepted(result) {
  return !!result&&typeof result==='object'&&(result.ret===undefined||Number(result.ret)===0)&&(result.errcode===undefined||Number(result.errcode)===0);
}
