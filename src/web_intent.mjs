// Classifies only the current utterance. It never reads context, member metadata,
// memory, URLs or files and does not call a model/network to classify a message.
const MAX_INPUT = 600, MAX_QUERY = 240;
const REPORTED = /^(?:(?:今天|昨天|刚才|刚刚|之前)?(?:他|她|他们|她们|有人|某人|群友|朋友)(?:说|问)|我听说|听说|据说|转述|引用|举例|例子|假设|如果有人|刚才小汐说|小汐(?:说|刚才|之前)|我朋友(?:说|问|想知道)|(?:he|she|they)\s+(?:said|asked)|someone\s+(?:said|asked)|quote\b)/iu;
const SOCIAL = /^(?:你|小汐|Example Account)(?:今天|现在|最近|目前|到底|还)?(?:在(?:吗|不在)|好(?:吗|不好)|怎么(?:样|了)|累|困|忙|开心|难过|能(?:不?能)?(?:上网|联网|搜索)|会(?:不会)?(?:上网|联网|搜索)|有什么功能|是什么模型|用什么模型|是机器人)|^(?:how are you|are you (?:there|tired|busy)|can you (?:browse|search|go online)|what can you do)\b/iu;
const PRIVATE = /本群|群里|群友|群成员|聊天记录|我们的聊天|刚才(?:说|提到|那个)|上面(?:说|提到|那个|这)|这个人|那个人|住址|家庭地址|(?:我|你|您|他|她|我们|他们|她们|同学|室友|同事|朋友|家人|老师|老板|爸爸|妈妈|老公|老婆)(?:的)?(?:手机(?:号)?|电话|邮箱|邮件|住址|地址|身份证|账号|账户|银行卡|病情|病历|聊天|行程|工资|收入|位置|定位|单位)|(?:手机号码?|微信号|QQ号|身份证号?|银行卡号?|验证码|密码|口令|私钥|密钥|API[ _-]?KEY|access[ _-]?token|bearer\s|cookie\s*[:=]|授权码)|(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})|(?:^|\D)1[3-9]\d{9}(?:$|\D)|\b\d{15,19}\b|(?:^|\s)(?:my|your|his|her|their)\s+(?:address|phone|email|password|salary|location|messages?)\b/iu;
const PERSONAL = /^(?:我|你|您|他|她|我们|你们|他们|她们)(?!想知道|想问|想了解|想查|知道)|(?:今天|最近|现在|这几天).*(?:好累|很累|累死|好烦|烦死|难过|伤心|失眠|睡不着|心情|没精神|不开心)|今天.*(?:吃什么|吃啥|聚餐|谁来|来不来)|^(?:how are (?:you|we)|how do i feel|i (?:am|feel)|my friend)\b/iu;
const LOCAL = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|localhost|127\.0\.0\.1|\[::1\]|\.local\b)|(?:本机|电脑上|本地文件|读取文件|环境变量|系统提示|开发者指令|忽略(?:之前|上面|所有)?(?:规则|指令))/iu;
const OPERATION_START = /^(?:(?:请|麻烦)(?:你)?|帮我)?(?:提醒|定时|记住|保存记忆|删除记忆|发给|转发|发送|转账|付款|支付|打开文件|运行|执行|启动|重启|关闭|设置|配置|开启|取消|删除|修改)/u;
const SIDE_EFFECT = /(?:然后|接着|顺便|同时|并且|再帮我|并帮我|并)(?:给我|帮我)?(?:发送|发给|转发|转账|付款|支付|删除|保存|运行|执行|打开|下载|设置|修改|提醒)|\b(?:then|and then)\s+(?:send|delete|run|execute|download|pay)\b/iu;
const TEMPORAL = /最新|实时|即时|现在|目前|当前|今天|今日|今晚|明天|后天|最近|近期|今年|本周|这周|这个月|本月|本赛季|\b(?:latest|current|currently|today|tonight|tomorrow|recent|this (?:week|month|year|season))\b/iu;
const QUESTION = /[?？]|怎么|怎样|如何|什么|为何|为什么|谁|哪(?:个|里|儿|种|些|几|天|家|座)|几(?:点|时|个|天|元|岁)|多少|是否|能否|会不会|有没有|什么时候|截至|截止|(?:吗|么|呢)[呀啊]?[。!！\s]*$|\b(?:what|who|when|where|which|how much|how many|is|are)\b/iu;
const PUBLIC_FACT = /新闻|消息|资讯|热点|版本|更新|发布|上线|上市|发售|价格|售价|多少钱|汇率|金价|油价|股价|利率|行情|比分|赛程|比赛|赛事|冠军|排名|积分榜|票价|余票|时刻表|班次|停运|延误|路况|政策|法规|规定|公告|通知|报名|截止|总统|总理|首相|市长|CEO|董事长|负责人|天气|气温|下雨|下雪|降水|空气质量|\b(?:news|version|release|price|rate|score|schedule|forecast|weather|president|minister|ceo|deadline|policy|announcement)\b/iu;
const DEICTIC = /^(?:那|那么)?(?:这个说法|那个说法|这个观点|那个观点|这个结论|那个结论|这个|那个|这件事|那件事|这个事|那个事|他|她|他们|她们|它|它们|上述|前面那个|刚才那个)(?:的|现在|目前|最新|今天|最近|怎么样|怎么|多少钱|呢|[，,。?？\s]|$)|^(?:what about (?:that|it)|what is (?:its|their)|how much is (?:it|that))\b/iu;

function stripAddress(text) { return text.replace(/^(?:@?(?:小汐|Example Account))[呀啊]?[，,、:：\s]*/u,''); }
function trimQuery(text) { return text.trim().replace(/^(?:[：:,，\s]+)/u,'').replace(/[。.!！?？\s]+$/u,'').replace(/[，,\s]*(?:谢谢(?:你)?|麻烦了|拜托了|please|thanks)[呀啊啦哦]*$/iu,'').trim(); }
function rejected(reason) { return {intent:null,blocked:true,reason}; }
function safety(text) {
  if(PRIVATE.test(text))return 'private_query';
  if(LOCAL.test(text))return 'local_or_instruction_payload';
  if(SIDE_EFFECT.test(text))return 'mixed_action_request';
  return null;
}
function explicitQuery(text) {
  const chinese=text.match(/^(?:(?:能不能|能否|可以)(?:请)?[，,\s]*)?(?:(?:请|麻烦)(?:你)?[，,\s]*)?(?:(?:帮|替)(?:我|我们)|给我)?(?:上网|联网)?(?:搜集|收集|查阅|检索|搜寻|查证|查资料|搜索|搜一下|搜一搜|查看一下|查看|查一下|查一查|查下|查查|查询|查找|核实|核对)(?:一下)?[：:\s]*([\s\S]+)$/u);
  if(chinese)return chinese[1];
  const english=text.match(/^(?:please\s+)?(?:search(?:\s+(?:online|the web))?(?:\s+for)?|look up|google|check online|verify online)\s+([\s\S]+)$/iu);
  return english?.[1]??null;
}

/** Returns blocking evidence separately so the old explicit-search parser cannot bypass it. */
export function inspectWebIntent(value) {
  if(typeof value!=='string'||!value.trim())return {intent:null,blocked:false};
  if(value.length>MAX_INPUT||/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value))return rejected('invalid_query_shape');
  const raw=value.normalize('NFKC').trim();
  if(REPORTED.test(raw)||/^(?:[>“”「」『』"'`]|```)/u.test(raw))return rejected('quoted_or_reported');
  let text=stripAddress(raw);
  if(REPORTED.test(text)||/[“”「」『』`]|(?:^|\s)>|\[CQ:/u.test(text))return rejected('quoted_or_reported');
  if(OPERATION_START.test(text)||/提醒(?:我|大家|本群)|\bremind me\b/iu.test(text))return rejected('non_search_operation');
  if(/^(?:不用|不要|别|不必|无需|先别)(?:再)?(?:联网|上网|搜索|查)|^(?:do not|don't|no need to)\s+(?:search|browse|look up)\b/iu.test(text))return rejected('search_declined');
  let query=explicitQuery(text),reason='explicit_search';
  if(query===null){
    if(SOCIAL.test(text))return {intent:null,blocked:false};
    text=text.replace(/^(?:(?:你)?知道|(?:能|可以)?告诉我|我想(?:知道|问一下|了解)|请问)[，,\s]*/u,'');
    if(PERSONAL.test(text)||DEICTIC.test(text))return {intent:null,blocked:false};
    if(!TEMPORAL.test(text)||!PUBLIC_FACT.test(text)||!(QUESTION.test(text)||/最新|实时|即时|\blatest\b/iu.test(text)))return {intent:null,blocked:false};
    query=text;reason='current_fact';
  }
  query=trimQuery(query);
  if(/^(?:相关|更多|上述|刚才的|上面的)?(?:资料|材料|证据|信息|说法)[，,。?？\s]*$/u.test(query))return rejected('ambiguous_subject');
  const problem=safety(query);if(problem)return rejected(problem);
  if(PERSONAL.test(query)||DEICTIC.test(query))return rejected('private_or_ambiguous_subject');
  if(query.length<2||query.length>MAX_QUERY)return rejected('invalid_query_shape');
  // Reject unresolved requests such as "现在多少钱"; their subject would have to
  // come from private/background context, which this classifier never reads.
  const subject=query.replace(/最新|实时|即时|现在|目前|当前|今天|今日|今晚|明天|后天|最近|近期|今年|本周|这周|这个月|本月/gu,'').replace(/(?:是|有|在|的)?(?:多少(?:钱)?|什么|谁|怎么(?:样)?|怎样|如何|哪(?:个|里|儿|种|些))|[?？。!！\s]/gu,'');
  if(subject.length<2)return rejected('ambiguous_subject');
  return {intent:{query,reason},blocked:false};
}

export function parseWebIntent(text) { return inspectWebIntent(text).intent; }
