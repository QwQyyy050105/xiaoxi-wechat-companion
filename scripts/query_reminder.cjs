// The Node wrapper owns the temporary Electron directories and cleans up after exit.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.join(__dirname,'..');
const scratchParent = path.join(root,'temp');
const allowedErrors = new Set(['usage','requires_windows_desktop_profile','target_not_authorized','exact_task_text_required',
  'explicit_time_window_required','session_binding_unavailable','task_record_invalid','desktop_store_missing',
  'desktop_key_store_unavailable','desktop_store_read_failed','desktop_store_decrypt_failed','desktop_store_format_invalid','reminder_query_failed']);

function readInput() {
  const args=process.argv.slice(2);
  if (args.length===1 && args[0]==='--stdin') {
    const buffer=Buffer.alloc(16385);let total=0;
    for(;;) {
      const length=fs.readSync(0,buffer,total,buffer.length-total,null);
      if(!length)break;
      total+=length;if(total>=buffer.length)throw Error('usage');
    }
    try {
      const value=JSON.parse(buffer.toString('utf8',0,total).replace(/^\uFEFF/,''));
      if (!value || Array.isArray(value) || Object.keys(value).sort().join(',')!=='from,target,text,until') throw Error();
      return value;
    } catch {throw Error('usage');}
  }
  if (args.length!==8) throw Error('usage');
  const names=new Set(['--target','--text','--from','--until']),query={};
  for (let i=0;i<args.length;i+=2) {
    if (!names.delete(args[i])) throw Error('usage');
    query[args[i].slice(2)]=args[i+1];
  }
  return query;
}

async function readDesktopStore(query) {
  const {app,safeStorage}=require('electron');
  const {validateReminderQuery,queryReminderReceipt}=await import('../src/reminder_receipt.mjs');
  validateReminderQuery(query);
  const {Store}=await import('../src/store.mjs');
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw Error('desktop_key_store_unavailable');
  let store;
  try {
    store=new Store(path.join(root,'data','companion.enc'),{
      decode(bytes) {
        try {return safeStorage.decryptString(bytes);}
        catch {throw Error('desktop_store_decrypt_failed');}
      }
    });
  } catch(error) {
    if(error.message==='desktop_store_decrypt_failed')throw error;
    throw Error(error.code?'desktop_store_read_failed':'desktop_store_format_invalid');
  }
  return queryReminderReceipt(store.value,query);
}

function main() {
  if (process.platform!=='win32') throw Error('requires_windows_desktop_profile');
  const profile=path.join(root,'runtime','client_profile'),file=path.join(root,'data','companion.enc');
  if(!fs.existsSync(file) || !fs.existsSync(profile)) throw Error('desktop_store_missing');
  if (process.versions.electron) {
    const scratch=process.env.XIAOXI_RECEIPT_SCRATCH;
    if (!scratch || path.dirname(scratch)!==scratchParent || !/^receipt_[\w-]{6}$/.test(path.basename(scratch))) throw Error('usage');
    const {app}=require('electron');
    app.setPath('userData',profile);
    // Chromium's OS key service uses the application's session data directory.
    // No BrowserWindow, persistent web session or connection is created.
    app.setPath('sessionData',path.join(root,'runtime','client_session'));
    for(const name of ['temp','logs','crashDumps'])app.setPath(name,scratch);
    app.setAppUserModelId('Xiaoxi.Companion');
    app.disableHardwareAcceleration();
    readDesktopStore(readInput()).then(
      result=>process.stdout.write(JSON.stringify(result)+'\n',()=>app.exit(0)),error=>fail(error));
    return;
  }
  const input=readInput();
  fs.mkdirSync(scratchParent,{recursive:true});
  const scratch=fs.mkdtempSync(path.join(scratchParent,'receipt_'));
  try {
    const env={...process.env,TEMP:scratch,TMP:scratch,XIAOXI_RECEIPT_SCRATCH:scratch};
    delete env.ELECTRON_RUN_AS_NODE;
    // Forward the query in stdin even when the owner used CLI flags.
    const result=spawnSync(require('electron'),[__filename,'--stdin'],{cwd:root,env,windowsHide:true,
      input:JSON.stringify(input),encoding:'utf8',timeout:20000,maxBuffer:65536});
    if (result.status!==0) {
      const lines=String(result.stderr??'').trim().split(/\r?\n/);
      for(const line of lines) {
        let item;
        try {item=JSON.parse(line);} catch {continue;}
        if(allowedErrors.has(item?.error))throw Error(item.error);
      }
      throw Error('reminder_query_failed');
    }
    const item=JSON.parse(result.stdout.trim());
    if (!['matched','not_found','ambiguous'].includes(item?.result))throw Error('reminder_query_failed');
    process.stdout.write(JSON.stringify(item)+'\n');
  } finally {
    fs.rmSync(scratch,{recursive:true,force:true,maxRetries:2});
  }
}
function fail(error) {
  const code=allowedErrors.has(error.message)?error.message:'reminder_query_failed';
  process.stderr.write(JSON.stringify({error:code})+'\n',()=>{
    if(process.versions.electron)require('electron').app.exit(1);else process.exitCode=1;
  });
}
try { main(); } catch(error){fail(error);}
