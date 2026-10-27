# Local extensions and owner API (v1)

Plugins are trusted local ES modules. The host loads only owner-configured `./plugins/*.mjs` paths after realpath checks; chat, API payloads and persona cards cannot install modules. Never enable code you do not trust. `setup` receives no secret store; its process still has normal Node permissions, so this is not an adversarial sandbox.

```js
export default {
  apiVersion: 1,
  id: 'my.model',
  capabilities: ['model'],
  async setup({ apiVersion, root, options, config }) {
    return {
      async model({ settings, persona, session, memories, mediaInput, signal, onPrepared, onProgress }) {
        signal?.throwIfAborted();
        return { text: 'your completed answer', searchUsed: false };
      },
      async dispose() { /* release only resources owned by this plugin */ }
    };
  }
};
```

`setup` returns one function for each declared capability. Duplicate IDs or capability providers, unknown capabilities, missing handlers and unsupported API versions are rejected before startup. Optional `dispose` runs on clean runtime shutdown. The built-in example is `plugins/example_model.mjs`. Enable in local configuration:

```json
{"module":"./plugins/example_model.mjs","options":{"prefix":"我的本机插件："}}
```

Restart `npm run panel`, open “本地试聊”, and ask anything. The reply goes through the registered plugin model; it does not call the built-in API/Codex. Mock demo deliberately ignores all local extensions so it stays offline.

| Capability | Function input | Required result / integration |
| --- | --- | --- |
| `model` | Generation input shown above | `{text, searchUsed:false, usage?, timing?}`; called by `Companion.runModel` for chat/self-check. Must honor cancellation; no implicit transport sends |
| `transport` | `{root}` | **Synchronous** factory returning EventEmitter-like `{start(),call(command,fields,timeout,options),kill()}`. Loaded at runtime bootstrap; core uses connect/open/read/send/stop receipts. See `src/desktop_transport.mjs` for the implemented protocol |
| `search` | `{query,settings,root,signal}` | `{text,query,sources,searchedAt,searchUsed:true}` from a real query. Called by existing isolated lookup/research flows; no conversation history passed. The provider must actually search and report sources; a generated answer alone is not evidence |
| `media` | `{sessionId,messageId,handle,kind,signal}` | Bound attachment `{sessionId,messageId,handle,source,mime,bytes}` with Uint8Array bytes or trustworthy platform transcript. Registered as the existing media service's attachment resolver; arbitrary paths/URLs are not accepted |
| `asr` | `{bytes,mime,sessionId,messageId,signal}` | `{text,confidence?}`; called by `core.media.analyze` only after the resolver validates real audio bytes and provenance. It does not extract native WeChat audio automatically |
| `tts` | `{text,requestId,signal,deadlineMs}` | For the current text-only native delivery, return `{kind:'text',text,reason?}` fallback. A plugin may expose its own owner API output, but returning audio does **not** make native WeChat voice bubbles supported |

Unregistered capabilities return `UnsupportedCapability` with `code='unsupported'`. `snapshot.extensions` explicitly lists capabilities as extension/unsupported; built-in model/native support is described separately. There is no pretend successful ASR, TTS or mobile adapter.

## Owner panel/API

Electron uses `window.xiaoxi.call(action,payload)` from its isolated preload and accepts only the app's own main frame. The browser panel binds **127.0.0.1 only**, checks exact Host and Origin, requires a per-run token, and permits JSON requests of at most 256 KiB. It has no LAN exposure switch.

A local developer can bootstrap and call the same owner API:

```js
const url = 'http://127.0.0.1:8765';
const {token} = await fetch(url+'/api/bootstrap').then(r=>r.json());
async function call(action,payload={}) {
  const response=await fetch(url+'/api/call', {
    method:'POST',
    headers:{Origin:url,'Content-Type':'application/json','X-Xiaoxi-Token':token},
    body:JSON.stringify({action,payload})
  });
  const body=await response.json();
  if(!response.ok)throw Error(body.error);
  return body.result;
}
const state=await call('snapshot');
const local=state.sessions.find(s=>s.channel==='local');
console.log(await call('chat',{sessionId:local.id,text:'你好'}));
```

Core actions (owner operations, never a chat tool):

- `snapshot`, `model.check`, `chat {sessionId,text}`, `cancel {sessionId}`.
- `persona.save {persona,aliases?,style?}`: validate complete card and aliases; persist local override, reload next generation. The stable ID remains configured; display name is editable.
- `settings.save {provider,model,baseUrl,apiKey?,apiKeyEnv?,timeoutMs?,retries?,stream?,aliases?,style?,allowSearch?,autoConnect?,clearApiKey?}`: validated, stops connection, masked snapshots. Browser rejects nonempty inline `apiKey`.
- `deployment.get`, `deployment.save <complete config>`: save owner registry, stop, return `{saved:true,restartRequired:true}`. Active registry is immutable until restart. No chat can call these.
- `target.save {id,name,kind,mode,enabled,preferences,participation,proactive}`: configure an already authorized scope; does not grant a new ID/name. `target.pause/remove/acknowledge` remain explicit owner controls.
- `extension.call {capability,input}`: local owner/developer invocation for a registered handler. For regular chat, bootstrap already routes model/search/transport/media/ASR/TTS functions to core; no separate call is needed.
- Memory/reminder actions in `Companion.dispatch` retain scoped IDs and explicit confirmation. Sending to an unknown scope is rejected before native submission.

For a new transport, return read snapshots with stable process/session metadata and `messages`, preserve baseline/live distinction, and use explicit send statuses (`local_echo`, `unknown`, `not_sent`, `deferred`). Only `deferred` proves nothing was submitted and permits retry. Do not map a timeout to success. A contact/mobile adapter must document its own platform/account support and include tests; the built-in WeChat adapter still rejects contacts and unknown builds.

Model plugins that truly accept image pixels may set `model.capabilities = {vision:true}` on the returned model function. Absence means unconfirmed, not automatic image support. Native transport read snapshots use `windowBinding` for the verified UIA AutomationId; owner `wechatPeerId` and internal `session.peerId` have separate cache-ID and local-target meanings. Do not forward a cache ID as a native window pin.

Search receives the isolated query and an explicit settings projection `{provider,model,timeoutMs}`; the selected model and timeout are retained for built-in Codex search. Inline API keys, conversation history and private persona are not passed to search. Plugin-specific credentials and endpoint options belong in the trusted plugin setup/options or named environment variables. Ordinary chat advertises search only when the owner switch is enabled and either the real search plugin is registered or the Codex search backend is selected; compatible API alone is not search.

The compatible provider normalizes malformed JSON/SSE and unknown upstream exceptions to safe codes (`api_invalid_json`, `api_invalid_stream_packet`, `api_connection_failed`). Neither remote response text nor arbitrary AbortSignal reason strings enter HTTP errors, model state or event logs. AbortError/TimeoutError remain distinct, and retries never restart a partial answer.

The built-in Codex route always passes the official `--ignore-user-config` flag. It preserves the CLI authentication location while excluding user config.toml providers/MCP/hooks/plugins; model, web search and restrictive overrides remain explicit. Unsupported older CLI versions fail closed, without retrying after removing the flag. If a custom provider requires user config, use the compatible API route or an owner-reviewed local model plugin instead.

## Same-request tail recovery: not implemented in this template

This public template does not start parallel duplicate model requests. Its compatible API retries are the documented bounded retries before any output; its model-health circuit only permits a later fresh input to recover. These are different mechanisms. There is no `tailHedge` owner option, schema field or panel control; adding an unknown field does not enable this capability.

A future implementation must first add a validated owner opt-in that defaults off, disclose potential extra usage, preserve the chosen provider/model and frozen conversation input, respect the owner's existing absolute timeout, enforce a process-wide extra-request budget, and cancel/reap losing workers after one protocol-complete result. Search, tools, media and third-party plugins need separate capability acceptance tests. A plugin is trusted local code, so the host cannot promise those properties for an arbitrary plugin implementation. This paragraph is an extension requirement, not an active API or a capability declaration.
