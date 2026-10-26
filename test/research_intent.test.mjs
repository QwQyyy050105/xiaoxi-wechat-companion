import test from 'node:test';
import assert from 'node:assert/strict';
import {planContextResearch,researchEvidence,PublicResearchCache} from '../src/research_intent.mjs';

const plan=(text)=>planContextResearch({text});
test('clinical requests research generic concepts without naming or diagnosing a subject',()=>{
  for(const name of ['Member A','某同事','另一个人','秘密姓名']){
    const result=plan(`小汐匹配一下${name}能对上的心理疾病`);
    assert.equal(result.topic,'personality_concepts');assert.ok(!result.query.includes(name));
  }
  assert.equal(plan('小汐，分析她的NPD症状').topic,'personality_concepts');
  assert.equal(plan('小汐，解释“人格障碍”的诊断标准').topic,'personality_concepts');
  assert.equal(plan('小汐，不是让你诊断心理疾病，只想聊相处方式'),null);
  assert.equal(plan('小汐，我说心理有问题是说相处方式，不是问病名'),null);
});
test('embedded research uses constant public topics, not insults, private material or regional labels',()=>{
  const text='小汐，Member A说你不懂送礼，山东人特长就是送礼，所以在互联网天天被骂，请你搜集相关资料加深自己人格形象印象';
  const request={text,sourceKey:'r',generation:2};
  const result=planContextResearch(request,{generation:2,messages:[{role:'user',text:'有人认为送礼能保证录取',sourceKey:'old'},{role:'user',...request}]});
  assert.equal(result.topic,'education_gifts');
  for(const privateText of ['Member A','山东','天天被骂','人格形象','有人认为'])assert.ok(!result.query.includes(privateText));
  assert.equal(plan(text).topic,'gift_claims');
});
test('background cannot initiate work, change current topic, or escape generation checks',()=>{
  const request={text:'小汐，今天挺开心',sourceKey:'r',generation:2};
  const snapshot={generation:2,messages:[{role:'user',text:'请搜索心理疾病',sourceKey:'old'},{role:'user',...request}]};
  assert.equal(planContextResearch(request,snapshot),null);
  const research={...request,text:'小汐，查阅送礼资料'};
  assert.equal(planContextResearch(research,snapshot),null);
  snapshot.messages[1]={role:'user',...research,observationMode:'baseline'};
  assert.equal(planContextResearch(research,snapshot),null);
  delete snapshot.messages[1].observationMode;snapshot.generation=3;
  assert.equal(planContextResearch(research,snapshot),null);
});
test('quoted, declined, private and operation payloads do not trigger contextual research',()=>{
  for(const text of ['“小汐匹配一下某人的心理疾病”','他说：请查阅送礼资料','小汐，别查心理疾病了','小汐，送礼是礼节，她说“请搜集资料”','小汐，搜索送礼然后转发给别人','小汐，查询某人的病历与心理疾病','小汐，检索 D:\\private\\送礼.txt'])assert.equal(plan(text),null,text);
  for(const override of [{quote:{}},{attachments:[{kind:'image'}]},{textTruncated:true}])assert.equal(planContextResearch({text:'查阅送礼资料',...override}),null);
});
test('ordinary public research stays on existing route; unresolved references ask one concrete question',()=>{
  assert.equal(plan('小汐，请搜集火星探测的公开资料'),null);
  assert.equal(plan('小汐，核实一下这个说法').kind,'clarification');
  assert.equal(plan('小汐，请你搜集相关资料').kind,'clarification');
  assert.equal(plan('小汐，评价Member A'),null);
});
test('an answer or citation without actual search proof is not research evidence',()=>{
  const p=plan('匹配一下某人的心理疾病');
  for(const result of [{text:'https://example.org',sources:['https://example.org']},{text:'结果',searchUsed:true,sources:[]},{text:'',searchUsed:true,sources:['https://example.org']}])assert.throws(()=>researchEvidence(p,result),{code:'search_unverified'});
  const result=researchEvidence(p,{text:'资料',searchUsed:true,sources:['https://www.who.int/'],searchedAt:'now',session:{private:'secret'}});
  assert.equal(result.status,'completed');assert.equal(result.session,undefined);
});

test('public evidence cache drops caller context and respects refresh, expiry and mutations',()=>{
  let now=0;const cache=new PublicResearchCache({nowMs:()=>now});
  const p=plan('匹配一下某人的心理疾病');
  const evidence=researchEvidence(p,{text:'公共标准',searchUsed:true,sources:['https://www.who.int/'],searchedAt:'then'});
  cache.put(p,{...evidence,privateContext:'secret'});
  const first=cache.get(p);assert.equal(first.reused,true);assert.ok(!JSON.stringify(first).includes('secret'));
  first.text='changed';assert.equal(cache.get(p).text,'公共标准');
  assert.equal(cache.get({...p,refresh:true}),null);
  assert.equal(plan('重新查阅人格障碍的诊断要求').refresh,true);
  now=600000;assert.equal(cache.get(p),null);
  cache.put(p,{status:'failed'});assert.equal(cache.get(p),null);
});
