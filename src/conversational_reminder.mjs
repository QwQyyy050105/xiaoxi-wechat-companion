// Parse only the scheduling part of a direct reminder, in the chat's Beijing time.
const numberText = '[0-9零一二两三四五六七八九十]+';
const duration = new RegExp('^(' + numberText + '|半)(分钟|小时)(?:之|以)?后');
const clock = new RegExp('^(?:(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)\\s*)?(?:(\\d{1,2})[:：](\\d{2})|(' + numberText + ')[点时](半|一刻|三刻|(?:' + numberText + ')分)?)(?![0-9:：点时刻分]|过|差)');
const days = /^(今天|明天|后天|今晚|明晚|今早|明早|下(?:周|星期)[一二三四五六日天])/u;
const offsetMs = 8 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const digits = '零一二三四五六七八九';

function numberOf(raw) {
  if (/^\d+$/u.test(raw)) return Number(raw);
  const word = raw.replaceAll('两', '二');
  if (word === '十') return 10;
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(word);
  if (tens) return (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0);
  return word.length === 1 && digits.includes(word) ? digits.indexOf(word) : NaN;
}

function hourOf(hour, period) {
  if (!period) return hour;
  if (hour >= 13 && hour <= 23 && ['下午', '傍晚', '晚上'].includes(period)) return hour;
  if (hour < 1 || hour > 12) return NaN;
  if (period === '中午') return hour === 11 || hour === 12 ? hour : hour <= 2 ? hour + 12 : NaN;
  if (['下午', '傍晚', '晚上'].includes(period)) return hour === 12 ? (period === '下午' ? 12 : NaN) : hour + 12;
  return hour === 12 ? (period === '凌晨' ? 0 : NaN) : hour;
}

function readTime(input, now) {
  const delta = duration.exec(input);
  if (delta) {
    const count = delta[1] === '半' ? 0.5 : numberOf(delta[1]);
    if (!Number.isFinite(count) || count <= 0 || count > 10080) return null;
    return {ms:now + count * (delta[2] === '小时' ? 3600000 : 60000), length:delta[0].length};
  }
  const day = days.exec(input);
  if (!day) return null;
  const today = new Date(now + offsetMs);
  const date = day[0];
  let shift = date.startsWith('明') ? 1 : date === '后天' ? 2 : 0;
  if (date.startsWith('下')) {
    const weekday = '一二三四五六日'.indexOf(date.at(-1).replace('天','日'));
    shift = 7 - (today.getUTCDay() + 6) % 7 + weekday;
  }
  const tail = input.slice(date.length);
  const match = clock.exec(tail.trimStart());
  if (!match) return null;
  const [,givenPeriod,h24,m24,spoken,fraction] = match;
  const implied = date.endsWith('晚') ? '晚上' : date.endsWith('早') ? '早上' : '';
  if (implied && givenPeriod && givenPeriod !== implied) return null;
  const period = givenPeriod || implied;
  const hour = hourOf(numberOf(h24 || spoken), period);
  let minute = Number(m24 || 0);
  if (fraction) minute = ({半:30,一刻:15,三刻:45})[fraction] ?? numberOf(fraction.slice(0,-1));
  if (spoken && !period && hour >= 1 && hour <= 12) return {ambiguous:true};
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const ms = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + shift, hour, minute) - offsetMs;
  return {ms, length:date.length + tail.length - tail.trimStart().length + match[0].length};
}

export function completeReminderTime(draft, answer, anchor) {
  const value = answer.trim().replace(/[。！!]$/u, '').trim();
  if (value.length > 20 || clock.exec(value)?.[0] !== value) return null;
  const result = conversationalReminder(draft.day + value + '提醒我' + draft.text, anchor, 'Asia/Shanghai');
  return result?.type === 'reminder' ? result : null;
}

export function conversationalReminder(body, now, timeZone) {
  if (timeZone !== 'Asia/Shanghai' || !body.includes('提醒')) return null;
  const after = /^(?:请|麻烦)?提醒(?:我|大家|本群)?[，,：:\s]*/u.exec(body);
  const parts = after ? null : /^(?:在)?(.{1,36}?)[，,\s]*提醒(?:我|大家|本群)?[，,：:\s]*(.+)$/u.exec(body);
  if (!after && !parts) return null;
  const input = after ? body.slice(after[0].length) : parts[1].trim();
  const time = readTime(input,new Date(now).getTime());
  const dateWord = days.exec(input)?.[0];
  const pendingText = parts?.[2]?.trim();
  const draft = dateWord && pendingText ? {day:dateWord, text:pendingText} : null;
  if (!time) {
    if (days.test(input) || duration.test(input)) {
      return {type:'clarify',code:'explicit_datetime_required',draft,
        message:draft ? `${dateWord}几点提醒你${pendingText}？` : '想定在几点？可以把时间和要做的事一起告诉我'};
    }
    return null;
  }
  if (time.ambiguous) return {type:'clarify',code:'ambiguous_hour',draft,message:'是上午还是下午？告诉我具体几点就好'};
  if (!after && time.length !== input.length) return null;
  const text = (after ? input.slice(time.length) : parts[2]).replace(/^[，,：:\s]+/u,'').trim();
  if (after && /^(?:左右|前后|以前|之前|之后|以后|半|一刻|三刻|[~～—-]|(?:到|至|还是)\s*(?:\d|[一二两三四五六七八九十]))/u.test(text)) {
    return {type:'clarify',code:'explicit_datetime_required',message:'到哪个具体时间提醒你？'};
  }
  if (!text) return {type:'clarify',code:'missing_content',message:'到时候要提醒你做什么？'};
  if (!Number.isFinite(time.ms) || time.ms <= new Date(now).getTime()) return {type:'clarify',code:'time_not_future',message:'这个时间已经过了，想改到什么时候？'};
  const dueAt = new Date(time.ms + offsetMs).toISOString().slice(0,19) + '+08:00';
  return {type:'reminder',text,dueAt,timeZone};
}
