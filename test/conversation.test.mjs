import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationContext, senderEvidence, sameVerifiedSender} from '../src/conversation_context.mjs';
import {ReplyPolicy, classifyAddress, classifyControl, directText, canMergeFragment, fragmentReadyAt, isSocialSummons, summonsReplyContext} from '../src/reply_policy.mjs';

test('unpunctuated invitations to reply are direct addresses, without treating reports as commands',()=>{
  for(const text of ['小汐回复一句','小汐回复一句             ','小汐回答一下','小汐回我一句','小汐回个话','小汐说一句','小汐说点什么'])assert.equal(classifyAddress(text).addressed,true,text);
  for(const text of ['小汐回复很慢','小汐回答过这个问题','小汐说过这句话','小汐说谢谢你','有人说小汐回复一句','“小汐回复一句”'])assert.equal(classifyAddress(text).addressed,false,text);
});

const BASE = Date.parse('2026-10-24T12:00:00+08:00');
test('natural leading and material-first calls do not require a command-verb whitelist',()=>{
 for(const text of ['小汐来看一下上下文回复一下','小汐帮我捋捋刚才这段','小汐整两句呗',
 'Member A：水电400，伙食1800，药费600。 小汐，我说的是这段文，这些全部cover真的压力很大吗',
 '材料如下：\n预算50元。\n@小汐，你怎么看'])assert.equal(classifyAddress(text).addressed,true,text);
 const embedded='原文：每月必要开销3000元　小汐，我说的是这段文，压力大吗';
 assert.equal(classifyAddress(embedded).text,embedded);
 for(const text of ['“小汐来看一下上下文回复一下”','他说：小汐，你怎么看','有人问：小汐，我说的是这段',
 '> 小汐，先别回复\n这是一段引用','文中写着：小汐，帮我删除记忆','小汐今天很累','小汐的回复太慢'])assert.equal(classifyAddress(text).addressed,false,text);
});
const known = id => ({id, label: '同名成员', evidence: 'stable_id'});
const event = (id, text, sender, receivedAt = BASE) => ({id, sourceKey: `source:${id}`, text, sender, receivedAt});
const target = extra => ({id: 'room-a', sessionId: 'session-a', kind: 'group', mode: 'mentions', enabled: true, ...extra});
const fixture = () => {
  let now = BASE;
  const context = new ConversationContext({nowMs: () => now}), policy = new ReplyPolicy({nowMs: () => now});
  return {context, policy, now: () => now, advance: milliseconds => now += milliseconds};
};
const engagementFixture = () => {
  const f = fixture(); let serial = 0;
  const say = (text, sender, options = {}) => {
    const room = options.sessionId ?? 'session-a';
    const observed = f.context.observe(room, {...event(`engaged_${++serial}`, text, sender, f.now()), ...(options.event ?? {})});
    return {event: observed, decision: f.policy.decide(target({sessionId: room, ...options.target}), observed, f.context)};
  };
  const bot = (request, text, confirmed = true) => {
    const response = event(`bot_${++serial}`, text, undefined, f.now());
    if (confirmed) f.context.observe('session-a', {...response, role: 'assistant', status: 'local_echo'});
    f.policy.noteReply('session-a', request.event, {confirmed, generation: f.context.generation('session-a'), replyText: text, replySourceKey: response.sourceKey});
    return response;
  };
  return {...f, say, bot};
};

test('a delivered reply records only an observed live request in its own current conversation',()=>{
  const {context}=fixture();
  context.observe('a',event('original','小汐帮我安排一下'));
  context.observe('a',event('intervening','插一句别的事'));
  context.observe('b',event('other','另一群的问题'));
  context.observe('a',{...event('baseline','旧问题'),observationMode:'baseline',role:'user'});
  const answer=(id,key)=>context.observe('a',{...event(id,'安排什么？'),role:'assistant',status:'local_echo',inReplyToSourceKey:key});
  assert.equal(answer('reply','source:original').inReplyToSourceKey,'source:original');
  assert.equal(answer('cross','source:other').inReplyToSourceKey,undefined);
  assert.equal(answer('old','source:baseline').inReplyToSourceKey,undefined);
  context.clear('a');assert.equal(answer('cleared','source:original').inReplyToSourceKey,undefined);
});

test('visible baseline retains observation provenance without fabricating a user or platform time', () => {
  const {context,now} = fixture();
  const row=context.observe('a',{...event('visible','已经在窗口里的内容'),observationMode:'baseline',role:'unknown',platformTimeVerified:true,platformTime:BASE-60000});
  assert.equal(row.observationMode,'baseline');assert.equal(row.role,'unknown');
  assert.equal(row.receivedAt,now());assert.equal(row.timeSource,'observed');assert.equal(row.platformTime,null);
  assert.equal(context.snapshot('a').range.timeSource,'observed');assert.equal(context.snapshot('a').range.historyComplete,false);
  const oldBot=context.observe('a',{...event('unconfirmed_self','旧气泡'),observationMode:'baseline',role:'assistant',status:'confirmed'});
  assert.equal(oldBot.role,'unknown');assert.equal(oldBot.deliveryStatus,undefined);
  const live=context.observe('a',event('live','新来信'));
  assert.equal(live.observationMode,'live');assert.equal(live.timeSource,'received');assert.equal(live.role,'user');
});

test('a baseline question cannot become an unanswered live question just because a new summons follows', () => {
  const f=fixture();
  f.context.observe('session-a',{...event('old_weather','天气怎么样',known('a')),observationMode:'baseline',role:'user'});
  const call=f.context.observe('session-a',event('fresh_call','小汐',known('a')));
  const decision=f.policy.decide(target(),call,f.context);
  assert.equal(decision.reason,'social_summons');assert.equal(decision.replyContext,undefined);
  assert.equal(summonsReplyContext(target(),call,f.context.snapshot('session-a'),f.now()),null);
});

test('unknown IDs and duplicate display names are not stable member identities', () => {
  assert.deepEqual(senderEvidence({id: 'arbitrary'}), {id: null, label: null, evidence: 'unknown'});
  assert.equal(sameVerifiedSender({label: '小明'}, {label: '小明'}), false);
  assert.equal(sameVerifiedSender(known('1'), known('2')), false);
  assert.equal(sameVerifiedSender(known('1'), known('1')), true);
  assert.equal(senderEvidence(known('a'.repeat(257))).id, null);
});

test('ordinary discussion is structured context, separate by session and sender evidence', () => {
  const {context} = fixture();
  context.observe('session-a', event('1', '第一个方案500元', known('a')));
  context.observe('session-a', event('2', '第二个方案800元', known('b')));
  context.observe('session-b', event('3', '另一个群的隐私'));
  const snap = context.snapshot('session-a');
  assert.deepEqual(snap.messages.map(item => item.text), ['第一个方案500元', '第二个方案800元']);
  assert.deepEqual(snap.messages.map(item => item.sender.id), ['a', 'b']);
  assert.equal(snap.range.historyComplete, false);
  assert.equal(snap.messages[0].timeSource, 'received');
  assert.equal(snap.messages[0].platformTime, null);
});

test('context has a 200 message and 120 minute cap with explicit omitted coverage', () => {
  const {context, advance} = fixture();
  for (let n = 0; n < 205; n++) context.observe('a', event(String(n), `发言${n}`));
  assert.equal(context.snapshot('a').messages.length, 200);
  assert.equal(context.snapshot('a').range.omitted, 5);
  advance(120 * 60 * 1000 + 1);
  assert.equal(context.snapshot('a').messages.length, 0);
  assert.equal(context.snapshot('a').range.omitted, 205);
});

test('discussion beyond the old 60 message and 20 minute limits remains available', () => {
  const {context, advance} = fixture();
  for (let n = 0; n < 80; n++) context.observe('a', event(String(n), `发言${n}`));
  advance(21 * 60 * 1000);
  const snap = context.snapshot('a');
  assert.equal(snap.messages.length, 80); assert.equal(snap.messages[0].text, '发言0');
  assert.equal(snap.range.omitted, 0); assert.equal(snap.range.historyComplete, false);
});

test('24000 character budget keeps current question first and marks clipped quote', () => {
  const {context} = fixture();
  context.observe('a', event('old', '旧背景'.repeat(2500)));
  context.observe('a', {...event('ask', '问'.repeat(23990)), quote: {verified: true, status: 'resolved', text: '引用'.repeat(50), sourceKey: 'older'}});
  context.observe('a', event('later', '新的旁聊'));
  const snap = context.snapshot('a', {focusId: 'ask'});
  assert.equal(snap.range.chars, 24000);
  assert.equal(snap.messages.length, 1);
  assert.equal(snap.messages[0].text.length, 23990);
  assert.equal(snap.messages[0].quote.text.length, 10);
  assert.equal(snap.messages[0].quote.truncated, true);
  assert.equal(snap.truncated, true);
});

test('context clear advances generation and late old events cannot repopulate it', () => {
  const {context} = fixture();
  context.observe('a', event('1', '旧话题'));
  const before = context.generation('a');
  context.clear('a', 'read_gap');
  assert.equal(context.generation('a'), before + 1);
  assert.equal(context.observe('a', {...event('2', '迟到'), generation: before}), null);
  assert.equal(context.snapshot('a').messages.length, 0);
  assert.equal(context.snapshot('a').range.reason, 'read_gap');
});

test('only confirmed bot deliveries enter what-she-said context, deduplication is per generation', () => {
  const {context} = fixture();
  assert.equal(context.observe('a', {...event('1', '待发'), role: 'assistant', status: 'prepared'}), null);
  assert.equal(context.observe('a', {...event('2', '不确定'), role: 'assistant', status: 'unknown'}), null);
  assert.ok(context.observe('a', {...event('3', '已发'), role: 'assistant', status: 'local_echo'}));
  assert.equal(context.observe('a', {...event('3', '已发'), role: 'assistant', status: 'local_echo'}), null);
  context.clear('a');
  assert.ok(context.observe('a', {...event('3', '新窗口同runtime ID'), role: 'assistant', status: 'local_echo'}));
});

test('unresolved quote never borrows nearby text, returned snapshots do not expose mutable state', () => {
  const {context} = fixture();
  context.observe('a', {...event('1', '小汐，这句什么意思'), quote: {text: '猜出来的原文', status: 'missing', authorIsBot: true}});
  const snap = context.snapshot('a');
  assert.equal(snap.messages[0].quote.text, null);
  assert.equal(snap.messages[0].quote.authorIsBot, false);
  snap.messages[0].text = '被篡改';
  assert.notEqual(context.snapshot('a').messages[0].text, '被篡改');
});

test('direct call versus third person mention and quotations', () => {
  for (const text of ['小汐，第二个方案贵在哪？', '小汐你觉得呢', '@Example Account 帮我看看', '你怎么看，小汐', '小汐，会不会太贵？', '小汐能不能回复一下', '小汐，说说你的看法']) assert.equal(classifyAddress(text).addressed, true, text);
  for (const text of ['刚才小汐说第二个便宜', '小汐说过这句话', '小汐的功能', '“小汐，停止本轮”', '> 小汐，停一下', '他说：小汐，停止本轮']) assert.equal(classifyAddress(text).addressed, false, text);
  assert.equal(classifyAddress('@Example Account 你好').evidence, 'textual_at');
  assert.equal(directText('示例：`小汐，停止本轮`'), '示例：');
});

test('natural social addresses reach a reply without requiring a question or punctuation', () => {
  const cases = ['小汐在吗', '小汐呀今天累死了', '小汐呀，今天累死了', '谢谢你小汐', '谢谢你，小汐', '晚安小汐', '小汐说说你喜欢什么'];
  for (const [index, text] of cases.entries()) {
    const {context, policy} = fixture();
    assert.equal(classifyAddress(text).addressed, true, text);
    const decision = policy.decide(target(), event(String(index), text), context);
    assert.equal(decision.action, 'reply', text);
    assert.equal(decision.control, undefined, text);
    assert.equal(decision.clarification, undefined, text);
  }
});

test('social-address expansion does not turn reports, quoted calls or code into a summons', () => {
  const cases = ['小汐今天很累', '小汐说谢谢你', '小汐说过“晚安”', '小汐的回复很好', '小汐在群里说晚安', '她说谢谢你小汐', '有人问你怎么看，小汐', '“谢谢你小汐”', '“小汐在吗”', '`小汐在吗`', '```\n小汐在吗\n```', '> 小汐呀今天累死了'];
  for (const [index, text] of cases.entries()) {
    const {context, policy} = fixture();
    assert.equal(classifyAddress(text).addressed, false, text);
    assert.equal(policy.decide(target(), event(String(index), text), context).action, 'ignore', text);
  }
});

test('address payload retains quoted feelings while quoted stop remains conversation data', () => {
  const cases = [
    ['小汐，“今天真的好累”', '“今天真的好累”'],
    ['小汐“今天真的好累”', '“今天真的好累”'],
    ['小汐，「停止本轮」', '「停止本轮」'],
    ['小汐，`停止本轮`是什么意思', '`停止本轮`是什么意思'],
    ['小汐，你说“等我说完”是什么意思', '你说“等我说完”是什么意思']
  ];
  for (const [index, [text, payload]] of cases.entries()) {
    const {context, policy} = fixture();
    const address = classifyAddress(text);
    assert.equal(address.text, payload, text);
    assert.equal(classifyControl(address.text), null, text);
    const decision = policy.decide(target(), event(String(index), text), context);
    assert.equal(decision.action, 'reply', text);
    assert.equal(decision.clarification, undefined, text);
    assert.equal(policy.state('session-a').waiting, null, text);
  }
});

test('a bare name is a social summons for the model, never a fixed missing-question response', () => {
  for (const text of ['小汐', '小汐！', '小汐呀', '@Example Account', '小汐呢', '小汐在吗', '小汐，在不在？', '小汐人呢']) {
    const {context, policy} = fixture();
    const decision = policy.decide(target(), event('call', text), context);
    assert.equal(decision.action, 'reply', text);
    assert.equal(decision.reason, 'social_summons', text);
    assert.equal(decision.text, text, text);
    assert.equal(decision.clarification, undefined, text);
    assert.equal(decision.control, undefined, text);
  }
});

test('an unknown sender summons can refer to the immediately preceding public question without claiming identity', () => {
  for (const summon of ['小汐', '@Example Account', '小汐呢', '小汐在吗']) {
    const {context, policy} = fixture();
    const question = context.observe('session-a', event('weather', '今天天气怎么样', {label: '同名成员'}));
    const call = context.observe('session-a', event('call', summon, {label: '同名成员'}));
    const decision = policy.decide(target(), call, context);
    assert.equal(decision.reason, 'social_summons'); assert.equal(decision.text, summon);
    assert.deepEqual(decision.replyContext, {kind: 'summons_after_question', sourceKey: question.sourceKey,
      text: '今天天气怎么样', sender: {id: null, label: '同名成员', evidence: 'display_name'}, relation: 'adjacent_public_topic'});
    assert.equal(policy.state('session-a').followup, null);
    assert.equal(decision.control, undefined); assert.equal(decision.clarification, undefined);
  }
});

test('summons association uses order even with equal timestamps and cannot bind a later question', () => {
  const {context, policy, now} = fixture();
  const question = context.observe('session-a', event('before', '今天聚餐预算够吗'));
  const call = context.observe('session-a', event('call', '小汐'));
  context.observe('session-a', event('after', '明天天气怎么样'));
  assert.equal(policy.decide(target(), call, context).replyContext.sourceKey, question.sourceKey);
  const empty = fixture();
  const earlier = empty.context.observe('session-a', event('earlier', '小汐'));
  empty.context.observe('session-a', event('only-after', '明天天气怎么样'));
  assert.equal(empty.policy.decide(target(), earlier, empty.context).replyContext, undefined);
  assert.equal(summonsReplyContext(target(), call, context.snapshot('session-a'), now()).text, question.text);
});

test('consecutive pure pings preserve the same adjacent question but no substantive message is skipped', () => {
  const {context, policy} = fixture();
  context.observe('session-a', event('question', '这两个方案哪个便宜'));
  context.observe('session-a', event('ping', '小汐呢'));
  const call = context.observe('session-a', event('call', '@Example Account'));
  assert.equal(policy.decide(target(), call, context).replyContext.sourceKey, 'source:question');
  context.observe('session-a', event('other-topic', '周日去爬山'));
  const later = context.observe('session-a', event('later', '小汐'));
  assert.equal(policy.decide(target(), later, context).replyContext, undefined);
});

test('only matching verified senders can associate personal questions; different known senders never merge', () => {
  for (const [questionSender, caller, relation] of [[known('a'), known('a'), 'same_verified_sender'],
    [known('a'), known('b'), undefined], [{label: '同名成员'}, {label: '同名成员'}, undefined]]) {
    const {context, policy} = fixture();
    context.observe('session-a', event('question', '我今天好累怎么办', questionSender));
    const call = context.observe('session-a', event('call', '小汐', caller));
    assert.equal(policy.decide(target(), call, context).replyContext?.relation, relation);
  }
  const {context, policy} = fixture();
  context.observe('session-a', event('public', '今天天气怎么样', known('a')));
  const call = context.observe('session-a', event('call', '小汐', known('b')));
  assert.equal(policy.decide(target(), call, context).replyContext, undefined);
});

test('summons context does not cross a confirmed bot reply, control, empty or attachment observation', () => {
  const barriers = [
    {...event('barrier', '今天晴'), role: 'assistant', status: 'local_echo'},
    event('barrier', '小汐，换个话题'), event('barrier', ''),
    {...event('barrier', '[图片]'), attachments: [{kind: 'image'}]},
  ];
  for (const barrier of barriers) {
    const {context, policy} = fixture();
    context.observe('session-a', event('question', '今天天气怎么样'));
    context.observe('session-a', barrier);
    const call = context.observe('session-a', event('call', '小汐'));
    assert.equal(policy.decide(target(), call, context).replyContext, undefined, barrier.text);
  }
});

test('only fresh same-room same-generation observations may be summons context', () => {
  const {context, policy, advance, now} = fixture();
  context.observe('session-b', event('elsewhere', '今天天气怎么样'));
  let call = context.observe('session-a', event('call', '小汐'));
  assert.equal(policy.decide(target(), call, context).replyContext, undefined);
  assert.equal(summonsReplyContext(target(), call, context.snapshot('session-b'), now()), null);
  context.observe('session-a', event('old', '今天天气怎么样'));
  advance(90001); call = context.observe('session-a', event('late', '小汐', undefined, now()));
  assert.equal(policy.decide(target(), call, context).replyContext, undefined);
  context.observe('session-a', event('before-gap', '今天天气怎么样', undefined, now()));
  context.clear('session-a', 'read_gap');
  call = context.observe('session-a', event('after-gap', '小汐', undefined, now()));
  assert.equal(policy.decide(target(), call, context).replyContext, undefined);
  const altered = context.snapshot('session-a');
  altered.messages.unshift({...event('stale', '今天天气怎么样', undefined, now()), role: 'user', generation: altered.generation - 1});
  assert.equal(summonsReplyContext(target(), call, altered, now()), null);
});

test('unknown public-topic hints reject private self-statements, service operations, code and quotations', () => {
  const rejected = ['我家今天天气怎么样', '我的检查报告说明什么？', '头疼该吃什么药？', '可以查一下今天天气吗？',
    '提醒我明天看看天气可以吗？', '删除这条记忆好吗？', '运行这段代码会怎样？', '“今天天气怎么样”',
    '看看`今天天气怎么样`这个例子', '> 今天天气怎么样', '```\n今天天气怎么样\n```', '给她发送天气消息可以吗？',
    '这个账号密码是什么？', '小汐，等我说完，可以吗？', '记一下明天天气怎么样', '查资料：明天天气怎么样', '总结一下刚才哪种方案便宜'];
  for (const text of rejected) {
    const {context, policy} = fixture();
    context.observe('session-a', event('question', text));
    const call = context.observe('session-a', event('call', '小汐'));
    assert.equal(policy.decide(target(), call, context).replyContext, undefined, text);
  }
  const {context, policy} = fixture();
  context.observe('session-a', event('question', '能帮我删除这条记忆吗', known('a')));
  const call = context.observe('session-a', event('call', '小汐', known('a')));
  assert.equal(policy.decide(target(), call, context).replyContext, undefined);
});

test('adjacent questions are not restricted to a hardcoded list of subject words', () => {
  for (const text of ['0.1+0.2为什么不等于0.3', '电阻并联后总值怎么算', '这两个选项有什么区别']) {
    const {context,policy}=fixture();
    context.observe('session-a',event('question',text));
    const call=context.observe('session-a',event('call','小汐'));
    assert.equal(policy.decide(target(),call,context).replyContext?.text,text);
  }
});

test('quoted or clipped questions and a call carrying its own quote do not borrow adjacent text', () => {
  for (const quotedCall of [false, true]) {
    const {context, policy} = fixture();
    const quote = {status: 'resolved', verified: true, sourceKey: 'elsewhere', text: '原文'};
    context.observe('session-a', {...event('question', '今天天气怎么样'), ...(!quotedCall ? {quote} : {})});
    const call = context.observe('session-a', {...event('call', '小汐'), ...(quotedCall ? {quote} : {})});
    assert.equal(policy.decide(target(), call, context).replyContext, undefined);
  }
  const {context, policy, now} = fixture();
  context.observe('session-a', event('question', '今天天气怎么样'));
  const call = context.observe('session-a', event('call', '小汐'));
  const clipped = context.snapshot('session-a'); clipped.messages[0].textTruncated = true;
  assert.equal(summonsReplyContext(target(), call, clipped, now()), null);
});

test('seeking the bot is still a summons without enabling reports, quotations or waiting overrides', () => {
  for (const text of ['小汐呢', '小汐在吗', '小汐，在不在？']) assert.equal(isSocialSummons(text), true, text);
  for (const text of ['小汐呢的意思是什么', '小汐在群里说晚安', '“小汐在吗”', '`小汐呢`', '小汐，今天天气怎么样']) assert.equal(isSocialSummons(text), false, text);
  const {context, policy} = fixture();
  policy.decide(target(), event('wait', '小汐，等我说完', known('a')), context);
  assert.equal(policy.decide(target(), event('call', '小汐在吗', known('a')), context).reason, 'waiting_for_complete_request');
  assert.ok(policy.state('session-a').waiting);
});

test('change-topic control carries its new request verbatim instead of swallowing it', () => {
  const {context, policy} = fixture();
  policy.noteReply('session-a', event('old', '旧问题', known('a')));
  const decision = policy.decide(target(), event('next', '小汐，换个话题，你喜欢雨天吗'), context);
  assert.equal(decision.action, 'control');
  assert.equal(decision.control, 'change_topic');
  assert.equal(decision.nextRequestText, '你喜欢雨天吗');
  assert.equal(policy.state('session-a').followup, null);
  const quoted = policy.decide(target(), event('quote', '小汐，换个话题：“停止本轮”这句话怎么翻译'), context);
  assert.equal(quoted.nextRequestText, '“停止本轮”这句话怎么翻译');
  assert.equal(classifyControl(quoted.nextRequestText), null);
  assert.equal(policy.decide(target(), event('only', '小汐，换个话题'), context).nextRequestText, undefined);
  const report = policy.decide(target(), event('report', '小汐，“换个话题，你喜欢雨天吗”'), context);
  assert.equal(report.action, 'reply');
  assert.equal(report.control, undefined);
});

test('natural summons retain owner permissions and do not establish guessed personal identities', () => {
  const {context, policy} = fixture();
  for (const extra of [{paused: true}, {enabled: false}, {authorized: false}, {mode: 'observe'}]) {
    assert.equal(policy.decide(target(extra), event('call', '小汐呀今天累死了'), context).action, 'ignore');
  }
  const call = event('call', '谢谢你小汐', {evidence: 'unknown'});
  assert.equal(policy.decide(target(), call, context).action, 'reply');
  policy.noteReply('session-a', call, {confirmed: true, generation: 0});
  assert.equal(policy.decide(target(), event('follow', '那你觉得呢', {evidence: 'unknown'}), context).action, 'ignore');
  assert.equal(policy.proactiveDecision(target(), context, {evidence: {score: 1}}).allowed, false);
});

test('an explicit call opens group engagement immediately for a same-batch unnamed question', () => {
  for (const text of ['天气怎么样', '电阻串联怎么计算', '为什么会这样', '1+1等于多少', '第一项还是第二项？']) {
    const f = engagementFixture(); const call = f.say('小汐', {evidence: 'unknown'});
    const next = f.say(text, {evidence: 'unknown'});
    assert.equal(next.decision.reason, 'engaged_group_followup', text);
    assert.equal(next.decision.text, text); assert.equal(next.decision.engagement.followupKind, 'question');
    assert.equal(next.decision.engagement.anchorSourceKey, call.event.sourceKey);
    assert.equal(next.decision.engagement.relation, 'current_group_topic');
    assert.equal(f.policy.state('session-a').followup, null);
  }
});

test('both question-call and call-question orders continue after the bot asks for a city', () => {
  for (const reversed of [false, true]) {
    const f = engagementFixture(); let request;
    if (reversed) { f.say('天气怎么样'); request = f.say('小汐'); assert.ok(request.decision.replyContext); }
    else { const call = f.say('小汐'); f.bot(call, '在呢'); request = f.say('天气怎么样'); }
    const question = f.bot(request, '哪座城市');
    const city = f.say('北京');
    assert.equal(city.decision.reason, 'engaged_group_followup');
    assert.equal(city.decision.engagement.followupKind, 'short_answer');
    assert.equal(city.decision.engagement.replyToSourceKey, question.sourceKey);
    assert.equal(city.event.sender.id, null);
  }
});

test('short answers require the actual confirmed bot question and preserve its kind', () => {
  for (const [question, answer] of [['几点开始？', '晚上八点'], ['预算多少？', '每人50元'], ['选第一种还是第二种？', '第二种'], ['想聊什么？', '电影'], ['可以吗？', '可以']]) {
    const f = engagementFixture(); const request = f.say('小汐，聊聊这个话题'); f.bot(request, question);
    assert.equal(f.say(answer).decision.engagement?.followupKind, 'short_answer', question);
  }
  const f = engagementFixture(); const request = f.say('小汐，天气怎么样'); f.bot(request, '哪座城市', false);
  const city = f.say('北京').decision;
  assert.equal(city.engagement.followupKind, 'statement');
  assert.equal(city.engagement.replyToSourceKey, undefined);
});

test('late presence delivery cannot replace the active question or its answer slot', () => {
  const f = engagementFixture(); const call = f.say('小汐'); const request = f.say('天气怎么样');
  f.bot(request, '哪座城市'); f.bot(call, '在呢');
  assert.equal(f.say('北京').decision.engagement?.followupKind, 'short_answer');
});

test('short supplements and reactions continue while clearly third-party discussion interrupts without extending', () => {
  const f = engagementFixture(); const request = f.say('小汐，聚餐预算够吗'); f.bot(request, '再说下人数');
  const supplement = f.say('补充一下，每人50元'); assert.equal(supplement.decision.engagement?.followupKind, 'supplement');
  f.bot(supplement, '这样可以'); assert.equal(f.say('谢谢').decision.engagement?.followupKind, 'reaction');
  const until = f.policy.state('session-a').engagement.until;
  f.advance(10000); assert.equal(f.say('小明，你到家了吗').decision.action, 'ignore');
  assert.equal(f.policy.state('session-a').engagement.until, until);
  assert.equal(f.say('天气怎么样').decision.action, 'ignore');
  f.say('小汐'); assert.equal(f.say('天气怎么样').decision.reason, 'engaged_group_followup');
});

test('an invitation also accepts ordinary feelings and observations without question or topic keywords', () => {
  for (const lines of [['今天好累', '刚下班', '路上还下雨'], ['终于收工了', '想坐一会儿', '先发会儿呆'], ['a long day', 'finally home']]) {
    const f = engagementFixture(); f.say('小汐');
    for (const text of lines) {
      const current = f.say(text).decision;
      assert.equal(current.reason, 'engaged_group_followup', text);
      assert.equal(current.engagement.followupKind, 'statement', text);
      assert.equal(current.text, text);
      assert.equal(current.engagement.relation, 'current_group_topic');
      assert.equal(f.policy.state('session-a').followup, null);
    }
  }
});

test('ordinary statements need an active invitation and never bypass clear noise or permission boundaries', () => {
  const outside = engagementFixture();
  assert.equal(outside.say('今天好累').decision.action, 'ignore');
  for (const text of ['……', '---', '123456', '@小明 今天好累', '他说今天好累', '“今天好累”', '发送消息给小明', '提醒我休息']) {
    const f = engagementFixture(); f.say('小汐');
    const result = f.say(text).decision;
    assert.equal(result.action, 'ignore', text); assert.equal(result.engagement, undefined, text);
  }
  const knownPeople = engagementFixture(); knownPeople.say('小汐', known('a'));
  assert.equal(knownPeople.say('刚下班', known('b')).decision.action, 'ignore');
});

test('engagement idle lifetime is three minutes and real interactions can continue up to the thirty-minute cap', () => {
  const expired = engagementFixture(); expired.say('小汐'); expired.advance(180000);
  assert.equal(expired.say('天气怎么样').decision.action, 'ignore');
  assert.equal(expired.policy.state('session-a').engagement, null);
  const f = engagementFixture(); f.say('小汐'); const opened = f.policy.state('session-a').engagement.openedAt;
  for (let turn = 0; turn < 10; turn++) {
    f.advance(179000); assert.equal(f.say(turn === 0 ? '天气怎么样' : '那明天呢').decision.reason, 'engaged_group_followup');
  }
  assert.equal(f.policy.state('session-a').engagement.until, opened + 1800000);
  f.advance(10000); assert.equal(f.say('后天呢').decision.action, 'ignore');
  assert.equal(f.policy.state('session-a').engagement, null);
});

test('engagement never crosses rooms, generations or an explicitly different verified sender', () => {
  const f = engagementFixture(); f.say('小汐', known('a'));
  assert.equal(f.say('天气怎么样', known('b')).decision.action, 'ignore');
  f.say('小汐'); assert.equal(f.say('天气怎么样', undefined, {sessionId: 'session-b'}).decision.action, 'ignore');
  f.context.clear('session-a', 'disconnect');
  assert.equal(f.say('天气怎么样').decision.action, 'ignore');
  f.policy.clear('session-a'); assert.equal(f.policy.state('session-a').engagement, null);
});

test('stop, wait, change-topic and owner restrictions end automatic group engagement', () => {
  for (const control of ['小汐，停止本轮', '小汐，等我说完', '小汐，换个话题']) {
    const f = engagementFixture(); f.say('小汐'); f.say(control);
    assert.equal(f.policy.state('session-a').engagement, null, control);
    assert.equal(f.say('天气怎么样').decision.action, 'ignore', control);
  }
  for (const restriction of [{paused: true}, {enabled: false}, {authorized: false}, {mode: 'observe'}]) {
    const f = engagementFixture(); f.say('小汐');
    assert.equal(f.say('天气怎么样', undefined, {target: restriction}).decision.reason, 'owner_paused');
    assert.equal(f.policy.state('session-a').engagement, null);
  }
  const f = engagementFixture(); f.say('小汐'); f.policy.clearEngagement('session-a');
  assert.equal(f.say('天气怎么样').decision.action, 'ignore');
});

test('an unnamed quiet request inside engagement cancels ordinary replies while outside it stays proactive-only', () => {
  for (const text of ['先别说了', '先别回复', '先别回答']) {
    const active = engagementFixture(); active.say('小汐'); active.say('天气怎么样');
    const stop = active.say(text).decision;
    assert.equal(stop.action, 'control'); assert.equal(stop.control, 'wait'); assert.equal(stop.proactiveOnly, false);
    assert.equal(active.policy.state('session-a').engagement, null);
    const outside = engagementFixture();
    assert.equal(outside.say(text).decision.proactiveOnly, true);
  }
});

test('reported speech, private exchanges with others and service commands do not gain group engagement permission', () => {
  for (const text of ['他说天气怎么样', '“天气怎么样”', '`天气怎么样`', '@别人 天气怎么样', '小明，你到家了吗', '你到家了吗',
    '提醒我明天出门', '记一下本群周六讨论', '查资料：北京天气', '发送天气消息给小明', '运行这段代码']) {
    const f = engagementFixture(); f.say('小汐'); const result = f.say(text).decision;
    assert.equal(result.action, 'ignore', text); assert.equal(result.control, undefined, text);
    assert.equal(result.engagement, undefined, text);
  }
  const f = engagementFixture(); f.say('小汐');
  assert.equal(f.say('怎么写一个排序函数？').decision.reason, 'engaged_group_followup');
});

test('bot observations cannot open or indefinitely extend engagement by themselves', () => {
  const f = engagementFixture(); const unknown = {event: event('not-called', '天气怎么样')};
  f.bot(unknown, '哪座城市'); assert.equal(f.say('北京').decision.action, 'ignore');
  const call = f.say('小汐'); const hardUntil = f.policy.state('session-a').engagement.hardUntil;
  f.advance(100000); f.bot(call, '在呢');
  assert.equal(f.policy.state('session-a').engagement.hardUntil, hardUntil);
  assert.equal(f.policy.state('session-a').engagement.until, BASE + 180000);
});

test('control words apply only as direct commands, not discussion of commands', () => {
  assert.equal(classifyControl('停止本轮'), 'stop_current');
  assert.equal(classifyControl('等我说完'), 'wait');
  assert.equal(classifyControl('我改一下'), 'wait');
  assert.equal(classifyControl('换个话题'), 'change_topic');
  assert.equal(classifyControl('我说完了'), 'continue');
  for (const text of ['“停止本轮”', '不要执行停止本轮', '解释一下停止本轮的意思', '我说“等我说完”是什么意思']) assert.equal(classifyControl(text), null, text);
});

test('ordinary background is ignored for reply while explicit call replies', () => {
  const {context, policy} = fixture();
  const ordinary = event('1', '第一个方案太贵了');
  context.observe('session-a', ordinary);
  assert.equal(policy.decide(target(), ordinary, context).action, 'ignore');
  const call = event('2', '小汐，第二个呢');
  assert.equal(policy.decide(target(), call, context).action, 'reply');
});

test('confirmed stable identity enables only relevant 90 second followups', () => {
  const {context, policy, advance, now} = fixture();
  const question = event('1', '小汐，推荐一个方案', known('a'));
  policy.noteReply('session-a', question, {nowMs: now(), generation: 0});
  assert.equal(policy.decide(target(), event('2', '那便宜一点呢', known('a')), context).action, 'reply');
  assert.equal(policy.decide(target(), event('3', '那便宜一点呢', known('b')), context).action, 'ignore');
  assert.equal(policy.decide(target(), event('4', '午饭吃了', known('a')), context).action, 'ignore');
  assert.equal(policy.decide(target(), event('5', '那便宜一点呢', {label: '同名成员'}), context).action, 'ignore');
  advance(90000);
  assert.equal(policy.decide(target(), event('6', '那便宜一点呢', known('a'), now()), context).action, 'ignore');
});

test('unknown reply outcome and unknown member never establish a followup', () => {
  const {context, policy} = fixture();
  policy.noteReply('session-a', event('1', '问题', known('a')), {confirmed: false});
  assert.equal(policy.decide(target(), event('2', '那再低一点呢', known('a')), context).action, 'ignore');
  policy.noteReply('session-a', event('3', '问题', {label: '阿宝'}));
  assert.equal(policy.decide(target(), event('4', '那再低一点呢', {label: '阿宝'}), context).action, 'ignore');
});

test('read gap invalidates followup and quote metadata must be verified', () => {
  const {context, policy} = fixture();
  policy.noteReply('session-a', event('1', '问题', known('a')), {generation: 0});
  context.clear('session-a', 'gap');
  assert.equal(policy.decide(target(), event('2', '那再低一点呢', known('a')), context).action, 'ignore');
  assert.equal(policy.decide(target(), {...event('3', '为什么'), quote: {authorIsBot: true, sourceKey: 'bot'}}, context).action, 'ignore');
  assert.equal(policy.decide(target(), {...event('4', '为什么'), quote: {verified: true, status: 'resolved', authorIsBot: true, sourceKey: 'bot'}}, context).action, 'reply');
});

test('stop current does not establish wait or grant an override of owner pause', () => {
  const {context, policy} = fixture();
  const command = event('1', '小汐，停止本轮');
  assert.equal(policy.decide(target(), command, context).control, 'stop_current');
  assert.equal(policy.state('session-a').waiting, null);
  assert.equal(policy.decide(target({paused: true}), event('2', '小汐，继续'), context).action, 'ignore');
  assert.equal(policy.decide(target({mode: 'observe'}), command, context).action, 'ignore');
});

test('wait buffers only stable same-member fragments; explicit request supersedes wait', () => {
  const {context, policy} = fixture();
  assert.equal(policy.decide(target(), event('1', '小汐，等我说完', known('a')), context).control, 'wait');
  policy.decide(target(), event('2', '预算500', known('a')), context);
  policy.decide(target(), event('3', '别人的问题', known('b')), context);
  assert.deepEqual(policy.state('session-a').waiting.fragments, ['source:2']);
  assert.equal(policy.decide(target(), event('4', '小汐，我说完了', known('b')), context).action, 'clarify');
  const resume = policy.decide(target(), event('5', '小汐，我说完了', known('a')), context);
  assert.equal(resume.control, 'continue'); assert.deepEqual(resume.fragments, ['source:2']);
  policy.decide(target(), event('6', '小汐，等我说完'), context);
  const fresh = policy.decide(target(), event('7', '小汐，完整的新问题'), context);
  assert.equal(fresh.action, 'reply'); assert.equal(fresh.supersedesWaiting, true);
});

test('unknown sender cannot resume an incomplete question; waiting expires without auto answer', () => {
  const {context, policy, advance} = fixture();
  policy.decide(target(), event('1', '小汐，等我说完'), context);
  policy.decide(target(), event('2', '预算500'), context);
  assert.equal(policy.decide(target(), event('3', '小汐，我说完了'), context).action, 'clarify');
  advance(90000);
  assert.equal(policy.state('session-a').waitingExpired, true);
  assert.equal(policy.state('session-a').waiting, null);
  assert.equal(policy.decide(target(), event('4', '继续'), context).action, 'ignore');
  policy.decide(target(), event('5', '小汐，等一下'), context);
  advance(90000);
  assert.equal(policy.decide(target(), event('6', '普通讨论'), context).waitingExpired, true);
});

test('quoted stop is not executed and change topic clears policy, not external memory', () => {
  const {context, policy} = fixture();
  assert.equal(policy.decide(target(), event('1', '他说：“小汐，停止本轮”'), context).action, 'ignore');
  policy.noteReply('session-a', event('2', '问题', known('a')));
  assert.equal(policy.decide(target(), event('3', '小汐，换个话题'), context).control, 'change_topic');
  assert.equal(policy.state('session-a').followup, null);
});

test('fragment merging requires known same member and explicit supplement semantics', () => {
  assert.equal(canMergeFragment(event('1', '问题', known('a')), event('2', '补充：不超过500', known('a'))), true);
  assert.equal(canMergeFragment(event('1', '问题'), event('2', '补充：不超过500')), false);
  assert.equal(canMergeFragment(event('1', '问题', known('a')), event('2', '一个新的问题', known('a'))), false);
  assert.equal(canMergeFragment(event('1', '问题', known('a')), event('2', '补充：不超过500', known('b'))), false);
  assert.equal(fragmentReadyAt([event('1', 'A', known('a'), BASE), event('2', 'B', known('a'), BASE + 1600)]), BASE + 1950);
  assert.equal(fragmentReadyAt([event('1', 'A', known('a'), BASE)]),BASE+350);
  assert.equal(fragmentReadyAt([event('1', 'A', known('a'), BASE),event('2','B',known('a'),BASE+1900)]),BASE+2000);
});

function proactiveFixture() {
  const f = fixture();
  f.context.observe('session-a', event('topic', '周末适合去哪里散步', known('a')));
  const config = target({authorized: true, proactive: {enabled: true, ownerApproved: true, quietHours: false}});
  const evidence = {authorized: true, kind: 'current_topic', generation: 0, sourceKeys: ['source:topic'], topic: '周末散步'};
  return {...f, config, evidence};
}

test('proactive participation defaults off and a model score is not authorization', () => {
  const {policy, context, config, evidence} = proactiveFixture();
  assert.equal(policy.proactiveDecision(target(), context, {evidence}).allowed, false);
  assert.equal(policy.proactiveDecision({...config, authorized: false}, context, {evidence}).allowed, false);
  assert.equal(policy.proactiveDecision(config, context, {evidence: {score: 1}}).allowed, false);
  assert.equal(policy.proactiveDecision({...config, proactive: {...config.proactive, utcOffsetMinutes: 'wrong'}}, context, {evidence}).reason, 'invalid_timezone');
  assert.equal(policy.proactiveDecision(config, context, {evidence}).allowed, true);
  assert.equal(policy.proactiveDecision({...config, id: 'b', sessionId: 'b'}, context, {evidence}).allowed, false);
});

test('proactive requires live same-session source evidence, not arbitrary topic or stale generation', () => {
  const {policy, context, config, evidence} = proactiveFixture();
  assert.equal(policy.proactiveDecision(config, context, {evidence: {...evidence, sourceKeys: ['other-room']}}).allowed, false);
  context.clear('session-a', 'read_gap');
  assert.equal(policy.proactiveDecision(config, context, {evidence}).allowed, false);
});

test('an unanswered proactive message suppresses another, ordinary chatter is not an acknowledgement', () => {
  const {policy, context, config, evidence, advance, now} = proactiveFixture();
  assert.equal(policy.recordProactive('session-a', {outboxId: 'out-1', status: 'local_echo'}), true);
  assert.equal(policy.recordProactive('session-a', {outboxId: 'out-1', status: 'local_echo'}), false);
  advance(1000);
  assert.equal(policy.acknowledgeProactive('session-a', event('human', '午饭吃什么', known('a'), now())), false);
  assert.equal(policy.proactiveDecision(config, context, {evidence}).reason, 'awaiting_human_response');
  assert.equal(policy.acknowledgeProactive('session-a', event('reply', '小汐，谢谢', known('a'), now())), true);
  assert.equal(policy.proactiveDecision(config, context, {evidence}).reason, 'cooldown');
});

test('per-session daily quota and unanswered state survive snapshot restore', () => {
  const {policy, context, config, evidence, advance, now} = proactiveFixture();
  for (let n = 0; n < 3; n++) {
    policy.recordProactive('session-a', {outboxId: `out-${n}`, status: 'local_echo'});
    advance(1); policy.acknowledgeProactive('session-a', event(`reply-${n}`, '小汐，谢谢', known('a'), now()));
    advance(20 * 60 * 1000);
  }
  context.observe('session-a', event('topic', '新的散步讨论', known('a'), now()));
  const restored = new ReplyPolicy({nowMs: now});
  restored.restoreProactive('session-a', policy.exportProactive('session-a'));
  assert.equal(restored.proactiveDecision(config, context, {evidence}).reason, 'daily_limit');
  assert.equal(restored.exportProactive('other').sent.length, 0);
  restored.recordProactive('other', {outboxId: 'uncertain', status: 'unknown'});
  const afterCrash = new ReplyPolicy({nowMs: now}); afterCrash.restoreProactive('other', restored.exportProactive('other'));
  assert.equal(afterCrash.state('other').proactive.awaitingResponse, true);
});

test('quiet hours span midnight in explicit Asia/Shanghai offset', () => {
  const {policy, context, config, evidence} = proactiveFixture();
  const quiet = {...config, proactive: {...config.proactive, quietHours: {start: '23:00', end: '08:00'}, utcOffsetMinutes: 480}};
  assert.equal(policy.proactiveDecision(quiet, context, {evidence, nowMs: Date.parse('2026-10-24T23:30:00+08:00')}).reason, 'quiet_hours');
  assert.equal(policy.proactiveDecision(quiet, context, {evidence, nowMs: Date.parse('2026-10-24T07:30:00+08:00')}).reason, 'quiet_hours');
  assert.equal(policy.proactiveDecision(quiet, context, {evidence, nowMs: BASE}).allowed, true);
});

test('a direct quiet request cancels proactive eligibility, only owner can resume the proactive setting', () => {
  const {policy, context, config, evidence} = proactiveFixture();
  const decision = policy.decide(config, event('quiet', '先别说了'), context);
  assert.equal(decision.control, 'wait'); assert.equal(decision.proactiveOnly, true);
  assert.equal(policy.state('session-a').waiting, null);
  policy.clear('session-a');
  assert.equal(policy.proactiveDecision(config, context, {evidence}).reason, 'conversation_paused');
  assert.equal(policy.resumeProactive('session-a'), false);
  assert.equal(policy.resumeProactive('session-a', {ownerApproved: true}), true);
  assert.equal(policy.proactiveDecision(config, context, {evidence}).allowed, true);
});
