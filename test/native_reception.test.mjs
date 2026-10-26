import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {MessageGate} from '../src/message_gate.mjs';

const root=path.resolve('.');
const text=(id,value)=>({id:String(id),text:value,klass:'mmui::ChatTextItemView'});
const voice=(id,value)=>({id:String(id),text:'语音3"秒'+value,klass:'mmui::ChatVoiceItemView'});
function nativeFrames(frames){
  const code=`import sys,json\nsys.path.insert(0,'scripts')\nfrom native_message_tracker import NativeMessageTracker\nt=NativeMessageTracker()\nprint(json.dumps([t.observe('abao','same',frame['rows'],frame.get('count',0))[0] for frame in json.load(sys.stdin)],ensure_ascii=False))`;
  const result=spawnSync(process.env.XIAOXI_TEST_PYTHON||'python',['-B','-c',code],{
    cwd:root,input:JSON.stringify(frames),encoding:'utf8',windowsHide:true,
    env:{...process.env,PYTHONIOENCODING:'utf-8',TEMP:path.join(root,'temp'),TMP:path.join(root,'temp')},timeout:10000});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
const snap=messages=>({pid:20,created:100,hwnd:123,messages});

test('actual native tracker plus live gate retains image request across unread jump and delayed voice conversion',{skip:!process.env.XIAOXI_TEST_PYTHON?'Python not installed; native tracker integration unavailable':false},()=>{
  const frames=nativeFrames([
    {rows:[text(1,'old visible anchor')]},
    {rows:[text(20,'unseen history'),text(21,'小汐，看看刚才的图片是什么'),voice(22,'未播放')],count:2},
    {rows:[text(20,'unseen history'),text(21,'小汐，看看刚才的图片是什么'),voice(22,'小汐，晚上好')]},
    {rows:[text(20,'unseen history'),text(21,'小汐，看看刚才的图片是什么'),voice(22,'小汐，晚上好')]}
  ]);
  const gate=new MessageGate(),target={id:'group_abao'};
  assert.equal(gate.observe(target,snap(frames[0])).baseline,true);
  const incoming=gate.observe(target,snap(frames[1]));assert.equal(incoming.gap,undefined);
  assert.deepEqual(incoming.messages.map(row=>row.text),['小汐，看看刚才的图片是什么','语音3"秒未播放']);
  const converted=gate.observe(target,snap(frames[2]));assert.equal(converted.gap,undefined);
  assert.equal(converted.messages.length,1);assert.equal(converted.messages[0].text,'小汐，晚上好');
  assert.equal(converted.messages[0].inputModality.kind,'platform_transcript');
  assert.deepEqual(gate.observe(target,snap(frames[3])).messages,[]);
});

test('widget recycling with retained content anchor does not lose or duplicate a new question',{skip:!process.env.XIAOXI_TEST_PYTHON?'Python not installed; native tracker integration unavailable':false},()=>{
  const frames=nativeFrames([
    {rows:[text(1,'first'),text(2,'last old')]},
    {rows:[text(10,'first'),text(11,'last old'),text(12,'小汐这是什么图')],count:1},
    {rows:[text(10,'first'),text(11,'last old'),text(12,'小汐这是什么图')]}
  ]);
  const gate=new MessageGate(),target={id:'group_abao'};gate.observe(target,snap(frames[0]));
  assert.deepEqual(gate.observe(target,snap(frames[1])).messages.map(row=>row.text),['小汐这是什么图']);
  assert.deepEqual(gate.observe(target,snap(frames[2])).messages,[]);
});

test('voice widget replacement after platform conversion is delivered with its prior live identity once',{skip:!process.env.XIAOXI_TEST_PYTHON?'Python not installed; native tracker integration unavailable':false},()=>{
  const frames=nativeFrames([
    {rows:[text(1,'unique lead-in')]},
    {rows:[text(1,'unique lead-in'),voice(2,'未播放')]},
    {rows:[text(10,'unique lead-in'),voice(20,'小汐，晚上好')]},
    {rows:[text(10,'unique lead-in'),voice(20,'小汐，晚上好')]}
  ]);
  const gate=new MessageGate(),target={id:'group_abao'};gate.observe(target,snap(frames[0]));gate.observe(target,snap(frames[1]));
  const result=gate.observe(target,snap(frames[2]));assert.equal(result.gap,undefined);
  assert.deepEqual(result.messages.map(row=>row.text),['小汐，晚上好']);
  assert.deepEqual(gate.observe(target,snap(frames[3])).messages,[]);
});
