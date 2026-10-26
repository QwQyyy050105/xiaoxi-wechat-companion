import fs from 'node:fs';
import path from 'node:path';

// A local deployment receipt records this owner's explicit request for online
// answers. It cannot grant new WeChat targets, files, tools or account access.
const GRANT_ID='public_lookup_2026_10_25';
export function applyDeploymentSettings(store,root){
  const file=path.join(root,'owner_feature_grant.json');
  if(!fs.existsSync(file))return {applied:false,reason:'no_grant'};
  const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>4096)throw Error('本机功能授权文件无效');
  const grant=JSON.parse(fs.readFileSync(file,'utf8'));
  if(grant.schemaVersion!==1||grant.id!==GRANT_ID||grant.publicLookup!==true)throw Error('本机功能授权内容无效');
  if(store.value.appliedOwnerGrants?.includes(GRANT_ID))return {applied:false,reason:'already_applied'};
  store.change(state=>{
    state.settings.allowSearch=true;
    state.appliedOwnerGrants=[...(state.appliedOwnerGrants??[]),GRANT_ID];
  });
  return {applied:true,id:GRANT_ID};
}
