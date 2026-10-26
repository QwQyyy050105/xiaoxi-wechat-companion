const {app,BrowserWindow,ipcMain,safeStorage,dialog}=require('electron');
const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');
const root=__dirname;
const appVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const verifyStartup=process.argv.includes('--verify-startup');
for(const folder of ['temp','data','logs','runtime/client_profile','runtime/client_session'])fs.mkdirSync(path.join(root,folder),{recursive:true});
process.env.TEMP=path.join(root,'temp');process.env.TMP=process.env.TEMP;
app.setPath('userData',path.join(root,'runtime/client_profile'));app.setPath('sessionData',path.join(root,'runtime/client_session'));app.setPath('temp',path.join(root,'temp'));app.setPath('logs',path.join(root,'logs'));
app.setAppUserModelId('Xiaoxi.Companion');
if(!app.requestSingleInstanceLock()){app.quit();return;}
let win,core,closing=false;
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
const runFile=path.join(root,'data/client_run.json');
function runReceipt(clean){fs.writeFileSync(runFile,JSON.stringify({pid:process.pid,at:new Date().toISOString(),cleanShutdown:clean}),{flush:true});}
app.whenReady().then(async()=>{
  try{
    if(!safeStorage.isEncryptionAvailable()||process.platform==='linux'&&safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('操作系统密钥存储暂不可用；未创建明文聊天或密钥文件');
    const {createRuntime}=await import('./src/runtime.mjs');
    const runtime=await createRuntime({root,codec:{encode:text=>safeStorage.encryptString(text),decode:buffer=>safeStorage.decryptString(buffer)}});core=runtime.core;
    let last;try{last=JSON.parse(fs.readFileSync(runFile,'utf8'));}catch{}
    if(last&&!last.cleanShutdown)core.store.event('检测到上次异常退出；已保留设置和记忆，发送结果未知的任务不会补发。');
    runReceipt(false);
    win=new BrowserWindow({width:1080,height:820,minWidth:880,minHeight:640,title:'小汐 · Xiaoxi Companion',show:!verifyStartup,autoHideMenuBar:true,backgroundColor:'#f5f6f8',
      webPreferences:{preload:path.join(root,'desktop_preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    const allowed=pathToFileURL(path.join(root,'public/client.html')).href;
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(url!==allowed)event.preventDefault();});
    win.webContents.session.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));
    ipcMain.handle('xiaoxi:call',async(event,action,payload)=>{
      if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==allowed)throw Error('无效调用来源');
      if(typeof action!=='string'||JSON.stringify(payload??{}).length>256*1024)throw Error('请求无效');
      return core.dispatch(action,payload??{});
    });
    let lastStatus=0,lastDiagnostic='';
    core.on('update',state=>{
      if(win&&!win.isDestroyed())win.webContents.send('xiaoxi:state',state);
      const diagnostic=JSON.stringify([state.modelInput?.callId,state.modelInput?.stage,state.personaStatus?.sha256,state.personaStatus?.lastError?.code,state.latency?.recent.at(-1)?.requestId]);
      if(Date.now()-lastStatus>3000||diagnostic!==lastDiagnostic){lastStatus=Date.now();lastDiagnostic=diagnostic;
        const status={at:new Date().toISOString(),pid:process.pid,appVersion,privacy:state.privacy,media:state.mediaStatus,mediaCapabilities:state.mediaCapabilities,searchEnabled:state.settings.allowSearch===true,personaVersion:core.persona.schema_version,persona:state.personaStatus,modelInput:state.modelInput,latency:state.latency,connection:state.connection,model:state.modelState.stage,targets:state.targetStates,busy:state.busy.length,inbox:state.inbox.map(({status})=>status),outbox:state.outbox.map(({status})=>status),memoryCount:state.memories.length};
        fs.writeFileSync(path.join(root,'data/runtime_status.json'),JSON.stringify(status,null,2));
      }
    });
    await win.loadFile(path.join(root,'public/client.html'));
    if(verifyStartup){
      const voice=await core.refreshReadiness();const state=core.snapshot();
      fs.writeFileSync(path.join(root,'data/startup_verification.json'),JSON.stringify({at:new Date().toISOString(),version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,runtimeVersion:process.versions.electron,storeVersion:core.store.value.version,secretStorage:'Windows DPAPI',rendererLoaded:true,connected:false,modelCalled:false,groupMessagesSubmitted:0,targets:state.targets.map(({name,enabled,quarantined,proactive})=>({name,enabled,quarantined,proactiveEnabled:proactive?.enabled===true})),counts:{sessions:state.sessions.length,memories:state.memories.length,candidates:state.memoryCandidates.length,tasks:state.tasks.length},voice:{ready:voice.ready,available:voice.available,reason:voice.reason},features:state.featureStatus},null,2));
      app.quit();
    }else if(process.argv.includes('--smoke-test')){
      await core.start();
      const state=core.snapshot();
      fs.writeFileSync(path.join(root,'data/client_smoke.json'),JSON.stringify({at:new Date().toISOString(),model:state.modelState.stage,connection:state.connection,targets:state.targetStates,secretStorage:'Windows DPAPI',automaticGroupMessagesSent:state.outbox.length},null,2));
      await core.stop();app.quit();
    }else if(core.store.value.autoConnect&&!process.argv.includes('--no-connect'))void core.start();
  }catch(error){dialog.showErrorBox('小汐启动失败',error.message);app.quit();}
});
app.on('before-quit',event=>{
  if(closing||!core)return;event.preventDefault();closing=true;
  Promise.resolve(core.stop()).finally(()=>{runReceipt(true);setTimeout(()=>app.quit(),800);});
});
app.on('window-all-closed',()=>app.quit());
