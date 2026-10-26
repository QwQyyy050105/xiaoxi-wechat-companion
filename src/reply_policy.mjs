import {senderEvidence, sameVerifiedSender} from './conversation_context.mjs';
import {parseMemoryIntent} from './memory_service.mjs';
import {parseTaskIntent} from './task_service.mjs';

const WINDOW_MS = 90000;
const ENGAGEMENT_IDLE_MS = 180000;
const ENGAGEMENT_MAX_MS = 30 * 60000;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const roomId = target => target.sessionId || target.id;
const eventKey = event => event.sourceKey || event.id;

function summonsBody(text) {
  const value = String(text ?? '').trim().replace(/[，,、:：!！?？。～~\s]+$/u, '');
  return !value || /^(?:呢|人呢|在(?:吗|么|不在|不))$/u.test(value) || /^(?:回复(?:我)?(?:一句|一下)|回(?:我)?(?:一句|一声|个话))(?:就好|就行|吧)?$/u.test(value);
}

// Only the direct utterance can be a command. Quotations, code and quote blocks are data.
export function directText(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ').replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/g, ' ').trim();
}

export function classifyAddress(text, names = ['小汐', 'Example Account']) {
  const raw = String(text ?? '').trim(), direct = directText(raw);
  const choices = names.filter(Boolean).map(escapeRegExp).join('|');
  if (!choices) return {addressed: false, text: direct};
  // Recognize an address outside quotes/code, but retain its original payload.
  // Quoted content can be the subject of a reply without becoming a command.
  const match = raw.match(new RegExp(`^(?:(?:嘿|嗨|你好|请问|麻烦)[，,\\s]*)?(@?(?:${choices}))([呀啊哇呐]?)([，,、:：!！?？。～~\\s]*)([\\s\\S]*)$`, 'i'));
  if (match) {
    const body = match[4].trim(), directBody = directText(body);
    const textualAt = match[1].startsWith('@');
    const separated = !!(match[2] || match[3]);
    const replyInvitation=/^(?:(?:回复|回答|回|答)(?:$|一下|一句|几句|两句|一声|个|我|这|那|问题|吧)|说(?:一下|一句|几句|两句|点|说))/u.test(directBody);
    // "小汐说..." is a report; "小汐说说..." is a direct invitation.
    if (!separated && !textualAt && !replyInvitation && /^(?:说(?!说)|讲过|刚才|之前|的|是)/.test(directBody)) return {addressed: false, text: direct};
    if(replyInvitation)return {addressed:true,text:body,directText:directBody,evidence:textualAt?'textual_at':'direct_address'};
    // A leading name is normally an invitation. Exclude clear third-person
    // reports instead of requiring a growing whitelist of command verbs.
    const report=/^(?:(?:回复|回答)(?:过|很|太|得|总是|一直)|在群里|今天很|最近很|刚刚|昨天|刚才|之前)/u.test(directBody);
    if (separated || textualAt || summonsBody(body) || !report) return {addressed: true, text: body, directText: directBody, evidence: textualAt ? 'textual_at' : 'direct_address'};
  }
  const suffix = raw.match(new RegExp(`^([\\s\\S]+?)[，,\\s]*(?:${choices})[呀啊哇呐?？!！。～~]*$`, 'i'));
  if (suffix) {
    const body = suffix[1].trim(), directBody = directText(body);
    const reported = /^(?:他说|她说|有人说|有人问|我听|转述|引用|示例|例子|假设|如果有人)/.test(directBody);
    const social = /^(?:谢谢(?:你)?|多谢(?:你)?|谢啦|辛苦(?:你)?了|你好|早(?:安|上好)?|晚上好|晚安|再见|拜拜)[呀啊哇呐啦了哦呢，,\s]*$/.test(directBody);
    if (!reported && (social || /[?？]|(?:你怎么看|你觉得|帮我|好吗|可以吗)/.test(directBody))) return {addressed: true, text: body, directText: directBody, evidence: 'direct_address'};
  }
  // People often paste material first and call us in the following clause.
  // Inspect unquoted text only; keep the full original material for the answer.
  const embedded=new RegExp(`(?:[。！？!?；;\\n]|\\s+|[，,])(@?(?:${choices}))([，,、:：!！?？。～~\\s]+)([^\\n]*)`,'gu');
  for(const found of direct.matchAll(embedded)){
    const before=direct.slice(0,found.index),clause=before.split(/[。！？!?；;\n]/u).at(-1).trim();
    if(/(?:他说|她说|有人说|有人问|转述|引用|示例|例子|假设|如果有人|写着|原话)[：:\s]*$/u.test(clause)||/^(?:他说|她说|有人说|有人问|转述|引用|示例|例子|假设|如果有人)/u.test(clause))continue;
    const tail=found[3].trim();
    if(tail&&/^(?:你|我|请|帮|来|看|听|评价|分析|回答|回复|说说|觉得|认为|能|这|那)/u.test(tail))return {addressed:true,text:raw,directText:direct,evidence:'embedded_address'};
  }
  return {addressed: false, text: direct};
}

export function isSocialSummons(text, names = ['小汐', 'Example Account']) {
  const address = classifyAddress(text, names);
  return address.addressed && summonsBody(address.text);
}

const QUESTION = /[?？]|(?:吗|么|呢)[呀啊]?[。!！\s]*$|怎么|怎样|如何|为什么|为何|谁|哪(?:个|里|儿|种|些|天|家|座)|几(?:点|时|个|天|元|岁)|多少|什么|是否|能否|会不会|有没有|要不要|可不可以/u;
const OPERATION = /记住|记忆|提醒|闹钟|定时|删除|取消|停止|换.{0,2}话题|等我|先别|开启|关闭|启动|重启|连接|发送|发给|转发|转账|付款|支付|搜索|联网|查询|查一下|帮我查|设置|配置|语音|发图|图片|附件|截图|视频|音频|运行|执行|命令|代码|密码|验证码|token|api.?key/iu;
const PERSONAL = /我|俺|咱|你|您|他|她|爸|妈|爷|奶|姐|哥|弟|妹|老公|老婆|孩子|身体|头疼|头痛|发烧|生病|药|医院|诊断|血|身份证|住址|电话|手机号|邮箱|账户|账号|银行卡|收入|工资|借款|欠款|贷款|感情|分手|抑郁|自杀|怀孕|检查报告/u;
const REPORTED = /^(?:他说|她说|他们说|她们说|有人说|有人问|听说|据说|转述|引用|举例|例子|假设|如果有人)/u;
const OTHER_CHAT = /^(?:@|(?:[^，,:：\s]{1,10})[，,:：]\s*(?:你(?:在|到|回|来|去|吃|睡)|咱们|我们)|(?:你|你们)(?:在(?:哪|家)|到(?:哪|家|了)|回来|回家|来不来|吃饭|吃了吗|下班|睡了吗|忙完))/u;
const ENGAGEMENT_OPERATION = /^(?:请|帮(?:我|忙)?|麻烦)?(?:记住|记一下|记下|忘掉|删除|修改|取消|提醒|发送|发给|转发|转账|付款|支付|运行|执行|打开|启动|重启|联网|搜索|查(?:一下|资料)|设置|配置|开启|关闭|用语音|发语音)/u;

function answerSlot(replyText) {
  const text = typeof replyText === 'string' ? replyText.trim() : '';
  if (!text || text.length > 4000 || !QUESTION.test(text)) return null;
  if (/哪(?:个|座)?(?:城市|地区|地方)|哪儿|哪里|什么地方/u.test(text)) return 'location';
  if (/什么时候|哪(?:一)?天|几(?:点|时|号)|什么时间/u.test(text)) return 'time';
  if (/哪个|哪种|选哪|还是/u.test(text)) return 'choice';
  if (/多少|几(?:个|人|元|份|次|天)|预算/u.test(text)) return 'quantity';
  if (/什么|怎样|怎么|如何/u.test(text)) return 'short';
  return /吗|么|是否|能否|[?？]/u.test(text) ? 'yes_no' : null;
}

function fitsShortAnswer(text, slot) {
  if (!slot || text.length > 80 || QUESTION.test(text)) return false;
  const value = text.replace(/[呀啊吧哦呢。!！\s]+$/u, '');
  if (slot === 'location') return /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z·\s-]{0,19}$/u.test(value) &&
    !/^(?:我|你|他|她|我们|他们)|(?:回家|下班|吃饭|睡觉|走了|来了|不知道|随便)/u.test(value);
  if (slot === 'time') return /^(?:今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|[上下]午|早上|晚上|\d{1,4}[-/:：年月日点号]|[一二两三四五六七八九十]+点)/u.test(value);
  if (slot === 'quantity') return /^(?:大概|大约|约|每人)?[\d一二两三四五六七八九十百千万零几半]+(?:[.．至到~-]\d+)?(?:个|人|元|块|份|次|天|小时|分钟|米|公里|公斤|斤|以内|左右|上下)*$/u.test(value);
  if (slot === 'choice') return /^(?:第?[一二三四五六七八九十\d]+(?:个|种|项|套|份|方案)?|[A-Fa-f]|前者|后者|都行|都可以|前面那个|后面那个)$/u.test(value);
  if (slot === 'yes_no') return /^(?:是的?|不是|好|不好|可以|不可以|行|不行|要|不要|有|没有|能|不能|会|不会|对|不对)$/u.test(value);
  // The actual bot question supplies the meaning of this short response. It is
  // not a guessed sender identity or permission to execute anything.
  return text.length <= 40 && !/[。！？!?；;\n]/u.test(text);
}

// A summons may refer to a just-observed public question, without asserting
// that two unknown senders are one person or promoting background to a command.
export function summonsReplyContext(target, event, snapshot, now = Date.now(), names = ['小汐', 'Example Account']) {
  if (!isSocialSummons(event.text, names) || snapshot?.sessionId !== roomId(target) ||
      !Number.isInteger(snapshot.generation) || !Array.isArray(snapshot.messages)) return null;
  const key = eventKey(event);
  const index = snapshot.messages.findIndex(item => eventKey(item) === key);
  if (!key || index < 0) return null;
  const call = snapshot.messages[index];
  if (call.observationMode === 'baseline' || call.generation !== snapshot.generation || (event.generation !== undefined && event.generation !== snapshot.generation) ||
      !Number.isFinite(call.receivedAt) || call.receivedAt > now || now - call.receivedAt > WINDOW_MS ||
      call.quote || call.textTruncated || call.attachments?.length) return null;
  for (let i = index - 1; i >= 0; i--) {
    const candidate = snapshot.messages[i];
    if (candidate.observationMode === 'baseline' || candidate.role !== 'user' || candidate.generation !== snapshot.generation ||
        !Number.isFinite(candidate.receivedAt) || candidate.receivedAt > call.receivedAt ||
        now - candidate.receivedAt > WINDOW_MS || candidate.quote || candidate.textTruncated || candidate.attachments?.length) return null;
    const text = String(candidate.text ?? '').trim();
    if (!text || text.length > 1000 || directText(text) !== text) return null;
    // Consecutive pings are not another substantive topic. Index order matters:
    // several native observations from one read can have identical timestamps.
    if (isSocialSummons(text, names)) continue;
    const address = classifyAddress(text, names), body = address.addressed ? address.text : text;
    if (!QUESTION.test(body) || classifyControl(body) || parseMemoryIntent(body) || parseTaskIntent(body) || OPERATION.test(body)) return null;
    const sender = senderEvidence(candidate.sender), caller = senderEvidence(call.sender);
    if (sender.evidence === 'stable_id' && caller.evidence === 'stable_id' && sender.id !== caller.id) return null;
    const same = sameVerifiedSender(sender, caller);
    if (!same && PERSONAL.test(body)) return null;
    return {kind: 'summons_after_question', sourceKey: eventKey(candidate), text: candidate.text,
      sender, relation: same ? 'same_verified_sender' : 'adjacent_public_topic'};
  }
  return null;
}

export function classifyControl(text) {
  const value = directText(text).replace(/[。.!！?？]+$/g, '').trim();
  if (/^(?:请)?(?:停止本轮|取消(?:本轮|这次|当前)(?:回答|回复|任务)?|停下(?:本轮|这次|当前)(?:回答|回复))$/.test(value)) return 'stop_current';
  if (/^(?:请)?(?:先停一下|等(?:一)?下|等我说完|先别说了|先别回复|先别回答|我改一下|我刚才说错了)(?:[，,。!！\s].*)?$/.test(value)) return 'wait';
  if (/^(?:请)?换(?:个|一个)?话题(?:[，,。!！:：；;\s].*)?$/.test(value)) return 'change_topic';
  if (/^(?:我说完了|说完了|可以回答了|继续(?:回答|回复)?)$/.test(value)) return 'continue';
  return null;
}

export function canMergeFragment(previous, event) {
  if (!previous || !sameVerifiedSender(previous, event)) return false;
  const text = directText(event.text).replace(/^(?:小汐|@Example Account)[，,：:\s]*/, '');
  return /^(?:补充(?:一下)?|再补充|条件(?:改成|改为)|更正|我改一下|刚才说错了)[，,：:\s]/.test(text);
}

export function fragmentReadyAt(events, nowMs = Date.now()) {
  const times = events.map(item => typeof item.receivedAt === 'number' ? item.receivedAt : Date.parse(item.receivedAt ?? item.createdAt)).filter(Number.isFinite);
  if (!times.length) return nowMs;
  return Math.min(times[0] + 2000, times.at(-1) + 350);
}

function localDay(now, offsetMinutes) { return new Date(now + offsetMinutes * 60000).toISOString().slice(0, 10); }
function quietNow(now, config) {
  const quiet = config.quietHours ?? {start: '23:00', end: '08:00'};
  if (quiet === false) return false;
  const read = value => /^\d{2}:\d{2}$/.test(value ?? '') ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
  const start = read(quiet.start), end = read(quiet.end);
  if (![start, end].every(value => Number.isFinite(value) && value >= 0 && value < 1440)) return true;
  const local = new Date(now + (config.utcOffsetMinutes ?? 480) * 60000), minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
}

export class ReplyPolicy {
  constructor({nowMs = Date.now, names = ['小汐', 'Example Account'], readOnlyIntent = () => false, engagementIdleMs=ENGAGEMENT_IDLE_MS, engagementMaxMs=ENGAGEMENT_MAX_MS} = {}) { this.engagementIdleMs=engagementIdleMs;this.engagementMaxMs=engagementMaxMs; this.nowMs = nowMs; this.names = names; this.readOnlyIntent = readOnlyIntent; this.sessions = new Map(); }
  room(sessionId) {
    if (!sessionId) throw Error('A session ID is required');
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, {waiting: null, followup: null, clarification: null, engagement: null, proactive: {sent: [], awaitingResponse: false, lastAt: null, lastOutboxId: null, paused: false}});
    return this.sessions.get(sessionId);
  }
  clear(sessionId) {
    const room = this.room(sessionId);
    // Usage limits and unanswered-turn safety survive a context gap/reconnect.
    room.waiting = null; room.followup = null; room.clarification = null; room.engagement = null;
  }
  clearEngagement(sessionId) { this.room(sessionId).engagement = null; }
  clearAll() { for (const id of this.sessions.keys()) this.clear(id); }
  state(sessionId, now = this.nowMs()) {
    const room = this.room(sessionId); let expired = false;
    if (room.waiting && now >= room.waiting.until) { room.waiting = null; expired = true; }
    if (room.followup && now >= room.followup.until) room.followup = null;
    if (room.clarification && now >= room.clarification.until) room.clarification = null;
    if (room.engagement && (now >= room.engagement.until || now >= room.engagement.hardUntil)) room.engagement = null;
    return {...structuredClone(room), waitingExpired: expired};
  }
  openEngagement(target, event, snapshot, now, topicText = '') {
    if (target.kind !== 'group' || !Number.isInteger(snapshot?.generation) || !eventKey(event)) return;
    const room = this.room(roomId(target)), previous = room.engagement;
    const reusable = previous && previous.generation === snapshot.generation && now < previous.until && now < previous.hardUntil;
    const openedAt = reusable ? previous.openedAt : now, hardUntil = openedAt + (target.participation?.maxMs??this.engagementMaxMs);
    room.engagement = {openedAt, hardUntil, until: Math.min(now + (target.participation?.idleMs??this.engagementIdleMs), hardUntil), generation: snapshot.generation,
      anchorKey: eventKey(event), lastAcceptedKey: eventKey(event), sender: senderEvidence(event.sender),
      topicText: String(topicText).slice(0, 1000), expectedAnswer: null, lastBotKey: null, interrupted: false};
  }
  engagedFollowup(target, event, snapshot, now) {
    const room = this.room(roomId(target)), engaged = room.engagement;
    if (target.kind !== 'group' || !engaged || engaged.interrupted || now >= engaged.until || now >= engaged.hardUntil ||
        snapshot?.sessionId !== roomId(target) || snapshot.generation !== engaged.generation ||
        (event.generation !== undefined && event.generation !== engaged.generation)) return null;
    const reject = () => { engaged.interrupted = true; return null; };
    const rows = snapshot.messages ?? [], index = rows.findIndex(row => eventKey(row) === eventKey(event));
    const previous = rows.findIndex(row => eventKey(row) === engaged.lastAcceptedKey);
    if (index < 0 || previous < 0 || index <= previous) return null;
    if (rows.slice(previous + 1, index).some(row => {
      if(row.generation!==engaged.generation)return true;
      if(row.role==='user'&&engaged.coalescedKeys?.includes(eventKey(row))&&isSocialSummons(row.text,this.names))return false;
      return row.role!=='assistant'||!['local_echo','confirmed'].includes(row.deliveryStatus??row.status);
    })) return reject();
    const text = String(event.text ?? '').trim(), sender = senderEvidence(event.sender);
    const readOnly=this.readOnlyIntent(text)===true,task=parseTaskIntent(text);
    if (!Number.isFinite(event.receivedAt) || event.receivedAt > now || now - event.receivedAt > (target.participation?.idleMs??this.engagementIdleMs) ||
        event.quote || event.textTruncated || event.attachments?.length || !text || text.length > 1000 ||
        directText(text) !== text || REPORTED.test(text) || OTHER_CHAT.test(text) || classifyControl(text) ||
        parseMemoryIntent(text) || (task && !(readOnly && task.type==='search')) || (ENGAGEMENT_OPERATION.test(text) && !readOnly)) return reject();
    if (sender.evidence === 'stable_id' && engaged.sender.evidence === 'stable_id' && sender.id !== engaged.sender.id) return reject();
    let followupKind;
    if (QUESTION.test(text) || /^(?:我想问|想问|问一下)/u.test(text)) followupKind = 'question';
    else if (engaged.expectedAnswer && fitsShortAnswer(text, engaged.expectedAnswer.kind)) followupKind = 'short_answer';
    else if (engaged.topicText && text.length <= 160 && /^(?:补充(?:一下)?|再补充|还有|其实|不是|应该是|条件(?:改成|改为)|预算|时间|地点)[，,:：\s]|^(?:那|所以|也就是说).+(?:就|是|要|不|会)/u.test(text)) followupKind = 'supplement';
    else if (engaged.lastBotKey && /^(?:谢谢(?:你)?|谢啦|懂了|明白了|知道了|原来如此|好(?:的)?|嗯嗯|哈哈[哈]*|有道理|行)[呀啊啦哦呢！!。\s]*$/u.test(text)) followupKind = 'reaction';
    // An invitation starts a conversation, not a question-only command mode.
    // Ordinary observations and feelings go to the same model turn with their
    // actual context; the model can stay silent for clearly third-party talk.
    else if (/[\p{L}]/u.test(text)) followupKind = 'statement';
    if (!followupKind) return reject();
    const replyToSourceKey = followupKind === 'short_answer' ? engaged.expectedAnswer.sourceKey : engaged.lastBotKey;
    const engagement = {relation: 'current_group_topic', anchorSourceKey: engaged.anchorKey, sourceKey: eventKey(event), followupKind,
      ...(replyToSourceKey ? {replyToSourceKey} : {})};
    engaged.until = Math.min(now + (target.participation?.idleMs??this.engagementIdleMs), engaged.hardUntil);
    engaged.lastAcceptedKey = eventKey(event); engaged.topicText = text; engaged.expectedAnswer = null; engaged.lastBotKey = null; engaged.coalescedKeys = [];
    return engagement;
  }
  noteReply(sessionId, event, {confirmed = true, nowMs = this.nowMs(), topicId, generation, replyText, replySourceKey} = {}) {
    const room = this.room(sessionId), sender = senderEvidence(event.sender);
    room.followup = confirmed && sender.evidence === 'stable_id' ? {sender, until: nowMs + WINDOW_MS, sourceKey: eventKey(event), topicId: topicId ?? eventKey(event), generation} : null;
    const engaged = room.engagement;
    if (engaged && eventKey(event) === engaged.lastAcceptedKey && (generation === undefined || generation === engaged.generation)) {
      const kind = confirmed ? answerSlot(replyText) : null;
      engaged.expectedAnswer = kind && typeof replySourceKey === 'string' ? {kind, sourceKey: replySourceKey} : null;
      engaged.lastBotKey = confirmed && typeof replySourceKey === 'string' ? replySourceKey : null;
    }
  }
  noteClarification(sessionId, event, {field, generation, nowMs = this.nowMs()} = {}) {
    const room = this.room(sessionId);
    if (room.clarification?.sourceKey === eventKey(event) && room.clarification.field === field) return false;
    room.clarification = {sourceKey: eventKey(event), sender: senderEvidence(event.sender), field, generation, until: nowMs + WINDOW_MS};
    return true;
  }
  decide(target, event, context, now = this.nowMs()) {
    const sessionId = roomId(target), state = this.state(sessionId, now), room = this.room(sessionId);
    const answer = (action, reason, extra = {}) => ({action, reason, sessionId, text: event.text ?? '', addressed: false, waitingExpired: state.waitingExpired, ...extra});
    if (target.enabled === false || target.paused || target.mode === 'observe' || target.authorized === false) { room.engagement = null; return answer('ignore', 'owner_paused'); }
    if (event.role === 'assistant' || event.own === true) return answer('ignore', 'own_message');
    const snap = typeof context?.snapshot === 'function' ? context.snapshot(sessionId) : context;
    if (event.generation !== undefined && snap?.generation !== undefined && event.generation !== snap.generation) return answer('ignore', 'stale_generation');
    const address = classifyAddress(event.text, this.names);
    const control = address.addressed ? classifyControl(address.text) : null;
    // A group member can stop pending proactive content without granting global controls.
    const quietRequest = !address.addressed && /^(?:先别说了|先别回复|先别回答)[。!！\s]*$/.test(directText(event.text));
    if (control || quietRequest) {
      const type = quietRequest ? 'wait' : control;
      room.engagement = null;
      if (quietRequest) { room.proactive.paused = true; }
      else if (type === 'wait') {
        room.waiting = {sourceKey: eventKey(event), sender: senderEvidence(event.sender), generation: snap?.generation, until: now + WINDOW_MS, fragments: []};
        room.followup = null; room.proactive.paused = true;
      } else if (type === 'change_topic') { this.clear(sessionId); }
      else if (type === 'continue') {
        if (!state.waiting || !sameVerifiedSender(state.waiting.sender, event.sender) || !state.waiting.fragments.length) return answer('clarify', 'continue_requires_complete_request', {addressed: true, clarification: '请在呼叫我的同时补全要回答的问题。'});
        const fragments = [...state.waiting.fragments]; room.waiting = null;
        return answer('control', 'explicit_control', {addressed: true, control: type, fragments});
      }
      const nextRequestText = type === 'change_topic' ? address.text.replace(/^(?:请)?换(?:个|一个)?话题(?:[，,。!！:：；;\s]+|$)/u, '').trim() : '';
      return answer('control', 'explicit_control', {addressed: address.addressed, control: type, proactiveOnly: quietRequest && !state.engagement, ...(nextRequestText ? {nextRequestText} : {})});
    }
    if (state.waiting) {
      if (address.addressed && address.text && !summonsBody(address.text)) { room.waiting = null; this.openEngagement(target, event, snap, now, address.text); return answer('reply', 'new_request_replaces_waiting', {addressed: true, text: address.text, supersedesWaiting: true}); }
      if (sameVerifiedSender(state.waiting.sender, event.sender)) { room.waiting.fragments.push(eventKey(event)); room.waiting.fragments = room.waiting.fragments.slice(-60); }
      return answer('ignore', 'waiting_for_complete_request');
    }
    if (address.addressed) {
      this.acknowledgeProactive(sessionId, event, now);
      if (summonsBody(address.text)) {
        const replyContext = summonsReplyContext(target, event, snap, now, this.names);
        this.openEngagement(target, event, snap, now, replyContext?.text ?? '');
        return answer('reply', 'social_summons', {addressed: true, callEvidence: address.evidence, ...(replyContext ? {replyContext} : {})});
      }
      this.openEngagement(target, event, snap, now, address.text);
      return answer('reply', 'direct_address', {addressed: true, text: address.text, callEvidence: address.evidence});
    }
    const quote = event.quote;
    if (quote?.verified === true && quote.status === 'resolved' && quote.authorIsBot === true && quote.sourceKey && directText(event.text)) {
      this.acknowledgeProactive(sessionId, event, now);
      return answer('reply', 'verified_bot_quote');
    }
    if (target.kind === 'contact' && target.mode === 'all') return answer('reply', 'explicit_private_all_mode');
    const engagement = this.engagedFollowup(target, event, snap, now);
    if (engagement) return answer('reply', 'engaged_group_followup', {engagement});
    const followup = state.followup;
    const relevant = /^(?:那|那么|所以|再|还有|第二|第一|这个|那个|为什么|怎么|如果|能否|可以|是否)/.test(directText(event.text)) && /[?？]|(?:呢|吗|一点|一下)$/.test(directText(event.text));
    if (followup && sameVerifiedSender(followup.sender, event.sender) && relevant && (followup.generation === undefined || followup.generation === snap?.generation)) return answer('reply', 'verified_member_followup');
    const clarification = state.clarification;
    if (clarification && sameVerifiedSender(clarification.sender, event.sender) && (clarification.generation === undefined || clarification.generation === snap?.generation) && directText(event.text)) {
      room.clarification = null; return answer('reply', 'verified_clarification_response');
    }
    return answer('ignore', 'background_only');
  }
  proactiveDecision(target, context, {evidence, nowMs = this.nowMs()} = {}) {
    const sessionId = roomId(target), config = target.proactive ?? {}, state = this.state(sessionId, nowMs);
    const reject = reason => ({allowed: false, reason, sessionId});
    if (target.kind !== 'group' || target.enabled !== true || target.authorized !== true || target.paused || target.mode === 'observe') return reject('target_not_authorized');
    if (config.enabled !== true || config.ownerApproved !== true) return reject('not_opted_in');
    if (!Number.isFinite(config.utcOffsetMinutes ?? 480) || Math.abs(config.utcOffsetMinutes ?? 480) > 840) return reject('invalid_timezone');
    if (state.waiting || state.proactive.paused) return reject('conversation_paused');
    if (quietNow(nowMs, config)) return reject('quiet_hours');
    if (state.proactive.awaitingResponse) return reject('awaiting_human_response');
    const snap = typeof context?.snapshot === 'function' ? context.snapshot(sessionId) : context;
    if (!snap || snap.sessionId !== sessionId || evidence?.authorized !== true || evidence.generation !== snap.generation || !['current_topic', 'approved_task'].includes(evidence.kind)) return reject('missing_topic_evidence');
    const sourceKeys = new Set(snap.messages.filter(item => item.role !== 'assistant').map(eventKey));
    if (!Array.isArray(evidence.sourceKeys) || !evidence.sourceKeys.length || !evidence.sourceKeys.every(key => sourceKeys.has(key))) return reject('topic_outside_current_context');
    if (typeof evidence.topic !== 'string' || !evidence.topic.trim()) return reject('missing_topic_evidence');
    const interval = Math.max(20 * 60 * 1000, Number(config.minIntervalMs) || 0);
    if (state.proactive.lastAt !== null && nowMs - state.proactive.lastAt < interval) return reject('cooldown');
    const day = localDay(nowMs, config.utcOffsetMinutes ?? 480);
    const limit = Math.max(0, Math.min(3, Number.isFinite(config.maxPerDay) ? config.maxPerDay : 3));
    if (state.proactive.sent.filter(item => localDay(item.at, config.utcOffsetMinutes ?? 480) === day).length >= limit) return reject('daily_limit');
    return {allowed: true, reason: 'authorized_current_topic', sessionId, generation: snap.generation, sourceKeys: [...evidence.sourceKeys], topic: evidence.topic.slice(0, 1000)};
  }
  recordProactive(sessionId, {outboxId, status, nowMs = this.nowMs()} = {}) {
    const room = this.room(sessionId);
    if (!outboxId || !['local_echo', 'confirmed', 'unknown'].includes(status) || room.proactive.sent.some(item => item.outboxId === outboxId)) return false;
    room.proactive.sent.push({outboxId, at: nowMs, status}); room.proactive.sent = room.proactive.sent.slice(-100);
    Object.assign(room.proactive, {lastAt: nowMs, lastOutboxId: outboxId, awaitingResponse: true}); return true;
  }
  exportProactive(sessionId) { return structuredClone(this.room(sessionId).proactive); }
  restoreProactive(sessionId, usage) {
    if (!usage || !Array.isArray(usage.sent)) return false;
    const sent = usage.sent.filter(item => typeof item.outboxId === 'string' && Number.isFinite(item.at) && ['local_echo', 'confirmed', 'unknown'].includes(item.status)).slice(-100);
    const last = sent.reduce((value, item) => !value || item.at > value.at ? item : value, null);
    this.room(sessionId).proactive = {sent, lastAt: last?.at ?? null, lastOutboxId: last?.outboxId ?? null,
      awaitingResponse: !!last && (last.status === 'unknown' || usage.awaitingResponse !== false), paused: usage.paused === true};
    return true;
  }
  acknowledgeProactive(sessionId, event, now = this.nowMs()) {
    const room = this.room(sessionId);
    const fresh = typeof event.receivedAt === 'number' ? event.receivedAt : Date.parse(event.receivedAt ?? event.createdAt);
    if (!room.proactive.awaitingResponse || event.role === 'assistant' || !Number.isFinite(fresh) || fresh <= room.proactive.lastAt || fresh > now) return false;
    const quoted = event.quote?.verified === true && event.quote.sourceKey === room.proactive.lastOutboxId;
    if (!quoted && !classifyAddress(event.text, this.names).addressed) return false;
    room.proactive.awaitingResponse = false; return true;
  }
  resumeProactive(sessionId, {ownerApproved = false} = {}) { if (!ownerApproved) return false; this.room(sessionId).proactive.paused = false; return true; }
}
