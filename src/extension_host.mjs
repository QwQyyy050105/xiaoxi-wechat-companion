import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export const API_VERSION=1;
export const CAPABILITIES=Object.freeze(['model','transport','search','media','asr','tts']);
export class UnsupportedCapability extends Error { constructor(capability){super(`unsupported:${capability}`);this.code='unsupported';this.capability=capability;} }
export class ExtensionHost {
 constructor({root,config={}}){this.root=path.resolve(root);this.config=structuredClone(config);this.handlers=new Map();this.manifests=[];this.disposers=[];}
 async register(plugin,options={}) {
  if(!plugin||plugin.apiVersion!==1||typeof plugin.id!=='string'||!/^[a-z][a-z0-9_.-]{0,63}$/.test(plugin.id)||!Array.isArray(plugin.capabilities)||!plugin.capabilities.length||new Set(plugin.capabilities).size!==plugin.capabilities.length||plugin.capabilities.some(x=>!CAPABILITIES.includes(x))||typeof plugin.setup!=='function')throw Error('plugin_manifest_invalid');
  if(this.manifests.some(x=>x.id===plugin.id)||plugin.capabilities.some(x=>this.handlers.has(x)))throw Error('plugin_registration_conflict');
  const result=await plugin.setup(Object.freeze({apiVersion:1,root:this.root,options:structuredClone(options),config:structuredClone(this.config)}));
  if(!result||plugin.capabilities.some(x=>typeof result[x]!=='function'))throw Error('plugin_handler_missing');
  for(const capability of plugin.capabilities)this.handlers.set(capability,{id:plugin.id,call:result[capability]});
  if(typeof result.dispose==='function')this.disposers.push(result.dispose);
  this.manifests.push({apiVersion:1,id:plugin.id,capabilities:[...plugin.capabilities]});
 }
 async load(entries=[]) {
  for(const entry of entries){
   if(!entry||typeof entry.module!=='string'||!entry.module.startsWith('./plugins/')||!entry.module.endsWith('.mjs'))throw Error('plugin_path_invalid');
   const base=fs.realpathSync(path.join(this.root,'plugins')),file=fs.realpathSync(path.resolve(this.root,entry.module));
   if(base!==path.join(fs.realpathSync(this.root),'plugins')||path.relative(base,file).startsWith('..')||path.isAbsolute(path.relative(base,file))||!fs.statSync(file).isFile())throw Error('plugin_path_denied');
   const module=await import(pathToFileURL(file).href);await this.register(module.default,entry.options??{});
  }return this;
 }
 has(capability){return this.handlers.has(capability);}
 async call(capability,args){const handler=this.handlers.get(capability);if(!handler)throw new UnsupportedCapability(capability);return handler.call(args);}
 snapshot(){return {apiVersion:1,disabledConfiguredPlugins:this.disabledConfiguredPlugins??0,plugins:structuredClone(this.manifests),capabilities:Object.fromEntries(CAPABILITIES.map(x=>[x,this.has(x)?'extension':'unsupported']))};}
 async dispose(){for(const dispose of this.disposers.reverse())await dispose();}
}
