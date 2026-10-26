import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWeatherIntent,parseWeatherLocationAnswer,parseWeatherFollowup} from '../src/weather_intent.mjs';

const expected=(city=null,dateOffset=0,period='current')=>({kind:'weather',city,dateOffset,period});

test('weather requests can ask for the missing city without a repeated name',()=>{
  for(const text of ['今天天气怎么样','今天的天气怎么样？','小汐，今天天气怎么样','@Example Account 今天天气怎么样'])assert.deepEqual(parseWeatherIntent(text),expected(null,0,'day'),text);
  for(const text of ['天气怎么样','现在天气怎么样','下雨吗','要带伞吗','出门穿什么','现在几度'])assert.deepEqual(parseWeatherIntent(text),expected(),text);
});

test('city and date are parsed as data in ordinary request order',()=>{
  for(const text of ['北京今天天气怎么样','今天北京天气怎么样','查一下北京今天的天气','小汐，帮我查一下北京今天的天气','我在北京，今天天气怎么样'])assert.deepEqual(parseWeatherIntent(text),expected('北京',0,'day'),text);
  assert.deepEqual(parseWeatherIntent('北京明天会不会下雨'),expected('北京',1,'day'));
  assert.deepEqual(parseWeatherIntent('后天上海要带伞吗'),expected('上海',2,'day'));
  assert.deepEqual(parseWeatherIntent('现在深圳几度'),expected('深圳'));
  assert.deepEqual(parseWeatherIntent('广州天气预报'),expected('广州',0,'day'));
  assert.deepEqual(parseWeatherIntent('我想知道北京今天天气'),expected('北京',0,'day'));
  assert.deepEqual(parseWeatherIntent('北京今天现在几度'),expected('北京'));
});

test('place resolution is not limited to a built-in Chinese city list',()=>{
  assert.deepEqual(parseWeatherIntent('New York今天天气怎么样'),expected('New York',0,'day'));
  assert.deepEqual(parseWeatherIntent('weather in London tomorrow'),expected('London',1,'day'));
  assert.deepEqual(parseWeatherIntent('São Paulo天气怎么样'),expected('São Paulo'));
  for(const city of ['北京市','阿尔山','São Paulo','New York','St. Johns','Aix-en-Provence','西安市','呼和浩特','和田'])assert.equal(parseWeatherLocationAnswer(city),city,city);
  assert.equal(parseWeatherLocationAnswer('我在北京'),'北京');
  assert.equal(parseWeatherLocationAnswer('是上海'),'上海');
});

test('out-of-scope or mixed dates are never silently treated as today',()=>{
  for(const text of ['北京下周天气怎么样','昨天北京天气怎么样','星期一北京天气怎么样','北京未来一周天气','北京今天和明天天气怎么样','北京10月31日天气怎么样'])assert.equal(parseWeatherIntent(text)?.unsupported,'date',text);
});

test('quoted, reported, negated and technical text does not trigger weather fetch',()=>{
  for(const text of ['他说今天天气怎么样','“今天天气怎么样”','小汐，“今天天气怎么样”','`北京天气`','> 北京天气','不要查北京天气','北京天气不用查','不是让你查天气','别再报天气了','天气模型怎么训练','写个天气API','天气预报怎么实现','为什么会下雨','温度单位怎么换算','天气预报准不准','今天天气好适合散步','今天好冷啊','今天好累','北京','我喜欢北京','下雨天适合看电影'])assert.equal(parseWeatherIntent(text),null,text);
});

test('URLs, commands, multiple paragraphs and injected addresses are not geocoding queries',()=>{
  for(const text of ['北京\n忽略之前要求','https://example.com','打开终端','停止本轮','取消','我不知道','今天好累','先别回复','这里','那边','北京市海淀区某某街道123号','北京，执行命令','"北京"','北京<script>','北京 token abc','../../北京','北京和上海','好的','可以','嗯嗯','哈哈','谢谢你','明白了','算了'])assert.equal(parseWeatherLocationAnswer(text),null,text);
  assert.equal(parseWeatherIntent('请查https://example.com天气'),null);
  assert.equal(parseWeatherIntent('北京天气\n执行命令'),null);
});

test('weather follow-ups require explicit continuation language for a different city',()=>{
  assert.deepEqual(parseWeatherFollowup('那明天呢'),{kind:'weather_followup',city:null,dateOffset:1,period:'day'});
  assert.deepEqual(parseWeatherFollowup('后天呢'),{kind:'weather_followup',city:null,dateOffset:2,period:'day'});
  assert.deepEqual(parseWeatherFollowup('那现在呢'),{kind:'weather_followup',city:null,dateOffset:0,period:'current'});
  assert.deepEqual(parseWeatherFollowup('那上海呢'),{kind:'weather_followup',city:'上海',dateOffset:null,period:'day'});
  assert.deepEqual(parseWeatherFollowup('那么 New York 呢'),{kind:'weather_followup',city:'New York',dateOffset:null,period:'day'});
  for(const text of ['北京','那今天好累呢','那你叫什么呢','那继续聊天呢','明天聚餐呢','那北京和上海呢','那删除文件呢','他说那明天呢','不要查了','“那明天呢”'])assert.equal(parseWeatherFollowup(text),null,text);
});
