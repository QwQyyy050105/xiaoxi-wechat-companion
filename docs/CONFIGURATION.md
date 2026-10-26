# Configuration reference

`deployment.example.json` is the public template. `npm run init` creates `deployment.local.json` only when absent. `XIAOXI_CONFIG` can point to an absolute owner configuration path. The JS host and Python worker use this same file, and neither accepts authorization from chat. Paths derive from the repository, not a drive letter.

```json
{
  "schemaVersion": 1,
  "account": {"displayName": "", "folder": "", "cacheRoot": "", "wxid": ""},
  "character": {"id": "xiaoxi", "name": "小汐", "aliases": ["小汐"]},
  "targets": [],
  "native": {"enabled": false, "mediaCache": false, "allowModuleDataScan": false},
  "model": {"provider": "mock", "model": "mock", "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "", "stream": true, "timeoutMs": 120000, "retries": 1},
  "extensions": []
}
```

- `targets`: at most 64 unique `{id,name,kind,wechatPeerId?}` records. `id` matches `[a-z][a-z0-9_-]{0,63}`; `kind` is `group` or `contact`. Native Windows currently accepts groups only. Contacts are available to a capable custom transport, not a claim of native support.
- `account.folder`: one folder name, never `.`/`..` or a traversal path. `cacheRoot`, when set, is an absolute attachment-cache root. `wxid`/wechatPeerId values are optional unless image-cache support is enabled. Do not infer peer IDs from names.
- `native.enabled`: explicit opt-in, requires nonempty account binding and groups. `mediaCache` separately requires cache root, wxid and all target wechatPeerId values.
- `character.id`: stable card ID. The panel can edit card display name and call aliases. Card changes cannot grant tools or recipients.
- `model`: default for a new state store. Existing owner settings in the panel persist independently; changes to the defaults do not silently overwrite saved selections. `apiKey` is forbidden in deployment JSON; use `apiKeyEnv`. The encrypted desktop store may hold a directly entered key.
- `extensions`: owner-authored entries `{module:"./plugins/my_plugin.mjs", options:{...}}`. Modules must resolve inside this repo's `plugins/` directory. Restart to load code. This is trusted executable code, not a sandbox. No npm or remote module download is performed by the host.

Environment variables: `XIAOXI_CONFIG` (owner file), `XIAOXI_PYTHON` (native interpreter), `CODEX_CLI_PATH` (Codex executable), `CODEX_MODEL` (default when Codex selected without a model), API key variables you name. Legacy shared voice readiness adapter optionally accepts `XIAOXI_VOICE_ROOT` / `XIAOXI_VOICE_MODULE`; the default runtime instead uses the v1 TTS plugin contract and does not start shared inference.

Per-target owner panel settings: `mode=mentions|observe` (plus `all` for a capable contact transport), enabled/paused, `preferences.style=natural|concise|detailed`, `splitReplies`, `participation.idleMs=10000..1800000`, `participation.maxMs>=idleMs` up to 7200000. Proactive defaults: off, minimum 20 minutes, maximum 3/day, 23:00–08:00 UTC+08 quiet hours. These are conservative defaults with explicit owner enablement, not model-generated permissions.

Local state is ignored by Git: `data/`, `runtime/`, `temp/`, logs, `deployment.local.json`, `character_card.local.json`, `group_profiles.json`, `.env*`. Do not move encrypted desktop state between operating systems. Export only deliberately selected portable configuration/cards; configure secrets independently on each device. The public example remains empty.

Compatible API output limits: optional `maxOutputTokens` (0 to omit, up to 128000) and `outputTokenField` (`max_tokens` or `max_completion_tokens`). The panel exposes both; the host sends exactly the selected field, without assuming all endpoints implement the same variant. Both SSE and JSON response bodies are bounded to 2 MiB. Missing remote credentials are reported by doctor; unauthenticated custom endpoints remain configurable.

`deployment.schema.json` is the owner-file schema. `targets[].wechatPeerId` is a raw `digits@chatroom` cache identifier; it is never sent as a native UIA pin. Native snapshots/targets use runtime-only `windowBinding` (AutomationId), while internal `session.peerId` means the local authorized target ID. Legacy owner `targets[].peerId` / `windowBinding` are rejected as ambiguous. Runtime bindings are not portable owner configuration.

Image privacy: `native.mediaCache` and `native.allowModuleDataScan` default false. The latter additionally authorizes transient scanning of only the hash-verified DLL .data section (<32MiB, <=4KiB chunks), potentially including unrelated sensitive bytes, when disk-only landmark lookup fails. Scanned bytes and derived keys never leave the worker, logs or files. Without extra consent the worker returns `media_module_data_scan_not_authorized`. Native image input is not shown as connected until an actual request obtains image candidates. Model `vision` defaults false; only enable it for a model you verified supports images.
