import path from 'node:path';
import fs from 'node:fs';
import {Companion} from './core.mjs';
import {deployment,DEPLOYMENT_ROOT} from './deployment_config.mjs';
import {ExtensionHost,UnsupportedCapability} from './extension_host.mjs';
import {generate,generateSearch} from './model.mjs';
import {DesktopTransport} from './desktop_transport.mjs';
import {createMediaService} from './media_service.mjs';
export async function createRuntime({root=DEPLOYMENT_ROOT,codec,demo=false,stateFile}={}){
 fs.mkdirSync(path.join(root,'temp'),{recursive:true});
 const extensions=await new ExtensionHost({root,config:deployment}).load(demo?[]:deployment.extensions??[]);
 extensions.disabledConfiguredPlugins=demo?(deployment.extensions?.length??0):0;
 const model=args=>extensions.has('model')?extensions.call('model',args):generate(args);
 const search=args=>extensions.has('search')?extensions.call('search',args):generateSearch(args);
 const transportFactory=()=>{
  if(demo||!deployment.native.enabled||process.platform!=='win32')throw new UnsupportedCapability('native_wechat');
  if(extensions.has('transport'))throw Error('transport_factory_must_be_sync');
  return new DesktopTransport(root);
 };
 // setup transport handlers return a transport synchronously; verify on use.
 const factory=extensions.has('transport')?()=>{const value=extensions.handlers.get('transport').call({root});if(value?.then||!value?.start||!value?.call||!value?.kill)throw Error('transport_contract_invalid');return value;}:transportFactory;
 const media=createMediaService({...(extensions.has('media')?{resolveAttachment:args=>extensions.call('media',args)}:{}),...(extensions.has('asr')?{asr:args=>extensions.call('asr',args)}:{})});
 const voice={status:async()=>({ready:false,available:extensions.has('tts'),audioFile:false,voiceBubble:false,reason:extensions.has('tts')?'transport_unsupported':'unsupported'}),generate:args=>extensions.has('tts')?extensions.call('tts',args):Promise.resolve({kind:'text',text:args.text,reason:'unsupported'})};
 const core=new Companion({root,codec,model,search,transportFactory:factory,media,voice,extensions,stateFile});
 core.demo=demo;
 if(demo){core.store.change(s=>{s.settings.provider='mock';s.settings.model='mock';s.settings.allowSearch=false;s.autoConnect=false;});}
 return {core,extensions,close:async()=>{await core.stop();await extensions.dispose();}};
}
