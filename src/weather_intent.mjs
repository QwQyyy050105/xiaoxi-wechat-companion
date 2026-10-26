import {classifyAddress, directText} from './reply_policy.mjs';

// Pure text routing. These functions neither obtain a location nor authorize
// network access; the core must first accept the current conversation turn.
const WEATHER = /天气|气温|温度|天气预报|下雨|有雨|降雨|下雪|有雪|几度|多少度|冷不冷|热不热|带伞|穿什么|穿啥|怎么穿|穿衣|\bweather\b|\btemperature\b/iu;
const UNSUPPORTED_DATE = /昨天|前天|大后天|上周|下周|上个月|下个月|去年|明年|周[一二三四五六日天]|星期|礼拜|这周|本周|周末|未来|接下来|最近(?:几|一周)|\d{1,4}[年/月日号-]|[三四五六七八九十\d]+天(?:后|内)|一周|\byesterday\b|\bnext week\b|\bweekend\b/iu;
const TECHNICAL = /原理|定义|意思|概念|模型|算法|代码|编程|函数|变量|参数|接口|API|爬虫|程序|软件|网站|数据集|训练|设计|实现|开发|文章|作文|翻译|英语怎么说|天气预报(?:准不准|准确吗|为什么)|为什么.{0,6}(?:下雨|下雪|有雨|有雪)|温度(?:单位|换算|公式)|\b(?:code|api|model|algorithm|meaning)\b/iu;
const REPORTED = /^(?:他说|她说|他们说|她们说|别人说|有人说|有人问|听说|据说|你(?:刚才|之前)?说|小汐说|Example Account说|转述|引用|示例|举例|例子|假设|如果有人)/u;
const NEGATED = /(?:别|不要|不用|不必|无需|不需要|不想|没让|没有让|不是让|别再|停止|取消).{0,12}(?:查|看|问|说|报|天气|气温|温度|下雨|下雪)|(?:天气|气温|温度).{0,5}(?:不用查|不查了|别查|不用看)/u;
const UNSAFE = /https?:|www\.|[\n\r\u0000-\u001f<>`{}\[\]\\]|@|\b(?:token|password|secret|api[_ -]?key)\b/iu;

function currentText(value) {
  if (typeof value !== 'string' || value.length > 180) return null;
  let text=value.normalize('NFC').trim();
  if (!text || /[\n\r]/u.test(text) || directText(text)!==text) return null;
  const address=classifyAddress(text);
  if(address.addressed)text=address.text.trim();
  text=text.replace(/[。！？?!，,；;～~\s]+$/u,'').trim();
  if(!text || UNSAFE.test(text) || REPORTED.test(text))return null;
  return text;
}

function cleanCity(value) {
  if (typeof value !== 'string')return null;
  let city=value.normalize('NFC').trim().replace(/^(?:我(?:现)?在|我是在|就查|请查|查一下|查下|查|在|是)[，,：:\s]*/u,'');
  city=city.replace(/[。！!？?，,～~\s]+$/u,'').replace(/[呀啊吧呢]$/u,'').trim();
  if(city.length<2||city.length>60||UNSAFE.test(city))return null;
  // Names stay data, including accents, spaces and hyphens. Numbers, phrases,
  // multiple clauses and operation requests cannot become geocoding input.
  if(!/^[\p{L}][\p{L}\p{M} .·'’-]*[\p{L}\p{M}]$/u.test(city))return null;
  if(/[\p{Script=Han}]{2,}和[\p{Script=Han}]{2,}|\b(?:and|or)\b/iu.test(city))return null;
  if(/^(?:我|你|他|她|它|我们|你们|他们|这里|那里|这边|那边|当地|家里|家乡|随便|不知道|不确定|都行|好的|谢谢|今天|明天|后天|现在|刚才|昨天|早上|晚上|中午|第[一二三四五六七八九十]|停止|取消|继续|等等|等一下|先别|不用|不要|不需要|没必要|开始|打开|执行|忽略)/u.test(city))return null;
  if(/(?:天气|气温|温度|下雨|下雪|带伞|穿衣|怎么|什么|哪[里儿个座]|吗|是不是|帮我|告诉|搜索|查询|关闭|重启|删除|发送|密码|验证码|聊天|累了|好累|下班|回家|吃饭|睡觉|聚餐|说完|知道|算了|不查|不想查)/u.test(city))return null;
  if(/^(?:yes|no|okay|thanks|here|there|home|now|today|tomorrow|yesterday|stop|cancel|continue|ignore|unknown|anywhere)$/iu.test(city))return null;
  if(/^(?:可以|不可以|行吧|还行|明白了|算了|没事|随你|嗯嗯|哈哈哈*|嘿嘿|谢谢你|不用了|不查了|无所谓)$/u.test(city))return null;
  return city;
}

/** Call only while the core owns a current, confirmed weather-location slot. */
export function parseWeatherLocationAnswer(value) {
  if(typeof value!=='string'||value.length>80||/[\n\r“”「」『』"`<>]/u.test(value))return null;
  return cleanCity(value);
}

function dateParts(text) {
  if(UNSUPPORTED_DATE.test(text))return {dateOffset:null,period:'day',unsupported:'date'};
  const later=/后天|\bday after tomorrow\b/iu.test(text),tomorrow=/明天|\btomorrow\b/iu.test(text);
  const today=/今天|今日|\btoday\b/iu.test(text);
  if((later&&tomorrow&&!/day after tomorrow/iu.test(text))||((later||tomorrow)&&today))return {dateOffset:null,period:'day',unsupported:'date'};
  return {dateOffset:later?2:tomorrow?1:0,period:later||tomorrow||(!/现在|目前|此刻|实时|\bnow\b/iu.test(text)&&(today||/天气预报/u.test(text)))?'day':'current'};
}

function extractCity(text) {
  // Remove the request grammar, never an arbitrary substring matching a city
  // dictionary. The weather provider resolves the remaining place name.
  let value=text
    .replace(/\bday after tomorrow\b|\btomorrow\b|\btoday\b|\bnow\b/giu,' ')
    .replace(/今天|今日|明天|后天|现在|目前|此刻|实时/gu,'')
    .replace(/^(?:(?:请|麻烦|能不能|能否|可以|帮我|帮忙|帮|给我|替我|问一下|想问一下|我想问|我想知道|想知道|请问)[，,\s]*)+/u,'')
    .replace(/^(?:查(?:询|一下|下)?|看(?:看|一下|下)?|告诉我|报一下)[，,\s]*/u,'')
    .replace(/\b(?:what(?:'s| is)|how(?:'s| is)|the|weather|temperature|in|for|please|check)\b/giu,' ')
    .replace(/天气预报|天气|气温|温度/gu,'')
    .replace(/(?:会不会|有没有|是不是|是否|会|有)?(?:下雨|有雨|降雨|下雪|有雪)/gu,'')
    .replace(/(?:要不要|需不需要|是否需要|需要|要)?(?:带伞|带雨伞)/gu,'')
    .replace(/(?:出门)?(?:穿什么|穿啥|怎么穿|穿衣(?:建议)?)/gu,'')
    .replace(/怎么样|怎样|如何|多少度|几度|冷不冷|热不热|好不好|预报|呢|吗|么|呀|啊|一下/gu,'')
    .replace(/[，,:：?？!！。]/gu,' ')
    .replace(/(?:的|了|吧)$/u,'').replace(/^的/u,'').trim();
  if(!value)return {city:null,valid:true};
  const city=cleanCity(value);
  return {city,valid:city!==null};
}

/** Only explicit requests, not every weather-related discussion, are routed. */
export function parseWeatherIntent(value) {
  const text=currentText(value);
  if(!text||!WEATHER.test(text)||TECHNICAL.test(text)||NEGATED.test(text))return null;
  const dates=dateParts(text);
  // Accept bare forecast requests, but do not turn "天气好适合散步" into a lookup.
  const query=/怎么|怎样|如何|几度|多少度|冷不冷|热不热|会不会|有没有|要不要|需不需要|是否|[吗么呢]$|^(?:请|麻烦|帮|查|看|告诉)|天气预报|\b(?:what|how|check|weather|temperature)\b/iu.test(text);
  const bare=/^(?:[\p{L}\p{M} .·'’-]{0,60})?(?:天气|气温|温度)$/u.test(text);
  if(!query&&!bare)return null;
  if(dates.unsupported){
    // Do not turn an out-of-scope date into a current forecast.
    return {kind:'weather',city:null,...dates};
  }
  const location=extractCity(text);
  if(!location.valid)return null;
  return {kind:'weather',city:location.city,...dates};
}

/** Requires an existing current weather thread; a bare city is deliberately not enough. */
export function parseWeatherFollowup(value) {
  const text=currentText(value);
  if(!text||NEGATED.test(text)||TECHNICAL.test(text))return null;
  const date=text.match(/^(?:那么|那)?(?:今天|今日|明天|后天|现在|此刻)(?:呢|怎么样|如何)?$/u);
  if(date)return {kind:'weather_followup',city:null,...dateParts(text)};
  const location=text.match(/^(?:那么|那)[，,\s]*(.+?)(?:呢|怎么样|如何)$/u);
  if(!location)return null;
  const city=cleanCity(location[1]);
  if(!city)return null;
  return {kind:'weather_followup',city,dateOffset:null,period:'day'};
}
