(()=>{
 const bootstrap=fetch('/api/bootstrap').then(r=>r.json());
 window.xiaoxi={call:async(action,payload)=>{
   const {token}=await bootstrap;
   const file=action==='voice.file';
   const url=file?'/api/voice-file?language='+encodeURIComponent(payload.language):'/api/call';
   const response=await fetch(url,{method:'POST',headers:{'Content-Type':file?'audio/wav':'application/json','X-Xiaoxi-Token':token},body:file?payload.bytes:JSON.stringify({action,payload})});
   const body=await response.json();
   if(!response.ok)throw Error(body.error);
   return body.result;
 },subscribe:listener=>{let active=true;const poll=async()=>{if(!active)return;try{listener(await window.xiaoxi.call('snapshot'));}catch{}if(active)setTimeout(poll,1500);};poll();return()=>{active=false;};}};
})();
