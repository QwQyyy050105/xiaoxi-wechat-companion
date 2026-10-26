import {inspectWebIntent} from './web_intent.mjs';

// Context may select a public topic, never supply search text. Each query below
// is constant: names, quotations, regional labels and family facts cannot leave
// the conversation through this route. Add domains here, not person-specific rules.
const TOPICS = {
  personality_concepts: 'WHO ICD-11 APA 人格障碍与一般人格特质、认知偏差的区别 诊断要求 持续性 跨情境 功能损害；仅查通用知识与证据局限，不评价具体人',
  education_gifts: '教育部 教师违规收受学生家长礼品礼金规定 高校招生 花钱保录取 内部指标 防诈骗 现行官方规定与适用范围',
  gift_claims: '礼尚往来与利用礼品利益交换的区别 送礼与办事成功的因果证据 如何核实 权威原始资料 不以地域概括个人',
  cognitive_patterns: '确认偏误 过度概括 幸存者偏差 心理学定义 证据局限 研究原始资料 与精神疾病诊断的区别'
};
const REQUEST = /(?:^|[，,。！？!?；;\n])\s*(?:(?:请|麻烦)(?:你)?|你|帮我|替我|给我|能不能|能否|可以)?\s*(?:帮我|替我|给我)?(?:实际|主动|先|再|重新|去)?(?:上网|联网)?(?:搜集|收集|查阅|检索|搜寻|搜索|查证|核实|查找|查资料|查一下|查一查|查询|查查)/u;
const REPORTED = /^(?:[>“”「」『』"'`]|(?:他|她|他们|她们|有人|朋友|群友)(?:说|问)|转述|引用|假设|如果)/u;
const DECLINED = /(?:不用|不要|不必|无需|别|先别)(?:再)?(?:上网|联网|搜|查|收集|检索)|(?:do not|don't)\s+(?:search|browse)/iu;
const UNSAFE_OPERATION = /(?:手机号|电话号|住址|家庭地址|身份证|病历|病情|密码|验证码|私钥|密钥|API.?KEY|[A-Za-z]:[\\/]|file:\/\/|localhost)|(?:然后|顺便|同时|并且)(?:给我|帮我)?(?:发送|发给|转发|删除|运行|执行|下载|转账|付款)/iu;
const CLINICAL = /心理疾病|精神疾病|精神障碍|人格障碍|精神病|\bNPD\b/iu;
const ASSESS = /匹配|对上|符合|判断|诊断|是不是|是否|有没有|分析|有哪些|哪种|什么|症状|可能|有病|怎么|解释|介绍|区分|标准|依据|定义|区别/u;

/** Only a new, current request can authorize research. Background is topic data. */
export function planContextResearch(request, snapshot) {
  if(!request||request.quote||request.attachments?.length||request.textTruncated||typeof request.text!=='string'||request.text.length>3000)return null;
  let text=request.text.normalize('NFKC').trim().replace(/^@?(?:小汐|Example Account)[呀啊]?[，,:：\s]*/u,'');
  if(!text||REPORTED.test(text)||DECLINED.test(text)||UNSAFE_OPERATION.test(text)||/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text))return null;
  // Quoted commands cannot initiate work; their topics may still be discussed.
  const commandText=text.replace(/[“「『"'`][\s\S]*?[”」』"'`]/gu,'');
  const requested=REQUEST.test(commandText);
  const clinical=CLINICAL.test(text)&&(requested||ASSESS.test(commandText)&&!/不是(?:让你|要你|要|问|让)?(?:诊断|匹配)|不问病名/u.test(commandText));
  if(!requested&&!clinical)return null;
  let context='';
  if(snapshot){
    if(request.generation!==snapshot.generation)return null;
    const index=(snapshot.messages??[]).findIndex(row=>row.sourceKey===request.sourceKey);
    const row=snapshot.messages?.[index];
    if(index<0||row.text!==request.text||row.role!=='user'||row.observationMode==='baseline')return null;
    context=snapshot.messages.slice(Math.max(0,index-32),index).filter(row=>row.role==='user'&&!row.textTruncated).map(row=>row.text).join('\n');
  }
  let topic;
  if(clinical)topic='personality_concepts';
  else if(/送礼|收礼|礼品|礼金|礼尚往来/u.test(text))topic=/招生|录取|教师|老师|学校|成绩|升学/u.test(text+'\n'+context)?'education_gifts':'gift_claims';
  else if(/确认偏误|确认偏差|过度概括|幸存者偏差|认知偏差/u.test(text))topic='cognitive_patterns';
  if(topic)return {kind:'research',topic,query:TOPICS[topic],refresh:/重新|再查|最新|实时|刷新/u.test(commandText)};
  // Existing explicit/public queries keep their one-call path. Unresolved
  // research asks for its public subject instead of falsely promising to search.
  if(inspectWebIntent(text).intent)return null;
  return {kind:'clarification',text:'想查哪一个具体说法？给我公开主题或关键词，我就能查资料对照'};
}

export function researchEvidence(plan, result) {
  const sources=Array.isArray(result?.sources)?result.sources.filter(value=>{try{const u=new URL(value);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password;}catch{return false;}}).slice(0,8):[];
  if(result?.searchUsed!==true||!sources.length||typeof result.text!=='string'||!result.text.trim())throw Object.assign(Error('Research returned no verified search evidence'),{code:'search_unverified'});
  return {topic:plan.topic,status:'completed',query:plan.query,text:result.text.slice(0,12000),sources,searchedAt:result.searchedAt??null};
}

// Only public source material is reusable. No request, reply, identity or group
// context enters this small in-memory cache. Explicit refresh bypasses it.
export class PublicResearchCache {
  constructor({nowMs=Date.now,ttlMs=600000}={}){this.nowMs=nowMs;this.ttlMs=ttlMs;this.entries=new Map();}
  get(plan){
    const row=this.entries.get(plan.query);
    if(!row||this.nowMs()-row.at>=this.ttlMs||this.nowMs()<row.at){this.entries.delete(plan.query);return null;}
    if(plan.refresh)return null;
    return {...structuredClone(row.evidence),reused:true};
  }
  put(plan,evidence){
    if(evidence.status!=='completed'||evidence.query!==plan.query||!evidence.sources?.length)return;
    this.entries.delete(plan.query);
    this.entries.set(plan.query,{at:this.nowMs(),evidence:structuredClone({topic:evidence.topic,status:evidence.status,query:evidence.query,text:evidence.text,sources:evidence.sources,searchedAt:evidence.searchedAt})});
    while(this.entries.size>8)this.entries.delete(this.entries.keys().next().value);
  }
}
