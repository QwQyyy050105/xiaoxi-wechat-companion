import {setTimeout as delay} from 'node:timers/promises';
import {validateEndpoint} from './model.mjs';
export function validateModelSettings(p={}) {
 if(!['mock','compatible','codex'].includes(p.provider))throw Error('model_provider_invalid');
 if(typeof p.model!=='string'||p.model.length>100)throw Error('model_name_invalid');
 const apiKeyEnv=p.apiKeyEnv??'';
 if(typeof apiKeyEnv!=='string'||apiKeyEnv&&!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(apiKeyEnv))throw Error('api_key_env_invalid');
 if(p.apiKey!==undefined&&(typeof p.apiKey!=='string'||p.apiKey.length>4000))throw Error('api_key_invalid');
 const timeoutMs=p.timeoutMs??120000,retries=p.retries??1,maxOutputTokens=p.maxOutputTokens??0,outputTokenField=p.outputTokenField??'max_completion_tokens';
 if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<0||maxOutputTokens>128000||!['max_tokens','max_completion_tokens'].includes(outputTokenField))throw Error('model_output_limit_invalid');
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>300000||!Number.isInteger(retries)||retries<0||retries>2)throw Error('model_limits_invalid');
 if(p.vision!==undefined&&typeof p.vision!=='boolean')throw Error('model_vision_invalid');
 if(p.provider==='compatible'&&!p.model.trim())throw Error('api_model_required');
 return {vision:p.vision===true,provider:p.provider,model:p.model.trim(),baseUrl:validateEndpoint(p.baseUrl||'https://api.openai.com/v1'),apiKeyEnv,timeoutMs,retries,maxOutputTokens,outputTokenField,stream:p.stream!==false};
}
class ApiProviderError extends Error {
 constructor(code){super(code);this.name='ApiProviderError';this.code=code;}
}
const apiError=code=>new ApiProviderError(code);
function parseProviderJson(value,code){try{return JSON.parse(value);}catch{throw apiError(code);}}
export async function callCompatible({settings,messages,signal,onDelta,fetchImpl=fetch,env=process.env}) {
 const checked=validateModelSettings(settings);
 const key=checked.apiKeyEnv?env[checked.apiKeyEnv]:settings.apiKey;
 if(checked.apiKeyEnv&&!key)throw apiError('api_key_environment_missing');
 const deadline=AbortSignal.timeout(checked.timeoutMs),combined=AbortSignal.any([signal??new AbortController().signal,deadline]);
 const cancelled=()=>new DOMException(signal?.aborted?'api_cancelled':'api_timeout',signal?.aborted?'AbortError':'TimeoutError');
 const active=()=>{if(combined.aborted)throw cancelled();};
 let text='',usage=null;
 for(let attempt=0;attempt<=checked.retries;attempt++){
  active();
  try{
   const response=await fetchImpl(checked.baseUrl+'/chat/completions',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},body:JSON.stringify({model:checked.model,messages,stream:checked.stream,...(checked.maxOutputTokens?{[checked.outputTokenField]:checked.maxOutputTokens}:{})}),signal:combined});
   if(!response.ok){const status=Number.isInteger(response.status)?response.status:0;const error=apiError(`model_api_http_${status}`);error.retryable=[429,502,503,504].includes(status);await response.body?.cancel();throw error;}
   if(!response.body)throw apiError('api_empty_response');
   if(!checked.stream||!response.headers?.get('content-type')?.includes('text/event-stream')){
    let length=0;const chunks=[];
    for await(const chunk of response.body){active();length+=chunk.length;if(length>2*1024*1024)throw apiError('api_output_limit');chunks.push(chunk);}
    const body=parseProviderJson(Buffer.concat(chunks).toString('utf8'),'api_invalid_json');
    text=body?.choices?.[0]?.message?.content;usage=body?.usage??null;
   }else{
    const decoder=new TextDecoder();let buffer='',bytes=0,done=false;
    const consume=line=>{
     if(!line.startsWith('data:'))return;
     const raw=line.slice(5).trim();if(raw==='[DONE]'){done=true;return;}if(!raw)return;
     const packet=parseProviderJson(raw,'api_invalid_stream_packet');if(packet?.error)throw apiError('api_stream_error');
     usage=packet?.usage??usage;const delta=packet?.choices?.[0]?.delta?.content;
     if(typeof delta==='string'){text+=delta;if(text.length>30000)throw apiError('api_output_limit');onDelta?.(delta);}
    };
    for await(const chunk of response.body){active();bytes+=chunk.length;if(bytes>2*1024*1024)throw apiError('api_output_limit');buffer+=decoder.decode(chunk,{stream:true});let n;while((n=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,n).replace(/\r$/,''));buffer=buffer.slice(n+1);}if(done)break;}
    if(buffer.trim())consume(buffer);if(!done)throw apiError('api_stream_incomplete');
   }
   active();if(typeof text!=='string'||!text.trim())throw apiError('api_empty_reply');
   return {text:text.slice(0,30000),usage,searchUsed:false,provider:'compatible'};
  }catch(error){
   if(combined.aborted)throw cancelled();
   const retryable=error instanceof ApiProviderError?error.retryable===true:error instanceof TypeError;
   if(text||attempt===checked.retries||!retryable)throw error instanceof ApiProviderError?error:apiError('api_connection_failed');
   try{await delay(150*(attempt+1),undefined,{signal:combined});}catch{if(combined.aborted)throw cancelled();throw apiError('api_connection_failed');}
  }
 }
}
