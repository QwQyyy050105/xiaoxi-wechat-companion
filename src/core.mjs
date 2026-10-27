import {deployment,loadDeployment,saveDeployment,validateAliases} from './deployment_config.mjs';
import fs from 'node:fs';
import {ModelHealth,ModelCallError,safeModelError,modelHealthMessage} from './model_health.mjs';
import {validateModelSettings} from './compatible_api.mjs';
import {UnsupportedCapability} from './extension_host.mjs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store,uid,now} from './store.mjs';
import {generate,generateSearch,validateEndpoint} from './model.mjs';
import {DesktopTransport} from './desktop_transport.mjs';
import {MessageGate,shouldReply,recoverInterrupted} from './message_gate.mjs';
import {ConversationContext,sameVerifiedSender} from './conversation_context.mjs';
import {ReplyPolicy,canMergeFragment,fragmentReadyAt,isSocialSummons,classifyAddress} from './reply_policy.mjs';
import {parseMemoryIntent,proposeMemory,approveMemory,rejectMemory,editMemory,deleteMemory,queryMemories} from './memory_service.mjs';
import {parseTaskIntent,createReminder,approveReminder,editReminder,cancelReminder,queryTasks,recoverTasks,claimReminder,settleReminder} from './task_service.mjs';
import {createVoiceProvider} from './voice_provider.mjs';
import {createMediaService} from './media_service.mjs';
import {planTextReply} from './delivery_plan.mjs';
import {classifyMediaRequest} from './media_intent.mjs';
import {PersonaLoader,validatePersona} from './persona_loader.mjs';
import {createWeatherConversation} from './weather_conversation.mjs';
import {parseWeatherIntent} from './weather_intent.mjs';
import {inspectWebIntent,parseWebIntent} from './web_intent.mjs';
import {isMissingDetailQuestion,supersedesClarification,replyRevision} from './turn_freshness.mjs';
import {CONVERSATION_SCOPE_POLICY,getAuthorizedWechatScopes,isAuthorizedWechatTarget,assertAuthorizedWechatTarget,filterAuthorizedWechatTargets,assertConversationScope,inspectConversationScope} from './conversation_scope.mjs';
import {applyDeploymentSettings} from './deployment_settings.mjs';
import {CODEX_CHAT_MODEL} from './model_policy.mjs';
import {loadGroupProfile} from './group_profile.mjs';
import {PublicLookupConversation} from './public_lookup_conversation.mjs';
import {GroupMediaInput} from './group_media.mjs';
import {normalizeNativeMedia} from './native_media.mjs';
import {planContextResearch,researchEvidence,PublicResearchCache} from './research_intent.mjs';

const OWNER={isOwner:true};
const reasonText={personal_memory_unavailable:'还不能可靠确认成员身份，暂不保存个人长期记忆。',shared_scope_required:'请明确这是本群共同约定；个人事实暂不保存。',not_confirmed_fact:'这句话包含转述或假设，暂不作为已确认事实保存。',temporary_state:'这更像当下感受，先不写成长期事实。',memory_not_found:'没找到当前会话的那条记忆。',memory_id_required:'请先查看记忆，再指定条目编号。',stale_epoch:'会话已经变化，请重新提交。',stale_memory_epoch:'记忆已变化，请重新提出这条候选。',stale_version:'条目已被修改，请查看最新内容后再操作。',time_not_future:'提醒时间已经过去，请提供未来的明确日期和时间。',explicit_datetime_required:'请给出完整日期和时间。',owner_required:'这项修改需要在本机客户端由主人确认。',task_already_committed:'任务已提交或结束，不能再次执行或撤销。',target_session_mismatch:'提醒目标与所属会话不一致。'};
function checked(result){if(!result?.ok)throw Error(reasonText[result?.code]||`操作未完成：${result?.code||'未知结果'}`);return result;}
function findShort(rows,id){const matches=rows.filter(x=>x.id===id||x.id.startsWith(id));return matches.length===1?matches[0].id:null;}

export class Companion extends EventEmitter {
  constructor({root,codec,model=generate,search=generateSearch,weather,voice=createVoiceProvider(),media=createMediaService(),groupMedia,transportFactory=()=>new DesktopTransport(root),nowMs=Date.now,extensions,stateFile}){
    super();this.activeModelCalls=new Set();this.modelHealth=new ModelHealth({nowMs});this.extensions=extensions;this.root=root;this.model=model;this.search=search;this.voice=voice;this.media=media;this.transportFactory=transportFactory;this.nowMs=nowMs;
    this.store=new Store(stateFile??path.join(root,'data/companion.enc'),codec);
    applyDeploymentSettings(this.store,root);
    if(this.store.value.settings.provider==='codex'&&!this.store.value.settings.model)this.store.change(s=>{s.settings.model=CODEX_CHAT_MODEL;});
    this.personaLoader=new PersonaLoader(root,{nowMs});
    const loaded=this.personaLoader.load();this.persona=loaded.persona;this.personaStatus=loaded.status;this.modelInput=null;
    this.gate=new MessageGate();this.controllers=new Map();this.targetStates={};this.pending=new Map();this.processing=new Set();this.ownIds=new Set();this.suspended=new Set();this.generation=0;this.running=false;this.attempting=false;this.timer=null;this.stopping=null;
    this.weather=weather===undefined?createWeatherConversation({nowMs}):weather;
    this.publicLookup=new PublicLookupConversation({nowMs});
    this.publicResearchCache=new PublicResearchCache({nowMs});
    this.groupMedia=groupMedia??new GroupMediaInput({root,nowMs});
    this.context=new ConversationContext({nowMs});this.policy=new ReplyPolicy({nowMs,names:this.store.value.settings.aliases??deployment.character.aliases??[deployment.character.name],readOnlyIntent:text=>this.store.value.settings.allowSearch===true&&!!(parseWeatherIntent(text)||parseWebIntent(text)||planContextResearch({text})?.kind==='research')});this.turns=new Map();this.batchTimers=new Map();this.taskRunning=false;
    this.latency={poll:null,recent:[],decisions:[],coalescedSummons:0,revisedReplies:0};this.polling=false;
    this.voiceReadiness={characterId:'xiaoxi',ready:false,available:false,audioFile:false,voiceBubble:false,reason:'unchecked'};
    this.connection={stage:'stopped',message:'尚未连接',account:deployment.account.displayName};this.modelState={stage:'unchecked',message:'当前模型尚未核验；新问题会尝试，也可手动测试。'};
    this.store.change(s=>{const recovered=recoverInterrupted(s)+recoverTasks(s,{now:this.nowMs()}).length;if(recovered)s.events.push({time:now(),message:`恢复了 ${recovered} 个中断状态；未补发旧消息。`});});
    if(!this.store.value.sessions.some(x=>x.channel==='local'))this.store.createSession();
    this.ensureSessions();
    this.store.change(s=>{for(const target of s.targets){const session=this.sessionFor(target.id);const last=s.outbox.filter(x=>x.sessionId===session?.id&&['unknown','local_echo'].includes(x.status)).at(-1);if(target.quarantined===undefined)target.quarantined=last?.status==='unknown';if(target.quarantined)this.suspended.add(target.id);}});
    for(const session of this.store.value.sessions){this.policy.restoreProactive(session.id,session.proactiveUsage);for(const out of this.store.value.outbox.filter(x=>x.sessionId===session.id&&x.kind==='proactive'&&['unknown','local_echo'].includes(x.status)))this.policy.recordProactive(session.id,{outboxId:out.id,status:out.status,nowMs:Date.parse(out.createdAt)});}
  }
  ensureSessions(){for(const t of filterAuthorizedWechatTargets(this.store.value.targets))if(!this.sessionFor(t.id))this.store.createSession(t.name,'desktop_wechat',deployment.account.displayName,t.id);}
  snapshot(){return {...this.store.snapshot(),mode:this.demo?'demo':'configured',privacy:{policy:CONVERSATION_SCOPE_POLICY,authorizedWechatTargets:getAuthorizedWechatScopes()},connection:this.connection,modelState:this.modelState,modelHealth:this.modelHealth.snapshot(),targetStates:this.targetStates,extensions:this.extensions?.snapshot()??null,persona:this.persona,personaStatus:this.personaStatus,modelInput:this.modelInput,latency:structuredClone(this.latency),busy:[...this.controllers.keys()],capabilities:{text:true,webSearch:this.searchEnabled(),media:this.mediaCapabilityStatus().imageInput,voice:false,senderIdentity:false},voiceReadiness:this.voiceReadiness,mediaCapabilities:this.mediaCapabilityStatus(),mediaStatus:structuredClone(this.groupMedia.status),featureStatus:this.featureStatus(),contextStatus:Object.fromEntries(this.store.value.sessions.map(s=>{const c=this.context.snapshot(s.id);return [s.id,{count:c.messages.length,generation:c.generation,range:c.range}];}))};}
  searchModelSettings(){
    // Explicit projection: search never receives chat history, private cards or
    // inline credentials. These are the settings the built-in Codex search uses.
    const settings=this.store.value.settings;
    return {provider:settings.provider,model:settings.model,timeoutMs:settings.timeoutMs??120000};
  }
  searchEnabled(){return !this.demo&&this.store.value.settings.allowSearch===true&&(this.extensions?.has('search')===true||this.store.value.settings.provider==='codex');}
  mediaCapabilityStatus(){
    const registered=this.media.capabilities();
    const connected=!this.demo&&process.platform==='win32'&&deployment.native.enabled===true&&this.connection.stage==='connected'&&this.connection.account===deployment.account.displayName&&Number.isInteger(this.connection.pid)&&Number.isFinite(this.connection.created);
    const cacheConnected=connected&&deployment.native.mediaCache===true;
    const last=this.groupMedia?.status?.last;const cacheReady=cacheConnected&&last?.ok===true&&last.count>0;
    const plugin=this.extensions?.handlers.get('model')?.call;
    const visionReady=!this.demo&&this.store.value.settings.provider!=='mock'&&(plugin?plugin.capabilities?.vision===true:this.store.value.settings.vision===true);
    return {...registered,imageInput:registered.imageInput||cacheReady,imageUnderstanding:registered.imageUnderstanding||cacheReady&&visionReady,platformTranscript:registered.platformTranscript||connected,groupCacheConfigured:deployment.native.mediaCache===true,groupCacheCandidates:cacheReady,modelVision:visionReady,autoTranscription:false,nativeStatus:this.demo?'disabled_demo':!deployment.native.mediaCache?'not_configured':!connected?'awaiting_connection':!visionReady?'model_vision_not_enabled':last?.ok===false?'resource_unavailable':cacheReady?'experimental_verified':'awaiting_image_read'};
  }
  featureStatus(){return [
 {id:1,label:'文字聊天与模型',status:'implemented',detail:'Mock 本机演示；OpenAI-compatible API；已安装且登录的 Codex CLI。自选模型，不自动换模型'},
 {id:2,label:'群聊与后台收发',status:deployment.native.enabled?'experimental':'unsupported',detail:'Windows 微信 4.1.15.56 精确构建实验适配；独立群窗口，账号/群名/版本核验失败即停止；其他版本不猜偏移'},
 {id:3,label:'上下文与记忆',status:'implemented',detail:'同会话上下文、连续接话、停止/等待/换话题；长期记忆由本机主人确认'},
 {id:4,label:'图片',status:deployment.native.mediaCache?'experimental':'unsupported',detail:'缓存需明确配置账号目录与 wechatPeerId；图片与具体消息/发言者未可靠绑定，不将缓存时间当发送顺序'},
 {id:5,label:'语音输入',status:'partially_implemented',detail:'可处理微信已有的转文字；自动点击转写、原始音频提取尚不支持。媒体/ASR 可用本机插件接入'},
 {id:6,label:'联网',status:this.store.value.settings.allowSearch?'implemented':'disabled',detail:'默认关闭。Codex 搜索需真实查询记录和来源；API 模型需另装 search 插件才支持资料搜索'},
 {id:7,label:'声音/表情/其他平台',status:'unsupported',detail:'内置不发送音频或表情。TTS/媒体/传输插件有明确接口，未配置就返回 unsupported'},
 {id:8,label:'提醒与恢复',status:'implemented',detail:'本机确认后发送；取消/过期/未确认不会重复提交，关机期间不运行'},
 {id:9,label:'个性化与扩展',status:'implemented',detail:'人格卡热更新、称呼、风格、每会话接话与主动参与；可信本机插件契约 apiVersion=1'}];}
  async refreshReadiness(){this.voiceReadiness=await this.voice.status();this.update();return this.voiceReadiness;}
  savePolicy(sessionId){this.store.change(s=>{const session=s.sessions.find(x=>x.id===sessionId);if(session)session.proactiveUsage=this.policy.exportProactive(sessionId);});}
  update(){this.emit('update',this.snapshot());}
  event(message){this.store.event(message);this.update();}
  sessionFor(id){return this.store.value.sessions.find(s=>s.channel==='desktop_wechat'&&s.peerId===id);}
  scopedTargetSession(target,sessionId){
    const current=this.store.value.targets.find(row=>row.id===target?.id);
    return isAuthorizedWechatTarget(target)&&isAuthorizedWechatTarget(current)&&current.name===target.name&&current.kind===target.kind&&(!target.windowBinding||current.windowBinding===target.windowBinding)&&this.sessionFor(target.id)?.id===sessionId&&inspectConversationScope(this.store.session(sessionId),this.store.value.targets).allowed;
  }
  async runModel(args,purpose='reply'){
    args.signal?.throwIfAborted();
    if(purpose!=='self_check')assertConversationScope(args.session,this.store.value.targets,{allowLocalOwner:true});
    const previousError=this.personaStatus?.lastError;
    const loaded=this.personaLoader.reload();this.persona=loaded.persona;this.personaStatus=loaded.status;
    if(loaded.status.lastError&&previousError?.code!==loaded.status.lastError.code)this.event('人设卡更新未通过校验，继续使用上次有效版本；请检查 character_card.json');
    if(purpose!=='self_check'&&this.controllers.has('model_check'))throw new ModelCallError('model_self_check_busy');
    if(purpose==='self_check'&&this.activeModelCalls.size)throw new ModelCallError('model_busy');
    const healthToken=this.modelHealth.begin({force:purpose==='self_check'});
    const callId=uid();this.activeModelCalls.add(callId);
    this.modelInput={callId,stage:'preparing',purpose,sourceSha256:loaded.status.sha256,personaVersion:this.persona.schema_version,provider:args.settings?.provider??'mock',prepared:false,startedAt:now()};
    const finish=stage=>{if(this.modelInput?.callId===callId){this.modelInput={...this.modelInput,stage,finishedAt:now()};this.update();}};
    this.update();
    try{
      const result=await this.model({...args,persona:loaded.persona,onProgress:phase=>{
        if(this.modelInput?.callId===callId&&!['completed','cancelled','failed'].includes(this.modelInput.stage))this.modelInput={...this.modelInput,transportTiming:{...this.modelInput.transportTiming,[phase.phase]:phase.elapsedMs}};
      },onPrepared:diagnostics=>{
        if(this.modelInput?.callId!==callId)return;
        this.modelInput={...this.modelInput,...diagnostics,stage:'prepared',prepared:true};this.update();
      }});
      if(args.signal?.aborted){this.modelHealth.release(healthToken);finish('cancelled');return {text:''};}
      this.modelHealth.success(healthToken);this.modelState={stage:'ready',message:'当前模型提供者调用已成功',checkedAt:new Date(this.nowMs()).toISOString()};
      if(this.modelInput?.callId===callId&&result.timing)this.modelInput.transportTiming=result.timing;
      finish('completed');return result;
    }catch(error){
      const failure=safeModelError(error,{cancelled:args.signal?.aborted===true});
      if(args.signal?.aborted)this.modelHealth.release(healthToken);
      else {this.modelHealth.failure(healthToken,failure);const health=this.modelHealth.snapshot();this.modelState={stage:'error',message:modelHealthMessage(health),errorCode:failure.code,actionRequired:health.actionRequired};}
      if(this.modelInput?.callId===callId)this.modelInput={...this.modelInput,errorCode:failure.code};
      finish(args.signal?.aborted?'cancelled':'failed');throw failure;
    }finally{this.activeModelCalls.delete(callId);this.modelHealth.release(healthToken);}
  }
  async checkModel(){
    const key='model_check';if(this.controllers.has(key))return;
    if(this.activeModelCalls.size)throw new ModelCallError('model_busy');
    const abort=new AbortController();this.controllers.set(key,abort);this.modelState={stage:'checking',message:'正在验证 AI 实际回复'};this.update();
    try{
      const reply=await this.runModel({settings:this.store.value.settings,session:{messages:[{role:'user',text:'用一句简短的话介绍你自己。'}]},memories:[],root:this.root,signal:abort.signal},'self_check');
      if(abort.signal.aborted)return;
      this.modelState={stage:'ready',message:reply.text,checkedAt:now()};this.event('模型提供者调用自检通过；Mock 仅代表本机演示');return reply.text;
    }catch(error){if(!abort.signal.aborted){const health=this.modelHealth.snapshot();this.modelState={stage:'error',message:modelHealthMessage(health),errorCode:error.code??'model_generation_failed',actionRequired:health.actionRequired};this.event('AI 自检未通过：'+(error.code??'model_generation_failed'));}throw error;}
    finally{this.controllers.delete(key);this.update();}
  }
  async start({acknowledgeUnknown=false}={}){
    if(this.stopping)await this.stopping;
    if(this.running)return;
    this.running=true;const generation=++this.generation;this.connection={stage:'connecting',account:deployment.account.displayName,message:'检查微信账号与兼容版本'};this.update();
    void this.refreshReadiness();
    // Local platform readiness must not wait for a cloud self-check.
    // New input verifies the configured provider; manual self-check stays explicit.
    if(this.modelState.stage==='unchecked'){this.modelState={stage:'unchecked',message:'当前模型尚未核验；新问题到来时尝试，或手动点击测试 AI。'};this.update();}
    if(this.running&&generation===this.generation)await this.connect(true,{acknowledgeUnknown});
  }
  schedule(ms){clearTimeout(this.timer);if(this.running)this.timer=setTimeout(()=>{void this.tick();},ms);}
  async connect(allowWindowOpen=false,{acknowledgeUnknown=allowWindowOpen}={}){
    if(!this.running)return;if(this.attempting){this.schedule(1000);return;}this.attempting=true;const generation=this.generation;let localBridge;
    try{
      this.gate.clear();this.ownIds.clear();this.invalidateAll('重新连接');if(acknowledgeUnknown){this.suspended.clear();this.store.change(s=>{for(const target of s.targets)target.quarantined=false;});}
      const targets=filterAuthorizedWechatTargets(this.store.value.targets,{enabledOnly:true});
      if(!targets.length)throw Error('没有启用的授权会话；请在本机配置会话并启用');
      localBridge=this.transportFactory();this.bridge=localBridge;localBridge.start();
      const connection=await localBridge.call('connect',{targets:targets.map(({id,name,kind,windowBinding})=>({id,name,kind,windowBinding}))});
      if(!this.running||generation!==this.generation)return;
      this.connection={...connection,stage:'connected',message:'已核对配置账号；仅处理连接后新出现的消息'};
      for(const target of targets){
        if(!this.running||generation!==this.generation)break;
        try{const snap=await localBridge.call('open',{group:target.name,allowForeground:allowWindowOpen});if(generation!==this.generation)return;this.store.change(s=>s.targets.find(x=>x.id===target.id).windowBinding=snap.windowBinding);this.gate.observe(target,snap);this.seedVisibleBackground(target,snap);this.targetStates[target.id]={stage:'listening',message:'监听中，启动可见内容仅作背景，不补发',lastRead:now()};}
        catch(error){this.targetStates[target.id]={stage:'error',message:error.message};}
      }
      this.event('微信连接已建立；各会话重新建立基线，未补发历史消息。');
    }catch(error){
      if(generation!==this.generation)return;
      this.connection={stage:'waiting',account:deployment.account.displayName,message:error.message};
      await localBridge?.stop();if(this.bridge===localBridge)this.bridge=null;this.update();
    }finally{this.attempting=false;if(generation===this.generation)this.schedule(this.bridge?1000:10000);}
  }
  async tick(){
    if(!this.running)return;if(this.polling){this.schedule(250);return;}if(!this.bridge){await this.connect();return;}
    this.polling=true;const pollStarted=performance.now();
    const generation=this.generation;const localBridge=this.bridge;
    try{
      await localBridge.call('health');
      for(const target of filterAuthorizedWechatTargets(this.store.value.targets,{enabledOnly:true})){
        if(!this.running||generation!==this.generation)break;
        try{
          const snapshot=await localBridge.call('read',{group:target.name});
          if(!this.running||generation!==this.generation)break;
          const observed=this.gate.observe(target,snapshot);const session=this.sessionFor(target.id);
          if(observed.gap||observed.baseline){this.invalidateSession(session?.id,observed.gap?'读取出现缺口':'窗口重新建立基线',{clearContext:true});this.seedVisibleBackground(target,snapshot);}
          this.targetStates[target.id]={...this.targetStates[target.id],stage:observed.gap?'gap':'listening',message:observed.gap?'可见消息不连续，已重新建立基线，未补发':snapshot.draft?'监听中；有手动草稿，发送将暂停':'监听中',lastRead:now()};
          const deferred=this.store.value.outbox.find(x=>x.sessionId===this.sessionFor(target.id)?.id&&x.status==='deferred');
          if(deferred){this.targetStates[target.id].stage='waiting_send';this.targetStates[target.id].message=deferred.note;}
          if(this.suspended.has(target.id)){this.targetStates[target.id].stage='error';this.targetStates[target.id].message='上次发送结果未确认，已暂停回复；核对微信后重新连接';}
          else for(const message of observed.messages){
            const ownText=this.store.value.outbox.some(x=>x.sessionId===this.sessionFor(target.id)?.id&&x.text===message.text&&Date.now()-Date.parse(x.createdAt)<180000);
            if(!this.ownIds.has(message.id)&&!ownText)this.ingest(target,message,snapshot);
          }
          if(target.paused){this.targetStates[target.id].stage='paused';this.targetStates[target.id].message='主人已暂停本群回复，其他群不受影响';}
          else if(session&&this.policy.state(session.id).waiting){this.targetStates[target.id].stage='waiting_input';this.targetStates[target.id].message='等待明确补充；超时不补发旧回答';}
        }catch(error){this.gate.rooms.delete(target.id);this.invalidateSession(this.sessionFor(target.id)?.id,'读取中断',{clearContext:true});this.targetStates[target.id]={stage:'error',message:error.message};}
      }
      if(!localBridge.child)throw Error('微信连接中断，等待重新登录');
      void this.runTasks();
      this.update();
    }catch(error){if(generation!==this.generation)return;await localBridge.stop();if(this.bridge===localBridge)this.bridge=null;this.gate.clear();this.invalidateAll('连接中断');this.connection={stage:'waiting',account:deployment.account.displayName,message:error.message};this.update();}
    finally{
      this.polling=false;const durationMs=performance.now()-pollStarted;
      const nextDelayMs=this.bridge?Math.max(250,1000-durationMs):10000;
      this.latency.poll={at:now(),durationMs:Math.round(durationMs),nextDelayMs:Math.round(nextDelayMs),targetIntervalMs:1000};
      if(generation===this.generation)this.schedule(nextDelayMs);
    }
  }
  invalidateSession(sessionId,reason,{clearContext=false,currentOnly=false,proactiveOnly=false}={}){
    if(!sessionId)return;
    if(!proactiveOnly){this.weather?.clear(sessionId);this.publicLookup.clear(sessionId);this.groupMedia.clear(sessionId);}
    const turn=this.turns.get(sessionId);
    const active=this.controllers.has(sessionId)||this.processing.has(sessionId);
    if(!proactiveOnly||turn?.kind==='proactive')this.controllers.get(sessionId)?.abort();
    if(currentOnly&&!active){
      // A batched request is already a cancellable turn even before its timer
      // starts the model. Remove its verified fragments, not independent asks.
      const queue=this.pending.get(sessionId)||[];const cancelled=[];
      if(queue.length){
        cancelled.push(queue.shift());let previous=this.store.value.inbox.find(x=>x.id===cancelled[0])?.event;
        while(queue.length){const next=this.store.value.inbox.find(x=>x.id===queue[0]);if(!canMergeFragment(previous,next?.event))break;cancelled.push(queue.shift());previous=next.event;}
      }
      this.pending.set(sessionId,queue);
      if(cancelled.length)this.store.change(s=>{for(const i of s.inbox.filter(x=>cancelled.includes(x.id))){i.status='skipped';i.reason=reason;}});
    }else if(!currentOnly){
      const queue=this.pending.get(sessionId)||[];
      const cancelled=queue.filter(id=>!proactiveOnly||this.store.value.inbox.find(x=>x.id===id)?.kind==='proactive');
      this.pending.set(sessionId,queue.filter(id=>!cancelled.includes(id)));
      this.store.change(s=>{for(const i of s.inbox.filter(x=>cancelled.includes(x.id))){i.status='skipped';i.reason=reason;}});
    }
    if(!proactiveOnly){clearTimeout(this.batchTimers.get(sessionId));this.batchTimers.delete(sessionId);}
    if(clearContext){this.context.clear(sessionId,reason);this.policy.clear(sessionId);}
    if(currentOnly&&!active&&this.running&&this.pending.get(sessionId)?.length){
      const target=this.store.value.targets.find(x=>this.sessionFor(x.id)?.id===sessionId);
      const next=this.store.value.inbox.find(x=>x.id===this.pending.get(sessionId)[0]);
      if(target&&next){const delay=next.event?.sender?.evidence==='stable_id'?Math.max(0,fragmentReadyAt([next.event],this.nowMs())-this.nowMs()):0;
        this.batchTimers.set(sessionId,setTimeout(()=>{this.batchTimers.delete(sessionId);void this.drain(target,sessionId);},delay));}
    }
  }
  invalidateAll(reason){for(const session of this.store.value.sessions)this.invalidateSession(session.id,reason,{clearContext:true});}
  seedVisibleBackground(target,snapshot){
    if(!isAuthorizedWechatTarget(target))return;
    const session=this.sessionFor(target.id);if(!session||!Array.isArray(snapshot?.messages))return;
    // This already-read visible snapshot is context only. It never enters the
    // trigger policy, inbox or reply queue, even if it contains calls/commands.
    for(const original of snapshot.messages.slice(-this.context.maxMessages)){
      const message=normalizeNativeMedia(original);
      if(message.klass!=='mmui::ChatTextItemView'&&message.inputModality?.kind!=='platform_transcript'||typeof message.text!=='string'||!message.text.trim()||!message.id)continue;
      if(message.own===true||message.role==='assistant'||this.ownIds.has(message.id))continue;
      const key=message.key||`${message.id}/${message.klass}/${message.text}`;
      this.context.observe(session.id,{id:message.id,sourceKey:`${snapshot.created}/${snapshot.hwnd}/${target.id}/${key}`,
        observationMode:'baseline',role:message.own===false?'user':'unknown',receivedAt:this.nowMs(),
        sender:message.sender||{evidence:'unknown'},text:message.text,inputModality:message.inputModality,attachments:message.attachments||[]});
    }
  }
  ingest(target,message,snapshot){
    if(!isAuthorizedWechatTarget(target))return;
    const session=this.sessionFor(target.id);if(!session)return;
    message=normalizeNativeMedia(message);
    if(message.inputModality?.kind==='voice_pending')return;
    const isText=message.klass==='mmui::ChatTextItemView'||message.inputModality?.kind==='platform_transcript';
    const event=this.context.observe(session.id,{...message,role:'user',sourceKey:`${snapshot.created}/${snapshot.hwnd}/${target.id}/${message.key||message.id}`,receivedAt:this.nowMs(),sender:message.sender||{evidence:'unknown'},attachments:message.attachments||[]});
    if(!event||!isText||!event.text.trim()||event.text.length>6000)return;
    const previousEngagement=this.policy.state(session.id).engagement;
    const decision=this.policy.decide({...target,sessionId:session.id,authorized:true},event,this.context);
    this.latency.decisions.push({at:now(),targetId:target.id,action:decision.action,reason:decision.reason,callEvidence:decision.callEvidence??null,textLength:event.text.length});
    this.latency.decisions=this.latency.decisions.slice(-50);
    // Diagnostic metadata only; no message body or sender identity in status.
    const outcome=decision.action==='reply'?'新消息已触发回复':decision.action==='clarify'?'新消息需要澄清':decision.action==='control'?'已处理对话控制':decision.reason==='owner_paused'?'新消息因暂停设置未回复':decision.reason==='waiting_for_complete_request'?'等待补充完整问题':'新消息作为背景，未触发回复';
    this.targetStates[target.id]={...this.targetStates[target.id],lastOutcome:outcome,lastDecision:{at:now(),action:decision.action,reason:decision.reason}};
    if(decision.waitingExpired)this.invalidateSession(session.id,'等待补充已超时');
    if(decision.action==='control'){
      this.applyControl(session.id,decision.control,{proactiveOnly:decision.proactiveOnly});
      if(decision.control==='continue'){
        const fragments=this.context.snapshot(session.id).messages.filter(x=>decision.fragments?.includes(x.sourceKey)).map(x=>x.text);
        const continued={...event,text:'请根据这些已经补充的条件回答：\n'+fragments.join('\n')};
        this.accept(target,{...message,event:continued,text:continued.text,key:message.key||message.id,kind:'continued'},snapshot);
      }
      if(decision.control==='change_topic'&&decision.nextRequestText){
        // Clearing the topic invalidates the previous event and any pending
        // answer. The question after the control belongs to the new context.
        const next=this.context.observe(session.id,{...event,text:decision.nextRequestText,generation:this.context.generation(session.id)});
        if(next)this.accept(target,{...message,event:next,text:next.text,key:message.key||message.id},snapshot);
      }
      return;
    }
    if(decision.action==='reply'||decision.action==='clarify'){
      if(decision.supersedesWaiting)this.invalidateSession(session.id,'新问题替代等待中的旧请求');
      const active=this.turns.get(session.id);
      if(active?.clarification&&supersedesClarification(active.item,{event:{...event,...(decision.engagement?{engagement:decision.engagement}:{})},replyReason:decision.reason}))this.invalidateSession(session.id,'新请求已替代旧澄清',{currentOnly:true});
      this.savePolicy(session.id);
      const presenceOnly=decision.reason==='social_summons'&&!decision.replyContext&&!event.quote&&!event.attachments?.length;
      const summonsContinuationKey=decision.reason==='social_summons'&&previousEngagement&&!previousEngagement.interrupted&&previousEngagement.generation===event.generation?previousEngagement.lastAcceptedKey:undefined;
      const accepted=this.accept(target,{...message,event:{...event,...(decision.replyContext?{replyContext:decision.replyContext}:{}),...(decision.engagement?{engagement:decision.engagement}:{})},replyReason:decision.reason,summonsContinuationKey,directReply:decision.clarification||(presenceOnly?'在呢':undefined),key:message.key||message.id},snapshot);
      // A redundant ping must not replace the pending question's reply/answer slot.
      if(accepted?.coalescedInto&&previousEngagement)this.policy.room(session.id).engagement={...previousEngagement,coalescedKeys:[...(previousEngagement.coalescedKeys??[]),event.sourceKey].slice(-30)};
      return;
    }
    // Active participation is scoped to a current, explicit question in an opted-in group.
    if(/[?？]/u.test(event.text)&&/(?:大家觉得|有没有人知道|谁知道|怎么办|怎么做|有没有建议)/u.test(event.text)){
      const evidence={kind:'current_topic',authorized:target.proactive?.ownerApproved===true,generation:event.generation,sourceKeys:[event.sourceKey],topic:event.text};
      const allowed=this.policy.proactiveDecision({...target,sessionId:session.id,authorized:true},this.context,{evidence,nowMs:this.nowMs()});
      if(allowed.allowed&&!this.processing.has(session.id)&&!(this.pending.get(session.id)?.length))this.accept(target,{...message,event,kind:'proactive',key:message.key||message.id},snapshot);
    }
  }
  applyControl(sessionId,control,{proactiveOnly=false}={}){
    if(['stop_current','wait','change_topic'].includes(control))this.policy.clearEngagement(sessionId);
    if(control==='stop_current')this.invalidateSession(sessionId,'停止本轮',{currentOnly:true});
    else if(control==='wait')this.invalidateSession(sessionId,'等待补充',{proactiveOnly});
    else if(control==='change_topic'){
      this.invalidateSession(sessionId,'换个话题',{clearContext:true});
      this.store.change(s=>{const row=s.sessions.find(x=>x.id===sessionId);if(row)row.messages=[];});
    }
    this.savePolicy(sessionId);this.update();
  }
  accept(target,message,snapshot){
    if(!isAuthorizedWechatTarget(target))return;
    const session=this.sessionFor(target.id);if(!session)return;
    const key=`${snapshot.created}/${snapshot.hwnd||0}/${target.id}/${message.key}`;
    if(this.store.value.inbox.some(x=>x.key===key))return;
    const id=uid();const queue=this.pending.get(session.id)||[];
    const event=message.event||this.context.observe(session.id,{...message,sourceKey:key,receivedAt:this.nowMs(),sender:message.sender||{evidence:'unknown'}})||{...message,sourceKey:key,receivedAt:this.nowMs(),sender:{evidence:'unknown'}};
    const active=this.turns.get(session.id),activeItem=active&&!active.controller.signal.aborted?active.item:null;
    const incoming={event,replyReason:message.replyReason,directReply:message.directReply,kind:message.kind||'reply'};
    // Sweep backwards only through the related tail. An independent question
    // is a boundary; a new "re-evaluate" must not erase earlier unrelated asks.
    const revised=[];
    let previousIncoming=incoming;
    for(let index=queue.length-1;index>=0;index--){
      const pendingItem=this.store.value.inbox.find(row=>row.id===queue[index]);
      if(!replyRevision(pendingItem,previousIncoming))break;
      revised.push(pendingItem);previousIncoming=pendingItem;queue.splice(index,1);
    }
    const reviseActive=activeItem&&!active.deliveryStarted&&queue.length===0&&replyRevision(activeItem,previousIncoming);
    if(reviseActive){
      revised.push(activeItem);active.supersededBy=id;active.controller.abort();
      this.weather?.clear(session.id);this.publicLookup.clear(session.id);
    }
    if(revised.length){
      event.revisionSourceKeys=[...new Set(revised.flatMap(row=>[...(row.event.revisionSourceKeys??[]),...(row.event.fragments??[]),row.event.sourceKey]))].slice(-30);
      this.latency.revisedReplies+=revised.length;
      this.store.change(s=>{for(const row of s.inbox.filter(row=>revised.some(old=>old.id===row.id))){row.status='skipped';row.reason='已合并到新的补充或重新提问';row.supersededBy=id;}});
    }
    const inFlight=[activeItem,...queue.map(id=>this.store.value.inbox.find(row=>row.id===id))].filter(Boolean);
    const observations=this.context.snapshot(session.id,{focusId:event.sourceKey}).messages;
    const coalesced=message.replyReason==='social_summons'&&!event.quote&&!event.attachments?.length&&inFlight.find(row=>{
      if(row.kind!=='reply'||row.event?.generation!==event.generation||event.receivedAt-row.event.receivedAt<0||event.receivedAt-row.event.receivedAt>=90000)return false;
      if(row.event.sender?.evidence==='stable_id'&&event.sender?.evidence==='stable_id'&&!sameVerifiedSender(row.event,event))return false;
      if(event.replyContext)return event.replyContext.sourceKey===(row.event.replyContext?.sourceKey??row.event.sourceKey);
      if(message.summonsContinuationKey===row.event.sourceKey&&row.replyReason==='engaged_group_followup')return true;
      if(row.replyReason!=='social_summons'||row.event.replyContext||row.event.quote||row.event.attachments?.length)return false;
      const from=observations.findIndex(item=>item.sourceKey===row.event.sourceKey),to=observations.findIndex(item=>item.sourceKey===event.sourceKey);
      return from>=0&&to>from&&observations.slice(from+1,to+1).every(item=>item.role==='user'&&!item.quote&&!item.attachments?.length&&isSocialSummons(item.text));
    });
    const availability=this.modelHealth.availability();
    const selfChecking=this.controllers.has('model_check');
    const modelEligible=!selfChecking&&['ready','unchecked','error'].includes(this.modelState.stage)&&availability.allowed;
    const eligible=!coalesced&&modelEligible&&queue.length<5;
    if(coalesced)this.latency.coalescedSummons++;
    this.store.change(s=>{
      s.inbox.push({id,key,sessionId:session.id,status:eligible?'queued':'skipped',reason:coalesced?'已有回答处理中，本次叫名合并':!modelEligible?(selfChecking?'model_self_check_busy':availability.code??'AI 尚未就绪'):queue.length>=5?'等待队列已满':'',...(coalesced?{coalescedInto:coalesced.id}:{}),createdAt:now(),event,replyReason:message.replyReason,directReply:message.directReply,kind:message.kind||'reply'});
      s.sessions.find(x=>x.id===session.id).messages.push({id:uid(),role:'user',text:message.text,createdAt:now(),source:'wechat',sourceKey:event.sourceKey,sender:event.sender});
    });
    if(eligible){queue.push(id);this.pending.set(session.id,queue);
      if(event.sender?.evidence==='stable_id'){
        clearTimeout(this.batchTimers.get(session.id));const first=this.store.value.inbox.find(x=>x.id===queue[0])?.event||event;
        const delay=Math.max(0,fragmentReadyAt([first,event],this.nowMs())-this.nowMs());
        this.batchTimers.set(session.id,setTimeout(()=>{this.batchTimers.delete(session.id);void this.drain(target,session.id);},delay));
      }else void this.drain(target,session.id);
    }
    this.update();return {id,coalescedInto:coalesced?.id??null};
  }
  async drain(target,sessionId){
    if(!this.scopedTargetSession(target,sessionId))return;
    if(this.processing.has(sessionId))return;
    const queue=this.pending.get(sessionId);if(!queue?.length||!this.running||this.suspended.has(target.id))return;
    const currentTarget=this.store.value.targets.find(t=>t.id===target.id);if(currentTarget?.paused||this.policy.state(sessionId).waiting)return;
    this.processing.add(sessionId);const ids=[queue.shift()];const generation=this.generation;
    let item=this.store.value.inbox.find(x=>x.id===ids[0]);
    if(!item){this.processing.delete(sessionId);return;}
    const events=[item.event];
    while(queue.length){const next=this.store.value.inbox.find(x=>x.id===queue[0]);if(!next||!canMergeFragment(events.at(-1),next.event))break;ids.push(queue.shift());events.push(next.event);}
    if(events.length>1)item={...item,event:{...item.event,text:events.map(x=>x.text).join('\n'),fragments:events.map(x=>x.sourceKey)}};
    const controller=new AbortController();this.controllers.set(sessionId,controller);
    const turn={controller,epoch:this.store.session(sessionId).epoch,contextGeneration:this.context.generation(sessionId),generation,kind:item.kind||'reply',item,startedAt:performance.now(),queueMs:Math.max(0,this.nowMs()-item.event.receivedAt)};this.turns.set(sessionId,turn);
    this.store.change(s=>{for(const i of s.inbox.filter(x=>ids.includes(x.id)))i.status='generating';});
    try{
      const reply=item.directReply||await this.reply(sessionId,{turn,request:item.event,kind:item.kind,target});
      turn.answerReadyAt=performance.now();
      turn.clarification ||= isMissingDetailQuestion(reply);
      if(turn.clarification&&(this.pending.get(sessionId)||[]).some(id=>supersedesClarification(item,this.store.value.inbox.find(row=>row.id===id)))){
        this.weather?.clear(sessionId);this.publicLookup.clear(sessionId);controller.abort();
      }
      if(!reply||!this.validTurn(sessionId,turn)){this.store.change(s=>{for(const i of s.inbox.filter(x=>ids.includes(x.id)&&x.status==='generating')){i.status='skipped';i.reason=reply?'本轮已取消':'本轮保持安静';}});return;}
      const plan=planTextReply(reply,{splitReplies:currentTarget?.preferences?.splitReplies===true});
      turn.deliveryStarted=true;
      let finalStatus='completed';
      for(const part of plan.parts){
        if(!this.validTurn(sessionId,turn)){finalStatus='skipped';break;}
        const out={id:uid(),sessionId,epoch:turn.epoch,contextGeneration:turn.contextGeneration,text:part.text,createdAt:now(),status:'prepared',kind:turn.kind,requestIds:ids,part:part.index};
        this.store.change(s=>s.outbox.push(out));
        const result=await this.deliver(target,out,generation,{signal:controller.signal});
        if(!result||!this.running||generation!==this.generation)return;
        this.recordDelivery(target,sessionId,out,result,item.event);
        if(result.status!=='local_echo'){finalStatus=result.status==='unknown'?'uncertain':'error';break;}
      }
      this.store.change(s=>{for(const i of s.inbox.filter(x=>ids.includes(x.id)))i.status=finalStatus;});
    }catch(error){this.store.change(s=>{for(const i of s.inbox.filter(x=>ids.includes(x.id))){i.status=controller.signal.aborted?'skipped':'error';i.reason=controller.signal.aborted?'本轮已取消':error.message;}});if(!controller.signal.aborted)this.event(`${target.name}：${error.message}`);}
    finally{
      const finished=performance.now();
      const timing={at:now(),requestId:item.id,sessionId,responsePath:item.directReply?(item.replyReason==='social_summons'?'presence':'clarification'):(turn.responsePath||'model_or_service'),queueMs:Math.round(turn.queueMs),answerMs:Math.round((turn.answerReadyAt??finished)-turn.startedAt),deliveryMs:turn.answerReadyAt===undefined?0:Math.round(finished-turn.answerReadyAt),totalAfterObservationMs:Math.round(turn.queueMs+finished-turn.startedAt),linkedPreviousQuestion:!!item.event.replyContext,engagedFollowup:item.event.engagement?.relation==='current_group_topic',status:this.store.value.inbox.find(row=>row.id===item.id)?.status??'unknown'};
      if(turn.researchTiming)timing.research={...turn.researchTiming};
      this.latency.recent.push(timing);this.latency.recent=this.latency.recent.slice(-20);
      if(this.controllers.get(sessionId)===controller)this.controllers.delete(sessionId);
      if(this.turns.get(sessionId)===turn)this.turns.delete(sessionId);
      this.processing.delete(sessionId);this.update();
      // An aborted model can finish after Stop -> Start. It must not send its
      // old answer, but releasing its slot must let the current run proceed.
      const currentTarget=this.store.value.targets.find(x=>x.id===target.id&&x.enabled&&x.name===target.name&&x.kind===target.kind&&(!target.windowBinding||!x.windowBinding||x.windowBinding===target.windowBinding));
      if(this.running&&currentTarget&&this.sessionFor(currentTarget.id)?.id===sessionId&&this.pending.get(sessionId)?.length)void this.drain(currentTarget,sessionId);
    }
  }
  validTurn(sessionId,turn){return !turn.controller.signal.aborted&&this.running&&turn.generation===this.generation&&this.store.session(sessionId)?.epoch===turn.epoch&&this.context.generation(sessionId)===turn.contextGeneration;}
  recordDelivery(target,sessionId,out,result,event){
    for(const id of result.ids||[])this.ownIds.add(id);
    if(this.ownIds.size>1000)this.ownIds=new Set([...this.ownIds].slice(-500));
    this.store.change(s=>{Object.assign(s.outbox.find(x=>x.id===out.id),{status:result.status,note:result.note});if(result.status==='local_echo')s.sessions.find(x=>x.id===sessionId).messages.push({id:out.id,role:'assistant',text:out.text,createdAt:now(),status:'local_echo'});});
    if(result.status==='local_echo'&&(out.contextGeneration===undefined||out.contextGeneration===this.context.generation(sessionId))&&(out.epoch===undefined||out.epoch===this.store.session(sessionId)?.epoch)){
      this.context.observe(sessionId,{id:out.id,sourceKey:out.id,text:out.text,generation:out.contextGeneration,receivedAt:this.nowMs(),role:'assistant',status:'local_echo',inReplyToSourceKey:event?.sourceKey});
      this.policy.noteReply(sessionId,event||{sender:{evidence:'unknown'}},{confirmed:true,generation:this.context.generation(sessionId),nowMs:this.nowMs(),replyText:out.text,replySourceKey:out.id});
      this.weather?.noteDelivery(sessionId,event,out,result);
      this.publicLookup.noteDelivery(sessionId,event,out,result);
    }
    if(out.kind==='proactive'){this.policy.recordProactive(sessionId,{outboxId:out.id,status:result.status,nowMs:this.nowMs()});this.savePolicy(sessionId);}
    this.targetStates[target.id]={...this.targetStates[target.id],lastReply:now(),lastOutcome:result.status==='local_echo'?'后台发送，本机气泡已确认':result.status==='not_sent'?'本条未发送：'+result.note:'发送结果未确认；不会自动重发'};
    if(result.status==='unknown'){this.suspended.add(target.id);this.store.change(s=>{const current=s.targets.find(x=>x.id===target.id);if(current)current.quarantined=true;});this.invalidateSession(sessionId,'发送结果未确认');this.event(`${target.name}：${result.note}；已暂停该会话回复`);}
    else if(result.status==='not_sent')this.event(`${target.name}：本条未发送，${result.note}`);
  }
  async deliver(target,out,generation,{retryMs=3000,maxWaitMs=180000,signal}={}){
    assertAuthorizedWechatTarget(target);assertConversationScope(this.store.session(out.sessionId),this.store.value.targets);
    if(!this.scopedTargetSession(target,out.sessionId))return {status:'not_sent',note:'会话授权或目标映射已变化，本条取消',ids:[]};
    const deadline=Date.now()+maxWaitMs;
    while(this.running&&generation===this.generation){
      if(Date.now()>=deadline)return {status:'not_sent',note:'等待手动操作结束已超过三分钟，本条取消',ids:[]};
      if(signal?.aborted)return {status:'not_sent',note:'本轮已取消，未继续发送',ids:[]};
      if(!this.scopedTargetSession(target,out.sessionId))return {status:'not_sent',note:'会话授权或目标映射已变化，本条取消',ids:[]};
      if(out.contextGeneration!==undefined&&this.context.generation(out.sessionId)!==out.contextGeneration)return {status:'not_sent',note:'对话背景已改变，本条取消',ids:[]};
      if(this.store.value.targets.find(t=>t.id===target.id)?.paused)return {status:'not_sent',note:'本群已暂停',ids:[]};
      if(out.epoch!==undefined&&this.store.session(out.sessionId)?.epoch!==out.epoch)return {status:'not_sent',note:'会话已重置，本条取消',ids:[]};
      this.store.change(s=>Object.assign(s.outbox.find(x=>x.id===out.id),{status:'sending'}));
      let result;
      const beforeSubmit=()=>this.running&&generation===this.generation&&!signal?.aborted&&Date.now()<deadline&&this.scopedTargetSession(target,out.sessionId)&&(out.epoch===undefined||this.store.session(out.sessionId)?.epoch===out.epoch)&&(out.contextGeneration===undefined||this.context.generation(out.sessionId)===out.contextGeneration)&&!this.suspended.has(target.id)&&!this.store.value.targets.find(t=>t.id===target.id)?.paused;
      try{result=await this.bridge.call('send',{group:target.name,text:out.text},20000,{signal,beforeSubmit});}
      catch(error){result={status:error.sendNotSubmitted?'not_sent':'unknown',note:error.message,ids:[]};}
      if(!this.running||generation!==this.generation)return null;
      if(!result||typeof result!=='object'||!['local_echo','unknown','not_sent','deferred'].includes(result.status))return {status:'unknown',note:'接口返回未识别的发送状态',ids:[]};
      if(result.status!=='deferred')return result;
      // A deferred result has submitted no send event. Any exact bot-owned
      // temporary draft has been cleared; only this state may be retried.
      if(Date.now()>=deadline)return {status:'not_sent',note:'等待手动操作结束已超过三分钟，本条取消',ids:[]};
      this.store.change(s=>Object.assign(s.outbox.find(x=>x.id===out.id),{status:'deferred',note:result.note}));
      this.targetStates[target.id]={...this.targetStates[target.id],stage:'waiting_send',message:result.note};this.update();
      // Short slices let Stop/reconnect finish promptly, without any old send.
      const resume=Date.now()+retryMs;
      while(this.running&&generation===this.generation&&!signal?.aborted&&Date.now()<resume)await new Promise(resolve=>setTimeout(resolve,Math.min(100,resume-Date.now())));
    }
    return null;
  }
  async serviceReply(sessionId,request,{signal,target,owner=false}={}){
    assertConversationScope(this.store.session(sessionId),this.store.value.targets,{allowLocalOwner:owner});
    if(target&&!this.scopedTargetSession(target,sessionId))throw Error('会话与授权目标不一致');
    const session=this.store.session(sessionId);const text=request?.text||'';const body=classifyAddress(text,this.policy.names).text;
    const memoryIntent=parseMemoryIntent(body);
    if(memoryIntent){
      const rows=queryMemories(this.store.value,{sessionId,actor:owner?OWNER:{}});
      const list=rows.slice(0,12).map(x=>`${x.id.slice(0,8)}：${x.text}`).join('\n');
      if(memoryIntent.type==='query')return rows.length?`这个会话已确认的共同记忆：\n${list}${rows.length>12?'\n其余条目可在客户端查看。':''}`:'这个会话还没有已确认的共同记忆。';
      if(memoryIntent.type==='clarify')return `${memoryIntent.message}${list?'\n'+list:''}`;
      const memoryId=memoryIntent.memoryId?findShort(rows,memoryIntent.memoryId):undefined;
      const options={sessionId,text:memoryIntent.text,action:memoryIntent.action,memoryId,source:{eventId:request.sourceKey,originalText:text},sender:request.sender,actor:owner?OWNER:{},expectedEpoch:session.epoch,expectedMemoryEpoch:session.memoryEpoch,now:this.nowMs()};
      let result;
      this.store.change(s=>{result=proposeMemory(s,options);if(result.ok&&owner)result=approveMemory(s,result.candidate.id,{actor:OWNER,now:this.nowMs()});
        if(result.ok&&owner&&memoryIntent.action!=='add')s.sessions.find(x=>x.id===sessionId).historyCutoffAt=this.nowMs();});
      if(!result.ok)return reasonText[result.code]||`这条记忆暂未保存：${result.code}`;
      // This local command itself owns the controller. Clear old facts without
      // aborting its durable confirmation or changing the current turn epoch.
      if(owner&&memoryIntent.action!=='add'){this.context.clear(sessionId,'记忆已修改');this.policy.clear(sessionId);}
      this.update();
      return owner?'记忆操作已保存。':'已提交给主人确认；确认前还不算长期记住。';
    }
    const taskIntent=parseTaskIntent(body,{now:this.nowMs(),timeZone:'Asia/Shanghai'});
    if(taskIntent){
      if(taskIntent.type==='clarify')return taskIntent.message;
      if(taskIntent.type==='list'){const tasks=queryTasks(this.store.value,{sessionId}).filter(x=>!['cancelled','not_sent'].includes(x.status));return tasks.length?tasks.slice(-10).map(x=>`${x.id.slice(0,8)}：${x.dueAt} ${x.text}（${x.status}）`).join('\n'):'这个会话还没有提醒。';}
      if(taskIntent.type==='cancel'){
        if(!owner)return '取消提醒需要在本机客户端由主人确认；群里自称身份不能代替确认。';
        const id=findShort(queryTasks(this.store.value,{sessionId}),taskIntent.id);let result;this.store.change(s=>{result=cancelReminder(s,id,{actor:OWNER,sessionId,now:this.nowMs()});});this.update();return result.ok?'提醒已取消。':reasonText[result.code]||'没有找到可取消的提醒。';
      }
      if(taskIntent.type==='reminder'){
        if(!target)return '请在客户端“任务与提醒”选择微信会话，再创建提醒。';
        let result;this.store.change(s=>{result=createReminder(s,{...taskIntent,sessionId,targetId:target.id,actor:owner?OWNER:{},source:{eventId:request.sourceKey},requestId:request.sourceKey,expectedEpoch:session.epoch,now:this.nowMs()});});this.update();
        return result.ok?`${owner?'提醒已保存':'提醒已提交给主人确认，尚未启用'}：${taskIntent.dueAt}，${taskIntent.text}。`:reasonText[result.code]||`提醒未建立：${result.code}`;
      }
      if(taskIntent.type==='search'){
        if(!this.store.value.settings.allowSearch)return '联网查询尚未启用。主人可在客户端“模型与启动”开启；我不会把离线回答说成刚查到的资料。';
        const lookup=inspectWebIntent(body);if(!lookup.intent)return '给我一个明确的公开名称或关键词，我再查一下';
        try{const result=await this.search({query:lookup.intent.query,settings:this.searchModelSettings(),root:this.root,signal});return result.text;}
        catch(error){if(signal?.aborted)throw error;return '这次没有完成可核验的联网查询。'+(error.code==='search_unavailable'?'当前后端没有接入搜索能力。':'请稍后再试；没有将旧知识当作搜索结果。');}
      }
    }
    const mediaIntent=classifyMediaRequest(body);
    if(mediaIntent.image&&mediaIntent.voiceInput)return '图和语音都提到了，你想先看哪一个？';
    if(mediaIntent.image||mediaIntent.voiceInput){
      const kind=mediaIntent.voiceInput?'audio':'image';
      const snapshot=this.context.snapshot(sessionId);const candidate=snapshot.messages.slice().reverse().find(x=>x.attachments?.some(a=>a.kind===kind));
      if(kind==='audio'&&snapshot.messages.some(x=>x.inputModality?.kind==='platform_transcript'&&this.nowMs()-x.receivedAt<300000))return null;
      if(candidate){const attachment=candidate.attachments.find(a=>a.kind===kind);const result=await this.media.analyze({sessionId,messageId:candidate.id,handle:attachment.resourceId,kind},{signal});if(result.ok)return result.uncertain?'这段语音有听不准的部分，请确认：'+result.text:result.text;}
      return kind==='image'?'这张图我这边还没取到，先在电脑微信里点开让它下载一下，再叫我看看':'这条语音还没转出文字，在微信里点一下“转文字”，我就能接着看';
    }
    return null;
  }
  async reply(sessionId,{turn,request,kind,target}={}){
    const session=this.store.session(sessionId);if(!session)throw Error('会话不存在');
    assertConversationScope(session,this.store.value.targets,{allowLocalOwner:session.channel==='local'});
    if(target&&!this.scopedTargetSession(target,sessionId))throw Error('会话与授权目标不一致');
    if(this.controllers.has(sessionId)&&!turn)throw Error('该会话正在生成，请等待或停止');
    const epoch=session.epoch;const abort=turn?.controller||new AbortController();if(!turn)this.controllers.set(sessionId,abort);this.update();
    try{
      const currentRequest=request||{text:session.messages.filter(x=>x.role==='user').at(-1)?.text||'',sourceKey:uid(),sender:{evidence:'unknown'}};
      const body=classifyAddress(currentRequest.text,this.policy.names).text;
      const engaged=currentRequest.engagement?.relation==='current_group_topic';
      const intent=parseTaskIntent(body);
      const mediaIntent=classifyMediaRequest(body);
      const mediaInput=kind!=='proactive'&&this.mediaCapabilityStatus().modelVision&&this.groupMedia.wants(session,currentRequest)?await this.groupMedia.prepare({session,request:currentRequest,connection:this.connection,signal:abort.signal}):null;
      let research=null;
      if(abort.signal.aborted||this.store.session(sessionId)?.epoch!==epoch)return null;
      if(!mediaInput&&this.store.value.settings.allowSearch===true&&!['proactive','continued'].includes(kind)&&!currentRequest.quote&&!currentRequest.attachments?.length&&!currentRequest.textTruncated){
        const weather=session.channel==='desktop_wechat'?await this.weather?.reply({sessionId,request:currentRequest,snapshot:this.context.snapshot(sessionId,{focusId:currentRequest.sourceKey}),epoch,signal:abort.signal,isCurrent:()=>!abort.signal.aborted&&this.store.session(sessionId)?.epoch===epoch&&(!turn||this.validTurn(sessionId,turn))}):null;
        if(abort.signal.aborted||this.store.session(sessionId)?.epoch!==epoch)return null;
        if(weather){if(turn){turn.responsePath='weather';turn.clarification=weather.kind==='clarification';turn.networkStatus=weather.status;}return weather.text;}
        const researchPlan=planContextResearch(currentRequest,session.channel==='desktop_wechat'?this.context.snapshot(sessionId,{focusId:currentRequest.sourceKey}):null);
        if(researchPlan?.kind==='clarification'){if(turn){turn.responsePath='research_clarification';turn.clarification=true;}return researchPlan.text;}
        if(researchPlan?.kind==='research'){
          if(turn)turn.responsePath='public_research';
          const lookupStarted=performance.now();
          try{
            research=this.publicResearchCache.get(researchPlan);
            if(!research){
            const found=await this.search({query:researchPlan.query,settings:this.searchModelSettings(),root:this.root,signal:abort.signal});
            research=researchEvidence(researchPlan,found);
            if(!abort.signal.aborted&&this.store.session(sessionId)?.epoch===epoch)this.publicResearchCache.put(researchPlan,research);
            }
          }catch(error){if(abort.signal.aborted)throw error;research={topic:researchPlan.topic,status:'failed',reason:error.code==='search_unavailable'?'unavailable':'unverified'};}
          if(turn)turn.researchTiming={topic:researchPlan.topic,searchMs:Math.round(performance.now()-lookupStarted),status:research.status,reused:research.reused===true};
          if(abort.signal.aborted||this.store.session(sessionId)?.epoch!==epoch)return null;
        }
        if(!research){
        const plan=session.channel==='desktop_wechat'?this.publicLookup.plan({sessionId,request:currentRequest,snapshot:this.context.snapshot(sessionId,{focusId:currentRequest.sourceKey}),epoch}):null;
        if(plan?.kind==='clarification'){if(turn){turn.responsePath='lookup_clarification';turn.clarification=true;}return plan.text;}
        const lookup=plan?.kind==='search'?{intent:{query:plan.query,reason:'confirmed_public_query_followup'}}:inspectWebIntent(body);
        if(lookup.intent){
          if(turn)turn.responsePath='web_search';
          try{
            const found=await this.search({query:lookup.intent.query,settings:this.searchModelSettings(),root:this.root,signal:abort.signal});
            if(abort.signal.aborted||this.store.session(sessionId)?.epoch!==epoch)return null;
            return found.text;
          }catch(error){if(abort.signal.aborted)throw error;return error.code==='search_unavailable'?'这个模型后端还没接上搜索，切回已验证的 Codex 查询后端就能查':'这次联网没查到可核对的结果，稍后可以再试';}
        }
        if(lookup.blocked&&intent?.type==='search')return '给我一个明确的公开名称或关键词，我再查一下';
        }
      }
      const needsService=!research&&!mediaInput?.images?.length&&kind!=='continued'&&((!engaged&&(parseMemoryIntent(body)||intent&&intent.type!=='summary'))||mediaIntent.image||mediaIntent.voiceInput);
      const service=needsService?await this.serviceReply(sessionId,currentRequest,{signal:abort.signal,target,owner:session.channel==='local'}):null;
      if(abort.signal.aborted||this.store.session(sessionId)?.epoch!==epoch)return null;
      if(service!==null)return service;
      const copied=structuredClone(session);copied.preferences=target?.preferences||session.preferences||{style:this.store.value.settings.style??'natural'};
      copied.capabilities={webSearch:this.searchEnabled(),weather:this.store.value.settings.allowSearch===true&&!!this.weather};
      copied.groupProfile=loadGroupProfile(this.root,session);
      if(research)copied.publicResearch=research;
      if(session.channel==='desktop_wechat'){copied.context=this.context.snapshot(sessionId,{focusId:currentRequest.sourceKey});copied.request=currentRequest;}
      else if(Number.isFinite(session.historyCutoffAt))copied.request=currentRequest;
      const task=parseTaskIntent(classifyAddress(currentRequest.text,this.policy.names).text);
      if(!engaged&&task?.type==='summary')copied.taskInstruction={kind:'summary'};
      if(engaged)copied.taskInstruction={kind:'engaged'};
      if(kind==='proactive')copied.taskInstruction={kind:'proactive'};
      const result=await this.runModel({settings:{...structuredClone(this.store.value.settings),webSearch:false},session:copied,memories:queryMemories(this.store.value,{sessionId}),mediaInput,root:this.root,signal:abort.signal});
      if(abort.signal.aborted||this.store.session(sessionId)?.epoch!==epoch)return null;
      if(kind==='proactive'&&result.text.trim()==='<xiaoxi-stay-silent/>')return null;
      if(engaged&&result.text.trim()==='<xiaoxi-stay-silent/>'){
        // A later invitation or accepted followup owns the current window.
        // Finishing this older turn must not close that newer conversation.
        const activeEngagement=this.policy.state(sessionId).engagement;
        if(activeEngagement?.lastAcceptedKey===currentRequest.sourceKey)this.policy.clearEngagement(sessionId);
        return null;
      }
      if(!engaged&&mediaIntent.voiceOutput){
        const voicePlan=await this.voice.generate({text:result.text,requestId:`xiaoxi:${uid()}`,signal:abort.signal,deadlineMs:this.nowMs()+1000});
        if(abort.signal.aborted||this.store.session(sessionId)?.epoch!==epoch)return null;
        if(voicePlan.kind==='none')return null;
        return '这次先用文字回复；小汐的微信语音发送还未验证可用。\n'+voicePlan.text;
      }
      return result.text;
    }finally{if(!turn&&this.controllers.get(sessionId)===abort)this.controllers.delete(sessionId);this.update();}
  }
  async localChat(sessionId,text){
    const s=this.store.session(sessionId);if(!s||s.channel!=='local')throw Error('仅限本地试聊');
    if(typeof text!=='string'||!text.trim()||text.length>6000)throw Error('请输入1至6000字');
    const request={id:uid(),sourceKey:uid(),text:text.trim(),receivedAt:this.nowMs(),sender:{id:'local_owner',evidence:'stable_id'}};
    const decision=this.policy.decide({id:sessionId,sessionId,enabled:true,kind:'contact',mode:'all'},request,this.context);
    if(decision.action==='control'){
      this.applyControl(sessionId,decision.control);
      if(!decision.nextRequestText)return '对话控制已处理。';
      request.text=decision.nextRequestText;
      if(this.controllers.get(sessionId)?.signal.aborted)this.controllers.delete(sessionId);
    }
    if(this.controllers.has(sessionId))throw Error('正在生成，请等待或停止');
    this.store.change(state=>state.sessions.find(x=>x.id===sessionId).messages.push({id:uid(),role:'user',text:request.text,createdAt:now()}));this.update();
    const answer=await this.reply(sessionId,{request});
    if(answer)this.store.change(state=>state.sessions.find(x=>x.id===sessionId).messages.push({id:uid(),role:'assistant',text:answer,createdAt:now()}));this.update();return answer;
  }
  async runTasks(){
    if(this.taskRunning||!this.running||!this.bridge)return;this.taskRunning=true;
    try{
      for(const task of this.store.value.tasks.filter(x=>x.status==='scheduled'&&Date.parse(x.dueAt)<=this.nowMs())){
        if(!this.running||!this.bridge)break;
        const target=this.store.value.targets.find(x=>x.id===task.targetId);const session=this.store.session(task.sessionId);
        if(!target||!session||!isAuthorizedWechatTarget(target)||!inspectConversationScope(session,this.store.value.targets).allowed||this.sessionFor(target.id)?.id!==session.id){
          this.store.change(s=>{const row=s.tasks.find(x=>x.id===task.id);if(row?.status==='scheduled')Object.assign(row,{status:'not_sent',reason:'target_unavailable',completedAt:new Date(this.nowMs()).toISOString()});});
          continue;
        }
        if(this.nowMs()-Date.parse(task.dueAt)>60000){this.store.change(s=>claimReminder(s,task.id,{now:this.nowMs()}));continue;}
        if(!target.enabled||target.paused||target.mode==='observe'||this.suspended.has(target.id)||this.processing.has(session.id)||this.policy.state(session.id).waiting)continue;
        const controller=new AbortController();const generation=this.generation;
        const turn={controller,generation,epoch:session.epoch,contextGeneration:this.context.generation(session.id),kind:'reminder',taskId:task.id};
        this.controllers.set(session.id,controller);this.turns.set(session.id,turn);this.processing.add(session.id);
        let claimed;
        try{
          this.store.change(s=>{claimed=claimReminder(s,task.id,{now:this.nowMs()});});if(!claimed.ok)continue;
          const out={id:uid(),sessionId:session.id,epoch:session.epoch,contextGeneration:turn.contextGeneration,text:`提醒：${task.text}`,createdAt:now(),status:'prepared',kind:'reminder',taskId:task.id};
          this.store.change(s=>s.outbox.push(out));
          const result=await this.deliver(target,out,generation,{signal:controller.signal,maxWaitMs:Math.max(1,60000-(this.nowMs()-Date.parse(task.dueAt)))});
          if(!result)continue;
          this.store.change(s=>settleReminder(s,task.id,{attemptId:claimed.task.attemptId,status:result.status,now:this.nowMs()}));
          this.recordDelivery(target,session.id,out,result);
        }finally{
          if(this.controllers.get(session.id)===controller)this.controllers.delete(session.id);
          if(this.turns.get(session.id)===turn)this.turns.delete(session.id);
          this.processing.delete(session.id);
          if(this.running&&this.pending.get(session.id)?.length)void this.drain(target,session.id);
        }
      }
    }catch(error){this.event('提醒处理暂停：'+error.message);}
    finally{this.taskRunning=false;this.update();}
  }
  stop(){
    if(this.stopping)return this.stopping;
    const task=(async()=>{
      this.running=false;this.generation++;clearTimeout(this.timer);this.timer=null;
      for(const controller of this.controllers.values())controller.abort();this.modelHealth.cancelAll();this.pending.clear();
      if(this.modelState.stage==='checking')this.modelState={stage:'unchecked',message:'模型自检已停止；尚未完成核验'};
      this.weather?.clearAll();
      this.publicLookup.clearAll();
      this.groupMedia.clear();
      for(const timer of this.batchTimers.values())clearTimeout(timer);this.batchTimers.clear();this.context.clearAll('停止连接');this.policy.clearAll();
      // Kill pending native work first: stopping must not wait behind a slow UIA call.
      const bridge=this.bridge;this.bridge=null;await bridge?.kill();
      this.gate.clear();this.store.change(s=>{recoverInterrupted(s);recoverTasks(s,{now:this.nowMs()});});
      this.connection={stage:'stopped',account:deployment.account.displayName,message:'监听已停止，兼容守护进程将恢复开关'};this.update();
    })();
    this.stopping=task;
    const finished=()=>{if(this.stopping===task)this.stopping=null;};
    task.then(finished,finished);return task;
  }
  async dispatch(action,p={}){
    if(action==='snapshot')return this.snapshot();
    if(action==='start'){void this.start();return true;}
    if(action==='stop'){await this.stop();return true;}
    if(action==='model.check')return await this.checkModel();
    if(action==='voice.status')return await this.refreshReadiness();
    if(action==='chat')return await this.localChat(p.sessionId,p.text);
    if(action==='cancel'){if(this.store.session(p.sessionId))this.policy.clearEngagement(p.sessionId);this.invalidateSession(p.sessionId,'主人停止本轮',{currentOnly:true});return true;}
    if(action==='session.control'){
      if(!this.store.session(p.sessionId)||!['stop_current','wait','change_topic'].includes(p.control))throw Error('对话控制无效');
      if(p.control==='wait')this.policy.decide({sessionId:p.sessionId,id:p.sessionId,enabled:true},{id:uid(),text:'小汐，等我说完',receivedAt:this.nowMs(),sender:{id:'local_owner',evidence:'stable_id'}},this.context);
      this.applyControl(p.sessionId,p.control);return true;
    }
    if(action==='target.pause'){
      const target=this.store.value.targets.find(x=>x.id===p.id);if(!target)throw Error('会话不存在');
      this.store.change(s=>{s.targets.find(x=>x.id===p.id).paused=!!p.paused;});if(p.paused){const sessionId=this.sessionFor(p.id)?.id;if(sessionId)this.policy.clearEngagement(sessionId);this.invalidateSession(sessionId,'主人暂停本群');}
      this.update();return true;
    }
    if(action==='target.acknowledge'){
      const target=this.store.value.targets.find(x=>x.id===p.id);if(!target)throw Error('会话不存在');
      assertAuthorizedWechatTarget(target);
      const bridge=this.bridge,generation=this.generation;
      // Keep the group quarantined until its current baseline is captured.
      // Clearing the gate and returning first swallowed the next live poll.
      let baseline;
      if(this.running&&bridge){
        baseline=await bridge.call('read',{group:target.name});
        if(!this.running||this.bridge!==bridge||this.generation!==generation)throw Error('恢复期间连接已变化，请重新核对后恢复');
        if(target.windowBinding&&baseline.windowBinding!==target.windowBinding)throw Error('恢复期间会话身份已变化，未解除隔离');
      }
      this.invalidateSession(this.sessionFor(p.id)?.id,'主人已核对未确认发送',{clearContext:true});
      this.gate.rooms.delete(p.id);
      if(baseline){this.gate.observe(target,baseline);this.seedVisibleBackground(target,baseline);}
      this.store.change(s=>{s.targets.find(x=>x.id===p.id).quarantined=false;});this.suspended.delete(p.id);
      this.event(`${target.name}：主人已核对，接收基线已就绪；旧回答未重发`);return true;
    }
    if(action==='deployment.get')return loadDeployment();
    if(action==='deployment.save'){await this.stop();const saved=saveDeployment(p);this.update();return saved;}
    if(action==='persona.save'){
      const aliases=p.aliases===undefined?this.policy.names:validateAliases(p.aliases);if(p.style!==undefined&&!['natural','concise','detailed'].includes(p.style))throw Error('style_invalid');
      validatePersona(p.persona);const body=JSON.stringify(p.persona,null,2)+'\n';if(Buffer.byteLength(body)>128*1024)throw Error('persona_too_large');
      const file=path.join(this.root,'character_card.local.json');if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('persona_file_invalid');
      fs.writeFileSync(file+'.new',body,{mode:0o600,flush:true});fs.renameSync(file+'.new',file);
      this.store.change(s=>{s.settings.aliases=aliases;s.settings.style=p.style??s.settings.style??'natural';});this.policy.names=aliases;
      const loaded=this.personaLoader.reload();this.persona=loaded.persona;this.personaStatus=loaded.status;this.update();return {saved:true,sha256:loaded.status.sha256};
    }
    if(action==='extension.call'){if(!this.extensions)throw new UnsupportedCapability(p.capability);return this.extensions.call(p.capability,p.input);}
    if(action==='settings.save'){
      const settings=validateModelSettings(p);const aliases=validateAliases(p.aliases??this.policy.names);
      if(p.style!==undefined&&!['natural','concise','detailed'].includes(p.style))throw Error('style_invalid');
      await this.stop();
      this.store.change(s=>{s.settings={...settings,aliases,style:p.style??s.settings.style??'natural',apiKey:p.clearApiKey?'':p.apiKey||s.settings.apiKey||'',webSearch:false,allowSearch:p.allowSearch===true};s.autoConnect=!!p.autoConnect;});
      this.policy.names=aliases;this.modelHealth.reset();this.modelState={stage:'unchecked',message:'设置已保存；新问题会核验当前模型，也可手动测试'};this.update();return true;
    }
    if(action==='target.save'){
      if(!p.id)p={...p,id:getAuthorizedWechatScopes().find(row=>row.name===p.name?.trim()&&row.kind===p.kind)?.id};
      assertAuthorizedWechatTarget({id:p.id,name:typeof p.name==='string'?p.name.trim():p.name,kind:p.kind});
      if(typeof p.name!=='string'||!p.name.trim()||p.name.length>100||!['group','contact'].includes(p.kind)||!['mentions','observe','all'].includes(p.mode)||p.kind==='group'&&p.mode==='all')throw Error('会话配置无效');
      const idleMs=p.participation?.idleMs??180000,maxMs=p.participation?.maxMs??1800000;
      if(!Number.isInteger(idleMs)||idleMs<10000||idleMs>1800000||!Number.isInteger(maxMs)||maxMs<idleMs||maxMs>7200000)throw Error('participation_invalid');
      const previous=this.store.value.targets.find(x=>x.id===p.id);
      const same=previous&&previous.name===p.name.trim()&&previous.kind===p.kind;
      const id=p.id;if(this.store.value.targets.some(x=>x.id!==p.id&&x.name===p.name.trim()))throw Error('显示名重复，请先在微信设置唯一备注');
      const style=['natural','concise','detailed'].includes(p.preferences?.style)?p.preferences.style:'natural';
      const proactive={enabled:p.proactive?.enabled===true,ownerApproved:p.proactive?.enabled===true,quietHours:{start:'23:00',end:'08:00'},maxPerDay:3,minIntervalMs:1200000,utcOffsetMinutes:480};
      await this.stop();this.store.change(s=>{const row={id,name:p.name.trim(),kind:p.kind,mode:p.mode,enabled:!!p.enabled,paused:same?!!previous.paused:false,quarantined:same?!!previous.quarantined:false,proactive,...(previous?.wechatPeerId?{wechatPeerId:previous.wechatPeerId}:{}),participation:{idleMs,maxMs},preferences:{style,splitReplies:p.preferences?.splitReplies===true},...(same&&previous.windowBinding?{windowBinding:previous.windowBinding}:{})};const index=s.targets.findIndex(x=>x.id===p.id);if(index>=0)s.targets[index]=row;else s.targets.push(row);});this.ensureSessions();
      if(proactive.enabled){this.policy.resumeProactive(this.sessionFor(id).id,{ownerApproved:true});this.savePolicy(this.sessionFor(id).id);}
      this.update();return true;
    }
    if(action==='target.remove'){await this.stop();this.store.change(s=>s.targets=s.targets.filter(x=>x.id!==p.id));this.update();return true;}
    if(action==='memory.save'){
      if(!this.store.session(p.sessionId)||typeof p.text!=='string'||!p.text.trim()||p.text.length>2000)throw Error('记忆内容无效');
      this.store.change(s=>{if(s.memories.filter(x=>x.status!=='deleted').length>=500)throw Error('记忆已达500条，请整理后再保存');const candidate=checked(proposeMemory(s,{sessionId:p.sessionId,text:p.text.trim(),actor:OWNER,source:{originalText:p.text},now:this.nowMs()}));checked(approveMemory(s,candidate.candidate.id,{actor:OWNER,now:this.nowMs()}));});this.update();return true;
    }
    if(['memory.approve','memory.reject','memory.edit','memory.remove'].includes(action)){
      const before=this.store.value.memories.find(x=>x.id===p.id)||this.store.value.memoryCandidates.find(x=>x.id===p.id);let result;
      this.store.change(s=>{const opts={actor:OWNER,text:p.text,now:this.nowMs()};result=checked(action==='memory.approve'?approveMemory(s,p.id,opts):action==='memory.reject'?rejectMemory(s,p.id,opts):action==='memory.edit'?editMemory(s,p.id,opts):deleteMemory(s,p.id,opts));});
      if(before&&(action==='memory.edit'||action==='memory.remove'||action==='memory.approve'&&before.action!=='add')){
        this.invalidateSession(before.sessionId,'记忆已修改',{clearContext:true});
        this.store.change(s=>{const session=s.sessions.find(x=>x.id===before.sessionId);if(session)session.historyCutoffAt=this.nowMs();});
      }
      this.update();return result;
    }
    if(action==='task.save'){
      const target=this.store.value.targets.find(x=>x.id===p.targetId);if(!target)throw Error('请选择已配置的会话');const session=this.sessionFor(target.id);let result;
      this.store.change(s=>{const opts={sessionId:session.id,targetId:target.id,text:p.text,dueAt:p.dueAt,timeZone:p.timeZone||'Asia/Shanghai',actor:OWNER,now:this.nowMs()};
        if(p.id){result=checked(editReminder(s,p.id,opts));const row=s.tasks.find(x=>x.id===p.id);row.status='proposed';delete row.approvedAt;result.task=structuredClone(row);}else result=checked(createReminder(s,{...opts,actor:{},requestId:uid()}));});this.update();return result;
    }
    if(action==='task.approve'||action==='task.cancel'){
      const task=this.store.value.tasks.find(x=>x.id===p.id);if(!task)throw Error('提醒不存在');
      if(action==='task.cancel'&&task.status==='claimed'&&this.turns.get(task.sessionId)?.taskId===p.id){this.controllers.get(task.sessionId)?.abort();return {ok:true,code:'cancellation_requested'};}
      let result;this.store.change(s=>{result=checked(action==='task.approve'?approveReminder(s,p.id,{actor:OWNER,now:this.nowMs()}):cancelReminder(s,p.id,{actor:OWNER,now:this.nowMs()}));});this.update();return result;
    }
    if(action==='session.reset'){this.invalidateSession(p.sessionId,'会话已重置',{clearContext:true});this.store.resetSession(p.sessionId);this.update();return true;}
    throw Error('未知操作');
  }
}
