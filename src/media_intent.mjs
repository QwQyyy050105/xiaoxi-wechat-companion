// Classify only the current utterance. This grants no media capability and
// does not resolve an attachment, choose a recipient or perform any action.
function unquoted(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/g, ' ');
}

const NEGATIVE = '(?:不要|不用|不必|无需|不需要|不想|不打算|不让|不准|禁止|不能|别|没(?:有)?(?:让|叫|要求)|不是(?:让|要)|并非(?:让|要)|停止|取消)';
const FILLER = '(?:再|总是|总|一直|老是|继续|现在|马上|给我|帮我|替我|让我|让你|叫你|要你|要求你|你|我|去|也|又|非要|把|将|\\s)*';
const negativeImage = new RegExp(NEGATIVE + FILLER + '(?:看|瞅|分析|识别|解释|描述)(?:一下|一眼|看|瞅)?', 'u');
const negativeInput = new RegExp(NEGATIVE + FILLER + '(?:听|转写|转成文字|识别)(?:一下|一听|听)?', 'u');
const negativeOutput = new RegExp(NEGATIVE + FILLER + '(?:(?:用|发|来|通过)(?:一条|一个|个)?(?:语音|音频)|语音回|朗读|念|读|说给)', 'u');

const imageCue = /(?:这|那)(?:一)?张(?:图(?:片)?|照片)|(?:图片|照片|图)(?:里(?:面)?|上|中)|(?:看(?:一下|一眼|看)?|瞅(?:一眼|瞅)?|分析(?:一下)?|识别(?:一下)?|读(?:一下)?|解释(?:一下)?|描述(?:一下)?)(?:这|那|刚才|刚发的|一下|一眼|一张|张|下|个|的|\s)*(?:图(?:片)?|照片)/u;
const inputCue = /(?:这|那)(?:一)?段(?:语音|录音)|(?:刚才|刚发的)(?:语音|录音)|(?:语音|录音)(?:里(?:面)?|中|说(?:了|的)|讲(?:了|的)|内容)|(?:听(?:一下|一听|听)?|转写|转成文字|识别)(?:这|那|刚才|刚发的|一下|一段|段|下|的|\s)*(?:语音|录音)/u;
const outputCue = /(?:用|发|来|通过)(?:一条|一个|个)?(?:语音|音频)|(?:说|念|读)给(?:我|大家|我们|他|她|它|你)?听|朗读(?:一下)?|念出来|读出来/u;
const bareListen = /^(?:(?:请|你|帮我|麻烦你|可以|能不能|能否|能|想|我想|我想让你|给我)\s*)*听(?:一下|一听|听)[吧呀啊哦\s]*$/u;
const directVoiceReply = /^(?:(?:请|你|帮我|麻烦你|可以|能不能|能否|能|给我)\s*)*语音回(?:复|答)?/u;

function isMention(clause) {
  if (/^(?:别人|有人|他|她|他们|她们|群友|朋友|同学)(?:刚才|之前|昨天|曾经)?(?:说|提到|问|觉得|让我|叫我|要求我)/u.test(clause)) return true;
  if (/^(?:你|我)(?:刚才|之前|昨天|刚刚|曾经)(?:说|提到|问)/u.test(clause)) return true;
  if (/(?:只是|是在|用来|拿来|仅仅是).{0,6}(?:举例|引用|转述)/u.test(clause)) return true;
  if (/(?:看图|语音回复|转写|语音)(?:的|这个|这个词的)?(?:功能|能力|接口|说法|含义)/u.test(clause)) return true;
  if (/(?:别|不要|不用).{0,6}(?:总说|总提|一直说|老说|强调|复述)/u.test(clause)) return true;
  if (/^(?:我|我们)(?:刚才|之前|昨天|已经|正在|在|刚刚|今天).*(?:看图|图片|照片|语音|录音)/u.test(clause) && !/(?:请你|帮我|让你|叫你|要你)/u.test(clause)) return true;
  return false;
}

export function classifyMediaRequest(text) {
  const result = {image: false, voiceInput: false, voiceOutput: false};
  // Alternatives such as 能不能 are questions, not a negation of the request.
  // Negation belongs to its own clause, never every request in the utterance.
  const clauses = unquoted(text).split(/[，,。.!！?？；;\n]+|但是|不过|而是|而且|但/u);
  for (const raw of clauses) {
    const clause = raw.trim().replace(/^(?:(?:嘿|嗨|你好|请问|麻烦)\s*)?(?:小汐|@?Example Account)[呀啊哇呐\s]*/u, '')
      .replace(/能不能|可不可以|会不会|要不要|想不想/gu, '可以').trim();
    if (!clause || isMention(clause)) continue;
    const image = imageCue.test(clause) && !negativeImage.test(clause);
    const voiceInput = (inputCue.test(clause) || bareListen.test(clause)) && !negativeInput.test(clause);
    // "听一下语音回复" is an incoming message, not an output instruction.
    const voiceOutput = (outputCue.test(clause) || directVoiceReply.test(clause)) && !negativeOutput.test(clause);
    result.image ||= image;
    result.voiceInput ||= voiceInput;
    result.voiceOutput ||= voiceOutput;
  }
  return result;
}
