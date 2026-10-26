const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('xiaoxi',{
  call:(action,payload)=>ipcRenderer.invoke('xiaoxi:call',action,payload),
  subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('xiaoxi:state',listener);return ()=>ipcRenderer.removeListener('xiaoxi:state',listener);}
});
