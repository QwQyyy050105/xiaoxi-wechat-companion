# Validation record

## Lightweight receiver coverage — 2026-10-27

The native receiver now reuses structural controls only within one verified read. It reacquires them after an unread jump, does not expand message/quotation/media children during ordinary row enumeration, and retains complete diagnostic expansion. Tests cover delayed voice text, viewport replacement, duplicate controls, bounded traversal and unchanged message ordering.

When the user switches applications after a verified unread jump, the receiver stops further window actions but retains the verified unread count. A production-reader/tracker regression checks that the new message reaches the stream exactly once instead of being discarded as a baseline. This does not remove the foreground, shortcut, draft, account or target checks used for sending.

Idle health requests check process identity and the compatibility guard on every request; account-file metadata is refreshed after at most the existing 10-second cache interval. Before any changed message payload leaves the native receiver, it forces a fresh account check. Failure returns no new payload and does not advance the tracker. Send preparation and submission retain their independent fresh account checks. Health receipts include bounded phase timings without message text. This is not a cache of authorization across new content or sends.

The added native regressions pass with the committed fictional configuration. Full and optional-free installations are validated separately: core smoke/diagnostic tests do not claim desktop Electron, real WeChat delivery, voice engines or unsupported versions. See PORTABILITY for the exact installation profiles. The dated recovery records below remain historical source checks, not an assertion about every later candidate or remote CI run.

## Candidate scope

Date: 2026-10-26. Candidate: Xiaoxi WeChat Companion 0.4.0 working files; no Git commit, staging/index change, push or remote operation was performed for this change. This record describes local source verification, not a published release or a new clean-install attestation.

Environment: Windows NT 10.0.26300 x64, Node.js 24.21.0, Python 3.12.2. Dependencies were already installed from the existing lockfile. Package, lockfile, default owner configuration and the private running deployment were not modified.

The change ports local platform/model startup separation and request-driven recovery into the public template. It retains selectable Mock/OpenAI-compatible/Codex providers, trusted local model plugins, default zero authorized conversations, API credential environment variables, native version checks and the separate runtime UIA/cache bindings. No private account, group, persona or forced model preference was copied.

## Commands and observed results

| Command | Observed result |
| --- | --- |
| `npm test` (same entry: `node scripts/test.mjs`, synthetic deployment bootstrap) | 438/438 pass; zero fail/cancel/skip; 8.16 seconds |
| `python -B -m unittest discover -s test -p "*_test.py"` (no caller `XIAOXI_CONFIG`) | 67/67 pass |
| `python -B scripts/test_native.py` (no caller `XIAOXI_CONFIG`) | 67/67 pass |
| `npm run demo -- --smoke` (same CLI entry) | exit 0; `mode=mock`, `cloudCalls=0`, `chatMessagesSent=0`, `panel=true` |
| `npm run doctor -- --json` (same CLI entry) | exit 0; `not_initialized`, Mock, zero targets, native disabled; no real connection test |
| `npm run check:release` (same script entry) | exit 0; 137 candidate files, zero standard-rule findings; no external private-identifier rules supplied |

Ignored evidence files are under `temp/native_isolation_node.tap`, `temp/native_isolation_raw.log`, `temp/native_isolation_runner.log`, `temp/native_isolation_demo.log`, `temp/native_isolation_doctor.json` and `temp/native_isolation_release.json`. The source-only candidate manifest and scoped before/after receipt is `temp/model_health_source_receipt.json`; it records a SHA-256 over sorted relative filenames and their byte hashes, not a Git tree ID. The earlier baseline covers the explicitly scoped original files, not a full pre-change checkout. These temporary files are local evidence, not release contents.

## Production-path coverage

- Starting a configured fake transport opens the authorized synthetic windows with zero model self-check calls and leaves the model `unchecked`. Only a fresh request calls the provider, gets a local-echo receipt and marks model readiness.
- Ordinary unchecked chat preserves same-conversation merging and cross-conversation concurrency. Explicit self-check cannot duplicate an active chat call; input received during explicit checking records a safe skip reason.
- A short network failure enters bounded 2/4/8/16/30-second backoff. One fresh request may enter recovery; skipped old inputs are not replayed and there is no background model polling or error posting to groups. Stop cancels recovery and discards late output without counting it as a network fault.
- A synthetic compatible API 503 followed by success exercises the core/provider/send path with the owner model and output-token field unchanged. Safe malformed JSON/SSE codes remain redacted through local HTTP, model state and events; upstream bodies and stderr are not persisted.
- Explicit capacity, busy, quota and HTTP500 failures remain recoverable; a known authentication failure cannot be overwritten by a later network notice or configured deadline.
- Saving validated owner model settings clears the previous backend's failure state without a cloud call or changing conversation authorization. Mock/demo, actual plugin bootstrap, privacy checks and configurable model/search paths remain covered by the complete suite.

## Boundaries

No real cloud model, WeChat account, UI operation or external message was used in this public-template verification. Mock success, fake transport success and a local echo do not prove Tencent delivery. The native adapter remains experimental for the previously documented exact Windows/WeChat build; another device/account/build requires its own acceptance test. Real upstream availability can still vary; request-driven recovery prevents a temporary model failure from permanently blocking later new input, but does not repair the upstream network.

Parallel same-request tail recovery is deliberately not ported in this candidate. There is no active option, schema field, panel control or unconditional duplicate call. Future support requires owner opt-in defaulting off and separate usage/timeout/provider acceptance tests, as specified in EXTENDING. Existing compatible-provider pre-output retries and request-driven circuit recovery remain supported.

Source review rechecked provider selection, immutable owner conversation scope, zero-target defaults, local persona overlay, loopback owner controls, safe API/CLI errors and the implemented plugin bootstrap. The standard release scan used zero external private-identifier rules. A proposed optional rules file was not created after approval review rejected inserting personal identifiers into the public tree; there is no new private-data copy. The final full private-identifier/history review and clean export/install are the parent release workflow's responsibility, as are remote publication and real-platform acceptance.

## Native test isolation correction — 2026-10-27

The earlier 67-pass result explicitly supplied `XIAOXI_CONFIG=test/fixtures/deployment.json`. The first clean export's raw unittest command did not supply it and correctly loaded the production zero-target default; five tests failed and fourteen errored at the authorization gate. That candidate was not accepted. This was an incomplete test bootstrap, not permission to relax the gate.

Each of the five native test modules now installs the committed fictional registry before importing production adapters. `scripts/test_native.py` is the standard standalone entry; `--check` checks only fixture setup. The test process ignores a caller's `XIAOXI_CONFIG`, never loads `deployment.local.json`, and routes temporary files under the repository. Production `owner_config.py` and the authorization gate are unchanged. Fresh-child Node tests prove both missing and invalid caller owner configuration still use the fixture, while a separate production import with an absent owner file still has zero groups/native disabled.

Using the clean validation Python environment, raw discovery without `XIAOXI_CONFIG` and the standalone runner each passed all 67 tests. The complete Node suite passed 438/438. These are source-root verification results; the parent workflow will re-export the new candidate and run all clean gates again rather than reuse the rejected export.

CI now adds Windows-only native tests with Python 3.12 and the existing pinned desktop requirements. The setup-python action is pinned to the full commit linked by its [official v5.6.0 release](https://github.com/actions/setup-python/releases/tag/v5.6.0), [a26af69be951a213d495a4c3e4e4022e16d87065](https://github.com/actions/setup-python/commit/a26af69be951a213d495a4c3e4e4022e16d87065). This CI configuration was reviewed locally; no remote CI execution is claimed, and Linux native WeChat compatibility is not claimed.
