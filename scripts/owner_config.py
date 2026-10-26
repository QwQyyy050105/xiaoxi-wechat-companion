"""Owner-only deployment configuration. Never accepts config from chat payloads."""
import json, os, pathlib, re
ROOT=pathlib.Path(__file__).resolve().parents[1]
CONFIG_PATH=pathlib.Path(os.environ.get('XIAOXI_CONFIG',str(ROOT/'deployment.local.json'))).absolute()
def load_owner_config():
    if not CONFIG_PATH.exists():return dict(schemaVersion=1,account={},targets=[],native=dict(enabled=False,mediaCache=False))
    if CONFIG_PATH.is_symlink() or not CONFIG_PATH.is_file() or CONFIG_PATH.stat().st_size>65536:raise ValueError('deployment_file_invalid')
    value=json.loads(CONFIG_PATH.read_text(encoding='utf-8-sig'))
    if not isinstance(value,dict) or value.get('schemaVersion')!=1:raise ValueError('deployment_schema_invalid')
    account=value.get('account',{});targets=value.get('targets',[]);native=value.get('native',{})
    if not isinstance(account,dict) or not isinstance(targets,list) or len(targets)>64 or not isinstance(native,dict):raise ValueError('deployment_invalid')
    folder=account.get('folder','')
    if not isinstance(folder,str) or folder and (not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}',folder) or folder in ('.','..')):raise ValueError('deployment_account_invalid')
    ids=set();names=set()
    for t in targets:
        if not isinstance(t,dict) or not isinstance(t.get('id'),str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}',t['id']) or t.get('kind') not in ('group','contact') or not isinstance(t.get('name'),str) or not t['name'].strip() or len(t['name'])>128 or t['id'] in ids or t['name'] in names:raise ValueError('deployment_target_invalid')
        if 'peerId' in t or 'windowBinding' in t or t.get('wechatPeerId') is not None and (not isinstance(t['wechatPeerId'],str) or not re.fullmatch(r'\d{1,32}@chatroom',t['wechatPeerId'])):raise ValueError('deployment_peer_id_ambiguous')
        ids.add(t['id']);names.add(t['name'])
    if native.get('enabled') is True and (not account.get('displayName') or not folder or not targets or any(t['kind']!='group' for t in targets)):raise ValueError('native_requires_account_and_group_scopes')
    if native.get('mediaCache') is True and (native.get('enabled') is not True or not account.get('cacheRoot') or not account.get('wxid') or any(not t.get('wechatPeerId') for t in targets)):raise ValueError('media_requires_explicit_account_cache_and_peers')
    if native.get('allowModuleDataScan') is True and native.get('mediaCache') is not True:raise ValueError('module_scan_requires_media_opt_in')
    return value
CONFIG=load_owner_config()
AUTHORIZED_GROUPS={t['id']:t['name'] for t in CONFIG.get('targets',[]) if t['kind']=='group'}
