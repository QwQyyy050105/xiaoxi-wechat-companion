const $=id=>document.getElementById(id);
let state,settingsLoaded=false,localSession,personaLoaded=false,deploymentConfig;
const titles={home:'连接与状态',targets:'会话管理',chat:'本地试聊',memory:'会话记忆',tasks:'提醒任务',settings:'模型与启动',events:'运行记录',persona:'人格与参与',deployment:'账号与授权'};
const stages={stopped:'已停止',connecting:'正在连接',connected:'微信已连接',waiting:'等待微信',unchecked:'尚未测试',checking:'正在测试',ready:'AI 已就绪',error:'需要处理',listening:'监听中',gap:'已重新同步',waiting_send:'等待手动操作结束',paused:'已暂停',generating:'正在回答',waiting_input:'等待你说完'};
const taskStages={proposed:'等待主人确认',scheduled:'已确认，等待时间',claimed:'正在处理',local_echo:'本机气泡已确认',unknown:'发送未确认，不重发',not_sent:'未发送',cancelled:'已取消',missed:'已错过，不补发'};
const featureStages={not_implemented:'未实现',implemented_pending_validation:'实现待验收',implemented_pending_acceptance:'实现待验收',implemented:'实现待验收',verified:'已验证',blocked:'真实阻塞',partially_implemented:'部分实现，仍有阻塞'};
const voiceReasons={transport_unsupported:'微信音频交付尚未验收',voice_not_approved:'小汐声线尚未选定',fatal_whea_unresolved:'共享推理保持暂停',generation_not_implemented:'共享层目前仅提供就绪检查',provider_missing_or_unavailable:'共享语音状态不可读取',status_timeout:'共享语音状态检查超时',status_busy:'已有语音状态检查在进行',provider_role_mismatch:'共享角色不匹配',provider_contract_invalid:'共享接口待核对',status_not_checked:'语音状态尚未检查'};
function el(tag,text,klass){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(klass)n.className=klass;return n;}
function notice(message=''){$('notice').textContent=message;}
async function call(action,payload){try{notice();return await window.xiaoxi.call(action,payload);}catch(error){notice(error.message.replace(/^Error invoking remote method '[^']+': Error: /,''));throw error;}}
function handle(fn){return event=>{event?.preventDefault();Promise.resolve().then(()=>fn(event)).catch(()=>{});};}
function button(text,action){const n=el('button',text);n.type='button';n.addEventListener('click',handle(action));return n;}
function page(name){for(const n of document.querySelectorAll('.page'))n.classList.toggle('hidden',n.id!==name);for(const n of document.querySelectorAll('nav button'))n.classList.toggle('active',n.dataset.page===name);$('page-title').textContent=titles[name];notice();}
for(const n of document.querySelectorAll('nav button'))n.onclick=()=>page(n.dataset.page);
$('connect').onclick=handle(async()=>{if(state.connection.stage!=='stopped')await call('stop');await call('start');});
$('stop').onclick=handle(()=>call('stop'));
$('test-model').onclick=handle(()=>call('model.check'));
function syncModelPolicy(){$('model').readOnly=false;}
$('provider').onchange=syncModelPolicy;
function clearTarget(){$('target-form').reset();$('target-id').value='';$('target-heading').textContent='配置已授权会话';}
$('target-clear').onclick=clearTarget;
$('target-form').onsubmit=handle(async()=>{const proactive=$('target-proactive').checked;await call('target.save',{id:$('target-id').value,name:$('target-name').value,kind:$('target-kind').value,mode:$('target-mode').value,enabled:$('target-enabled').checked,participation:{idleMs:Number($('target-idle').value)*1000,maxMs:Number($('target-max').value)*60000},proactive:{enabled:proactive,ownerApproved:proactive,quietHours:{start:'23:00',end:'08:00'}},preferences:{style:$('target-style').value,splitReplies:$('target-split').checked}});clearTarget();notice('会话已保存。核对后点击“连接小汐”。');});
$('settings-form').onsubmit=handle(async()=>{await call('settings.save',{provider:$('provider').value,model:$('model').value,baseUrl:$('base-url').value,apiKey:$('api-key').value,apiKeyEnv:$('api-key-env').value,timeoutMs:Number($('model-timeout').value)*1000,retries:Number($('model-retries').value),vision:$('model-vision').checked,stream:$('model-stream').checked,maxOutputTokens:Number($('model-max-tokens').value),outputTokenField:$('model-token-field').value,clearApiKey:$('clear-key').checked,autoConnect:$('auto-connect').checked,allowSearch:$('allow-search').checked});$('api-key').value='';$('clear-key').checked=false;notice('设置已保存。点击“连接小汐”进行实际调用检查。');});
$('chat-form').onsubmit=handle(async()=>{const text=$('chat-text').value.trim();if(!text)return;$('chat-text').value='';await call('chat',{sessionId:localSession.id,text});});
$('chat-cancel').onclick=handle(()=>call('cancel',{sessionId:localSession.id}));
function clearMemory(){$('memory-id').value='';$('memory-text').value='';$('memory-heading').textContent='主人明确确认的事实或约定';$('memory-submit').textContent='保存到此会话';}
$('memory-clear').onclick=clearMemory;
$('memory-form').onsubmit=handle(async()=>{const id=$('memory-id').value;await call(id?'memory.edit':'memory.save',id?{id,text:$('memory-text').value}:{sessionId:$('memory-session').value,text:$('memory-text').value});clearMemory();notice(id?'记忆已修改。':'记忆已保存。');});
$('memory-session').onchange=()=>{clearMemory();renderMemories();};
function clearTask(){$('task-form').reset();$('task-id').value='';$('task-target').disabled=false;$('task-heading').textContent='创建待确认提醒';}
$('task-clear').onclick=clearTask;
function beijingInput(value){const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';return new Date(date.getTime()+8*3600000).toISOString().slice(0,16);}
function displayTime(value){const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）':'时间待核对';}
$('task-form').onsubmit=handle(async()=>{
  const raw=$('task-due').value;const stamp=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)?`${raw}:00+08:00`:'';
  if(!stamp||beijingInput(stamp)!==raw||Date.parse(stamp)<=Date.now()){notice('请填写有效的未来时间，按北京时间解释。');return;}
  const targetId=$('task-target').value;if(!state.targets.some(x=>x.id===targetId)){notice('请先选择一个已配置会话。');return;}
  await call('task.save',{...($('task-id').value?{id:$('task-id').value}:{}),targetId,text:$('task-text').value,dueAt:stamp,timeZone:'Asia/Shanghai'});
  clearTask();notice('已保存为待确认提醒。核对会话、时间与内容后，再点击“确认执行”。');
});
function memorySource(source){
  if(typeof source==='string')return source||'来源待核对';
  if(!source||typeof source!=='object')return '来源待核对';
  const label=source.label||({local_owner:'本机主人明确保存',local_owner_edit:'本机主人修改',group_request:'当前会话中的请求',legacy_owner:'本机主人保存，具体成员未知'}[source.kind])||'来源待核对';
  return label+(source.kind==='group_request'&&source.senderEvidence!=='stable_id'?'；请求者身份尚未可靠识别':'')+(source.eventId?`；原始消息编号：${source.eventId}`:'');
}
function renderMemories(){
  const list=$('memory-list');list.replaceChildren();
  const rows=state.memories.filter(x=>x.sessionId===$('memory-session').value&&x.status!=='deleted');
  if(!rows.length)list.append(el('p','此会话还没有长期记忆。','muted'));
  for(const m of rows){const row=el('div',undefined,'row');const actions=el('div',undefined,'actions');actions.append(button('编辑',()=>{$('memory-id').value=m.id;$('memory-text').value=m.text;$('memory-heading').textContent='修改这条记忆';$('memory-submit').textContent='保存修改';$('memory-text').focus();}),button('删除',async()=>{await call('memory.remove',{id:m.id});if($('memory-id').value===m.id)clearMemory();}));row.append(el('p',m.text),el('p',`编号：${m.id} · 来源：${memorySource(m.source)}`),actions);list.append(row);}
  const pending=$('memory-candidates');pending.replaceChildren();const candidates=(state.memoryCandidates||[]).filter(x=>x.sessionId===$('memory-session').value&&x.status==='pending');
  if(!candidates.length)pending.append(el('p','当前会话没有等待确认的候选。','muted'));
  for(const candidate of candidates){
    const row=el('div',undefined,'row');const action=candidate.action||'add';const existing=rows.find(x=>x.id===candidate.memoryId);
    row.append(el('b',({add:'请求新增记忆',edit:'请求修改记忆',delete:'请求删除记忆'}[action])||'待核对的记忆请求'));
    if(action!=='add')row.append(el('p',`原条目：${existing?.text||'条目已变化，请重新核对'}${candidate.memoryId?'（'+candidate.memoryId+'）':''}`));
    if(action!=='delete')row.append(el('p',(action==='edit'?'修改为：':'')+(candidate.text||'')));
    row.append(el('p',`来源：${memorySource(candidate.source)}`));
    if(typeof candidate.source?.originalText==='string'&&candidate.source.originalText)row.append(el('p',`原始请求：${candidate.source.originalText}`));
    const actions=el('div',undefined,'actions');const approve=button(({add:'确认新增',edit:'确认修改',delete:'确认删除'}[action])||'状态待核对',()=>call('memory.approve',{id:candidate.id}));
    approve.disabled=!['add','edit','delete'].includes(action)||(action!=='add'&&!existing);
    actions.append(approve,button('拒绝此请求',()=>call('memory.reject',{id:candidate.id})));row.append(actions);pending.append(row);
  }
}
function renderTasks(){
  const list=$('task-list');list.replaceChildren();const tasks=state.tasks||[];
  if(!tasks.length)list.append(el('p','还没有提醒任务。','muted'));
  for(const task of tasks){const row=el('div',undefined,'row');const title=el('div',undefined,'row-title');const target=state.targets.find(x=>x.id===task.targetId);title.append(el('b',target?.name||'目标已移除'),el('span',taskStages[task.status]||task.status||'状态待核对','tag'));row.append(title,el('p',task.text),el('p',displayTime(task.dueAt)));if(task.note)row.append(el('p',task.note));
    const actions=el('div',undefined,'actions');
    if(task.status==='proposed'&&target)actions.append(button('确认执行',()=>call('task.approve',{id:task.id})));
    if(['proposed','scheduled'].includes(task.status)){if(target)actions.append(button('编辑',()=>{$('task-id').value=task.id;$('task-target').value=task.targetId;$('task-target').disabled=true;$('task-due').value=beijingInput(task.dueAt);$('task-text').value=task.text;$('task-heading').textContent='编辑提醒（保存后重新确认，目标固定）';}));actions.append(button('取消任务',()=>call('task.cancel',{id:task.id})));}
    row.append(actions);list.append(row);
  }
  const select=$('task-target');const selected=select.value;const signature=state.targets.map(x=>`${x.id}:${x.name}:${x.enabled}`).join('|');
  if(select.dataset.signature!==signature){select.replaceChildren();for(const target of state.targets){const option=el('option',`${target.name}${target.enabled?'':'（未启用）'}`);option.value=target.id;select.append(option);}if(state.targets.some(x=>x.id===selected))select.value=selected;select.dataset.signature=signature;}
}
function renderCapabilities(s){
  const list=$('feature-status');list.replaceChildren();const features=s.featureStatus||[];
  if(!features.length)list.append(el('p','功能状态尚未加载；不视为已通过验收。','muted'));
  for(const feature of features){const row=el('div',undefined,'row');const title=el('div',undefined,'row-title');title.append(el('b',feature.label),el('span',featureStages[feature.status]||feature.status||'待核对','tag'));row.append(title,el('p',feature.detail||''));list.append(row);}
  const media=s.mediaCapabilities||{};const voice=s.voiceReadiness||{};
  $('media-status').textContent=media.groupCacheCandidates?(media.imageUnderstanding?'图片：实验缓存通道已连接，最多2张候选图；未绑定发言者。':'图片缓存已连接，但所选模型尚未确认支持看图。'):media.groupCacheConfigured?({awaiting_connection:'图片缓存已配置，等待授权微信连接；当前未取得图片。',model_vision_not_enabled:'图片缓存已配置，但所选模型尚未确认支持图片输入。',resource_unavailable:'图片资源读取失败；查看运行记录中的原因，当前不能看图。',awaiting_image_read:'图片缓存已配置并连接，尚未实际取得图片；需要一次读图请求验证。'}[media.nativeStatus]||'图片资源通道尚未就绪。'):'图片缓存未配置，当前没有原生图片输入。语音只处理已取得的微信转文字；原声识别未接通。';
  const reasons=(voice.blockers||[voice.reason||'status_not_checked']).map(x=>voiceReasons[x]||x).join('；');
  $('voice-status').textContent=`小汐语音回复：${voice.ready&&voice.transportSupported?'就绪，仍按目标能力判断':'关闭，继续使用文字'}。音频文件：${voice.audioFile?'已验证':'未验证'}；原生语音气泡：${voice.voiceBubble?'已验证':'未验证'}。${reasons}`;
}
function render(s){
  state=s;if(!personaLoaded){fillPersona(s);personaLoaded=true;}localSession=s.sessions.find(x=>x.channel==='local');
  $('connection-status').textContent=stages[s.connection.stage]||s.connection.stage;
  $('connection-message').textContent=s.connection.message;
  $('model-status').textContent=stages[s.modelState.stage]||s.modelState.stage;
  $('model-message').textContent=s.modelState.message;
  $('test-model').disabled=s.modelState.stage==='checking';
  $('connect').textContent=['connected','connecting','waiting'].includes(s.connection.stage)?'重新连接':'连接小汐';
  const rooms=$('room-status');rooms.replaceChildren();
  for(const t of s.targets){
    const r=s.targetStates[t.id];const session=s.sessions.find(x=>x.channel==='desktop_wechat'&&x.peerId===t.id);const row=el('div',undefined,'row');const title=el('div',undefined,'row-title');
    title.append(el('b',t.name),el('span',t.quarantined?'发送未确认，已隔离':!t.enabled?'未启用':t.paused?'已暂停回复':s.connection.stage==='stopped'?'已停止':r?stages[r.stage]||r.stage:'等待连接','tag'));
    row.append(title,el('p',(!t.enabled?'此会话不会被监听。':t.paused?'已暂停此会话回复，可由主人恢复。':s.connection.stage==='stopped'?'点击连接后开始监听。':r?.message||'等待检查窗口')+(r?.lastOutcome?' · '+r.lastOutcome:'')));
    const actions=el('div',undefined,'actions');actions.append(button(t.paused?'恢复回复':'暂停回复',()=>call('target.pause',{id:t.id,paused:!t.paused})));
    for(const [label,control] of [['停止本轮','stop_current'],['换话题','change_topic']]){const n=button(label,()=>call('session.control',{sessionId:session.id,control}));n.disabled=!session;actions.append(n);}
    if(t.quarantined===true){
      row.append(el('p','上一条可能已经发送，请先在微信中核对。恢复只处理新的消息，不会重发旧回答；普通重新连接不会解除本群隔离。'));
      actions.append(button('已核对微信，恢复本群',async()=>{await call('target.acknowledge',{id:t.id});notice('已解除本群发送隔离；连接后处理新消息，旧回答不会重发。');}));
    }
    row.append(actions);rooms.append(row);
  }
  renderCapabilities(s);
  const targets=$('target-list');targets.replaceChildren();
  for(const t of s.targets){const row=el('div',undefined,'row');row.append(el('b',t.name),el('p',`${t.kind==='group'?'群聊':'联系人'} · ${t.enabled?'启用':'未启用'} · ${{mentions:'叫名开始，可连续聊天',observe:'仅验证读取',all:'每条文字回复'}[t.mode]} · 主动参与${t.proactive?.enabled?'已开启':'关闭'}`));const actions=el('div',undefined,'actions');actions.append(button('编辑',()=>{$('target-id').value=t.id;$('target-name').value=t.name;$('target-kind').value=t.kind;$('target-mode').value=t.mode;$('target-enabled').checked=t.enabled;$('target-style').value=t.preferences?.style||'natural';$('target-split').checked=t.preferences?.splitReplies===true;$('target-proactive').checked=t.proactive?.enabled===true;$('target-idle').value=(t.participation?.idleMs??180000)/1000;$('target-max').value=(t.participation?.maxMs??1800000)/60000;$('target-heading').textContent='编辑会话';}),button('移除目标',()=>call('target.remove',{id:t.id})));row.append(actions);targets.append(row);}
  const history=$('chat-history');const nearBottom=history.scrollHeight-history.scrollTop-history.clientHeight<50;history.replaceChildren();
  for(const m of localSession?.messages||[]){const bubble=el('div',undefined,'bubble '+m.role);bubble.append(el('small',m.role==='user'?'你':'小汐'),el('div',m.text));history.append(bubble);}if(nearBottom)history.scrollTop=history.scrollHeight;
  $('chat-submit').disabled=s.busy.includes(localSession?.id);$('chat-submit').textContent=$('chat-submit').disabled?'小汐正在想…':'发送';
  const select=$('memory-session');const selected=select.value;const options=s.sessions.filter(x=>x.channel==='local'||s.targets.some(t=>t.id===x.peerId));
  if([...select.options].map(x=>x.value).join()!==options.map(x=>x.id).join()){select.replaceChildren();for(const session of options){const option=el('option',session.title);option.value=session.id;select.append(option);}if(options.some(x=>x.id===selected))select.value=selected;}renderMemories();
  renderTasks();
  if(!settingsLoaded){$('provider').value=s.settings.provider;$('model').value=s.settings.model;$('base-url').value=s.settings.baseUrl;$('auto-connect').checked=s.autoConnect;$('allow-search').checked=s.settings.allowSearch===true;$('api-key-env').value=s.settings.apiKeyEnv??'';$('model-timeout').value=(s.settings.timeoutMs??120000)/1000;$('model-retries').value=s.settings.retries??1;$('model-stream').checked=s.settings.stream!==false;$('model-vision').checked=s.settings.vision===true;$('model-max-tokens').value=s.settings.maxOutputTokens??0;$('model-token-field').value=s.settings.outputTokenField??'max_completion_tokens';syncModelPolicy();settingsLoaded=true;}
  const events=$('event-list');events.replaceChildren();for(const item of s.events.slice().reverse()){const row=el('div',undefined,'event');row.append(el('time',new Date(item.time).toLocaleString()),el('div',item.message));events.append(row);}
}
window.xiaoxi.subscribe(render);call('snapshot').then(render).catch(()=>{});

const lines=id=>$(id).value.split('\n').map(x=>x.trim()).filter(Boolean);
function fillPersona(s){$('persona-name').value=s.persona.name;$('persona-identity').value=s.persona.identity;for(const field of ['core','voice','preferences'])$('persona-'+field).value=(s.persona[field]??[]).join('\n');$('persona-aliases').value=(s.settings.aliases??[s.persona.name]).join('\n');$('persona-style').value=s.settings.style??'natural';}
$('persona-form').onsubmit=handle(async()=>{const persona={...state.persona,name:$('persona-name').value,identity:$('persona-identity').value,core:lines('persona-core'),voice:lines('persona-voice'),preferences:lines('persona-preferences')};await call('persona.save',{persona,aliases:lines('persona-aliases'),style:$('persona-style').value});notice('人格、称呼与默认风格已保存，下一次回答立即生效。');});
function scopeRow(t={id:'',name:'',kind:'group'}){const row=el('div',undefined,'row');for(const [key,label] of [['id','英文 ID'],['name','微信名称']]){const input=el('input');input.placeholder=label;input.value=t[key];input.dataset.scope=key;input.maxLength=128;row.append(input);}const select=el('select');select.dataset.scope='kind';for(const [value,label] of [['group','群聊'],['contact','联系人（自定义传输）']]){const option=el('option',label);option.value=value;select.append(option);}select.value=t.kind;row.append(select,button('移除此授权',()=>row.remove()));if(t.wechatPeerId)row.dataset.wechatPeerId=t.wechatPeerId;$('scope-list').append(row);}
$('scope-add').onclick=()=>scopeRow();
$('deployment-form').onsubmit=handle(async()=>{if(!deploymentConfig)throw Error('配置尚未加载');const targets=[...$('scope-list').children].map(row=>Object.fromEntries([...row.querySelectorAll('[data-scope]')].map(x=>[x.dataset.scope,x.value.trim()])));for(const [i,row] of [...$('scope-list').children].entries())if(row.dataset.wechatPeerId)targets[i].wechatPeerId=row.dataset.wechatPeerId;const next={...deploymentConfig,account:{...deploymentConfig.account,displayName:$('account-name').value,folder:$('account-folder').value},targets,native:{...deploymentConfig.native,enabled:$('native-enabled').checked}};await call('deployment.save',next);deploymentConfig=next;$('restart-notice').textContent='已保存，请正常退出并重新打开。新增授权在重启前不会读取。';});
call('deployment.get').then(config=>{deploymentConfig=config;$('account-name').value=config.account.displayName;$('account-folder').value=config.account.folder;$('native-enabled').checked=config.native.enabled;for(const target of config.targets)scopeRow(target);}).catch(()=>{});
