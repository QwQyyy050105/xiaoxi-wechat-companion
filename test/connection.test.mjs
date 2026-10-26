import test from 'node:test';
import assert from 'node:assert/strict';
import {ILink,trustedBase,inbound} from '../src/ilink.mjs';
import {eligibleTestMessage,sendAccepted} from '../src/probe_policy.mjs';
test('official credentials cannot be sent to redirects or arbitrary hosts',()=>{
  for(const url of ['http://ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com.evil.example','https://evil.example','https://user:pw@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com:8443','https://ilinkai.weixin.qq.com/path'])assert.throws(()=>trustedBase(url));
  assert.equal(trustedBase('https://ilinkai.weixin.qq.com/'),'https://ilinkai.weixin.qq.com');
});
test('64 bit message identifiers are lossless and dedupe keys include account',async()=>{
  const api=new ILink(async()=>new Response('{"ret":0,"msgs":[{"message_id":18446744073709551614,"message_type":1,"message_state":2,"from_user_id":"peer","item_list":[{"type":1,"text_item":{"text":"hello"}}]}]}'));
  const result=await api.updates({base:'https://ilinkai.weixin.qq.com',token:'fake-test'});
  assert.equal(result.msgs[0].message_id,'18446744073709551614');
  assert.notEqual(inbound(result.msgs[0],'account-a').key,inbound(result.msgs[0],'account-b').key);
});
test('one-shot test replies only to scanning user exact text with context',()=>{
  const msg={message_type:1,message_state:2,from_user_id:'owner',context_token:'context',item_list:[{type:1,text_item:{text:'连接测试 abc'}}]};
  assert.equal(eligibleTestMessage(msg,'owner','连接测试 abc'),true);
  for(const patch of [{from_user_id:'stranger'},{group_id:'group'},{message_type:2},{message_state:1},{context_token:''},{item_list:[{type:1,text_item:{text:'普通消息'}}]},{item_list:[...msg.item_list,{type:2}]}])
    assert.equal(eligibleTestMessage({...msg,...patch},'owner','连接测试 abc'),false);
});
test('empty HTTP success response is accepted, not falsely reported as failure',()=>{
  assert.equal(sendAccepted({}),true);assert.equal(sendAccepted({ret:0}),true);
  assert.equal(sendAccepted({ret:-14}),false);assert.equal(sendAccepted({ret:0,errcode:1}),false);assert.equal(sendAccepted(null),false);
});
test('transport rejects service errors and never retries uncertain sends',async()=>{
  let calls=0;const api=new ILink(async()=>{calls++;throw new Error('network failed');});
  await assert.rejects(api.send({base:'https://ilinkai.weixin.qq.com',token:'fake'},'peer','ctx','test'));
  assert.equal(calls,1);
  const expired=new ILink(async()=>new Response('{"ret":-14}'));
  await assert.rejects(expired.updates({base:'https://ilinkai.weixin.qq.com',token:'fake'}),e=>e.code===-14);
});
