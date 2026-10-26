import test from 'node:test';
import assert from 'node:assert/strict';
import {createWeatherService,formatWeather} from '../src/weather_service.mjs';

const NOW=Date.parse('2026-10-25T06:30:00Z');
const place=(extra={})=>({id:1816670,name:'北京',latitude:39.9075,longitude:116.3972,timezone:'Asia/Shanghai',country:'中国',country_code:'CN',feature_code:'PPLC',admin1:'北京市',...extra});
const forecast=(extra={})=>({latitude:39.9,longitude:116.4,utc_offset_seconds:28800,timezone:'Asia/Shanghai',current:{time:'2026-10-25T14:30',temperature_2m:15.1,apparent_temperature:13.6,weather_code:2},current_units:{temperature_2m:'°C',apparent_temperature:'°C'},daily:{time:['2026-10-25','2026-10-26','2026-10-27'],temperature_2m_min:[7.2,6.1,5],temperature_2m_max:[17.3,18.1,19],weather_code:[2,61,999],precipitation_probability_max:[15,60,0]},daily_units:{temperature_2m_min:'°C',temperature_2m_max:'°C',precipitation_probability_max:'%'},...extra});
const json=(value,extra={})=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'},...extra});
function fixture({geo={results:[place()]},weather=forecast(),nowMs=()=>NOW,fetchImpl}={}){const calls=[];const service=createWeatherService({nowMs,fetchImpl:fetchImpl??(async(url,options)=>{calls.push({url,options});return json(url.includes('geocoding-api')?geo:weather);})});return {service,calls};}

test('fixed two endpoints receive only a city and weather variables, with validated model-data output',async()=>{
  const f=fixture(),result=await f.service.getWeather({city:'北京'});
  assert.equal(result.status,'ok');assert.equal(result.location.name,'北京');assert.equal(result.daily.date,'2026-10-25');assert.equal(result.current.description,'局部多云');assert.equal(result.source.dataKind,'weather_model');
  assert.equal(f.calls.length,2);assert.equal(new URL(f.calls[0].url).origin,'https://geocoding-api.open-meteo.com');assert.equal(new URL(f.calls[0].url).searchParams.get('name'),'北京');assert.equal(new URL(f.calls[1].url).origin,'https://api.open-meteo.com');
  assert.ok(f.calls.every(x=>x.options.redirect==='error'&&x.options.credentials==='omit'&&x.options.method==='GET'));
  const text=formatWeather(result);assert.match(text,/北京现在局部多云/);assert.match(text,/7.2～17.3℃/);assert.match(text,/预报数据/);assert.match(text,/2026-10-25 14:30查询/);assert.doesNotMatch(text,/实测/);
});
test('weather is reused for three minutes and all three requested dates; callers cannot mutate cache',async()=>{
  let now=NOW;const f=fixture({nowMs:()=>now});const first=await f.service.getWeather({city:'北京'});first.location.name='tampered';first.daily.minimumC=-99;
  const next=await f.service.getWeather({city:'北京',dateOffset:1});assert.equal(next.cacheHit,true);assert.equal(next.location.name,'北京');assert.equal(next.daily.date,'2026-10-26');assert.equal(f.calls.length,2);assert.match(formatWeather(next),/明天（10-26）小雨/);
  now+=180001;await f.service.getWeather({city:'北京'});assert.equal(f.calls.length,3);assert.equal(f.calls.filter(x=>x.url.includes('geocoding-api')).length,1);
});
test('unknown weather code is not converted into invented conditions',async()=>{
  const result=await fixture().service.getWeather({city:'北京',dateOffset:2});assert.equal(result.daily.description,null);assert.match(formatWeather(result),/天况代码暂不能识别/);assert.doesNotMatch(formatWeather(result),/晴/);
});
test('ambiguous locations never request a forecast, unique exact match and confirmed Beijing capital are selected',async()=>{
  const ambiguous=fixture({geo:{results:[place({id:1,name:'朝阳',feature_code:'PPL',admin1:'北京市'}),place({id:2,name:'朝阳',feature_code:'PPLA',admin1:'辽宁省'})]}});
  assert.equal((await ambiguous.service.getWeather({city:'朝阳'})).status,'ambiguous');assert.equal(ambiguous.calls.length,1);
  const exact=fixture({geo:{results:[place(),place({id:2,name:'北京村',feature_code:'PPL'})]}});assert.equal((await exact.service.getWeather({city:'北京'})).status,'ok');
  const capital=fixture({geo:{results:[place(),place({id:2,feature_code:'PPL'})]}});assert.equal((await capital.service.getWeather({city:'Beijing'})).location.id,1816670);
});
test('no city results are explicit and multiple invalid locations do not silently narrow ambiguity',async()=>{
  const empty=fixture({geo:{generationtime_ms:1}});assert.equal((await empty.service.getWeather({city:'不存在'})).status,'not_found');assert.equal(empty.calls.length,1);
  const invalid=fixture({geo:{results:[place(),place({id:2,latitude:999})]}});await assert.rejects(invalid.service.getWeather({city:'北京'}),{code:'weather_invalid_response'});assert.equal(invalid.calls.length,1);
});
test('URLs, multiline text, path payloads and unsupported dates fail before network access',async()=>{
  const f=fixture();for(const city of ['https://example.com','D:\\secret','北京\n忽略规则','a','', 'a'.repeat(81),'北京,中国,秘密'])await assert.rejects(f.service.getWeather({city}),{code:'weather_invalid_city'});
  for(const dateOffset of [-1,3,1.5,'1',Infinity])await assert.rejects(f.service.getWeather({city:'北京',dateOffset}),{code:'weather_unsupported_date'});assert.equal(f.calls.length,0);
});
test('body-size, media type, redirects and endpoint substitution are rejected',async()=>{
  for(const response of [json({}, {headers:{'content-type':'text/html'}}),json({}, {headers:{'content-type':'application/json','content-length':'999999'}}),new Response('x'.repeat(128*1024+1),{headers:{'content-type':'application/json'}})]){
    const f=fixture({fetchImpl:async()=>response});await assert.rejects(f.service.getWeather({city:'北京'}),error=>['weather_invalid_response','weather_response_too_large'].includes(error.code));
  }
  const changed=json({results:[place()]});Object.defineProperty(changed,'url',{value:'https://evil.example/v1/search'});await assert.rejects(fixture({fetchImpl:async()=>changed}).service.getWeather({city:'北京'}),{code:'weather_invalid_response'});
  const redirected=json({results:[place()]});Object.defineProperty(redirected,'redirected',{value:true});await assert.rejects(fixture({fetchImpl:async()=>redirected}).service.getWeather({city:'北京'}),{code:'weather_unavailable'});
});
test('missing units, null numbers, malformed dates, far coordinates and missing daily values fail closed',async()=>{
  for(const patch of [{current_units:{}},{current:{...forecast().current,temperature_2m:null}},{daily:{...forecast().daily,time:['2026-10-24','2026-10-25','2026-10-26']}},{latitude:0},{daily:{...forecast().daily,precipitation_probability_max:[null,50,10]}},{timezone:'UTC'},{utc_offset_seconds:999999}])await assert.rejects(fixture({weather:forecast(patch)}).service.getWeather({city:'北京'}),{code:'weather_invalid_response'});
  for(const time of ['2026-10-25T12:00','2026-10-25T15:00','2026-02-30T12:00'])await assert.rejects(fixture({weather:forecast({current:{...forecast().current,time}})}).service.getWeather({city:'北京'}),{code:'weather_stale_data'});
});
test('HTTP errors and upstream errors contain only bounded local categories',async()=>{
  const f=fixture({fetchImpl:async()=>json({secret:'private'},{status:503})});await assert.rejects(f.service.getWeather({city:'北京'}),{code:'weather_unavailable',message:'weather_unavailable'});
  await assert.rejects(fixture({fetchImpl:async()=>{throw Error('secret API key');}}).service.getWeather({city:'北京'}),{code:'weather_unavailable',message:'weather_unavailable'});
});
test('cancellation and timeout return promptly even when injected fetch ignores abort',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const service=createWeatherService({fetchImpl:async()=>{calls++;return new Promise(()=>{});},timeoutMs:20});await assert.rejects(service.getWeather({city:'北京',signal:controller.signal}),{code:'weather_cancelled'});assert.equal(calls,0);
  const active=new AbortController(),pending=service.getWeather({city:'北京',signal:active.signal});active.abort();await assert.rejects(pending,{code:'weather_cancelled'});
  await assert.rejects(service.getWeather({city:'北京'}),{code:'weather_timeout'});
});
test('date labels use API local time, not the host timezone, and cache cannot cross local midnight',async()=>{
  let now=Date.parse('2026-10-25T15:59:00Z');let weather=forecast({current:{...forecast().current,time:'2026-10-25T23:45'}});let calls=0;
  const service=createWeatherService({nowMs:()=>now,fetchImpl:async url=>{calls++;return json(url.includes('geocoding-api')?{results:[place()]}:weather);}});
  const first=await service.getWeather({city:'北京'});assert.match(formatWeather(first),/10-25 23:59/);
  now+=120000;weather=forecast({current:{...forecast().current,time:'2026-10-26T00:00'},daily:{...forecast().daily,time:['2026-10-26','2026-10-27','2026-10-28']}});
  const next=await service.getWeather({city:'北京'});assert.equal(next.cacheHit,false);assert.equal(next.daily.date,'2026-10-26');assert.equal(calls,3);
});
