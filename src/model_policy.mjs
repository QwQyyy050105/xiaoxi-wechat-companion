import {deployment} from './deployment_config.mjs';
export const CODEX_CHAT_MODEL=(deployment.model?.provider==='codex'?deployment.model.model:undefined)??process.env.CODEX_MODEL??'';
export const CHAT_REASONING_EFFORT='low';
export function selectedChatModel(settings){return settings?.model?.trim()||CODEX_CHAT_MODEL;}
