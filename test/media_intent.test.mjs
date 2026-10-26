import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyMediaRequest} from '../src/media_intent.mjs';

const NONE = {image: false, voiceInput: false, voiceOutput: false};
const IMAGE = {...NONE, image: true};
const INPUT = {...NONE, voiceInput: true};
const OUTPUT = {...NONE, voiceOutput: true};

test('direct image requests cover demonstratives, pictures and photos', () => {
  for (const text of ['小汐，看看这张图', '看图', '这张图是真的吗', '图片里写的是什么', '照片里有几个人', '帮我分析一下照片', '图上这个字怎么念']) {
    assert.deepEqual(classifyMediaRequest(text), IMAGE, text);
  }
});

test('incoming voice requests remain separate from outgoing voice', () => {
  for (const text of ['小汐，语音说了什么', '听一下', '你听一下', '这段语音是什么意思', '帮我听一下语音', '听一下语音回复', '录音里的内容是什么']) {
    assert.deepEqual(classifyMediaRequest(text), INPUT, text);
  }
});

test('outgoing voice requests are recognized without implying audio is available', () => {
  for (const text of ['用语音回复', '小汐，语音回我', '说给我听', '念给大家听', '读给我听', '请朗读一下', '发一条语音', '用语音说“早安”']) {
    assert.deepEqual(classifyMediaRequest(text), OUTPUT, text);
  }
});

test('negated or denied media actions do not hijack ordinary conversation', () => {
  for (const text of ['别用语音了，用文字', '我又没让你看图', '我没有叫你听语音', '不是让你看图', '不要发语音', '不需要你分析这张图', '这张图不用看', '这段语音不用听', '别总说这张图看不到', '不要一直说这段语音听不到']) {
    assert.deepEqual(classifyMediaRequest(text), NONE, text);
  }
});

test('reported, quoted and code-only mentions are not media requests', () => {
  for (const text of ['别人说“这段语音”，我是在举例', '别人说‘这段语音’，我是在举例', '别人说这段语音很短', '别人说：这段语音很短', '他说：看图', '她刚才问这张图是什么', '你刚才说可以看图', '我正在看图', '我今天用语音聊天了', '解释一下“用语音回复”是什么意思', '小汐，“看看这张图”', '`看图`', '```text\n用语音回复\n```', '> 这张图是什么']) {
    assert.deepEqual(classifyMediaRequest(text), NONE, text);
  }
});

test('discussing a capability is not a request to process media', () => {
  for (const text of ['看图功能还没做好吗', '语音回复的能力是什么', '转写接口怎么接', '解释一下语音这个词的含义']) {
    assert.deepEqual(classifyMediaRequest(text), NONE, text);
  }
});

test('a negation in one clause does not erase a real image request in another', () => {
  for (const text of ['别长篇解释，看看这张图', '不要听语音，看看照片里有什么', '别总说这张图看不到，看看这张图', '别长篇解释但看看这张图']) {
    assert.deepEqual(classifyMediaRequest(text), IMAGE, text);
  }
});

test('local negation applies to the relevant modality instead of every cue', () => {
  assert.deepEqual(classifyMediaRequest('别用语音回复这张图'), IMAGE);
  assert.deepEqual(classifyMediaRequest('不要看图，听一下语音'), INPUT);
  assert.deepEqual(classifyMediaRequest('不用看图，而是用语音说早安'), OUTPUT);
  assert.deepEqual(classifyMediaRequest('不要听这段语音，请用语音回复'), OUTPUT);
});

test('quoted negative text does not cancel an actual direct media request', () => {
  assert.deepEqual(classifyMediaRequest('他说“别用语音”，但请用语音回复'), OUTPUT);
  assert.deepEqual(classifyMediaRequest('“我又没让你看图”只是例句，请看看这张图'), IMAGE);
});

test('question-form alternatives are not mistaken for prohibitions', () => {
  assert.deepEqual(classifyMediaRequest('小汐能不能看图'), IMAGE);
  assert.deepEqual(classifyMediaRequest('可不可以用语音回复'), OUTPUT);
  assert.deepEqual(classifyMediaRequest('要不要听一下语音'), INPUT);
});

test('one explicit request may need image input and voice output independently', () => {
  assert.deepEqual(classifyMediaRequest('帮我看看这张图，用语音说给我听'), {...IMAGE, voiceOutput: true});
  assert.deepEqual(classifyMediaRequest('听一下这段语音，然后用语音回复'), {...INPUT, voiceOutput: true});
});

test('ordinary conversation and empty input do not enable media', () => {
  for (const text of ['', null, undefined, '今天好累', '小汐在吗', '我想听一下你的想法', '谢谢你小汐']) {
    assert.deepEqual(classifyMediaRequest(text), NONE, String(text));
  }
});
