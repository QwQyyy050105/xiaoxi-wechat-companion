// Local model-health metadata only. No chat body, upstream response or secrets.
const TRANSIENT=new Set(['model_network_error','model_timeout','model_rate_limited','api_connection_failed','api_timeout','api_stream_incomplete']);
const API_CODES=new Set(['api_key_environment_missing','api_invalid_json','api_invalid_stream_packet','api_empty_response','api_empty_reply','api_output_limit','api_stream_error','api_connection_failed','api_timeout','api_cancelled','api_stream_incomplete']);
const isHttpCode=code=>/^model_api_http_[1-5]\d\d$/.test(code);
const isTransient=code=>TRANSIENT.has(code)||/^model_api_http_(429|5\d\d)$/.test(code);
const SAFE=new Set([...TRANSIENT,'model_auth_required','model_configuration_error','model_generation_failed','model_cancelled','model_backoff','model_recovery_busy','model_action_required','model_self_check_busy','model_busy']);
export class ModelCallError extends Error {constructor(code){super(SAFE.has(code)||API_CODES.has(code)||isHttpCode(code)?code:'model_generation_failed');this.name='ModelCallError';this.code=this.message;}}
export function classifyModelFailure(error){
 if(error instanceof ModelCallError)return error.code;
 const code=typeof error?.code==='string'?error.code:'';
 if(SAFE.has(code)||API_CODES.has(code)||isHttpCode(code))return code;
 if(error?.name==='TimeoutError')return 'model_timeout';
 if(error?.name==='AbortError')return 'model_cancelled';
 const message=typeof error==='string'?error:typeof error?.message==='string'?error.message:'';
 const value=(code+' '+message).slice(0,12000);
 if(/\b429\b|rate.?limit|too many requests|at capacity|server busy|overloaded|usage[ _-]?limit|insufficient_quota|quota.{0,16}(?:exceed|exhaust)/iu.test(value))return 'model_rate_limited';
 if(/\b401\b|unauthorized|authentication|invalid.?api.?key|token.{0,20}expir|sign.?in|login.?required|credentials/iu.test(value))return 'model_auth_required';
 if(/cloudflare|edge.{0,20}(?:403|block)|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|fetch failed|network|connect(?:ion|ing)?(?:[ _-]+(?:error|failed|reset|closed))?|stream.{0,20}disconnect|error sending request|request.{0,10}failed|\b50[0234]\b/iu.test(value))return 'model_network_error';
 if(/timeout|timed out|超过两分钟/iu.test(value))return 'model_timeout';
 if(/unexpected argument|unrecognized option|unsupported|unknown.{0,12}model|model.{0,16}not found|config|未找到本机 Codex|模型进程无法启动|请填写 API 模型/iu.test(value))return 'model_configuration_error';
 return 'model_generation_failed';
}
export function safeModelError(error,{cancelled=false}={}){return new ModelCallError(cancelled?'model_cancelled':classifyModelFailure(error));}
export class ModelHealth {
 constructor({nowMs=Date.now,baseMs=2000,maxMs=30000}={}){this.nowMs=nowMs;this.baseMs=baseMs;this.maxMs=maxMs;this.serial=0;this.reset();}
 reset(){this.failures=0;this.retryAt=0;this.lastSuccessAt=null;this.lastFailureAt=null;this.lastFailureCode=null;this.lastErrorCode=null;this.actionRequired=false;this.activeRecovery=null;this.recoveryAttempts=0;}
 availability(){if(this.actionRequired)return {allowed:false,code:'model_action_required'};if(this.activeRecovery!==null)return {allowed:false,code:'model_recovery_busy'};if(this.nowMs()<this.retryAt)return {allowed:false,code:'model_backoff'};return {allowed:true,code:null};}
 begin({force=false}={}){const status=this.availability();if(!force&&!status.allowed)throw new ModelCallError(status.code);const token={id:++this.serial,recovery:this.failures>0&&!force};if(token.recovery){this.activeRecovery=token.id;this.recoveryAttempts++;}return token;}
 cancelAll(){this.activeRecovery=null;}
 release(token){if(token?.recovery&&this.activeRecovery===token.id)this.activeRecovery=null;}
 success(token){this.release(token);this.failures=0;this.retryAt=0;this.lastSuccessAt=new Date(this.nowMs()).toISOString();this.lastErrorCode=null;this.actionRequired=false;}
 failure(token,error){this.release(token);const code=classifyModelFailure(error);this.failures++;this.lastFailureAt=new Date(this.nowMs()).toISOString();this.lastFailureCode=this.lastErrorCode=code;this.actionRequired=!isTransient(code);this.retryAt=this.actionRequired?0:this.nowMs()+Math.min(this.maxMs,this.baseMs*2**Math.min(this.failures-1,8));}
 snapshot(){return {phase:this.activeRecovery!==null?'half_open':this.actionRequired?'action_required':this.failures?'open':this.lastSuccessAt?'closed':'unverified',failures:this.failures,retryAt:this.retryAt,retryAfterMs:Math.max(0,this.retryAt-this.nowMs()),lastSuccessAt:this.lastSuccessAt,lastFailureAt:this.lastFailureAt,lastFailureCode:this.lastFailureCode,lastErrorCode:this.lastErrorCode,actionRequired:this.actionRequired,recoveryAttempts:this.recoveryAttempts};}
}
export function modelHealthMessage(health){if(health.actionRequired)return '模型需要检查登录、配置或服务权限；修正后点击“测试 AI”，不会自动切换当前模型。';return '模型网络暂不可用；短暂退避后，下一条新问题会尝试当前模型，旧问题不会补发。';}
