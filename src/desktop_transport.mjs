import {spawn} from 'node:child_process';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {assertScopedNativeRequest} from './conversation_scope.mjs';

export class DesktopTransport extends EventEmitter {
  constructor(root,{workerPath,pythonPath}={}){super();this.root=root;this.workerPath=workerPath||path.join(root,'scripts/desktop_bridge.py');this.pythonPath=pythonPath||process.env.XIAOXI_PYTHON||path.join(root,process.platform==='win32'?'runtime/desktop_bridge/Scripts/python.exe':'runtime/desktop_bridge/bin/python');this.child=null;this.requests=new Map();this.serial=0;this.tail=Promise.resolve();this.worker=null;this.termination=null;}
  start(){
    if(this.child)throw Error('连接进程已启动');
    this.token=randomUUID();this.worker=null;this.launcherCreated=null;this.handshake=false;
    const token=this.token;
    const child=spawn(this.pythonPath,['-B',this.workerPath,'--transport-token',token],{
      cwd:this.root,windowsHide:true,env:{...process.env,TEMP:path.join(this.root,'temp'),TMP:path.join(this.root,'temp'),PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});
    this.child=child;let buffer='';
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>2*1024*1024){this.kill('接口数据超出限制');return;}
      let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);let value;try{value=JSON.parse(line);}catch{continue;}
        if(value.event==='worker_ready'){
          if(this.child!==child)continue;
          const ancestor=Array.isArray(value.ancestors)?value.ancestors.find(a=>a.pid===child.pid&&Number.isFinite(a.created)):null;
          if(value.token!==token||!Number.isInteger(value.pid)||value.pid<=0||!Number.isFinite(value.created)||value.created<=0||value.pid!==child.pid&&!ancestor){this.kill('微信接口进程身份握手不匹配');return;}
          this.worker={pid:value.pid,created:value.created};this.launcherCreated=value.pid===child.pid?value.created:ancestor.created;this.handshake=true;this.emit('worker',this.worker);continue;
        }
        const waiting=this.requests.get(value.id);if(!waiting)continue;clearTimeout(waiting.timer);this.requests.delete(value.id);
        value.error?waiting.reject(Error(value.error)):waiting.resolve(value.result);
      }
    });
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>this.kill('微信接口无法启动，请检查运行环境'));
    child.on('close',()=>{if(this.child===child){this.child=null;this.rejectAll('微信接口已退出');this.emit('lost');}});
  }
  rejectAll(message){for(const task of this.requests.values()){clearTimeout(task.timer);task.reject(Error(message));}this.requests.clear();}
  kill(reason='接口已停止'){
    const child=this.child;if(!child)return this.termination||Promise.resolve();
    const request={launcherPid:child.pid,launcherCreated:this.launcherCreated,worker:this.worker,token:this.token,scriptPath:this.workerPath};
    this.child=null;child.stdin.destroy();this.rejectAll(reason);this.emit('lost');
    this.termination=new Promise(resolve=>{
      let output='',finished=false;
      const helper=spawn(this.pythonPath,['-B',path.join(this.root,'scripts/terminate_worker.py')],{cwd:this.root,windowsHide:true,env:{...process.env,TEMP:path.join(this.root,'temp'),TMP:path.join(this.root,'temp'),PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','ignore']});
      const finish=(result)=>{if(finished)return;finished=true;clearTimeout(timer);child.kill();this.emit('terminated',result);resolve(result);};
      const timer=setTimeout(()=>{helper.stdin.destroy();helper.kill();finish({terminated:false,error:'实际接口进程结束未确认'});},5000);
      helper.stdout.setEncoding('utf8');helper.stdout.on('data',chunk=>{if(output.length<65536)output+=chunk;});helper.stdin.on('error',()=>{});
      helper.on('error',error=>finish({terminated:false,error:error.message}));
      helper.on('close',()=>{let result;try{result=JSON.parse(output.trim().split('\n').at(-1));}catch{result={terminated:false,error:'实际接口进程结束未确认'};}finish(result);});
      helper.stdin.end(JSON.stringify(request)+'\n');
    });
    return this.termination;
  }
  call(command,fields={},timeout=20000,{signal,beforeSubmit}={}){
    const run=()=>new Promise((resolve,reject)=>{
      // Cancellation before this serialized command starts proves no native
      // submission took place. Once written, preserve the real worker receipt.
      if(signal?.aborted||beforeSubmit&&beforeSubmit()!==true){const error=Error('本轮已取消或已过期，未提交微信');error.sendNotSubmitted=true;return reject(error);}
      if(!this.child)return reject(Error('微信接口未启动'));
      const id=++this.serial;let line;
      try{
        // Inspect exactly the detached payload that will be written. Config or
        // queued-field mutation must not widen the fixed owner authorization.
        const payload={...structuredClone(fields),id,command};
        assertScopedNativeRequest(command,payload);line=JSON.stringify(payload)+'\n';
      }catch(error){error.sendNotSubmitted=true;return reject(error);}
      const timer=setTimeout(()=>this.kill('微信接口超时，已释放连接；请重试'),timeout);
      this.requests.set(id,{resolve,reject,timer});this.child.stdin.write(line);
    });
    const result=this.tail.then(run,run);this.tail=result.catch(()=>{});return result;
  }
  async stop(){if(!this.child){await this.termination;return;}try{await this.call('stop',{},5000);}finally{await this.kill();}}
}
