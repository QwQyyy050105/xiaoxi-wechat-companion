// Read-only weather model data. No chat history, identity, credential or model call.
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const DOCS_URL = 'https://open-meteo.com/en/docs';
const GEO_TTL_MS = 10 * 60 * 1000, WEATHER_TTL_MS = 3 * 60 * 1000;
const BODY_LIMIT = 128 * 1024, CACHE_LIMIT = 128;
const DAY_MS = 86400000;
const CODES = Object.freeze({0:'晴',1:'大部晴朗',2:'局部多云',3:'阴',45:'雾',48:'雾凇',51:'小毛毛雨',53:'中等毛毛雨',55:'密集毛毛雨',56:'轻微冻毛毛雨',57:'较强冻毛毛雨',61:'小雨',63:'中雨',65:'大雨',66:'轻微冻雨',67:'强冻雨',71:'小雪',73:'中雪',75:'大雪',77:'雪粒',80:'小阵雨',81:'中等阵雨',82:'强阵雨',85:'小阵雪',86:'强阵雪',95:'雷暴',96:'雷暴伴小冰雹',97:'强雷暴',99:'雷暴伴大冰雹'});

function fail(code) { const error = new Error(code); error.code = code; return error; }
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f<>]/u.test(value);
const normalized = value => value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/gu,' ').trim();
const weatherDescription = code => CODES[code] ?? null;
function validZone(value) { try { return typeof value === 'string' && value.length <= 80 && !!new Intl.DateTimeFormat('en',{timeZone:value}); } catch { return false; } }
function localDate(at, offset) { return new Date(at + offset * 1000).toISOString().slice(0,10); }
function localMinute(at, offset) { return new Date(at + offset * 1000).toISOString().slice(0,16); }
function dateAtOffset(today, offset) { return new Date(Date.parse(today+'T00:00:00Z') + offset * DAY_MS).toISOString().slice(0,10); }
function checkStopped(signal) { if (signal.aborted) throw fail(signal.reason === 'weather_timeout' ? 'weather_timeout' : 'weather_cancelled'); }
function checkedCity(city) {
  if (typeof city !== 'string'||/[\u0000-\u001f\u007f\u2028\u2029]/u.test(city)) throw fail('weather_invalid_city');
  const value=city.normalize('NFKC').trim().replace(/\s+/gu,' ');
  // Short place names only. No URL, path, query fragment or multiline payload.
  if (value.length < 2 || value.length > 80 || !/^[\p{L}\p{M} .’'·,-]+$/u.test(value) || (value.match(/,/g)||[]).length>1 || !value.split(',').every(part=>part.trim().length>=2)) throw fail('weather_invalid_city');
  return value;
}
function cacheGet(cache,key,now) { const item=cache.get(key); if(!item)return null; if(now>=item.until){cache.delete(key);return null;} return structuredClone(item.value); }
function cachePut(cache,key,value,until) { cache.delete(key);cache.set(key,{value:structuredClone(value),until});while(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value); }

async function fetchJson(fetchImpl,url,signal) {
  checkStopped(signal);
  const response=await fetchImpl(url,{method:'GET',redirect:'error',credentials:'omit',headers:{Accept:'application/json'},signal});
  checkStopped(signal);
  if(!response?.ok||response.redirected===true)throw fail('weather_unavailable');
  if(response.url){const final=new URL(response.url);if(final.origin!==new URL(url).origin||final.pathname!==new URL(url).pathname)throw fail('weather_invalid_response');}
  const type=response.headers?.get('content-type')??'';
  if(!/^application\/json(?:\s*;|$)/i.test(type))throw fail('weather_invalid_response');
  const announced=response.headers?.get('content-length');
  if(announced!==null&&announced!==undefined&&(!/^\d+$/.test(announced)||Number(announced)>BODY_LIMIT))throw fail('weather_response_too_large');
  if(!response.body?.getReader)throw fail('weather_invalid_response');
  const reader=response.body.getReader();let length=0;const chunks=[];
  try {
    while(true){const {value,done}=await reader.read();checkStopped(signal);if(done)break;if(!(value instanceof Uint8Array))throw fail('weather_invalid_response');length+=value.byteLength;if(length>BODY_LIMIT)throw fail('weather_response_too_large');chunks.push(value);}
  } finally { await reader.cancel().catch(()=>{}); }
  checkStopped(signal);
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('weather_invalid_response');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.error===true)throw fail('weather_invalid_response');
  return parsed;
}
function parseLocation(item) {
  if(!item||!Number.isSafeInteger(item.id)||item.id<=0||!safeName(item.name)||!finite(item.latitude,-90,90)||!finite(item.longitude,-180,180)||!validZone(item.timezone)||!safeName(item.country)||!/^[A-Z]{2}$/.test(item.country_code)||typeof item.feature_code!=='string'||!/^[A-Z0-9]{1,10}$/.test(item.feature_code)||item.admin1!==undefined&&!safeName(item.admin1))return null;
  const location={id:item.id,name:item.name,admin1:item.admin1??null,country:item.country,countryCode:item.country_code,latitude:item.latitude,longitude:item.longitude,timezone:item.timezone,featureCode:item.feature_code};
  location.label=[location.name,location.admin1,location.country].filter((value,index,all)=>value&&all.indexOf(value)===index).join('，');return location;
}
function parseGeocoding(data,city) {
  if(data.results===undefined)return {status:'not_found',city};
  if(!Array.isArray(data.results)||data.results.length>10)throw fail('weather_invalid_response');
  const locations=data.results.map(parseLocation);
  if(locations.some(item=>!item))throw fail('weather_invalid_response');
  const unique=[...new Map(locations.map(item=>[item.id,item])).values()];
  if(!unique.length)return {status:'not_found',city};
  if(unique.length===1)return {status:'resolved',location:unique[0]};
  const term=normalized(city.split(',')[0]),exact=unique.filter(item=>normalized(item.name)===term||normalized(item.name).replace(/市$/u,'')===term.replace(/市$/u,''));
  if(exact.length===1)return {status:'resolved',location:exact[0]};
  // Beijing's confirmed CN capital may coexist with similarly named villages.
  if(['北京','北京市','beijing'].includes(term)){
    const capital=unique.filter(item=>item.countryCode==='CN'&&item.featureCode==='PPLC'&&['北京','北京市','beijing'].includes(normalized(item.name)));
    if(capital.length===1)return {status:'resolved',location:capital[0]};
  }
  return {status:'ambiguous',city,candidates:(exact.length?exact:unique).map(({id,name,admin1,country,countryCode,label})=>({id,name,admin1,country,countryCode,label}))};
}
function parseForecast(data,location,at,url) {
  if(!finite(data.latitude,-90,90)||!finite(data.longitude,-180,180)||Math.abs(data.latitude-location.latitude)>1||Math.abs(data.longitude-location.longitude)>1||!Number.isInteger(data.utc_offset_seconds)||!finite(data.utc_offset_seconds,-43200,50400)||!validZone(data.timezone)||data.timezone!==location.timezone)throw fail('weather_invalid_response');
  const offset=data.utc_offset_seconds,nowDate=localDate(at,offset),current=data.current,daily=data.daily;
  if(!current||!daily||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(current.time??''))throw fail('weather_invalid_response');
  const currentAt=Date.parse(current.time+'Z')-offset*1000;
  if(!Number.isFinite(currentAt)||localMinute(currentAt,offset)!==current.time||at-currentAt>90*60000||currentAt-at>15*60000)throw fail('weather_stale_data');
  if(data.current_units?.temperature_2m!=='°C'||data.current_units?.apparent_temperature!=='°C'||data.daily_units?.temperature_2m_min!=='°C'||data.daily_units?.temperature_2m_max!=='°C'||data.daily_units?.precipitation_probability_max!=='%')throw fail('weather_invalid_response');
  if(!finite(current.temperature_2m,-100,65)||!finite(current.apparent_temperature,-130,85)||!Number.isInteger(current.weather_code)||!finite(current.weather_code,0,999))throw fail('weather_invalid_response');
  const arrays=['time','temperature_2m_min','temperature_2m_max','weather_code','precipitation_probability_max'];
  if(arrays.some(key=>!Array.isArray(daily[key])||daily[key].length!==3))throw fail('weather_invalid_response');
  const days=[];
  for(let i=0;i<3;i++){
    const min=daily.temperature_2m_min[i],max=daily.temperature_2m_max[i],code=daily.weather_code[i],rain=daily.precipitation_probability_max[i];
    if(daily.time[i]!==dateAtOffset(nowDate,i)||!finite(min,-100,65)||!finite(max,-100,65)||min>max||!Number.isInteger(code)||!finite(code,0,999)||!finite(rain,0,100))throw fail('weather_invalid_response');
    days.push({date:daily.time[i],minimumC:min,maximumC:max,weatherCode:code,description:weatherDescription(code),precipitationProbabilityMax:rain});
  }
  return {location,current:{time:current.time,temperatureC:current.temperature_2m,apparentTemperatureC:current.apparent_temperature,weatherCode:current.weather_code,description:weatherDescription(current.weather_code)},days,timezone:data.timezone,utcOffsetSeconds:offset,source:{provider:'Open-Meteo',url,docsUrl:DOCS_URL,dataKind:'weather_model'},fetchedAt:new Date(at).toISOString()};
}

export function createWeatherService({fetchImpl=globalThis.fetch,nowMs=Date.now,timeoutMs=8000}={}) {
  if(typeof fetchImpl!=='function'||typeof nowMs!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw new TypeError('Invalid weather service options');
  const geoCache=new Map(),weatherCache=new Map();
  async function getWeather({city,dateOffset=0,signal}={}) {
    city=checkedCity(city);if(!Number.isInteger(dateOffset)||dateOffset<0||dateOffset>2)throw fail('weather_unsupported_date');
    if(signal?.aborted)throw fail('weather_cancelled');
    const controller=new AbortController();let rejectStop;
    const stopped=new Promise((_,reject)=>{rejectStop=reject;});
    const stop=code=>{controller.abort(code);rejectStop(fail(code));};
    const onAbort=()=>stop('weather_cancelled');signal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>stop('weather_timeout'),timeoutMs);
    const work=async()=>{
      const key=normalized(city);let geo=cacheGet(geoCache,key,nowMs());
      if(!geo){const url=new URL(GEOCODING_URL);url.search=new URLSearchParams({name:city,count:'10',language:'zh',format:'json'}).toString();geo=parseGeocoding(await fetchJson(fetchImpl,url.href,controller.signal),city);checkStopped(controller.signal);cachePut(geoCache,key,geo,nowMs()+GEO_TTL_MS);}
      if(geo.status!=='resolved')return geo;
      const location=geo.location,weatherKey=String(location.id);let forecast=cacheGet(weatherCache,weatherKey,nowMs()),cacheHit=!!forecast;
      if(forecast&&forecast.days[0].date!==localDate(nowMs(),forecast.utcOffsetSeconds)){weatherCache.delete(weatherKey);forecast=null;cacheHit=false;}
      if(!forecast){const url=new URL(FORECAST_URL);url.search=new URLSearchParams({latitude:String(location.latitude),longitude:String(location.longitude),current:'temperature_2m,apparent_temperature,weather_code',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',timezone:location.timezone,forecast_days:'3',temperature_unit:'celsius',timeformat:'iso8601'}).toString();forecast=parseForecast(await fetchJson(fetchImpl,url.href,controller.signal),location,nowMs(),url.href);checkStopped(controller.signal);cachePut(weatherCache,weatherKey,forecast,nowMs()+WEATHER_TTL_MS);}
      checkStopped(controller.signal);const {days,...result}=forecast;
      return {status:'ok',city,dateOffset,...result,daily:days[dateOffset],cacheHit};
    };
    try{return await Promise.race([work(),stopped]);}
    catch(error){if(controller.signal.aborted)throw fail(controller.signal.reason);if(typeof error?.code==='string'&&error.code.startsWith('weather_'))throw error;throw fail('weather_unavailable');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  }
  return Object.freeze({getWeather,formatWeather});
}

export function formatWeather(result,{dateOffset=result?.dateOffset??0}={}) {
  if(result?.status!=='ok'||dateOffset!==result.dateOffset||!Number.isInteger(dateOffset)||dateOffset<0||dateOffset>2)throw fail('weather_invalid_result');
  const {location,current,daily}=result,number=value=>Number(value.toFixed(1)).toString();
  const day=['今天','明天','后天'][dateOffset],description=daily.description??'天况代码暂不能识别';
  const currentDescription=current.description??'天况代码暂不能识别';
  const first=dateOffset===0?`${location.name}现在${currentDescription}，约${number(current.temperatureC)}℃，体感${number(current.apparentTemperatureC)}℃`:`${location.name}${day}（${daily.date.slice(5)}）${description}`;
  const second=`${dateOffset===0?'今天':day}${number(daily.minimumC)}～${number(daily.maximumC)}℃，最高降水概率${Math.round(daily.precipitationProbabilityMax)}%`;
  const fetched=localMinute(Date.parse(result.fetchedAt),result.utcOffsetSeconds).replace('T',' ');
  return `${first}\n${second}\nOpen-Meteo预报数据 · 当地${fetched}查询`;
}

const defaultService=createWeatherService();
export const getWeather=input=>defaultService.getWeather(input);
