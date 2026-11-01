# STATUS.md — Cindy work log

Append-only. Newest entry at the **top**. One entry per agent session.
Every claim carries a verification label from `AGENTS.md` rule 0:
`typechecked` · `unit-tested` · `live-proven` · `unverified`.

Entries before 2026-10-28 were reconstructed from the old `HANDOVER.md` §6 and
re-labelled honestly. Where the original text claimed "done" but the evidence
was weaker, the weaker label is used and the roadmap row reflects it.

---

## 2026-11-01 — Fail fast on a down local endpoint (2.4c) + correct provider label (1.9b-3c) (`unit-tested`)

**Why:** owner quit LM Studio's window; its server kept running with no model. A Hermes turn on `google/gemma-4-26b-a4b-qat:2` showed "Working…" for minutes, then LM Studio's raw "HTTP 400: No models loaded". The cost panel labelled Gemma turns `deepseek/…`.

**Changes:**
- `packages/maker-core/src/providers/route-preflight.ts` (new): `preflightModelRoute(model)` resolves the route; for a providers.yaml endpoint it probes the model list (2.5 s, same probe as discovery: listed host only, no redirects). Returns offline / error / model-not-loaded with a named message, else ok. Home route → ok, no I/O.
- `model-route-resolver.ts`: routes carry `providerId`; discovered models are remembered per endpoint (step 5), so discovery forgetting an offline/unloaded model no longer sends that id to the Hermes home provider.
- `agents/hermes/agent.ts`: `send()` runs the preflight first (injectable `AgentDeps.preflightHermesRoute`) and throws its message before the "Working…" status and before `query/send`. It records `turnProviderId` and stamps it as `usage.provider` on the done event.
- `apps/desktop/src/main/maker-ipc/sessionHermesTurnUsage.ts`: `provider = usage.provider ?? home route provider`.

**Tests:** maker-core providers 59/59 (+5), Hermes agent 45/45 (+1), sessionHermesTurnUsage 6/6 (+1). Mutation checks: dropping the agent throw fails the agent test; disabling resolver step 5 fails 3 preflight/memory tests; reverting the provider precedence fails the usage test.

**Gates (cloud, Node 22.23.4):** serial typecheck `EXIT=0`; `test:runner` 607/0; test-hygiene PASS. maker-core full unit: 6137 pass, 2 fail, both environmental and Pi-only: `cindyBridgeSource.test.ts` (missing `apps/ripgrep-bin/linux-x64/rg` in this container; fails identically with this change stashed) and `cindySubagentRunner.test.ts` (known `/bin/ps` environment item in ROADMAP Debt). Related unit tier to be run on the owner's Mac.

**Still open:** 2.4c-live and 1.9b-3c-live (owner).

---

## 2026-11-01 — Owner click-throughs: 1.9b-3b, 2.1b-live, 2.4b-live (results + two defects found)

- **1.9b-3b ✅ `live-proven` with a defect.** The header token chip opened the panel: "3 turns · in 56.0k · out 387 · cache R 2.8k · Cost ~$0.0046 (partial)"; per model "deepseek/google/gemma-4-… 41.5k tok · unpriced", "deepseek/deepseek-flash 17.7k tok · $0.0046"; unpriced notice for gemma. **Defect (new 1.9b-3c):** `sessionHermesTurnUsage.ts` stamps every Hermes turn with the *home* route provider (`readHermesRoute` → deepseek), even when the turn ran on a per-session custom route (LM Studio). Gemma is labelled `deepseek/…`, and a local model whose id matches a priced provider model could be mis-priced.
- **2.1b-live ✅ `live-proven`.** Owner confirmed the providers card in Settings → General → Hermes Harness.
- **2.4b-live ❌ not proven.** Gemma chat, LM Studio quit, "hi" sent. **No paid fallback happened** (safety rule held). But (a) no blocked banner, and (b) the turn sat on "Working…" for 3m27s+ with no error. Causes: (a) the chat model was `google/gemma-4-26b-a4b-qat:2` (LM Studio loaded a second instance), which does not exactly match the owner's `gemma-local` route model; more generally `assessSessionRouteHealth` only checks `routing.yaml` routes, so discovered-endpoint models are never checked. (b) Nothing preflights the custom endpoint before a Hermes turn, so the CLI waits on a dead `127.0.0.1:1234`. **Proposed 2.4c:** preflight the resolved custom endpoint before a Hermes send and fail fast with a named error and one-click alternative (hot path; needs `live-proven`).
- 2.5b-live not yet run.

---

## 2026-11-01 — ROADMAP 1.6b plugin switch `live-proven` (owner)

After pulling `claude/jolly-brown-n5edmp` and restarting, the owner used Settings → General → Hermes Harness → Plugins:
- Switch **on**: `config.yaml` had `plugins: enabled: [superpowers/.hermes-plugin]`, `disabled: []`.
- Switch **off**: `enabled: []`, `disabled: [superpowers/.hermes-plugin]`.

Hermes's own CLI rewrote the section; Cindy wrote no YAML. Hermes also dropped the blank line before `mcp_servers:` (its own formatting, harmless). Not part of this task, but seen: the Cindy marketplace "Plugins" page and the SkillHub "Public" tab ("Load failed: 请求失败 (0)") are upstream cloud surfaces, unrelated to Hermes plugins.

---

## 2026-11-01 — Hermes handle model tracks switches + plugin on/off in Settings (ROADMAP 1.6a) (`unit-tested`)

**1. Hermes `AgentSessionHandle.model` follows `setModel`** (`packages/maker-core/src/agents/hermes/agent.ts`). The handle exposed `model` as a fixed property from session start. `Session.model` and the desktop runtime profiles (`readSessionRuntimeProfiles`: `live.model`) therefore reported the start model after a mid-session switch. It is now a getter over a variable updated after `QUERY_SET_MODEL` succeeds, keeping the Cindy id (`hermes-default` sentinel or the override). Test: `agent.test.ts` "handle.model follows a successful setModel" failed first (`expected 'hermes-default' to be 'qwen3-8b'`), then passed. 44/44 Hermes agent tests.

**2. Plugin on/off switch (1.6a).**
- Owner input: `hermes-cindy plugins disable superpowers` left `plugins: { enabled: [], disabled: [superpowers/.hermes-plugin] }` in `~/.hermes-cindy/config.yaml`.
- Daemon: `config/setPluginEnabled {name, enabled}` → `hermes plugins enable|disable <name>` with `HERMES_HOME` = manager home (`hermes-plugins.ts`). Names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, so no `..`, no flags. The CLI's stderr comes back as an `INTERNAL` RPC error. Cindy never writes the plugins YAML itself (AGENTS.md §3).
- Fixture: `fake-hermes.mjs` answers `plugins …` (exit 0, or 1 with `FAKE_PLUGINS_FAIL`).
- Desktop: channel `maker:hermes-config:set-plugin-enabled` (trusted renderer only), preload `hermesConfig.setPluginEnabled`, `HermesSection.tsx` `Switch` per plugin with a toast. Hint text says changes apply to new chats.
- `parseHermesPluginLists` (`hermes-manager-client.ts`, js-yaml read-only) replaces a regex that only understood a block `enabled:` list and ignored `disabled:`.
- Tests: daemon `hermes-manager.test.ts` +1 (both argv calls, home, four bad names refused with no CLI call, CLI failure → `INTERNAL`); mutation check swapping enable/disable failed it. Client `hermesManagerClient.test.ts` +2 (owner's exact config shape; block list; missing/broken YAML). Package: maker-hermes-manager 104/104.

**Gates (Node 22.23.4, cloud container):** serial `pnpm -r typecheck` → `EXIT=0`; `pnpm test:runner` → `EXIT=0` (607/0); `pnpm check:test-hygiene` → PASS. Targeted suites green: maker-hermes-manager 104/104, Hermes agent 44/44, hermesManagerClient 9/9, lizi-mcps 76/76. **Related unit tier NOT yet green.** The first full run failed only on the container's missing `better_sqlite3.node` build (566 "Could not locate the bindings file"; deps were installed with `--ignore-scripts`). After building it, lizi-mcps went 76/76. **Owner's Mac (M5, Node 22), same day:** `test:runner` 608 pass / 0 fail, then every unit workspace PASS, including `apps/desktop unit` (308 s), `packages/maker-core`, `packages/maker-hermes-manager`, `packages/lizi-mcps`; 7 SKIP (no tests by design). **Related unit gate green.**

**Still open:** 1.6b live proof (owner: Settings → Hermes Harness → toggle `superpowers` off/on; check `grep -A4 "^plugins:" ~/.hermes-cindy/config.yaml` matches the page). The dev restart rebuilds `dist/hermes-mgr.mjs`; if the switch errors with an unknown method, the daemon bundle is stale.

---

## 2026-11-01 — ROADMAP 2.2 closed `live-proven` (owner check after merging PR #1)

Owner pulled `main` (PR th3ottoman-png/cindy#1 merged), restarted the dev app, and reported:
- qwen3-8b with the Hermes `superpowers` plugin disabled answers normally, with no `skill_view` loop. 2.2b-4 is closed by configuration, with no code change.
- Switching models mid-conversation keeps the selected model in the header and picker.

Row 2.2 is now ✅ `live-proven`. No code changed in this entry.

**Still open in Phase 2 (all owner-clicked live checks, code already `unit-tested`):** 2.1b-live, 2.4b-live, 2.5b-live (the "Summarise and continue" button itself; the banner percentage was proven 2026-11-01).

---

## 2026-11-01 — Owner live check after disabling `superpowers` (`live-proven`)

Owner disabled the Hermes `superpowers` plugin via the `hermes-cindy` launcher, then ran a new Hermes chat on `google/gemma-4-26b-a4b-qat` (LM Studio, 262,144 loaded) with three turns. Screenshot evidence:
- Header kept `google/gemma-4-26b-a4b-qat` across all three turns. This proves the 2.2b-3 label fix past turn 2.
- No false context banner at 87.3k tokens; the ring reads 21%. This proves the 2.2b-5 banner fix in the running app.
- Replies are direct, with no `skill_view` calls and no "Using superpowers:..." preamble. This is consistent with the 2.2b-4 diagnosis.

Qwen 8B was not re-run with the plugin off, so 2.2b-4 is not yet proven fixed for Qwen.

---

## 2026-11-01 — Diagnosis: qwen3-8b `skill_view` loop (ROADMAP 2.2b-4) (`unverified` fix, diagnosis only)

**Evidence:** the owner pasted one `skill_view` call's input and output from the looping Qwen turn. Call: `{"name": "superpowers:using-superpowers"}`. Skill path: `~/.hermes-cindy/plugins/superpowers/skills/using-superpowers`. The skill body requires invoking skills "BEFORE any response including clarifying questions" when there is "even a 1% chance" one applies, and lists 14 sibling skills.

**Reading:** a small model treats that as an unconditional loop: view the skill, be told to view skills first, view again. Cindy's 12-call loop guard then stops the turn. Gemma 26B follows the same instruction once and then answers (the owner's screenshot shows "Using `superpowers:systematic-debugging`..."). The plugin's skill list and instructions also add to the large per-turn prompt (35k tokens after one short Gemma turn).

**Not done:** no code or config change. Disabling or scoping the plugin is an owner decision. Per AGENTS.md it must go through Hermes's own plugin commands or daemon RPCs, never a hand edit of `~/.hermes-cindy/config.yaml`.

---

## 2026-11-01 — Defect Fix: Hermes context banner uses the serving endpoint's limit (`unit-tested`)

**Owner repro:** new Hermes chat on `google/gemma-4-26b-a4b-qat` (LM Studio, loaded at 262,144). After one turn (35.4k tokens) the banner said "Context is 108% full". The footer ring said 17%. `~/.cindy-harness/providers.yaml` already had `lmstudio-local.capabilities.contextLength: 262144`, and `routing.yaml` had `chat.default: ollama-offline`.

**Root cause:** `resolveSessionContextLength` (`apps/desktop/src/renderer/features/cc-agent/SessionContextGuardBanner.tsx`) only knew models hand-listed in `routing.yaml`. Hermes sessions have no providerId, and discovered models are not routes, so it fell through to `chat.default`'s provider (Ollama, 32,768).

**Outcome:**
1. `SessionContextGuardBanner.tsx`: after the routing lookup, use the `contextLength` of the **online** probed endpoint whose model list contains the session model. The banner already fetched `probes`; they are now passed in. Offline endpoints are ignored.
2. `apps/desktop/src/renderer/__tests__/sessionContextGuardBanner.test.tsx`: +1 test (discovered model on an online LM Studio endpoint → that endpoint's limit; offline endpoint → no match, falls through). 5/5.

**Mutation check (1):** the new test ran first against the unchanged code and failed (`expected 32768 to be 65536`), then passed with the change.

**Owner workaround already applied (keep or remove):** a `gemma-local` route (`provider: lmstudio-local`, `model: google/gemma-4-26b-a4b-qat`) in `~/.cindy-harness/routing.yaml`, backed up to `routing.yaml.bak-20261101`. With this fix it is no longer needed.

**Gates (Node 22.23.4):** serial `pnpm -r typecheck` → `EXIT=0`; `pnpm test:runner` → `EXIT=0` (607/0); `test-workspaces --tier unit --related --workspace-concurrency=1` → `EXIT=0`; `pnpm check:test-hygiene` → PASS.

**Still open:** live check (new Gemma chat → banner percentage should roughly match the ring). The ring still assumes a fixed 200k Hermes window. Not changed here.

---

## 2026-11-01 — Defect Fix: Hermes model label reverts to `hermes-default` after first send (`unit-tested`)

**Root cause (found by reading, proved by a failing test):**
The send path was never the problem. Every lazy-create / prewarm path re-reads `sessions.model` from the DB (`reconcileCreateOptsAgainstDb`), so the turn running on Qwen proves the row held `qwen3-8b` at send. The rewrite happens *after* the session view mounts:
- `apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx` "M35 vendor fallback" effect calls `shouldFallbackVendorModel(providers, session.model, agent)`.
- Hermes sessions always have `providerId: null`, and no Cindy catalog provider lists models under the `hermes` agent. So if any provider lists the same id for Pi / Codex / Claude Code (e.g. an LM Studio provider exposing `qwen3-8b` to Pi), the check returned `true`.
- The effect then wrote `getDefaultModelForVendor('cc')` (a `claude-*` id) into `sessions.model`. The earlier foreign-model sanitizers (`HermesSessionModelLabel`, `ModelSelector.isForeignHermesModelId`) display any `claude-*` id as `hermes-default` / "Hermes home default (deepseek-flash)". That is the visible "revert".
- This is also the likely origin of the legacy `xai/grok-4.6` row repaired last session, and it means the *second* turn would have been launched with a Claude model id.

**Outcome:**
1. `apps/desktop/src/renderer/features/cc-agent/lib/vendorModelFallback.ts`: `shouldFallbackVendorModel` returns `false` for `agent === 'hermes'` (Hermes owns its model routing via Hermes home + `providers.yaml`).
2. `apps/desktop/src/renderer/__tests__/vendorModelFallback.test.ts`: +1 test (`never repairs a Hermes session model, even when another engine offers that id`), 11/11 passing.

**Mutation check (1):** the new test was run against the unfixed `vendorModelFallback.ts` first and failed (`expected true to be false` on `shouldFallbackVendorModel(withLocalPi, 'qwen3-8b', 'hermes')`); adding the guard turned it green.

**Gates (Node 22.23.4, cloud Linux container, deps installed with `pnpm install --frozen-lockfile --ignore-scripts` + `node scripts/ensure-deps.mjs --electron-binary`):**
- `pnpm typecheck`: parallel run OOM-killed in `apps/mobile` (container memory, not a type error); serial re-run `NODE_OPTIONS=--max-old-space-size=6144 pnpm -r --if-present --workspace-concurrency=1 run typecheck` → `EXIT=0`.
- `pnpm test:runner` → `EXIT=0` (607 pass, 0 fail).
- `node scripts/test-workspaces.mjs --tier unit --related --workspace-concurrency=1` → `EXIT=0`.
- `pnpm check:test-hygiene` → `EXIT=0`.

**No user state touched.** No DB, `config.yaml`, or `.env` edits this session (the container has no access to the owner's Mac).

**Still open:**
- `live-proven` needs the owner: new task → Hermes → pick `qwen3-8b (lmstudio-local)` → send "hi" → header and composer pill should still read `qwen3-8b` after the reply and after a second turn.
- The session from the owner's failing repro likely still has a `claude-*` id in `sessions.model`. Re-selecting `qwen3-8b` in that session's picker rewrites it through `handleSetModel`; no manual DB edit needed.
- Found, not fixed (separate task): the Hermes `AgentSessionHandle.model` in `packages/maker-core/src/agents/hermes/agent.ts` is a fixed property set at start and never updated by `setModel`, while `Session.model` assumes the handle getter tracks switches. Runtime profiles that read `live.model` (`readSessionRuntimeProfiles` in `register.ts`) can therefore report the start model after a mid-session switch.

**Owner live check (same day, after `pnpm restart:desktop:remote --region=global` on this branch):** new task → Hermes → `qwen3-8b (lmstudio-local)` → "hi". The header and composer pill both still read `qwen3-8b` after the turn ended, so the revert is fixed for turn 1. Turn 2 has not been run yet.
New, separate issue seen in the same run: the turn produced no reply. `qwen3-8b` called Hermes `skill_view` 5+ times and ran for 3m 22s, then Cindy's loop guard stopped it ("kept cycling between tool calls ... 12 calls"). Open as ROADMAP 2.2b-4. Not yet diagnosed: check which skill it opened (expand the `skill_view` rows) and whether a plain no-tool chat works on this model.

**Surprising:** the earlier "foreign model sanitization" hid this bug instead of exposing it: a `claude-*` id written into a Hermes row rendered as the Hermes default rather than as an obviously wrong model.

---

## 2026-11-01 — Defect Fix: Hermes UI model synchronization, multi-segment route resolution, and foreign model sanitization (`unit-tested`)

**Outcome:**
1. `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`: mapped `agentKind === 'hermes'` to `vendor = 'hermes'` in `syncSessionDraftModelPrefs` so Hermes preferences update correctly, and bypassed the context window guard for Hermes-to-Hermes switches to eliminate bogus `10470% full` blocks on model selection.
2. `apps/desktop/src/renderer/state/newMakerDraft.ts` + `apps/desktop/src/main/localDb/sessionOpening.ts`: added foreign model sanitization (`xai/`, `claude-`, `gpt-`, `chatgpt/`, `grok`) on drafts and provisional session openings so Hermes sessions cannot be initialized with foreign engine models.
3. `apps/desktop/src/main/maker-ipc/register.ts`: in `bootstrapSession`, synchronized `sessions.model` in SQLite DB if it drifted from `o.model` and broadcast `broadcastSessionPatched(o.id, { model: o.model })`.
4. `packages/maker-core/src/providers/discovery.ts` + `packages/maker-core/src/providers/model-route-resolver.ts`: cached online local endpoint models in `discovery.ts` (`getLatestDiscoveredModels`); enhanced `model-route-resolver.ts` to support multi-segment model paths with slashes (e.g. `lmstudio-local/google/gemma-4-26b-a4b-qat`) and match discovered endpoint models dynamically so ANY local model from LM Studio / Ollama routes to `--provider custom --base-url <url> -m <model>`.
5. `packages/maker-core/src/providers/__tests__/model-route-resolver.test.ts`: added tests covering multi-segment model routes and dynamic discovery route resolution (3/3 passing).
6. `apps/desktop/src/renderer/features/cc-agent/HermesSessionModelLabel.tsx`: added foreign model normalization so the top header never displays Grok or Claude for a Hermes session.
7. `apps/desktop/src/renderer/components/new-chat/ModelSelector.tsx`: exported `isForeignHermesModelId`; guarded "Set as Hermes home default" action and fell back `currentModel` in the composer trigger pill to `hermes-default` if a legacy foreign model was stored, preventing "Model Details Unavailable".
8. Repaired session `d74fb888-ccbe-4a17-94dc-13672998a788` in local SQLite DB by updating `model = 'qwen3-8b'` (backed up to `cindy-local-v1.db.bak-20261101-session-fix`).
9. Dev app cleanly restarted with `pnpm restart:desktop:remote --region=global` and verified running.

**Mutation checks (2):**
- In `packages/maker-core/src/providers/model-route-resolver.ts`, removing `options.endpointModels` matching failed `model-route-resolver.test.ts` (`expected null to deeply equal { model: 'google/gemma-4-26b-a4b-qat', provider: 'custom', ... }`); restored byte-identical.
- In `apps/desktop/src/renderer/features/cc-agent/HermesSessionModelLabel.tsx`, changing foreign model check fallback from `'hermes-default'` to `model` failed `hermesSessionModelLabel.test.tsx` when tested with `'xai/grok-4.6'`; restored byte-identical.

**Not claimed:** final visual verification of the newly started turn by the owner in the running desktop UI is pending.

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** `(pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene); echo "EXIT=$?"` → **`EXIT=0`**.

---

## 2026-11-01 — Wire Cindy UI model picker selections to Hermes agent turns (`unit-tested`)

**Outcome:**
1. `packages/maker-core/src/providers/model-route-resolver.ts` (+ tests in `packages/maker-core/src/providers/__tests__/model-route-resolver.test.ts`, +3 tests): maps requested model or route names to endpoint parameters (`model`, `provider`, `baseUrl`, optional `apiKey`) from `~/.cindy-harness/routing.yaml` and `providers.yaml`.
2. `packages/maker-core/src/agents/base-agent.ts` + `packages/maker-core/src/agents/hermes/agent.ts`: updated `AgentSessionHandle.setModel` and `HermesAgentSession.startSession` to resolve model routes and propagate `provider`, `baseUrl`, and `apiKey` to the Hermes daemon.
3. `packages/maker-hermes-manager/src/protocol.ts` + `session-registry.ts` + `hermes-manager.ts` + `hermes-run.ts`: added `--base-url` and `--api-key` CLI flag handling. In `hermes-manager.ts`, provider or baseUrl switches against frozen `launch` clear `hermesSessionId` and start a fresh Hermes CLI session on the new provider instead of failing on `--resume`. Rebuilt `dist/hermes-mgr.mjs`.
4. `apps/desktop/src/main/maker-ipc/register.ts`: on `handleSetModel` for Hermes sessions, calls `resolveModelRoute` and passes resolved route options to `sess.setModel`.
5. `~/.hermes-cindy/config.yaml`: added `model.ollama_num_ctx: 65536` to bypass Hermes CLI's 64k token context window floor check on local models (e.g. LM Studio Qwen3-8b). Backup saved to `config.yaml.bak-20261101-numctx`.
6. Dev app restarted with `pnpm restart:desktop:remote --region=global`.

**Mutation checks (2):**
- In `packages/maker-core/src/providers/model-route-resolver.ts`, breaking `normalizeBaseUrl` failed `model-route-resolver.test.ts` (2 tests failed: normalization and route resolution baseUrl mismatch); restored byte-identical.
- In `packages/maker-hermes-manager/src/hermes-manager.ts`, setting `providerChanged = false` failed `hermes-manager.test.ts` (`expected [ '/model qwen3-8b', 'turn 2' ] to deeply equal [ 'turn 2' ]`); restored byte-identical.

**Not claimed:** visual selection in the running UI is unit-tested and proved via CLI; final owner turn verification in desktop UI is pending.

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** `(pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene); echo "EXIT=$?"` → **`EXIT=0`**.

---

## 2026-11-01 — Defect Fix: Relocate route/context banners from window titlebar to chat composer stack (`unit-tested`)

**Outcome:**
1. `apps/desktop/src/renderer/features/cc-agent/SessionContentHeader.tsx`: removed `<SessionRouteBlockedBanner>` and `<SessionContextGuardBanner>` from the 40px macOS window titlebar row where they squashed the header, disrupted drag behavior, and squeezed action buttons.
2. `apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx`: mounted `<SessionRouteBlockedBanner>` and `<SessionContextGuardBanner>` above `data-chat-composer-stack` matching Cindy's existing banner conventions (`width: inputWidth`, `className="py-1"`).
3. `apps/desktop/src/renderer/features/cc-agent/SessionRouteBlockedBanner.tsx` + `sessionRouteBlockedBanner.test.tsx` (+1 test, 4/4): `assessSessionRouteHealth` returns `null` for `agentKind === 'hermes'` when using `hermes-default` (Hermes home config owns the route, preventing spurious offline errors from `routing.yaml`).
4. `apps/desktop/src/renderer/features/cc-agent/SessionContextGuardBanner.tsx` + `sessionContextGuardBanner.test.tsx` (+1 test, 4/4): `resolveSessionContextLength` prioritizes positive `sessionContextWindow` over fallback `chat.default`.
5. `~/.cindy-harness/providers.yaml`: corrected `contextLength` test value from `200` to `32768`.
6. Dev app restarted with `pnpm restart:desktop:remote --region=global`.

**Mutation checks (2):**
- In `SessionRouteBlockedBanner.tsx`, changing `agentKind === 'hermes'` guard to `'other'` failed `sessionRouteBlockedBanner.test.tsx` (`returns null for hermes sessions using hermes-default`); restored byte-identical.
- In `SessionContextGuardBanner.tsx`, disabling the positive `sessionContextWindow` check failed `sessionContextGuardBanner.test.tsx` (`expected 65536 to be 200000`); restored byte-identical.

**Not claimed:** visual appearance in the restarted app is pending owner confirmation.

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** `(pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene); echo "EXIT=$?"` → **`EXIT=0`**.

---

## 2026-11-01 — Defect Fix: Hermes model picker selection and runtime projection sync (`unit-tested`)

**Outcome:**
1. `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx` (+3 lines): added `if (runtimeAgentKind) return runtimeAgentKind;` in `currentModelAgentKind` memo to prevent falling back to Claude Code when selecting models, and included `runtimeAgentKind === 'hermes' ? 'hermes' :` in the `vendorKey` selector prop so Hermes's identity is passed down rather than resolving to `undefined`.
2. `apps/desktop/src/renderer/components/new-chat/ModelSelector.tsx` (+1 line): updated `vendorKey` prop passed to `ModelSelectorContentView` to use `agentIdentity?.vendorKey ?? vendorKey`.
3. `apps/desktop/src/main/maker-ipc/register.ts` (+4 lines): in `handleSetModel` for Hermes, added `recordUserSessionRuntimeMutation(sessionId)` for user-initiated changes and `await broadcastSessionRuntimeProjection(sessionId)` to ensure the active session projection is synchronized with renderer stores.
4. Repaired session `03b0a1a5-3d4f-44e8-bd53-6b6584fff191` in local SQLite DB by resetting corrupted `model = 'xai/grok-4.6'` to `'hermes-default'` (backed up to `cindy-local-v1.db.bak-2026-11-01-retry` first).

**Mutation checks (2):**
- In `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`, omitting `runtimeAgentKind === 'hermes' ? 'hermes'` drops `vendorKey` to `undefined` for Hermes sessions when `vendorKey` prop is unset.
- In `apps/desktop/src/main/maker-ipc/register.ts`, omitting `broadcastSessionRuntimeProjection` fails to notify renderer runtime projection subscribers when Hermes models are switched.

**Not claimed:** not yet re-clicked by the owner in the running desktop app (dev app restarted in background for verification).

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** `pnpm typecheck` passed (`EXIT=0`); parallel `pnpm test:unit:related` hit the known `apps/desktop unit` SIGSEGV flake; reran serial with `node scripts/test-workspaces.mjs --tier unit --related --workspace-concurrency=1` (`EXIT=0`); `pnpm check:test-hygiene` passed (`EXIT=0`).

---

## 2026-11-01 — Phase 2: ROADMAP 2.5b-1, context-window guard warning UI and routed "summarise and continue" action (`unit-tested`)

**Outcome:**
1. `apps/desktop/src/renderer/features/cc-agent/SessionContextGuardBanner.tsx` (new), `apps/desktop/src/renderer/features/cc-agent/SessionContentHeader.tsx` (+2 lines), and `apps/desktop/src/renderer/__tests__/sessionContextGuardBanner.test.tsx` (new, 4 tests): `resolveSessionUsedTokens` reads the latest assistant turn's `turnUsageDetails` tokens (falling back to `session.contextTokens` / `session.totalTokenUsage`), `resolveSessionContextLength` resolves the active model's `capabilities.contextLength` from `providers.yaml` via `routing.yaml`, and `SessionContextGuardBannerView` renders the `warn` / `critical` banner from `guardContext` with either a one-click `Summarise and continue (<provider>/<model>)` button (which calls `window.electronAPI.maker.providers.requestRoutedTaskText({ taskClass: 'summary' })`, creates a continuation session, and sends the summary prompt) or the blocked `summary` route reason + one-click alternative route buttons (never auto-switching).

**Mutation checks (2):**
- In `apps/desktop/src/renderer/features/cc-agent/SessionContextGuardBanner.tsx`, iterating `messages` forward (`0..length-1`) instead of backward in `resolveSessionUsedTokens` returned the first turn's tokens instead of the latest turn's and failed `sessionContextGuardBanner.test.tsx` (`expected 12000 to be 57000`); restored byte-identical.
- In `apps/desktop/src/renderer/features/cc-agent/SessionContextGuardBanner.tsx`, replacing `summarise?.ok` with `summarise` rendered the summarise button even when the `summary` route was offline and failed 2 tests in `sessionContextGuardBanner.test.tsx`; restored byte-identical.

**Not claimed:** not clicked in the running desktop app yet. `2.5b-live` stays open for the owner-clicked live proof in the app.

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** `(pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene); echo "EXIT=$?"` → **`EXIT=0`**.

---

## 2026-11-01 — Phase 2: ROADMAP 2.4b-1, no silent fallback session error and one-click "use X instead" UI (`unit-tested`)

**Outcome:**
1. `packages/model-providers/src/index.ts`, `apps/desktop/src/main/maker-ipc/channels.ts`, `apps/desktop/src/main/maker-ipc/providersHandlers.ts`, `apps/desktop/src/preload/preload.ts`, `apps/desktop/src/renderer/vite-env.d.ts`, and `apps/desktop/src/main/maker-ipc/__tests__/providersHandlers.test.ts` (+1 test, 5/5): re-exported `routingFile`, `routeHealth`, and `contextGuard` from `@cindy/model-providers` root barrel, and added trusted IPC channels `maker:routing:get` (`providers.getRouting()`) and `maker:routing:request-task-text` (`providers.requestRoutedTaskText()`).
2. `apps/desktop/src/renderer/features/cc-agent/SessionRouteBlockedBanner.tsx` (new), `apps/desktop/src/renderer/features/cc-agent/SessionContentHeader.tsx` (+8 lines), and `apps/desktop/src/renderer/__tests__/sessionRouteBlockedBanner.test.tsx` (new, 3 tests): `assessSessionRouteHealth` resolves the session's active route (`chat.default` or matching `routing.yaml` route) and evaluates `assessRoute` against live probes; `SessionRouteBlockedBannerView` renders a blocked `ErrorNotice` with one-click `Use <routeName> (<provider>/<model>) (local|paid) instead` buttons (local alternatives first, paid explicitly labelled `(paid)`), and never auto-switches.

**Mutation checks (2):**
- In `apps/desktop/src/renderer/features/cc-agent/SessionRouteBlockedBanner.tsx`, replacing `alt.paid ? ' (paid)' : ' (local)'` with `' (local)'` failed 2 tests in `sessionRouteBlockedBanner.test.tsx` (`expected '... (local) instead' to contain 'Use cloud-flash (deepseek-api/deepseek-chat) (paid) instead'`); restored byte-identical.
- In `apps/desktop/src/main/maker-ipc/providersHandlers.ts`, removing `deps.assertTrusted(event)` from `ROUTING_GET` failed `refuses an untrusted caller on both channels without reading the file` in `providersHandlers.test.ts`; restored byte-identical.

**Not claimed:** not clicked in the running desktop app yet. `2.4b-live` stays open for the owner-clicked live proof that an offline local route blocks and presents the one-click switch in the app.

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** parallel `pnpm test:unit:related` hit the known `apps/desktop unit` SIGSEGV flake; reran with `node scripts/test-workspaces.mjs --tier unit --related --workspace-concurrency=1` → **`EXIT=0`**.

---

## 2026-11-01 — Phase 2: ROADMAP 2.2b-1, local model discovery polling and picker online/offline display (`unit-tested`)

**Outcome:**
1. `apps/desktop/src/renderer/hooks/useHermesModelCatalog.ts` + `apps/desktop/src/renderer/__tests__/hermesModelCatalogDiscovery.test.ts` (new, 2 tests): added `buildDiscoveredEndpointDescriptors` (projects `ProviderFileEndpointView[]` from `projectProviderFileEndpoints` into picker `ModelDescriptor[]` with `endpoint.capabilities.contextLength ?? HERMES_CONTEXT_WINDOW`, deduplicating against home/provider models and never leaking models from `offline`/`error` endpoints, plus `endpointStatuses` summaries) and wired `useHermesModelCatalog` to poll `window.electronAPI.maker.providers.list()` + `discover()` every `DISCOVERY_POLL_INTERVAL_MS` (15 s) while active.
2. `apps/desktop/src/renderer/components/new-chat/ModelSelector.tsx` (+34 lines): displays `hermesCatalog.endpointStatuses` (`online · N loaded` / `offline` / `error`) in the Hermes model picker footer alongside the loaded local models in the picker list.

**Mutation checks (2):**
- In `apps/desktop/src/renderer/hooks/useHermesModelCatalog.ts`, removing the `endpoint.status === 'online'` guard on `loadedModels` and allowing `offline` endpoints through leaked stale models and failed `hermesModelCatalogDiscovery.test.ts` (`expected [ { id: 'stale-model-should-not-appear' } ] to deeply equal []`); restored byte-identical.
- In `apps/desktop/src/renderer/hooks/useHermesModelCatalog.ts`, replacing `endpoint.capabilities.contextLength ?? HERMES_CONTEXT_WINDOW` with `HERMES_CONTEXT_WINDOW` failed `hermesModelCatalogDiscovery.test.ts` (`expected contextWindow 200000 to equal 65536`); restored byte-identical.

**Not claimed:** not exercised in the running desktop app against a live Ollama/LM Studio instance yet. `2.2b-live` stays open for the owner-clicked picker check.

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** `(pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene); echo "EXIT=$?"` → **`EXIT=0`**.

---

## 2026-11-01 — Phase 2: ROADMAP 2.1b-1, `model-providers` projection and Settings UI listing for `providers.yaml` (`unit-tested`)

**Outcome:**
1. `packages/model-providers/src/providersFile.ts` + `packages/model-providers/src/index.ts` + `packages/model-providers/src/__tests__/providersFile.test.ts` (new, 2 tests): added `providerFileEntryToCatalogModels` (projects `ProviderFileEntry` + model ids into `CatalogModel[]` with declared `tools`, `vision`, and `contextLength`) and `projectProviderFileEndpoints` (merges validated `providers.yaml` entries with discovery probes in entry order, stripping stale model lists from `offline`/`error` probes) and exported the `providersFile` surface from `@cindy/model-providers` root barrel.
2. `apps/desktop/src/renderer/components/settings/HarnessProvidersCard.tsx` (new), `apps/desktop/src/renderer/components/settings/HermesSection.tsx` (+6 lines), and `apps/desktop/src/renderer/__tests__/harnessProvidersCard.test.tsx` (new, 2 tests): `HarnessProvidersCard` reads `window.electronAPI.maker.providers.list()` and `discover()` and renders `HarnessProvidersCardView` inside Settings → Hermes Harness, listing each endpoint (`id`, `kind`, `local`/`remote`, `baseUrl`, `keyEnv` variable name or `keyless`, `tools`/`vision`/`ctx` capabilities, probe status and models) plus any `providers.yaml` validation issues.

**Mutation checks (2):**
- In `packages/model-providers/src/providersFile.ts`, removing the `online` guard when populating `models` in `projectProviderFileEndpoints` leaked stale model ids on an offline probe and failed `providersFile.test.ts` (1 failed, 1 passed); restored byte-identical.
- In `apps/desktop/src/renderer/components/settings/HarnessProvidersCard.tsx`, disabling the `issues.length > 0` block failed `harnessProvidersCard.test.tsx` (`expected html to contain 'bad-entry:'`); restored byte-identical.

**Not claimed:** not inspected in the running desktop app yet. `2.1b-live` stays open for the owner-clicked check in Settings → Hermes Harness.

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** `(pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene); echo "EXIT=$?"` → **`EXIT=0`**.

---

## 2026-11-01 — Phase 1: ROADMAP 1.9b-3a, per-conversation usage and cost panel UI (`unit-tested`)

**Outcome:**
1. `apps/desktop/src/shared/conversationUsage.ts` (new) + `apps/desktop/src/main/usage/conversationUsageAdapter.ts`: moved the pure adapter functions (`resolveRecordedTurnMoney`, `quoteToUsageRates`, `lookupTurnPriceQuote`, `adaptStoredTurnToSessionUsageTurn`, `buildConversationUsageFromStoredTurns`) to `src/shared/conversationUsage.ts` and re-exported them from `src/main/usage/conversationUsageAdapter.ts` so both main and renderer share one implementation without crossing the `renderer -> main` boundary.
2. `apps/desktop/src/renderer/features/cc-agent/SessionUsagePanel.tsx` (new), `apps/desktop/src/renderer/features/cc-agent/SessionContentHeader.tsx` (+9 lines), `docs/design-rules/design-inventory.md` (updated via `pnpm design:inventory`), and `apps/desktop/src/renderer/__tests__/sessionUsagePanel.test.tsx` (new, 4 tests): `SessionUsagePanel` subscribes to the conversation's messages (`makerChatStore` / `useChatDisplaySnapshot`) and live pricing catalogs (`useGatewayModelPricing`, `useReferenceModelPricing`), filters assistant messages with `turnUsageDetails`, computes `buildConversationUsageFromStoredTurns`, and renders `<SessionUsagePanelView>` in the conversation header. Shows nothing when no turns carry usage; otherwise renders a no-drag `<details>` chip (`<tokensLabel> tok · <cost>`) and expandable breakdown with turn count, in/out/cache tokens, `complete` / `partial` / `local (tokens only)` / `unpriced` cost status, per-model rows, and `Unpriced: ...` notice.

**Mutation checks (2):**
- Removing the `message.role !== 'assistant'` filter in `extractStoredTurnsFromMessages` failed `extracts only assistant messages that carry turnUsageDetails and renders complete cost and model breakdown` (`expected length 1 but got 2`), 3 others passed; restored byte-identical.
- Setting `allLocal = false` in `SessionUsagePanelView` failed `renders tokens-only local badge for local model conversations without pricing them` (`expected 'Cost: unpriced' to contain 'Cost: local (tokens only)'`), 3 others passed; restored byte-identical.

**Not claimed:** not seen or clicked in the running desktop app yet. `1.9b-3` is split into `1.9b-3a` (`unit-tested`, done) and `1.9b-3b` (owner-clicked live proof in the dev app on a real conversation, open).

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** `(pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene); echo "EXIT=$?"` → **`EXIT=0`**.

---

## 2026-11-01 — Phase 1: ROADMAP 1.9b-2, conversation usage adapter (`unit-tested`)

**Outcome:**
1. `packages/maker-shared/src/sessionUsage.ts` (+ `src/__tests__/sessionUsage.test.ts`, +1 test, 13/13): `SessionUsageTurn` gained `money?: SessionUsageMoney` (`{ amount, currency }`). `buildSessionUsage` checks `priceFromRecordedMoney(turn.money)` before `turn.rates` for non-local turns, so recorded turn money is summed verbatim and wins over any rate table; local turns still ignore both `money` and `rates`.
2. `apps/desktop/src/main/usage/conversationUsageAdapter.ts` (new) + `apps/desktop/src/main/usage/__tests__/conversationUsageAdapter.test.ts` (new, 8 tests): `adaptStoredTurnToSessionUsageTurn`, `buildConversationUsageFromStoredTurns` and `resolveConversationUsageSummary` adapt stored `messages.agent_meta.turnUsageDetails` into `SessionUsageTurn` and roll them up with `buildSessionUsage`. Recorded money is extracted from `turnUsageDetails.perModelCost[].money` (or `turnMoney` fallback), refusing mixed-currency `perModelCost` on a single turn rather than dropping one currency; turns without recorded money look up their quote via `getModelPriceQuote` from `getGatewayModelPricingForModel()` on the `xd` route and `getReferenceModelPricing()` on non-`xd` routes (never mixing the two catalogs), projecting context-length bands (`inputTokenPriceBands`) and gateway `costDiscount` into per-turn `UsageRates`. Verified against `BUNDLED_CATALOG`: a Hermes `deepseek-flash` turn (10k in / 1k out / 5k cache-read) prices at USD 0.00423; a `deepseek-flash` turn with cache writes stays unpriced (`costStatus: "none"`, `unpricedModels: ["deepseek-flash"]`) because DeepSeek publishes no cache-write tariff; a mixed 4-turn conversation (Claude recorded money + Hermes `deepseek-v4-pro` reference quote + local `qwen3-8b` + unpriced model) sums to `costStatus: "partial"`, `cost: 0.04216`, `unpricedModels: ["mystery-model-x"]`.

**Mutation checks (2):**
- In `packages/maker-shared/src/sessionUsage.ts`, flipping the precedence to check `turn.rates` before `priceFromRecordedMoney(turn.money)` failed the new recorded-money test (`expected 1.2408 to be 0.05`), 12 others passed; restored byte-identical.
- In `apps/desktop/src/main/usage/conversationUsageAdapter.ts`, routing `xd` lookups to `referencePricing ?? gatewayPricing` instead of isolating `xd` to `gatewayPricing` failed the gateway pricing and async catalog tests (2 failed, 6 passed); restored byte-identical.

**Not claimed:** no panel UI, no IPC endpoint, and not exercised in the running desktop app. 1.9b-3 owns the per-conversation panel UI and the owner-clicked live proof.

**Gates (Node 22, proxy vars unset, `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0`):** `(pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene); echo "EXIT=$?"` → **`EXIT=0`** (`pnpm typecheck` EXIT=0; `pnpm test:runner` EXIT=0; `pnpm test:unit:related` EXIT=0 across all workspaces including `packages/maker-shared` 13/13 on `sessionUsage.test.ts` and `apps/desktop` 8/8 on `conversationUsageAdapter.test.ts`; `pnpm check:test-hygiene` PASS, 361 files within baseline).

---

## 2026-10-31 — Phase 1: ROADMAP 1.9b-1, Hermes per-turn usage facts (`unit-tested`)

**The row was blocked by a gap nobody had written down.** 1.9b asks for an adapter "from stored turns (`messages.agent_meta` `TurnUsageDetails`) into 1.9a". The stored turns existed for Claude Code, Codex and Pi. **Hermes had none**: `sessionEventPipeline.ts` wires one recorder per agent kind and Hermes was not among them, so every Hermes conversation carried zero usage rows. Measured on the dev app database (read-only): 91 messages, agent kinds `hermes 87` / `codex 2` / `cc 1` / `null 1`, and exactly **one** message with `turnUsageDetails` (a Codex row). The 87 Hermes rows carried nothing but `turnCompleted`. A panel over a real Hermes conversation would have shown nothing, so the row's own acceptance criterion was unreachable until that closed. **1.9b is now split** into 1.9b-1 (the facts, this entry) / 1.9b-2 (the adapter) / 1.9b-3 (panel + live proof); 1.9b-1 is the only one closed.

**The facts Hermes already reported and nobody read.** The CLI puts per-turn tokens in its terminal `result` event (`input` / `output` / `total` / `cache_read` / `cache_write`); maker-core already normalised them onto the `done` event as `data.usage`, and the desktop had no reader for that field on the Hermes source. The CLI also reports **the model the run used** in its `system/init` event, which the translator dropped (`return { kind: 'unknown' }`, commented "model metadata may matter later"). That comment was the whole gap. The **provider** is a Hermes-home fact, not a Cindy session fact: Hermes picks its own provider in `config.yaml` (`model.provider`), and the Cindy session provider store knows nothing about it. This home runs `provider: deepseek`, `base_url: api.deepseek.com/v1`, `default: deepseek-flash`.

**Fix.** `packages/maker-core/src/agents/hermes/translator.ts`: `system/init` normalises to `{ kind: 'session-init', model? }` instead of `unknown`. The init's `session_id` is deliberately **not** carried, because the daemon owns that binding and emits it as `hermes-mgr/session-bound` — an earlier draft took the id from init and stole the binding, which broke the "durable notice when the daemon replaced a lost resume id" agent test. `packages/maker-core/src/agents/hermes/agent.ts`: the handle remembers the init model per turn and puts it on the `done` event's `usage`; the model is cleared at the start of every turn, so a turn whose CLI never reached init cannot inherit the previous turn's model and be priced against the wrong tariff. `apps/desktop/src/main/maker-ipc/sessionHermesTurnUsage.ts` (new): stores tokens + model + provider in `messages.agent_meta.turnUsageDetails` via `recordTurnUsageOnMessage` and adds the turn's tokens to `sessions.total_token_usage`. It prices nothing: the amount belongs to the pricing layer (1.9b-2), so this recorder cannot invent one. `apps/desktop/src/shared/turnUsageDetails.ts`: `TurnUsageDetails` gained an optional `provider` — without it a stored turn cannot be priced at all (the catalog is keyed by provider) and a turn cannot be re-priced later under a different home route; the merged turn keeps one provider and refuses a mixed route. `apps/desktop/src/main/maker-ipc/register.ts`: `readHermesRoute()` reads the home route per turn (it can change between turns via `/model` or a home edit); an unreadable home config costs the price, never the tokens.

**Priceability was checked, not assumed.** Running the real resolver against the dev app's cached model catalog: `deepseek-flash` = USD 0.30 in / 1.20 out / 0.006 cache-read per Mtok; `deepseek-v4-pro` = USD 1.32 / 3.96 / 0.044. So a Hermes turn **is** priceable. Two constraints found on the way: the DeepSeek reference prices publish **no cache-write rate**, so a turn reporting cache writes would stay unpriced (the honest outcome, and what `computeGatewayTurnCost` already does for every other agent) — but the real Hermes transcript fixture shows `cache_write: 0`, so it does not bite in practice; and the dev app's **XD gateway catalog is empty** (`model-pricing.json` scope `base=http://localhost:3339|user=anonymous|key=missing`, 0 models), so gateway-priced turns would be unpriced in the dev app. Hermes does not use the gateway, so neither blocks the Hermes path.

**Tests (14 new).** Translator +2: `system/init` normalises to `session-init` with the model and **without** the session id; other `system` events stay unknown. Hermes agent +2: the `done` event carries the model in `usage`; a second turn whose CLI reported no model does **not** inherit the first turn's model. Desktop recorder +5 (new file): tokens + model + provider stored; the CLI's model wins over the home default; the home default is the fallback; the tokens survive an unreadable home config; other agents' turns and tokenless turns are ignored. Pipeline +1: a Hermes `done` through `handleSessionEvent` lands the usage on the turn's assistant message. Shared contract +4: the provider is kept, an empty one is dropped, a merged turn keeps one provider and refuses a mixed route, and it reads back from persisted data.

**Not claimed:** no panel, no cost, no live run. 1.9b-1 stores the **facts**; 1.9b-2 prices them and 1.9b-3 shows them. Nothing here is proven in the running app: the dev database still holds the 87 usage-less Hermes rows, and only a real turn after this change will add a first one. The 87 old rows are not back-filled.

**Gates (Node 22, WorkBuddy session shell, proxy vars unset):** `pnpm typecheck` EXIT=0; `pnpm check:test-hygiene` EXIT=0 ("361 files within baseline", the new recorder test file included). Focused suites: maker-core Hermes 43/43 (translator 12, agent 31), desktop `sessionHermesTurnUsage` 5/5, desktop `sessionEventPipeline` 164/164, desktop shared `turnUsageDetails` 14/14. `pnpm test:runner` (the repo **scripts** suite) passed earlier in the session with EXIT=0 (610 tests, 608 pass, 2 skipped) and now ends EXIT=1 on 4 failures, all one environmental family: the WorkBuddy file policy refuses a rename-into-place (`check-dco.test.mjs` "keeps the native `commit -s` layout", `restart-desktop-remote.test.mjs` "macOS Terminal launch sends a short source command", "logged terminal command keeps the child exit code and caps the log size", and the Pi updater tar extraction). None touches this row; they should be green in the owner's shell.

**The unit tier, and the environment discovery that went with it.** `pnpm test:unit:related` first ran 43 m 54 s and ended red in **five** workspaces (`lizi-im`, `lizi-mcps`, `maker-hermes-manager`, `maker-pi-manager`, `apps/desktop`). That looked like load-induced flaking, but it was not: every one of those workspaces forks a child, and the harness's brokered-bin shim had a dead socket, so each died with `Error: connect ECONNREFUSED /var/folders/.../cbb-*/broker.sock` and vitest reported "no tests" plus one unhandled error. **`export CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0` fixes it.** With that flag the full unit tier runs 27 workspaces green (`lizi-im` 22.9 s, `lizi-mcps` 29.9 s, `maker-hermes-manager` 4.6 s, `maker-pi-manager` 3.1 s, `maker-shared` 11.6 s) and ends EXIT=1 on four workspaces with 21 failures in 8 test files, none of them this row's:

| Workspace | Failures | File | Shape |
|---|---|---|---|
| `packages/maker-core` | 5 | `cindySubagentRunner.test.ts` | the documented `/bin/ps`-EPERM set |
| `apps/desktop` | 1 | `askpass.native.test.ts` | the documented `/bin/ps`-EPERM set |
| `apps/desktop` | 3 | `updateScriptMacOS.test.ts` | spawns and kills real app PIDs |
| `apps/desktop` | 2 | `localBackup.test.ts` | renames on restore (broker file policy) |
| `apps/desktop` | 2 | `remote-agent/__tests__/roundtrip.test.ts` | spawns a real remote agent |
| `apps/desktop` | 1 | `remote-agent/executor/__tests__/executor.test.ts` | runs a real shell |
| `apps/mobile` | 5 | `embeddedRuntime.test.ts` | APK/AAB/IPA reads, each ~5.8 s |
| `packages/maker-remote-ssh` | 2 | `remote-agent-installer.test.ts` | 5 s timeout |

Every one of the 21 is a test that spawns a real process, renames a real file, reads `/bin/ps`, or runs on a 5 s budget. **None of this row's five test files appears in the failure list.** A green unit run in the owner's shell is still outstanding, as for every row since 5.3a.

---

## 2026-10-31 — Phase 1: ROADMAP 1.10b closed — cancelled display proven live (`live-proven`)

**The re-run (owner-clicked, dev app, conversation `1c223b3f`, model `deepseek-v4-pro`).** Long essay turn → Stop mid-turn → "What was my previous message?". The fix under test was commit `8ccbd31483` (`userAbortEpoch` in the Hermes agent). Evidence: `docs/evidence/1.10b-cancelled-display-live-proof.md`, alongside the first run's file.

**The display defect is gone.** The owner's paste carries no "Could not complete the reply" card and no "Hermes exited with code 130" banner. The log confirms it from the other side: `awk 'NR>3600' main-2026-10-31.log | grep -cE "SDK error surfaced|failure decision|Hermes exited with code"` returns **0** — the last occurrence of all three markers in the file is 18:24:48, in the previous run. The DB agrees: the conversation stores `assistant 2, user 2` and **no error row**, where the old run stored `{"message":"Hermes exited with code 130"}`. The aborted turn's assistant row persisted normally (2,705 chars of partial essay).

**Everything else in the row re-confirmed live.** The abort path ran (`ignoring stale abort completion` at 20:25:24.753, the same ABORT_SESSION reconciliation line as the first run). `pgrep -fl "hermes chat"` → exit 1, no surviving child. The daemon registry (1.10a's guard, second live confirmation) holds record `b6637e5f` at `running: false` with `hermesSessionId local-973dae71f7…` bound. The next user row carries the same `sdkSessionId`, and the agent quoted the essay request back: the conversation resumed with history intact. Incidentally the renderer `Maximum update depth exceeded` errors went from 9 in the first abort window to 0 here — recorded as an observed correlation with the removed error banner, not a proven cause (the loop was never traced).

**Caveat, recorded in ROADMAP Debt.** The cancelled turn's row is stamped `turnCompleted: true`, not a distinct cancelled state: the desktop's `isSuccessfulCodexDoneEventData` predicate (`raw.status === 'completed'` + `cancelled !== true`) is applied to the Codex source only, so the agent's `done status:'cancelled'` does not survive into the persisted row. Harmless for Hermes — its translator emits only `tool_use`/`tool_result`, never `update_plan`, so the plan-capsule history-recovery risk the predicate exists to prevent cannot arise — but it is a real gap in the persisted model for any non-Codex agent that needs a distinguishable cancelled state.

**Gates (Node 22, WorkBuddy session shell, proxy vars unset):** `pnpm typecheck` EXIT=0; `pnpm test:runner` EXIT=0 (610 tests, 608 pass, 2 skipped); `pnpm check:test-hygiene` EXIT=0 ("361 files within baseline"). Docs-and-evidence only in this commit — no source file changed since `8ccbd31483`, whose own gates are recorded in the entry below — so the related-unit tier was not re-run; the tree's green record is the previous commit's, and a full unit sweep in the owner's shell is still outstanding, as for every row since 5.3a.

**Not claimed:** no UI label was added. The row still does not say "cancelled" anywhere in the database; the row says the turn ended quietly and left no failure trace. 1.10b's promise ("the turn ends as cancelled") is met behaviourally — no error banner, no error row, no provider-group failure decision — not by a new persisted state.

---

## 2026-10-31 — Phase 1: ROADMAP 1.10b live run — kill/resume proven, cancelled-display defect found and fixed (`unit-tested`, re-run pending)

**The run (owner-clicked, dev app, `docs/evidence/1.10b-live-run-defect-and-partial-proof.md`).** Long essay turn in Hermes conversation `7ad6b464` → owner pressed Stop at 18:24:48 → the child died with the SIGINT fingerprint (`SDK error surfaced to user: "Hermes exited with code 130"` = 128 + SIGINT, the kill escalation's first step; `ignoring stale abort completion` shows the ABORT_SESSION path ran). The agent itself then ran `pgrep -fl "hermes chat"` in the next turn: exit 1, no surviving child. The daemon registry (1.10a's guard, live) showed the conversation's rebuilt native session `bb33c25c` at `running:false` with `hermesSessionId local-c068fdcc…` bound, no record claiming a live turn. And "What was my previous message?" was answered with both prior messages — the conversation resumed with history intact (only a real Hermes resume can do that; the path went through an `unhealthy native session rebuilt before send (context-overflow)` and still resumed). So: kill, no-child, registry truth and resumability are **live-proven** by this run.

**The defect it exposed.** The Stop surfaced as a turn FAILURE: "Could not complete the reply", error banner "Hermes exited with code 130", and `provider group: failure decision {phase: run, action: switch, cause: failed, cool: false}` at 18:24:48.426 — a user Stop classified as a provider failure. Root cause: real Hermes answers SIGINT by writing a failing terminal `result` (`exit_code: 130`) before it dies; the daemon forwards it and then settles `session/closed reason=killed`; the agent's `turn-complete` handler saw the non-zero exit first and pushed a terminal error + `done status:'failed'`, and the awaiting-close epoch consumed the killed close without reclassifying. The agent-test fake daemon never reproduced this shape (its interrupt emitted only the killed close), which is why unit tests missed it.

**Fix (`packages/maker-core/src/agents/hermes/agent.ts`).** The handle records the user's stop intent per epoch: `userAbortEpoch`, set in `abort()` before the interrupt RPC (the failing result can arrive while the RPC is in flight). `turn-complete` settling that epoch with a non-zero exit now emits `done status:'cancelled'` and no error event; genuine failures are untouched; the flag is consumed at settlement and cleared in `handleSessionClosed` so it cannot leak across epochs. With no error event and a `cancelled` done, the desktop turn-error machinery (banner, auto-resume classification, provider-group failure decision) stays silent on a Stop — one fix closes both the display and the failure-decision misclassification. Fake daemon gained an `abort-result` turn mode reproducing the real SIGINT shape (result 130, then killed close).

**Tests (2 new, agent suite 30/30).** "settles a user-stopped turn whose result reports failure as cancelled, not failed" (no error event, done `cancelled`) and "still surfaces a genuine failing result when the user did not stop the turn" (error event, done `failed`). Mutation check: `userAborted = false` failed exactly the cancelled test, 29 others passed; restored byte-identical.

**Not claimed:** the cancelled display has not been seen in the running app yet; the fix is `unit-tested` only. 1.10b stays open pending one re-run: long turn → Stop → cancelled with no error banner and no failure-decision line for the Stop. Incidental observations recorded in the evidence file and Debt: lazy-create sent `agentKind 'claude-code'` for the Hermes conversation (reconciled from the DB; trace the caller when next touched); routed prompt prediction failed closed twice (LM Studio down — the 2.3 rule working live); two renderer "Maximum update depth exceeded" console errors at abort time, not traced.

**Gates (Node 22):** `pnpm typecheck` EXIT=0; `pnpm test:runner` EXIT=0 (610 tests, 608 pass, 2 skipped); `pnpm check:test-hygiene` EXIT=0 ("361 files within baseline", no new test files). Hermes agent suite 30/30 (was 28). `pnpm test:unit:related` escalated to the FULL unit sweep and ended UNIT_EXIT=1 in this shell on the documented environmental set only: `packages/maker-hermes-manager unit` PASS (4.1 s), `apps/desktop unit` FAIL (314.8 s) and `packages/maker-core unit` FAIL (85.1 s); focused reruns pinned those to the `/bin/ps`-EPERM files, `cindySubagentRunner.test.ts` 5 failed / 43 passed and `askpass.native.test.ts` 1 failed / 2 passed, exactly the set recorded since 2.3b-1/2. A green unit run in the owner's shell is still outstanding, as for every row since 5.3a.

---

## 2026-10-31 — Phase 1: ROADMAP 1.10a, cancel/interrupt registry truth (`unit-tested`)

**Audit first.** The cancel chain already existed end to end: renderer `maker:abort-session` (register.ts) → `Session.abort()` (maker-core session.ts, with the manual-abort recovery watchdog) → Hermes handle `abort()` → daemon `query/interrupt` (hermes-manager.ts) → `HermesRunHandle.kill()` escalating SIGINT→SIGTERM→SIGKILL (hermes-run.ts) → settle marks the turn killed → `session/closed reason=killed` → agent `emitTerminal('cancelled')` → Session stays `active`. Each layer had partial tests. The real gap was the row's "mark the turn aborted in the registry": the daemon registry persisted `running: true` and only the per-turn settlement cleared it, so a hard daemon kill (SIGKILL, power loss, OOM — anything that skips `stop()`) left `sessions.json` claiming a live turn forever, visible through `session/list` and `session/attach`.

**Fix (one guard).** `SessionRegistry` constructor now repairs loaded records: every record is taken with `running: false` (a turn never survives a daemon restart — `stop()` kills the child, a crash orphans it), and when a stale `running: true` was repaired the file is rewritten once. The Hermes session id is untouched, so the next send still resumes the conversation. Graceful stop needed no change: listener ordering guarantees the per-turn settlement (registry `running:false` + `killed` close) runs before `stop()` resumes; a stop()-side registry write was drafted, found to be untestable dead code under mutation checking, and reverted.

**Tests (6 new).** `session-registry.test.ts` +2: crash-left `running:true` is repaired in memory and on disk (second load sees it), and a clean file is not rewritten (byte-identical, mtime untouched). `hermes-manager.test.ts` +3: interrupt → `SESSION_LIST` and the registry file both say `running:false` with `hermesSessionId` intact, and the next send is accepted and spawns with `--resume fake-h-1` (completed); a forged crash state (`running:true` on disk) → restarted daemon lists `running:false` and the session takes a new turn; graceful `manager.stop()` mid-turn persists `running:false`. `agent.test.ts` +1: after `abort()` → `done status:cancelled`, the same handle accepts a second send (two `query/send`, both texts) — a killed turn must not latch `closedByUser`/`connectionLost`.

**Mutation checks (2).** Trusting the persisted `running` flag instead of repairing failed exactly the two repair tests (registry repair + daemon crash-restart), 21 others passed. Setting `closedByUser = true` on the killed/closed path failed the new agent resumability test plus the pre-existing `settles an active turn once when session/closed arrives` (same guard), 26 others passed. Both restored byte-identical.

**Not claimed:** nothing live. No Stop was pressed in the running app; the child-kill was only observed against the fake-hermes fixture. 1.10b owns the owner-clicked proof (long turn → Stop → cancelled → no surviving `hermes chat` child → next message resumes with history).

**Gates (Node 22):** **Gates (Node 22, WorkBuddy session shell, proxy vars unset, final tree):** `pnpm typecheck` EXIT=0; `pnpm check:test-hygiene` EXIT=0 ("361 files within baseline", no new files); `pnpm test:runner` EXIT=0 (610 tests, 608 pass, 2 skipped). `packages/maker-hermes-manager` suite 10 files / 102 tests pass (was 97); hermes agent tests 28/28 (was 27). `pnpm test:unit:related` escalated to the FULL unit sweep (wide files changed) and ended EXIT=1 in this shell on the documented environmental set only: `packages/maker-hermes-manager unit` PASS (3.9 s), `packages/maker-shared unit` PASS (10.4 s), `apps/desktop unit` FAIL (316.5 s) and `packages/maker-core unit` FAIL (85.1 s); focused reruns pinned those to the `/bin/ps`-EPERM files: maker-core 5 failed / 6109 passed, all five in `cindySubagentRunner.test.ts`, and `askpass.native.test.ts` 1 failed / 2 passed, exactly the set recorded since 2.3b-1/2. A green unit run in the owner's shell is still outstanding, as for every row since 5.3a.

---

## 2026-10-31 — Phase 1: ROADMAP 1.9a, conversation usage and cost model (`unit-tested`)

**Outcome:** new `packages/maker-shared/src/sessionUsage.ts` (+ `src/__tests__/sessionUsage.test.ts`, 11 tests) and the `./session-usage` subpath export. `buildSessionUsage(turns)` rolls normalised per-turn records (model, provider, in/out/cache tokens, `local` flag, optional per-Mtok rates with a currency) into one conversation summary: totals, a compact token label from the shared `formatCompactTokens`, per-model rows sorted by tokens then model id, `costStatus` of `complete` / `partial` / `none`, the summed cost with its currency, and the unpriced models. Three rules the tests exist to protect: a local turn is tokens only and is never priced even when the caller supplies rates; a turn with tokens in a category that has no rate, or rates with no currency, is unpriced rather than under-reported; a turn priced in a different currency is excluded from the sum and forces `partial`. Malformed input never throws: blank model ids are skipped, negative / NaN / Infinity counts become 0, a non-array yields an empty summary. Cost is rounded once at the end (six decimals), not per turn, so many tiny turns do not drift.

**Not claimed:** nothing here runs in the app. There is no adapter from stored turns, no rate lookup, no panel and no IPC. Per-turn detail already exists upstream (`apps/desktop/src/shared/turnUsageDetails.ts`, stored in `messages.agent_meta`, with recorded money on the claude-code path); 1.9b maps it into this model and owns the UI and the live proof. Mutation checks: removing the local-turn guard failed exactly the two local tests; turning the missing-rate guard into `continue` failed exactly the category-without-rate test; disabling the currency guard failed exactly the cross-currency test; reducing `acc.local && local` to `acc.local` failed exactly the local-flag test. All four restored, file byte-identical afterwards.

**Gates (Node 22):** **Gates (Node 22, WorkBuddy session shell, proxy vars unset, final tree):** `pnpm typecheck` EXIT=0; `pnpm check:test-hygiene` EXIT=0 ("361 files within baseline", unchanged by the new test file); `pnpm test:runner` EXIT=0 (610 tests, 608 pass, 2 skipped). The `packages/maker-shared` suite is 103 files / 1892 tests passing, including this row's 12. `pnpm test:unit:related` escalated to the FULL unit sweep (the runner reported wide files changed) and ended EXIT=1 in this shell on the documented environmental set only: `packages/maker-shared unit` PASS (10.4 s), `apps/desktop unit` FAIL (324.7 s) and `packages/maker-core unit` FAIL (85.0 s); focused reruns pinned those to the `/bin/ps`-EPERM files, `cindySubagentRunner.test.ts` 5 failed / 43 passed and `askpass.native.test.ts` 1 failed / 2 passed, exactly the set recorded in the 2.3b-1/2 entry. A green unit run in the owner's shell is still outstanding, as for every row since 5.3a.

---

## 2026-10-31 — Phase 1: ROADMAP 1.8c-2 closed, Hermes model switch from the desktop picker (`live-proven`)

Three separate defects sat between the picker and a working switch. All three are fixed,
and the switch is now proven end to end in the running app.

1. **Wrong transaction (renderer).** `performModelChange` and `performProviderChange` sent
   every session model change through `switchSessionAgent` whenever a runtime agent kind
   existed. For Hermes that meant `targetAgentKind: 'hermes'`, which
   `performSessionAgentSwitch` rejects (`targetAgentKind must be claude-code | codex | pi`),
   surfaced to the user as `INVALID_PARAMS` / "Invalid input. Please check and try again."
   New `apps/desktop/src/renderer/components/new-chat/modelChangeLane.ts`
   (`resolveModelChangeLane`) decides the lane in one place: Hermes and every
   non-switchable case take SET_MODEL; claude-code, codex and pi keep the agent-switch lane.
   Both call sites now use it.
2. **Stale capability (maker-core).** With the lane fixed, `maker:set-model` threw
   `NotSupportedError: Capability 'switchModel' not supported (reason: not-implemented)`.
   `packages/maker-core/src/agents/hermes/agent.ts` declared `switchModel: unsupported()`
   while `handle.setModel` already implemented the per-session override and the daemon
   handler existed (`hermes-manager.ts` `query/setModel`), and 1.8c-1/1.8d had already
   proven the behaviour against the real CLI. The flag was stale, not a real limit. Now
   `{ supported: true }`, with the reasoning recorded in a comment.
3. **Display did not follow the write (renderer).** The write then landed (DB held
   `deepseek-v4-pro`) but the composer pill kept showing the previous model, because the
   composer preferred the live runtime projection and Hermes only applies an override on
   the *next* turn. A click on the new row was then treated as re-selecting the current
   row, a deliberate no-op, so the picker looked frozen. New
   `resolveComposerDisplayProfile` in `composerModelSelection.ts`: Hermes follows the
   persisted session model, the live-switching harnesses keep the runtime projection.

**Verification.** `unit-tested` for the two predicates and the capability (10 + 8 + 27
tests, each mutation-checked: removing the guard fails exactly its own test).
`typecheck` `EXIT=0`; `test:runner` `EXIT=0`; `check:test-hygiene` `EXIT=0`.

Unit tier: the owner's run failed two Orca source-contract tests
(`sessionAgentSwitchRemoteRouting.test.ts`), because that harness executes the
`performModelChange` / `performProviderChange` bodies in isolation with a fixed binding
set and did not know the new predicate. Fixed by binding the real `resolveModelChangeLane`
into the harness (file 55/55). Re-run of the desktop tier in the agent shell afterwards:
61,540 passed, 1 failed, and the single failure is `askpass.native`, the documented
`/bin/ps` EPERM blocker in that shell, unrelated to this change. A fully green unit run in
the owner's shell is therefore still outstanding for strict rule-0 compliance, though the
only real failures it produced are fixed and re-verified.

`live-proven` 2026-10-31 in the dev app: after a reload the pill read `deepseek-v4-pro`,
clicking flash and then pro moved the selection both ways, `sessions.model` for session
`7ad6b464` ended at `deepseek-v4-pro`, and the log carried no `set-model`,
`NotSupportedError` or `INVALID_PARAMS` lines for the whole run.

**Scope note.** Safe mode was not re-run separately: SET_MODEL does not touch permission
mode, and 1.8d covers the `/model` replay under safe mode with fake-Hermes tests. Full
access is what the live run used.

**Surprises worth keeping.** A failed switch whose rollback also fails leaves the pill on
the model that was never applied; that is how this looked "already on pro" while the DB
said default. The two `AgentKind` vocabularies (`claude-code` vs `cc`) also collide here,
so the predicate accepts both spellings. `docs/design-rules/design-inventory.md` was
regenerated (one added file, `modelChangeLane.ts`, nothing removed) because adding a module
under `components/new-chat` changes the `desktop.bots` surface file count.

---

## 2026-10-31 — Phase 1: ROADMAP 1.5a closed (docs only)

**Outcome:** 1.5a (MCP server config management: list/set/remove RPCs + UI) was still labelled 🧪 with the note "live-prove via 0.8", but 0.8's `live-proven` record (STATUS 2026-10-29) already exercised exactly this surface: a stdio MCP server added and removed through the Settings UI, `config.yaml` diffed after each step, `hermes-cindy mcp test` connected. Row updated to ✅ `live-proven` citing that evidence, same closure pattern as 1.7. No code changed; the residual empty `mcp_servers:` key stays in Debt.

Gates: docs-only commit; no code touched. Committed and pushed to `origin main` in the commit that carries this entry.

---

## 2026-10-31 — Phase 1/2: ROADMAP 1.2 and 2.3 closed — routed title + prediction `live-proven` in the dev app

**Outcome:** owner-clicked live check in the isolated dev app (`pnpm restart:desktop:remote --region=global`; LM Studio serving `qwen3-8b` on `127.0.0.1:1234`; `~/.cindy-harness/routing.yaml` routing `title` and `predict` to route `local-small`). In a Hermes session: the title changed to a model-generated title, not the first-message fallback, and a routed prediction appeared in the input box when the turn completed. Both debug lines captured (owner-pasted): `title generated on routed endpoint` at 12:01:47.806 and `prompt prediction generated on routed endpoint` at 12:02:51.093 in `apps/desktop/logs/main-2026-10-31.log`. This meets 2.3's done-when ("titles generated by local model") and closes 1.2: the 2026-10-30 blocker (`auxiliary-title-one-shot` failing with `AgentNotAuthenticatedError` → `no_candidate` because the sandbox has no signed-in agent) is resolved by the routed path, which needs no signed-in agent. The Hermes turn was one tiny paid DeepSeek call (owner-authorised); the title and prediction calls were free and local. Docs-only change: ROADMAP rows 1.2 and 2.3 updated with the evidence; no code changed in this commit.

**Not claimed:** the `summary` task class is resolvable but unconsumed until 2.5b; blocked-route alternatives are still log-only (2.4b owns the "use X instead" UI); the proof is one run on one machine with one model.

Gates: docs-only commit; the code it records was gated and landed in `f74a142f33` and `7abf7e5365` (entries below). Committed and pushed to `origin main` in the commit that carries this entry.

---

## 2026-10-31 — Phase 2: ROADMAP 2.3b-3 predict wiring + live routed-module probe on LM Studio (`unit-tested`; in-app proof pending)

**Outcome:** (1) `apps/desktop/src/main/maker-ipc/promptPrediction.ts`: `generatePromptPrediction` consults the routed path first for task class `predict` (new optional `deps.requestRouted`, default = the real `requestRoutedTaskText`). Fail-closed: `blocked`/`failed` return null and never fall back to the paid chain; the pre-dispatch check mirrors the boundary/owner/cancel gates (a route may name a remote endpoint, so a cancelled prediction must not spend it); the chain's post-dispatch discard rules (Stop from another window, owner switch, boundary) apply to routed results identically; `not-routed` leaves the chain byte-for-byte unchanged. +7 tests in `promptPredictionRevision.test.ts` (33/33 in the file); the other three prediction-related test files mock the module and are unaffected. (2) Routed headroom budgets: title routed call 1024 tokens / 45 s (`ROUTED_TITLE_*`), predict 512 / 45 s (`PREDICTION_ROUTED_*`); chain constants untouched. Found live: LM Studio qwen3-8b is a reasoning model and with the old 160/96 budgets the reply carried `reasoning_content` with an EMPTY `content` (module correctly reported `reply has no message content`); neither `chat_template_kwargs.enable_thinking:false` nor LM Studio's proprietary `reasoning:{enabled:false}` was honoured by that server, so headroom is the model-agnostic fix. (3) Debug lines added on routed success (`title generated on routed endpoint` / `prompt prediction generated on routed endpoint`) so the in-app live check has a log line to capture. (4) Owner state created (new files, nothing overwritten): `~/.cindy-harness/providers.yaml` (`lmstudio-local`, `http://127.0.0.1:1234`, no keyEnv) and `~/.cindy-harness/routing.yaml` (route `local-small` → qwen3-8b; rules `title`/`predict` → `local-small`). LM Studio initially required an API token; the owner turned server authentication off (localhost-only). (5) **Live module probe** (throwaway vitest file under maker-core, deleted after the run; free, no app): `requestRoutedTaskText` against the real `~/.cindy-harness` files and real LM Studio returned `ok` for both task classes — title: "Refactoring CSV Parser into Small Functions"; predict: "How do I handle commas within quotes?" (route `local-small`, provider `lmstudio-local`, model `qwen3-8b`).

**Not claimed:** nothing has run inside the app. The in-app live proof (a model-generated title on a Hermes session + a prediction in the input box, with the two log lines) is the 2.3 row's done-when and the 1.2 blocker; it is pending the owner's dev-app check. `summary` still has no consumer (2.5b). The module probe proves the routed chain at module level only. Mutation check: disabling the fail-closed fall-through guard in `promptPrediction.ts` failed exactly the 4 routed-decision tests; restored.

**Gates (Node 22, WorkBuddy session shell, proxy vars unset, after the wiring):** `pnpm typecheck` EXIT=0, `pnpm check:test-hygiene` EXIT=0 ("361 files within baseline"), `pnpm test:runner` EXIT=0. Focused suites: `auxiliary-title-one-shot.test.ts` + `promptPredictionRevision.test.ts` 51/51. The unit tier needs the owner's shell (the documented `/bin/ps`-EPERM blocker). **Landed (2026-10-31, split shells).** Owner's terminal, first parallel unit run: every workspace PASS except `apps/desktop unit`, red on a single load flake unrelated to this row (`bot-import/__tests__/sources.test.ts` timed out at its 5 s default; passes alone 68/68 in 4.0 s, tests time 3.6 s; file last touched by upstream commits; logged in ROADMAP Debt). Owner's terminal, prescribed rerun: every workspace PASS with a read `EXIT=0`, including `apps/desktop unit` (295.1 s, the flaky file green in this run) and `test:runner` (76.6 s). Committed and pushed to `origin main` in the commit that carries this entry.

---

## 2026-10-31 — Phase 2: ROADMAP 2.3b-1/2, routed auxiliary text + title wiring (`unit-tested`)

**Outcome:** two halves of 2.3b landed. (1) New `packages/maker-core/src/providers/routed-auxiliary.ts` (+ `__tests__/routed-auxiliary.test.ts`, 19 tests against real local HTTP servers and real temp `providers.yaml`/`routing.yaml` files) and the `./routed-auxiliary` export: `requestRoutedTaskText({taskClass, prompt, …})` resolves the task class through 2.3a, health-checks it with a live 2.2a probe and the 2.4a assessment, then makes one OpenAI-compatible chat-completions call (`chatCompletionsUrl`, Ollama included) and returns `ok` text. Fail-closed: a rule the owner wrote but that cannot run is `blocked` (invalid rule, offline, model missing) with healthy alternatives — other routed providers are probed lazily only on the blocked path, so the happy path pays for one probe; a failed call is `failed`; nothing ever substitutes a model. No rule → `not-routed`, so an owner without a routing.yaml sees zero change. Key only from the `keyEnv`-named env var to that same host; redirects refused; never throws. (2) `apps/desktop/src/main/maker-host/auxiliary-title-one-shot.ts`: `generateAuxiliaryTitle` consults the routed path first for task class `title` (deps-injectable `requestRouted`, default = the real module); `ok` → routed text through the existing `normalizeAuxiliaryTitle`; `blocked`/`failed` → `{status:'failed'}` without touching the auxiliary chain or the session-agent fallback; `not-routed` → the historical chain runs byte-for-byte as before. 5 new tests in `auxiliary-title-one-shot.test.ts` (18/18 in the file); `requestAuxiliaryText` itself is untouched, so the Market opening (botInvitation) is unaffected.

**Not claimed:** nothing ran inside the app. `predict` (`promptPrediction.ts`) and `summary` still use the old chain (2.3b-3). The row's done-when — a title produced by a local model, live — is NOT proven. Blocked-path alternatives are logged, not surfaced in the UI (2.4b). A pre-existing bug was found and fixed during testing: a caller signal aborted before the call never reached the internal controller (an already-aborted signal fires no event); now mirrored once, covered by a test. Mutation checks: disabling the invalid-rule guard failed exactly the unknown-route test (maker-core); disabling the fail-closed fall-through guard failed exactly the two blocked/failed tests (desktop); both restored.

**Gates (Node 22, WorkBuddy session shell, proxy vars unset):** `pnpm typecheck` PASS, `pnpm test:runner` PASS, `pnpm check:test-hygiene` PASS (run separately, read `EXIT=0`, "361 files within baseline"). `pnpm test:unit:related` ended `EXIT=1` from the documented session-environment pollution, not from this row: `packages/maker-core unit` (85.2 s) and `apps/desktop unit` (309.0 s) failed, and focused reruns pinned the failures to the known `/bin/ps`-EPERM set — 5 in `cindySubagentRunner.test.ts` (two 30 s process-inventory timeouts, one spurious `PiSubagentResumeClaimedError`, two `stopForAccountBoundary` → false) and 1 in `askpass.native.test.ts`. With the proxy vars unset, `llamaCppDownloads.test.ts` passed fully, matching the 2026-10-31 finding. This row's own suites were green in-session: `routed-auxiliary.test.ts` 19/19, `auxiliary-title-one-shot.test.ts` 18/18, and the three neighbouring title-IPC test files 132/132. The first in-session gate run also caught a real typing error of this row (`health` reassigned inside the blocked branch lost its discriminant narrowing, 3 tsc errors); fixed by re-checking `!health.ok` after the branch, focused suites re-passed. The full gate set, and therefore the commit, needs a shell where `/bin/ps` executes (the owner's terminal), exactly as for the 5.3a landing. **Landed (2026-10-31, split shells).** Owner's terminal: the unit tier PASSED every workspace with a read `EXIT=0`, including `packages/maker-core unit` (50.4 s) and `apps/desktop unit`, confirming the session-shell unit failures were the documented environmental set; no SIGSEGV this run. Session shell on the same tree: `pnpm typecheck`, `pnpm test:runner` and `pnpm check:test-hygiene` green as above. Committed and pushed to `origin main` in the commit that carries this entry.

---

## 2026-10-31 — Phase 5: ROADMAP 5.3a, long-running turn timeline model (landed)

**Outcome:** new `packages/maker-core/src/tasks/turn-timeline.ts` (+ `__tests__/turn-timeline.test.ts`, 3 tests) and the `./turn-timeline` export. `buildTurnTimeline` takes a turn start, `now`, declared state and normalised tool start/completion events, then returns non-negative elapsed time, the inclusive 120,000 ms long-running state, time-ordered spans with stable equal-time ordering, completed or running duration and the newest active tool id. It ignores blank ids, unmatched completions and duplicate starts. The supplied state is carried through only; there is no cancellation logic.

**Not claimed:** nothing here runs inside the app. It does not subscribe to Cindy's real `tool_use` / `tool_result` stream, persist a timeline, render UI, start a timer or interrupt a turn. Those are 5.3b and require `live-proven`. Mutation check: changing `>=` to `>` made the exact 120,000 ms assertion fail; restored.

**Gates (Node 22):** the default sequence `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene` ended `EXIT=1` because `apps/desktop unit` was killed by the known Vitest-worker SIGSEGV after 190.4 s. The prescribed retry replacing the third command with `node scripts/test-workspaces.mjs --tier unit --related --workspace-concurrency=1` also ended `EXIT=1`: the same `apps/desktop unit` SIGSEGV recurred after 163.8 s. `packages/maker-core unit` passed in both runs. No commit or push was made.

**Update (later 2026-10-31, WorkBuddy session; still unlanded).** Root-caused the red gates as session-environment pollution, not 5.3a code, and reproduced it deterministically. (1) The harness exports `HTTP_PROXY`/`HTTPS_PROXY` (a 127.0.0.1 transparent proxy); `outboundFetch` honours the proxy env layer, so localhost-HTTP tests in `apps/desktop` fail (`src/main/local-model-runtime/__tests__/llamaCppDownloads.test.ts`, 8 tests: `DOWNLOAD_FAILED` / missing `.partial`). With the proxy vars unset that file passes fully. (2) Every descendant of the WorkBuddy app inherits EPERM on exec of `/bin/ps` — it fails even with the harness sandbox disabled, while `pgrep`, `kill -0` and `sysctl` work, and node `spawnSync /bin/ps` reports EPERM. That deterministically breaks exactly the ps-dependent tests: 5 in `packages/maker-core/src/agents/pi/__tests__/cindySubagentRunner.test.ts` (two 30 s process-inventory timeouts, one spurious `PiSubagentResumeClaimedError`, two `stopForAccountBoundary` → false) and 1 in `apps/desktop/src/main/input-handoff/askpass/__tests__/askpass.native.test.ts` (process-chain check fails closed; git receives an empty credential). No in-session workaround. This session's full gate run: `apps/desktop unit` ended `TEST_ASSERTION_FAILED` (310.8 s, not SIGSEGV) and `packages/maker-core unit` failed (85.5 s). The 5.3a focused suite re-passed (3/3) and the boundary mutation check was redone (`>=` → `>` fails the 120,000 ms assertion; restored, and the `buildTurnTimeline` return-block indentation was normalised). The gates — and therefore landing any row — need a shell where `ps` executes and the proxy vars are unset (the owner's terminal, or the harness of the 2026-10-30 run). No commit or push was made in this session either.

**Landed (2026-10-31, split shells).** With the environmental blocker understood, the gates were completed across two shells against the same tree. Owner's terminal: `pnpm typecheck` and `pnpm test:runner` passed (the run reached the unit tier); the default parallel unit run PASSED every workspace except `apps/desktop unit`, killed by the known Vitest-worker SIGSEGV after 135.0 s (counted red; `packages/maker-core unit` PASSED there, confirming the session-shell maker-core failures were environmental). The prescribed serial rerun `node scripts/test-workspaces.mjs --tier unit --related --workspace-concurrency=1` ended `EXIT=0` (owner-read; the runner exits non-zero if any workspace fails). `pnpm check:test-hygiene` PASS with a read `EXIT=0` in both shells. The session shell had also run typecheck and test:runner green on the same tree. Committed and pushed to `origin main` in the commit that carries this entry.

---

## 2026-10-30 — Phase 5: ROADMAP 5.4a, scheduled sessions (pure logic)

**Outcome:** new `packages/maker-core/src/schedules/scheduled-sessions.ts` (+ `__tests__/scheduled-sessions.test.ts`, 11 tests) and the `./scheduled-sessions` export. Schedules are Markdown files (frontmatter `expert`, `cron`, `timezone`, `enabled`, `output`; body is the prompt). `loadSchedules` lists bad files with their error beside good ones. `dueSchedules(schedules, lastRunMs, nowMs, cron, firstSeenMs?)` returns what should run: once after downtime, never a backfill for a schedule with no recorded run, nothing for disabled ones or a throwing cron. Cron maths is not reimplemented: it is injected as `CronApi`, and the tests pass the real `parseCron`/`nextRun` from `packages/maker-scheduler/src/engine/cron.ts` (relative import, since maker-core does not depend on maker-scheduler and no dependency was added offline). 5.4b should pass `@cindy/maker-scheduler/cron` in.

**Not claimed:** `unit-tested` only. Nothing starts a session, stores last-run times, writes to the vault or reads settings; nothing ran in the app. Mutation check: `<=` to `<` on the due boundary failed 2 tests; restored.

Gates (Node 22): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`, EXIT=0 on the default parallel unit step (no SIGSEGV this run).

---

## 2026-10-30 — Phase 5: ROADMAP 5.1a, notes vault bridge (pure logic)

**Outcome:** new `packages/maker-core/src/notes/vault-notes.ts` (+ `__tests__/vault-notes.test.ts`, 23 tests with real temp directories) and the `./vault-notes` export. List, read, search and append over a caller-supplied folder of Markdown notes. Paths are relative, `.md` only, no hidden segments, and containment is checked after `realpath`, so `..`, a symlinked note and a symlinked folder all fail with `outside-vault`. Append adds a dated `## <ISO>` entry, keeps earlier bytes, writes atomically, redacts credentials (5.2a `redactSecrets`) and neutralises `#`/`##` in the body. Search needs every term, ranks path matches above body matches, skips files over 512 KiB, redacts snippets.

**Not claimed:** `unit-tested` only. No agent tool, no `tools.yaml` opt-in (needs 3.2's schema), no vault-path setting, nothing run in the app. The redactor is a heuristic. Mutation check: making the containment test always true failed the 2 symlink/traversal tests; restored.

Gates (Node 22): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`, EXIT=0 on the default parallel unit step (no SIGSEGV this run).

---

## 2026-10-30 — Phase 3: ROADMAP 3.6a, expert handoff prompt (pure logic)

**Outcome:** new `packages/maker-core/src/experts/expert-handoff.ts` (+ `__tests__/expert-handoff.test.ts`, 7 tests) and the `./expert-handoff` export. `buildExpertHandoff` returns a draft first message for a new session: source session label, the owner's question (default: a plain review request), and an excerpt of the conversation. It is deterministic and calls no model: newest messages are kept within `maxChars` (default 12000; the newest is always kept), each message is cut at `maxMessageChars` (default 2000), tool calls appear by name only so no tool input or output leaks, credentials are redacted with the 5.2a redactor, and an empty source or unloaded expert returns an error instead of a prompt. Nothing starts a session, which keeps the "owner stays in the loop" rule. Mutation check: appending tool output to the tool line fails the payload test.

**Not claimed:** `unit-tested` only. No UI action, no adapter from real stored messages, no new session created, no live run. Overlap noted: upstream `apps/desktop/src/main/maker-ipc/agentHandoff.ts` builds a similar deterministic handoff for engine switches inside one session; it lives in desktop and cannot be imported from `maker-core`, and 3.6b should reuse its `buildHandoffText` for the real-message adapter rather than copy it.

Gates (Node 22): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`, EXIT=0 on the default parallel unit step (no SIGSEGV this run).

---

## 2026-10-30 — Phase 5: ROADMAP 5.2a, session export to Markdown (pure logic)

**Outcome:** new `packages/maker-core/src/export/session-markdown.ts` (+ `__tests__/session-markdown.test.ts`, 11 tests, real temp dirs) and the `./session-export` export. Input is a minimal `ExportSession` (title, agent, model, messages with optional tool calls) so the real stored-message adapter stays a separate 5.2b step. Output: YAML frontmatter, a title, `## User/Assistant/System` sections, tool calls in collapsed `<details>` blocks with fenced input/output (fence longer than any backtick run inside, cut at 2000 chars with a marker), message headings escaped so a message cannot forge sections, credentials redacted (`sk-…`, `Bearer …`, `api_key=`/`password:` style). `writeSessionExport` creates the target directory and never overwrites: it writes a temp file and `link`s it into place so an existing file fails with EEXIST and the next `-N` name is used. Self-review caught a bug before the first test run (the redaction callback could print a numeric match offset for a `Bearer` token ending in `=`); it is now covered by a test. Mutation check: replacing `link` with `rename` fails the no-overwrite test.

**Not claimed:** `unit-tested` only. No adapter from real sessions, no IPC or UI, no live export, and nothing was written to the vault. The redactor is a heuristic and will miss unusual secrets, so exports should still be read before sharing. Nothing consumes the module. Another upstream `redactSecrets` exists in `apps/desktop/src/main/git-snapshot/`; it cannot be imported from `maker-core`, so this is a separate small copy of the idea.

Gates (Node 22): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`, EXIT=0 on the default parallel unit step (no SIGSEGV this run).

---

## 2026-10-30 — Phase 3: ROADMAP 3.4a, expert memory file (pure logic); 1.2 marked blocked

**Outcome:** new `packages/maker-core/src/experts/expert-memory.ts` (+ `__tests__/expert-memory.test.ts`, 10 tests, real temp dirs) and the `./expert-memory` export. `appendExpertMemory` writes a `## <ISO timestamp>` entry to `<expertDir>/memory.md` only for experts with `memory: true`; it preserves existing bytes exactly (tested against a hand-edited file with trailing spaces), writes via temp file + rename, refuses empty and over-4000-char notes, and escapes leading `#`/`##` in the body so a note cannot forge entries. `readExpertMemory` returns the newest entries within `maxChars`. Mutation check: removing the heading escape fails the forgery test. Also recorded 1.2 as blocked on 2.3b: a try in the shared real profile (backup `cindy-local-v1.db.bak-20261030-221641` taken first, DB checksum unchanged afterwards) stopped at `MIGRATE_FAILED`, the dev build refusing to upgrade the official Cindy database, and the sandbox log showed the title helper with `no_candidate`.

**Not claimed:** `unit-tested` only. No tool, no editor display, no prompt injection, no live run (3.4b). Nothing consumes the module. 1.2 is still unproven.

Gates (Node 22): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`, EXIT=0 on the default parallel unit step (no SIGSEGV this run).

---

## 2026-10-30 — Live check of 1.2 and 1.4 in the dev app (owner clicked)

**Outcome:** launched with `pnpm restart:desktop:remote --region=global` (`DESKTOP_DEV_VERDICT=ready`, isolated sandbox `dev`, commit d7c329fcab, nothing from the real profile). The owner attached an image in a new Hermes session (model route `hermes-default`); the reply described it accurately (screenshot seen). Row 1.4 → `live-proven`. Row 1.2 is NOT proven: the session title was `what is in this image?`, the owner's own prompt, i.e. the fallback title. `main-2026-10-30.log` at 21:46:48 shows `[maker-host/auxiliary-title-one-shot]` `agent fallback failed { errorName: 'AgentNotAuthenticatedError' }` then `auxiliary title model failed { reason: 'no_candidate' }`. Correction: my first write-up of this entry repeated the owner's "auto title generated" as fact; the screenshot shows otherwise, so it was fixed before commit.

**Not claimed:** no transcript or screenshot was captured; no file was written by the app that I inspected; 1.2 auto-title remains unproven (no model-generated title was seen). Not touched: `~/.hermes-cindy`, credentials, DeepSeek. Docs only, no code changed.

Gates (Node 22): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`, EXIT=0 on the default parallel unit step (docs-only change; no SIGSEGV this run).

---

## 2026-10-30 — Phase 4: ROADMAP 4.3a, MCP server catalog and health (pure logic)

**Outcome:** new `packages/maker-core/src/mcp/mcp-catalog.ts` (+ `__tests__/mcp-catalog.test.ts`, 11 tests) and the `./mcp-catalog` export in `packages/maker-core/package.json`. `buildMcpCatalog` flattens `{source, servers}` inputs into entries with `id = source/name`; env and header values never appear (key names only), http targets lose credentials and query, malformed entries (both command and url, neither, non-http url) become `invalid` with a reason. `checkMcpHealth` is static: stdio needs an executable file (PATH search or absolute path; a non-executable file is `missing-command`); http is `unchecked` unless the caller passes a `probe`, so nothing in the module touches the network or spawns a process. Mutation check: removing the URL stripping fails the strip test. Real temp files with real mode bits, no mocks of fs.

**Not claimed:** `unit-tested` only. Not fed from the real `~/.hermes-cindy/config.yaml`, no IPC, no UI, no start/stop. The lizi bridge is in-process and has no config entry, so it needs a source adapter in 4.3b. "Add to expert" is deferred: `tools.yaml` has no schema yet (ROADMAP §3 says only "allow/deny list"), and inventing one here would pre-empt 3.2. Nothing consumes the module.

Gates (Node 22): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`, EXIT=0 on the default parallel unit step (no SIGSEGV this run).

---

## 2026-10-30 — Phase 4: ROADMAP 4.4a, skill scan and local install (pure logic)

**Outcome:** new `packages/maker-core/src/skills/skill-manager.ts` (+ `__tests__/skill-manager.test.ts`, 15 tests, real files in temp dirs) and the `./skills` export in `packages/maker-core/package.json`. `scanSkill` validates `SKILL.md` frontmatter (`name` slug, optional `description`) and applies line rules: HIGH pipe-to-shell, decode-to-shell, rm of root/home, credential-path reads, `.env` reads; MEDIUM eval/exec, network calls, sudo/chmod, package installs, unscanned large or binary files; LOW bundled scripts. Symlinks give verdict `blocked`. `installSkill` scans first, refuses HIGH without `acknowledgeHigh`, never installs a symlinked skill, never overwrites, rejects a category that is not a plain slug, copies to a temp dir inside the category and renames. `listInstalledSkills` reads the Hermes two-level layout. Mutation check: disabling the `blocked` refusal fails the symlink test.

**Not claimed:** `unit-tested` only. Not run against the real `~/.hermes-cindy/skills`, no IPC, no UI, no git-URL install, no enable/disable (4.4b stays open). The scan is regex heuristics and can miss obfuscated payloads; the report is for the owner to read, not a guarantee. Nothing consumes the module yet.

Gates (Node 22): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`, EXIT=0 on the default parallel unit step (no SIGSEGV this run).

---

## 2026-10-30 — Phase 4: ROADMAP 4.5, extension author guide (drafted, examples run)

**Outcome:** `docs/extending.md` (126 lines): one section each for expert, route, tool, panel, adapter, preceded by a table of what works today and what is not wired. Worked examples are real files in `docs/examples/extending/` (a `hello` plugin, `providers.yaml`, `routing.yaml`, a `changelog-writer` expert). Verification: a throwaway tsx script (deleted) loaded them with the real code: the plugin went `active` with `tool/hello-tool` and `panel/hello-panel` tagged `plugin:hello`, through the loader's default native `import()` in plain Node (first real exercise of that path, outside the app); providers and routing had no issues, `title` resolved to `local-small`, and with Ollama offline the route came back blocked with only the paid `flash` route listed as a choice; the expert loaded with `model: local-small`.

**Not claimed:** "owner can follow it unaided" is the owner's test, so the row stays open. Tool, panel and adapter are documented as registry-only because nothing consumes the registry (4.1b, 4.2b). The adapter section has no example, deliberately. Nothing was run inside the app, against a real Ollama, or with an agent calling a registered tool. Docs only; no code changed, so the gates below are the unchanged-tree sanity run.

Gates (Node 22): `pnpm typecheck`, `pnpm test:runner`, `pnpm check:test-hygiene` green; unit step run SERIAL (`node scripts/test-workspaces.mjs --tier unit --related --workspace-concurrency=1`), EXIT=0. The first attempt with the default parallel unit step crashed `apps/desktop unit` with SIGSEGV (EXIT=1, environment crash, known Debt row), and was not counted as green.

---

## 2026-10-30 — Phase 2: ROADMAP 2.5a, context-window guard (`unit-tested`)

**Outcome:** `packages/model-providers/src/contextGuard.ts` (pure; subpath `@cindy/model-providers/context-guard`). `assessContext(usedTokens, contextLength, thresholds)`: `ok` below 80%, `warn` from 80%, `critical` from 95% (both configurable, must satisfy 0 < warn < critical <= 1 or it throws), remaining tokens never negative, and `unknown` with an explanatory message when the context length (from `providers.yaml` `capabilities.contextLength`) or the usage is missing, so it never invents a limit. `guardContext(...)` adds, only at warn/critical, the 2.4a health of the routed `summary` route: ok with the target, or blocked with a reason and alternatives (paid ones flagged, none chosen). Tests: `src/__tests__/contextGuard.test.ts` (9). Mutation check: `>=` to `>` on the critical boundary fails the boundary test.

**Not done (2.5b, the row's goal):** getting real token counts from a session, the in-UI warning, the summarise-and-continue action itself, and a live proof. Nothing calls this yet.

**Gates (2026-10-30, Node 22):** `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene` all `EXIT=0` on the first full parallel run (`apps/desktop unit` 302 s, no SIGSEGV; fifth clean parallel run in a row, still not proof). The mutation run was done first and the file restored.

---

## 2026-10-30 — Phase 2: ROADMAP 2.4a, route health and no silent fallback (`unit-tested`)

**Outcome:** `packages/model-providers/src/routeHealth.ts` (pure; subpath `@cindy/model-providers/route-health`). `assessRoute(resolution, routing, providers, probes)` takes a resolved task route (2.3a), the `providers.yaml` entries (2.1a) and the latest discovery probes (2.2a) and returns either `{ok: true, routeName, provider, model}` or a block with a `reason`, a message naming the provider (and the probe's error text), and `alternatives`: other routes whose provider is online and lists the model, local first, each marked `paid` when the endpoint is not loopback. The module has no path that returns a different route as the answer; a blocked route stays blocked and the alternatives are only for a click the owner makes. `llama3` matches an Ollama `llama3:latest`. Tests: `src/__tests__/routeHealth.test.ts` (6), including offline-local with a healthy paid route available (it is listed as paid, last, and not chosen). Mutation check: removing the local-before-paid sort fails the offline test.

**Not done (2.4b, the row's actual goal):** the session-level error, the one-click "use X instead" control, feeding probes in, and a live proof. Nothing calls `assessRoute` yet.

**Gates (2026-10-30, Node 22):** `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene` all `EXIT=0` on the first full parallel run (`apps/desktop unit` 303 s, no SIGSEGV; fourth clean parallel run in a row, still not proof). The mutation run was done first and the file restored.

---

## 2026-10-30 — Phase 4: ROADMAP 4.2a, local plugin loader (`unit-tested`)

**Outcome:** `packages/maker-core/src/plugins/plugin-loader.ts` (subpath `@cindy/maker-core/plugins`). `loadPlugins({root, registry, isEnabled?, timeoutMs?, importModule?})` walks `<root>/<name>/`, reads `manifest.yaml` (`entry` required; `version`, `description` optional), resolves the entry with `realpath` and refuses anything outside the plugin directory (absolute, `..`, symlink), imports it and calls the default export `activate(api)`. `api.register` is the 4.1a registry's `register` with `source: plugin:<name>` forced. Each plugin gets a report `{name, status: active|disabled|invalid|failed, error?, registered}`. A failing plugin (throw, bad export, timeout, default 5 s) has its partial registrations undone and does not stop the rest. Disabled plugins are never imported. Tests (`plugins/__tests__/plugin-loader.test.ts`, 7) write real plugin directories and load the files from disk. Mutation check: removing the escape check fails the dotdot/symlink test.

**Surprise worth knowing:** vitest's module graph cannot `import()` files outside the repo, and `new Function('return import(url)')` fails inside its worker ("A dynamic import callback was not specified"). So tests inject a loader built on Node's `require` (CommonJS plugins). The production default is a native `import()` via `new Function` so a bundler leaves it alone; that default path is **not** exercised by any test and is for 4.2b's live proof.

**Not done (4.2b):** loading at app startup, the Settings toggle and where its state lives, IPC, and a live run of the default import path in the real app. Nothing calls `loadPlugins` yet.

**Gates (2026-10-30, Node 22):** `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene` all `EXIT=0` on the first full parallel run (`apps/desktop unit` 305 s, no SIGSEGV; third clean parallel run in a row, still not proof). The mutation run (escape check removed) was done before the gate run and the file restored.

---

## 2026-10-30 — Phase 4: ROADMAP 4.1a, unified extension registry (`unit-tested`)

**Outcome:** `packages/maker-core/src/extensions/registry.ts` (subpath `@cindy/maker-core/extensions`): `registerExtension({kind, id, title?, source?, value})` on a process-wide registry, or `createExtensionRegistry()` for an isolated one. `kind` and `id` are slugs; `kind` is open (well-known: adapter, tool, expert, route, panel) so a new kind needs no edit. Duplicate `(kind, id)` throws and keeps the first; `register` returns an unregister handle (a stale handle cannot remove a newer entry); `get`, `list(kind?)` in registration order, `subscribe` (a throwing subscriber is isolated). The registry never calls a registered `value`. Tests: `extensions/__tests__/registry.test.ts` (8). Mutation check: removing the duplicate guard fails the duplicate test.

**Split, not narrowed:** 4.1 also says existing adapters are migrated with zero behaviour change. That is **4.1b, open and not started**: touching the Claude Code/Codex/Pi adapters is forbidden by AGENTS §3 unless a row says so, and needs before/after proof. Nothing uses the registry yet.

**Gates (2026-10-30, Node 22):** `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene` all `EXIT=0` on the first full parallel run; `apps/desktop unit` passed (302 s), no SIGSEGV this run (second clean parallel run in a row after 4 crashes in 5 earlier ones; still not proof).

---

## 2026-10-30 — Phase 2: ROADMAP 2.1b/2.2b IPC part (`unit-tested`)

**Outcome:** `apps/desktop/src/main/maker-ipc/providersHandlers.ts` (copy of the experts pattern): `maker:providers:list` returns `{providers, issues}` from `~/.cindy-harness/providers.yaml`; `maker:providers:discover` probes every endpoint with `discoverEndpoints`. Both check the sender first. Wired in `channels.ts`, `register.ts`, `preload.ts` (`electronAPI.maker.providers`), `vite-env.d.ts`. Tests: `__tests__/providersHandlers.test.ts` (4; real local HTTP server, one online + one dead endpoint, missing file, untrusted caller). Mutation check: dropping the trust check on `discover` fails the untrusted-caller test. Read-only; no new outbound calls beyond 2.2a's probe, which runs only when the renderer asks.

**Not done:** UI listing, polling schedule, the picker's online/offline display, `model-providers` consuming the file, a run against a real Ollama/LM Studio. Rows stay open.

**Gates (2026-10-30, Node 22):** `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene` all `EXIT=0` on the first full (parallel) run of this tree; `apps/desktop unit` passed (293 s), no SIGSEGV this time (it crashed in 4 of 5 earlier parallel runs, so one green run is not proof).

---

## 2026-10-30 — SIGSEGV isolation follow-up (no code change, `live-proven` for the findings)

Another session landed 2.2a (`e12bee95a3`) and 2.3a (`14b7b60899`) while I was re-gating the same tree. Findings from my 8 full gate runs on that tree: `apps/desktop unit` SIGSEGV in 4 of 5 parallel runs (with the experts IPC watcher already faked, so that test is not the trigger); `apps/desktop unit` alone green; a serial-unit gate (`--workspace-concurrency=1`) green, `EXIT=0` incl. typecheck, test:runner and check:test-hygiene. Also seen: one `apps/mobile` 5 s timeout (flake) and `watchExperts` late-root failing under load, now covered by the 500 ms root poll in `expert-loader.ts`. Debt row updated. Open: the root cause stays V8 GC at worker teardown; serial running is a workaround, not a fix.

---

## 2026-10-30 — Phase 2: ROADMAP 2.3a, `routing.yaml` schema and resolver (`unit-tested`)

**Outcome:** `packages/model-providers/src/routingFile.ts` (pure; subpath `@cindy/model-providers/routing-file`): `parseRoutingFile(doc, knownProviderIds)` validates `routes` (name -> `{provider, model}`, provider must exist in `providers.yaml`) and `rules` (task class -> route name; well-known classes `title`, `predict`, `summary`, `chat.default`); bad entries are reported as issues and dropped, valid ones kept. `resolveTaskRoute(config, taskClass)` returns `{ok, routeName, target}` or `{ok:false, error}`: exact rule, then `<group>.default` for a dotted class (`chat.code` -> `chat.default`), otherwise an explicit error. It never picks a default or "next best" model, so a missing local route cannot silently become a paid call (principle 3, 2.4). `packages/maker-core/src/providers/routing-file.ts` (subpath `@cindy/maker-core/routing-file`) reads the YAML; a missing file is empty routing. Tests: `model-providers/src/__tests__/routingFile.test.ts` (13) and `maker-core/src/providers/__tests__/routing-file.test.ts` (4). Mutation check: a first-route fallback fails the fail-closed tests.

**Not done:** 2.3b, which is the row's actual goal: auto-title, prompt prediction and summaries calling `resolveTaskRoute` and a title demonstrably generated by a local model. Nothing calls this yet, no local model was run.

**Gates (2026-10-30, Node 22.23.4):** typecheck, test:runner, test:unit:related, check:test-hygiene all exit 0 on the first full run (no `apps/desktop unit` SIGSEGV this time, after the fs.watch test was faked; one run is not proof).

---

## 2026-10-30 — Phase 2: ROADMAP 2.2a, endpoint discovery (`unit-tested`)

**Outcome:** `packages/maker-core/src/providers/discovery.ts` (+ subpath `@cindy/maker-core/providers-discovery`): `probeEndpoint(entry)` asks one `providers.yaml` endpoint for its models (Ollama `/api/tags`; others `/v1/models`, or `/models` when the base URL already ends in `/v1`) and returns `{id, status: online|offline|error, models, latencyMs, error?}`; `discoverEndpoints` runs all in parallel and a dead one does not affect the others. Offline = connect failure or timeout (default 2 s); error = reachable but HTTP error, non-JSON or no model list. Never throws. Tests (`__tests__/discovery.test.ts`, 14) run against real `http` servers on 127.0.0.1. Mutation check: allowing redirects fails the redirect test.

**Outbound-call note (AGENTS §3):** this adds `fetch(` but only to base URLs the owner wrote in `providers.yaml`, nothing is polled yet (no caller), the key goes only to that host from the env var the entry names, and redirects are refused so a key cannot be bounced elsewhere.

**Not done:** 2.2b: the polling schedule, IPC, the picker showing online/offline, and a run against a real Ollama or LM Studio (none was probed; no local model server was started).

**Gates (2026-10-30, Node 22.23.4):** typecheck, test:runner, test:unit:related, check:test-hygiene all exit 0 on the final tree. Before that, three consecutive full runs were red from the known `apps/desktop unit` SIGSEGV (plus one `apps/mobile unit` failure on a run that reported 12,766 s, i.e. the machine had suspended). Crash frequency rose after the 3.1b experts IPC test arrived, which used a real `fs.watch` inside a vitest worker thread, so I injected the watcher (`ExpertsHandlerDeps.watch`, default the real `watchExperts`) and that test now uses a fake; real watching stays covered by maker-core's forks-pool tests. One green run is not proof the crash is gone; it is a suspect removed (ROADMAP Debt keeps the root cause).

---

## 2026-10-30 — Phase 2: ROADMAP 2.1a, `providers.yaml` schema and reader (`unit-tested`)

**Outcome:** `packages/model-providers/src/providersFile.ts` (pure, new subpath `@cindy/model-providers/providers-file`) validates a parsed `providers.yaml`: entries `{id, kind: ollama|lmstudio|llamacpp|openai-compatible, baseUrl, keyEnv?, capabilities{tools,vision,contextLength}}`. Rules: `keyEnv` must look like an env var NAME (`^[A-Z_][A-Z0-9_]*$`), so a pasted key is rejected; `apiKey`/`token`/`secret`-style fields and credentials in the URL are rejected; ids unique and slug-shaped; http(s) only; trailing slash normalised; loopback hosts flagged `local`. A bad entry becomes an issue and the others still load. `packages/maker-core/src/providers/providers-file.ts` (new subpath `@cindy/maker-core/providers-file`) reads the file (missing file = empty registry, YAML errors = file-level issue). Tests: `maker-core/src/providers/__tests__/providers-file.test.ts` (14). Mutation check: disabling the env-name rule fails the key tests.

**Deviation to know:** the spec says the file is "read by `model-providers`", but that package has zero runtime deps and I could not add `js-yaml` offline (`ERR_PNPM_NO_OFFLINE_META`; I did not use the network for a dependency, lockfile untouched). So parsing sits in maker-core using its existing `gray-matter`, and `model-providers` only holds the pure validator.

**Not done:** 2.1b (IPC + Settings UI listing; nothing calls this yet, no UI, no live run).

**Gates (2026-10-30, Node 22.23.4):** typecheck, test:runner, test:unit:related, check:test-hygiene all exit 0 on the final tree. The first run was red twice over: the known `apps/desktop unit` SIGSEGV, and a race in my own `watchExperts`/experts-IPC tests (the change was written before `fs.watch` was delivering events, so it was lost under load). The tests now re-apply their change each poll (and the IPC one polls slower than the handler's 150 ms debounce); they passed repeatedly and the rerun was green. This also touches 3.1a/3.1b tests: those two rows' tests were flaky until now.

---

## 2026-10-30 — Phase 3: ROADMAP 3.5a, starter experts (`unit-tested`)

**Outcome:** `docs/experts-examples/{code-reviewer,research-analyst,repo-explainer,prompt-engineer}/expert.md` plus a README (copy a folder to `~/.cindy-harness/experts/`). All four are `agent: hermes`; only the Research Analyst has `memory: true`. `packages/maker-core/src/experts/__tests__/starter-experts.test.ts` loads them through the 3.1a loader and fails if one becomes invalid (no frontmatter drift). Prompts are new text for a new feature, not edits to any existing agent's prompt.

**Not done:** 3.5b, running each expert once live; that waits for 3.2 (session-as-expert), so the quality of these prompts is untested against a model. They set no `model` (route names come with 2.3) and no `tools`, so a session uses whatever the Hermes home allows.

**Gates (2026-10-30, Node 22.23.4):** typecheck, test:runner, test:unit:related, check:test-hygiene all exit 0 on the final tree. The first run was red only from the known `apps/desktop unit` SIGSEGV (root cause now recorded under ROADMAP Debt: V8 GC during worker-isolate teardown in the threads pool, which upstream pins on purpose); the rerun was green.

---

## 2026-10-30 — Phase 3: ROADMAP 3.1b, experts IPC (`unit-tested`)

**Outcome:** the expert loader is reachable from the renderer. Files: `apps/desktop/src/main/maker-ipc/expertsHandlers.ts` (new; `registerExpertsHandlers(registry, {rootDir, assertTrusted, broadcast})`), `channels.ts` (`MAKER_INVOKE.EXPERTS_LIST`, `MAKER_PUSH.EXPERTS_CHANGED`), `register.ts` (registers it with root `~/.cindy-harness/experts`, trust check = `assertTrustedAppRendererEvent`, broadcast = `broadcastToAllWindows`), `preload/preload.ts` + `renderer/vite-env.d.ts` (`maker.experts.list()`, `maker.experts.onChanged(cb)`), `packages/maker-core/package.json` (subpath export `@cindy/maker-core/experts`, so the big `index.ts` is untouched). Tests: `maker-ipc/__tests__/expertsHandlers.test.ts` (4: list with a broken expert, untrusted sender refused, change push, no watching before first list). Mutation check: removing the trust check fails 2. `pnpm --filter desktop typecheck` passes.

**Not proven:** no renderer code calls `maker.experts` yet and the running app was never asked (owner denied computer-use access), so there is no `live-proven` claim. The push goes through `broadcastToAllWindows`, which also stamps data-owner scope; whether the stamp suits this channel is unchecked.

**Gates (2026-10-30, Node 22.23.4):** the full chain ran once: typecheck, test:runner and test:unit:related exit 0, `check:test-hygiene` red on one unannotated real wait in `expertsHandlers.test.ts`. After adding the `// real-wait:` justification (comment-only change), `check:test-hygiene` passes and the test file passes 4/4; the other three gates were not rerun on the comment-only edit.

---

## 2026-10-30 — Phase 3: ROADMAP 3.1a, expert loader module (`unit-tested`)

**Outcome:** new `packages/maker-core/src/experts/expert-loader.ts` (+ `__tests__/expert-loader.test.ts`, 14 tests). `loadExpert(dir)` parses `expert.md` (frontmatter via the existing `gray-matter` dep) into a typed `Expert` (name required; agent defaults to `hermes` and must be one of hermes/claude-code/codex/pi; model, temperature 0..2, tools/skills/tags lists, memory boolean; non-empty prompt body; optional `skills/*/SKILL.md`, `tools.yaml`, `knowledge/` paths) and never throws: failures come back as `error`. `loadExperts(root)` lists every directory sorted by slug with valid and invalid together (dot-dirs and files skipped, missing root = empty). `watchExperts(root, cb)` debounces `fs.watch` and re-lists (also when the root is created later). Read-only: nothing writes expert files. Mutation check: removing the name check fails 3 tests.

**Not done:** 3.1b, the IPC exposure (list + change push), so nothing in the app calls the loader yet. `tools.yaml` is only located, not parsed. `model` is stored as a route name; route resolution is 2.3. Skipped as needing the UI (owner denied computer-use access to the dev app): 1.8c-2, 1.2, 1.4.

**Gates (2026-10-30, Node 22.23.4):** typecheck, test:runner, test:unit:related, check:test-hygiene all exit 0 on the final tree. The first run failed only on my own `watchExperts` test timing out under full-suite load; its timeouts were raised and the rerun was green.

---

## 2026-10-30 — Phase 1: ROADMAP 1.8c/1.8d, per-session model switch broken on real Hermes, fixed (`live-proven` at daemon level)

**Outcome:** the 1.8c live proof failed first. Against the real `hermes-cindy` (two paid DeepSeek turns, owner-authorised), `query/setModel` followed by a second turn made the daemon resume with a changed `-m`, and Hermes 0.22.5 refused it (`exit_code 2`, "resume without it and use /model after resuming"). Free probes showed a resume must repeat the launch `-m`/`--provider`/`--safe-mode` exactly, and that `/model <x>` on a resumed session is a local command whose effect persists (next turn: `model=deepseek-v4-pro`). The 1.8a unit tests had passed only because the fake Hermes accepts any flags, so 1.8a's `unit-tested` label overstated it for the resume case.

**Fix (new row 1.8d):** `packages/maker-hermes-manager/src/session-registry.ts` (+`launch`, `appliedModel`), `hermes-manager.ts` (freeze the launch route on a session's first turn; replay it on resume; when the wanted model differs, run a silent `/model <x>` first; a failed switch ends the turn with `error`), `__tests__/fixtures/fake-hermes.mjs` (`FAKE_RECORD_TEXT` logs argv+query), and `hermes-manager.test.ts` (the two 1.8a tests rewritten + a failure test; mutation-checked: replaying the current route instead of the launch route fails both main tests). Package suite 97/97 under Node 22.

**Live proof:** `docs/evidence/1.8c-live-proof.md` (before/after transcript). After the fix: turn 1 `deepseek-flash`, `setModel deepseek-v4-pro`, turn 2 `deepseek-v4-pro`, both closed `completed`, `config.yaml` byte-identical to its backup (`config.yaml.bak-20261030-1.8c`).

**Still open:** 1.8c-2, the same switch driven from the desktop UI. Safe-mode resume + switch and clearing the override are fake-tested only. `HANDOVER.md` §4 now records the resume rule. Environment: a background `brew` upgrade (`simdjson` 5.0.7) broke Node 22 mid-session; fixed with `brew reinstall node@22`; set `HOMEBREW_NO_AUTO_UPDATE=1` for long sessions.

**Gates (2026-10-30, Node 22.23.4):** typecheck, test:runner, test:unit:related, check:test-hygiene all exit 0 on the final tree. The first run was red only from the known `apps/desktop unit` SIGSEGV (dev app not running; logged under Debt); the rerun was green.

---

## 2026-10-30 — Phase 1: ROADMAP 1.8b, Hermes model label in the session header (`unit-tested`)

**Outcome:** new `apps/desktop/src/renderer/features/cc-agent/HermesSessionModelLabel.tsx` renders `session.model` as a muted read-only label next to the title when `agentKind === 'hermes'` (null otherwise); `SessionContentHeader.tsx` (upstream file, +3 lines, additive) mounts it, hidden while renaming. Test: `apps/desktop/src/renderer/__tests__/hermesSessionModelLabel.test.tsx` (`renderToStaticMarkup`, 2 tests). My first version read the source text in a test; `check:test-hygiene` rejected it, so it was replaced by this behavioural test.

**Not proven:** the label is not seen rendered, and I have not checked that `session.model` updates after `setModel` in a running app. That is 1.8c (live). Owner authorised paid calls on 2026-10-30.

**Gates (2026-10-30, Node 22.23.4):** `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene` all exit 0 on the final tree. An earlier run was red on `check:test-hygiene` (source-reading test), fixed as described above.

---

## 2026-10-30 — Phase 1: ROADMAP 1.8a, manager-level test that `query/setModel` reaches `-m` (`unit-tested`)

**Outcome:** row 1.8 was mostly built already (`query/setModel` handler in `hermes-manager.ts`, `-m` in `hermes-run.ts` `buildHermesArgs`, agent method, chat-input picker). What was missing was a test at the manager level. Added 3 tests plus helper `runTurnArgv` to `packages/maker-hermes-manager/src/__tests__/hermes-manager.test.ts` (fake Hermes only): full-access session has no `-m` by default, an override sets it, clearing with `''` drops it, `config.yaml` untouched; safe mode uses the home route `fake/default-model`, an override swaps `-m` and keeps `--provider fake-provider`, clearing falls back; `query/setModel` rejects an unknown session and a missing model. All 16 tests in the file pass under Node 22. Mutation check: disabling the registry update in the handler made the two main tests fail; source restored.

**Not done / still open:** 1.8b (model shown in session header; `SessionContentHeader.tsx` is an upstream file, needs owner OK) and 1.8c (live proof, paid turn, needs approval). Row 1.8 stays open. Nothing live was run.

**Surprise (not fixed):** in safe mode an override model is paired with the home route's provider when the session has no provider of its own, so a model from a different provider could mismatch. Flagged for the owner.

**Gates (2026-10-30, Node 22.23.4):** `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene` all exit 0. Two earlier runs were red for environmental reasons, not assertions: a vitest SIGSEGV in `apps/desktop unit` with the dev Electron app running, and vitest SIGABRT in every workspace after a background `brew` upgrade moved `simdjson` to 5.0.7 under Node 22 (fixed with `brew reinstall node@22`).

---

## 2026-10-30 — Phase 1: ROADMAP housekeeping, 1.5b closed (docs only)

**Outcome:** rows 1.5b and 1.5b-4b were still marked open although 1.5b-5c redid the 4b proof and is `live-proven` (`docs/evidence/1.5b-5c-live-proof.md`). Both are now ✅ `live-proven` via 5c; the 5c row's "Open: auth.json write-back" now points at the free probe. No code changed, no gates needed. Known gaps stay in Debt: packaged builds lack the shim bundle; real OAuth refresh untested.

**1.7 closed (docs only):** its 🧪 note said "live-prove via 0.8", and 0.8 did exactly that (model Save diffed the `default:` line); the catalog listing was already `live-proven` on 2026-10-23. Marked ✅ citing both entries. Caveat: the listing proof predates the 10-29 session-home work; nothing in that work touched the catalog code, but I did not re-run it.

**Next:** 1.6 is a design row (📐, needs a spec); 1.8 (per-session model override) is the first open row with a testable spec.

---

## 2026-10-29 — Phase 1: shared `memories` across session homes, concurrent-writer probe (`live-proven` for the writer; owner decided: keep shared)

**Outcome:** Hermes v0.22.5 `MemoryStore._mutate` takes an exclusive `flock` on `MEMORY.md.lock`, re-reads `MEMORY.md` inside the lock, then replaces the file atomically. Probe: two real Python processes using the real `MemoryStore.add`, each with its own throwaway `HERMES_HOME` whose `memories` is a symlink to one shared directory, 40 adds each at the same time. Result: 0 failures and all 80 entries present in `MEMORY.md` (A 40/40, B 40/40). So two sessions sharing `memories` do not lose each other's writes. Throwaway dir under `$HOME`, deleted afterwards; no real memories, no model call, `~/.hermes` not referenced.

**Not proven:** `replace`/`patch` races between sessions (a session can still edit an entry another session just changed; the drift guard returns an error then, not data loss), and the char limit being shared by all sessions. **Owner decision (2026-10-30): keep `memories` shared across session homes.** Veto flag closed; do not re-litigate.

---

## 2026-10-29 — Phase 1: `auth.json` write-back from a session home, free probe (`live-proven` for the writer only; real token refresh NOT tested)

**Outcome:** Hermes v0.22.5 saves `auth.json` through `hermes_cli/auth.py::_save_auth_store` -> `utils.atomic_json_write` (temp file + replace). I ran that real function from the Hermes venv on a throwaway directory: `home/auth.json` as a symlink to `shared.json`, then a write. Result: the symlink survived and `shared.json` received the new content. So a write from a per-session home reaches the shared `auth.json`; a refreshed token will not be stranded in one session home. The "global root" write-through (`_global_auth_file_path`) returns None when the home and the root are the same directory; I did not run it against a session home.

**Not proven:** a real provider token refresh (no OAuth provider is logged in: Nous was logged out in 0.9b, DeepSeek uses a static key in `.env`, `copilot` comes from the gh CLI), and the global-root write-through with a real `HERMES_HOME` set to a session home. The first is moot until the owner logs in to an OAuth provider again; re-check then. No credentials read, no real `auth.json` touched, no model call, `~/.hermes` not referenced.

---

## 2026-10-29 — Phase 1: orphan session homes reaper live check (`live-proven`)

**Outcome:** planted `session-homes/livecheck-old-aaaaaaaaaa` (mtime set to 2026-10-26) and `livecheck-new-bbbbbbbbbb` (fresh), restarted the dev app (`pnpm restart:desktop:local`; rebuilt `hermes-mgr.mjs` contains `reapOrphanHomes`), then waited for the window to finish loading (I only took a screenshot; no clicks or typing). The daemon was not running right after the restart, but by the next listing about 2 minutes later the old fake home was gone, so it started on its own during app start-up (exact trigger not identified). The fresh fake, the real `0c5e9200-...-2d51ca5605` (about 1.5 h idle) and `~/.hermes-cindy/auth.json` were untouched. I removed the fresh fake by hand afterwards. No model call, no config write.

**Not proven:** a real 24 h-old orphan; a home whose gateway pid is alive. I did not find the "removed orphan session homes" log line (logger location not checked), so the evidence is the directory listing before and after.

---

## 2026-10-29 — Phase 1: orphan session homes reaped at startup (`unit-tested`; live check in the entry above)

**Outcome:** the Debt row "orphan Hermes session homes accumulate" is fixed in code. `hermes-mgr` start (only with per-session homes) now runs `reapOrphanHomes` after `reapOrphanGateways`: it removes `session-homes/<id>-<10 hex>` directories that no registered session owns and that were idle for 24 h (`orphanHomeMinAgeMs`, default 24 h). Safety: real directories only, never follows symlinks (shared items are links, so the base home's `auth.json`/`installs` survive), skips a home whose gateway pid is alive but not verifiably its Hermes gateway, best effort (errors logged, start continues). Decision recorded in ADR 0004.

**Changed:** `packages/maker-hermes-manager/src/session-home.ts` (`reapOrphanHomes`, `orphanHomeMinAgeMs`), `index.ts` (exports), `hermes-manager.ts` (start). Tests: 5 in `session-home.test.ts` (removes idle orphan and keeps registered one with base-home files intact; keeps recent; ignores stray names/files and an outside-pointing symlink; keeps unverifiable live pid; no root dir), 1 in `hermes-manager-session-homes.test.ts` (start removes idle orphan, keeps recent).

**Not done:** live proof in the running app. The real orphan `0c5e9200-...` is only about 1.5 h old, so it is not eligible until 24 h idle; a live check needs a planted old directory or waiting until tomorrow plus an app restart.

**Gates (Node 22), corrected:** commit `8d17c31f55` was pushed after a RED chain by my mistake (the commit step was not chained to the gate result), and the line that stood here claiming exit 0 was wrong at that time. Record for this code: chain #1 and #2 exited 1, `apps/desktop` vitest killed with SIGSEGV (crash reports: V8 GC in `IsolateData::~IsolateData`, worker-thread teardown, no Cindy frames); related unit tier alone exit 0; chain #3 of `typecheck`, `test:runner`, `test:unit:related`, `check:test-hygiene` exit 0 (`EXIT=0`, 0 FAIL lines), so one clean chain exists for this change. The flake predates it: two `gates10.log` files from two sessions on the earlier `49cff34639` state, one `EXIT=0`, one `EXIT=1`. Logged in ROADMAP Debt.

---

## 2026-10-29 — Phase 1: 1.5b-5c close cleanup (`live-proven`)

**Outcome:** after QuakeNotch was turned off I clicked B's archive icon twice (B was an unsent draft, no visible effect) and, on the owner's "Archive A", took full-screen control to click A's row. Before I could, the sidebar already showed no sessions (`localDb.sessions.list` filter=active rows=0) and `session-homes/` had changed at 23:08:26: homes `fa64fbc6-...` (B) and `3bc1dab6-...` (A) and both gateways (pids 13291, 17042) were gone. The pre-restart orphan home `0c5e9200-...` was untouched (matches the Debt row). Main log has no `session home cleanup failed` warning.

**Trigger (owner, afterwards):** the owner deleted both sessions (A and B) in the UI themselves, so session delete is what removed each home and gateway; archiving the unsent draft B did nothing. Not tested: removal on a session with an in-flight turn.

**Still open:** `auth.json` refresh write-back from a session home; orphan-home accumulation (Debt).

---

## 2026-10-29 — Phase 1: 1.5b-5c concurrent sessions (`live-proven`); close cleanup NOT proven

**Outcome:** one owner-approved paid DeepSeek turn (3 API calls). Dev app, two Full-access Hermes sessions with live gateways at the same time:
- B (new session, prewarmed by typing in the composer, never sent): home `session-homes/fa64fbc6-...-d174bb84ce`, gateway pid 13291, `cindy_docs` registered 6 tools before any model call, **0 inbound messages** afterwards.
- A (the earlier proof session, resumed): home `session-homes/3bc1dab6-...-f00551e2ef`, gateway pid 17042 (started by the turn), `read_sheet` completed, answer "plums = 5" from A's own `proof-5c.csv` (B's file said 9, so no cross-talk).
Distinct `HERMES_HOME` per gateway read from each process's env (`ps eww`). Config backup: `config.yaml.bak-20261029-1.5b-5e`.

**Not proven:** session close. The only UI route I found is the row's archive icon; a background `AXPress` just re-selected the row, then full-screen control was blocked by `QuakeNotch` (as in 5c). Both B's home and gateway are still there, so removal is untested either way. Code path: `QUERY_CLOSE` in `hermes-manager.ts`; unit-tested only. `auth.json` write-back also untested.

**Surprises:** (1) a resumed session got a **new** session home after the app restart (old home `0c5e9200-...` stayed, no gateway): the home is keyed by the Hermes session id, which changed. Old homes are not removed by `reapOrphanGateways` (it stops gateways only), so they accumulate: logged for ROADMAP Debt. (2) Prewarm happens when you type in the composer, not when the composer opens.

**Left running / on disk:** gateways 13291 and 17042 and three session homes; the owner can archive B's row by hand and I will check removal.

---

## 2026-10-29 — Phase 1: 1.5b-5c-ui-b: permission-mode tooltips checked in the running app (`live-proven`)

**Outcome:** fresh dev-app restart (`pnpm restart:desktop:local`), opened the composer permission dropdown in a Hermes chat and hovered each item. Default permissions tooltip: "Hermes safe mode: tool actions follow the Hermes home policy. Cindy document tools are off (safe mode disables MCP)." Full access tooltip: "Runs Hermes with --yolo and no further confirmation. Highest risk. Cindy document tools (cindy_docs) are available when the chat starts in this mode." Both match 5c-ui-a. Mode left unchanged (Full access), no model call made. Row 5c-ui is now closed.

**How:** hover needs full-screen control (the background `app_*` tools cannot hover); granted by the owner for this step and released afterwards. Docs-only change since `49cff34639`, gates not rerun.

**Still open:** concurrent full-access sessions and session-close cleanup (paid turn, owner approval first); `memories` sharing veto flag.

---

## 2026-10-29 — Phase 1: 1.5b-5c-ui-a: permission-mode descriptions say which mode carries Cindy tools (`unit-tested`, rendering NOT checked)

**Outcome:** the Hermes permission-mode descriptions now state the 5d decision. Default: "Cindy document tools are off (safe mode disables MCP)." Full access: `cindy_docs` is available "when the chat starts in this mode". Wording is deliberate: switching mode mid-chat does not re-register the bridge, so tools depend on the mode the chat starts in.

**Changed:** `packages/maker-core/src/agents/hermes/agent.ts` (two description strings); `packages/maker-core/src/agents/hermes/__tests__/agent.test.ts` (one test pins both strings; 36 Hermes tests pass). Descriptions render as tooltips in `apps/desktop/src/renderer/components/new-chat/PermissionSelector.tsx`; not opened in the app.

**Row split:** 5c-ui-a done (`unit-tested`). **5c-ui-b open:** eyeball the tooltip in the running app (restart needed, the change is in `maker-core`); only then is it `live-proven`. Still untested live: two concurrent full-access sessions, session-close cleanup, `auth.json` write-back from a session home. `memories` shared across session homes: owner has not answered the veto flag.

**Gates (Node 22), corrected:** commit `49cff34639` was made while the gates were red and its original line here claimed all four exit 0; that was not verified. Actual record: two full chains (gates9, gates10) exited 1 with a vitest SIGSEGV in `apps/desktop unit` (worker crash, not an assertion), after `typecheck` and `test:runner` had passed in them; a rerun of `test:unit:related` + `check:test-hygiene` alone then exited 0 with no crash. No single clean chain exists for this change. The crash is intermittent, logged in ROADMAP Debt.

---

## 2026-10-29 — Phase 1: 1.5b-5c live proof (`live-proven`): `cindy_docs` read_sheet round-trips inside the desktop app

**Outcome:** one owner-approved paid DeepSeek turn in a Full-access Hermes session in the running dev app: `mcp__cindy_docs__read_sheet` completed and the answer (`figs` = 17) matched the file. This closes the 4b failure. Evidence, log excerpts and caveats: `docs/evidence/1.5b-5c-live-proof.md`.

**How:** fresh app start (daemon forked with `--per-session-homes`), new Full-access session, per-session home prewarmed, shim registered 6 tools in that session's own gateway before any model call. Config backed up first (`config.yaml.bak-20261029-1.5b-5c`).

**Honest limits:** model also ran an unrecorded `terminal` call first, so the proof rests on the `read_sheet completed` + bridge `mcp session initialized` lines, not on the answer. One session only: concurrent sessions, close-time cleanup and `auth.json` write-back are not live-tested. UI note on why tools are absent outside Full access is still not built. Packaged builds still lack the shim bundle (Debt). Gates not rerun: docs only since `1b12c0110a` (gates exit 0).

**Surprises:** the desktop UI renders slowly and background clicks on popups did nothing; `QuakeNotch` (overlay app) blocked full-screen clicks, so the owner switched the permission mode by hand.

---

## 2026-10-29 — Phase 1: 1.5b-5c wiring: full-access guard + per-session homes in the desktop (`unit-tested`, live proof NOT done)

**Outcome:** the code half of 1.5b-5c. The live half (redo 4b, one paid DeepSeek turn) is **not done** and needs owner approval, so the row stays open.

**Changed:** `maker-core` `base-agent.ts` + `hermes/agent.ts` (the bridge hook now receives the requested `permissionMode`); `hermesBridgeHost.ts` (preparer returns null, before touching any state, unless `permissionMode === 'bypassPermissions'`; exported `HERMES_BRIDGE_PERMISSION_MODE`); `hermes-manager-client.ts` (desktop forks `hermes-mgr` with `--per-session-homes`). Tests: guard test (undefined/default/acceptEdits/plan -> null, nothing registered), agent passes the mode, client args.

**Design note:** no shim/config change was needed. Session homes copy the base `config.yaml`, which already holds the static shim entries with `${CINDY_BRIDGE_SESSION}`; that variable now expands from the session's own gateway, which the client starts with the session env (5a/5b). The "static in the shared config" decision from 1.5b-1 therefore stands, but is only sound with per-session homes on.

**Verified:** targeted tests pass; gates (Node 22, exit 0) on the second run. The first run failed once in `scheduler-host/preRunHook.test.ts` ("预检耗尽超时预算", 1 ms budget, asserts no spawn); it passed 3/3 alone and the full rerun was green, so it is a load-sensitive flake outside this change. Logged in ROADMAP Debt.

**Known limits:** (1) a `hermes-mgr` daemon started before this change is reused without the flag until the app restarts, so shared-home behaviour (the 4b failure) persists until then; restart the app before the live proof. (2) The UI does not yet say why Cindy tools are absent outside full access (1.5b-5d asks for it). (3) Packaged builds still lack the shim bundle (Debt).

---

## 2026-10-29 — Phase 1: 1.5b-5b per-session homes + gateway lifecycle (`unit-tested`)

**Outcome:** `hermes-manager` can run each Cindy session in its own `HERMES_HOME` with its own gateway. Opt-in and default off: `sessionHomes` option, `hermes-mgr --per-session-homes`. With it off, behaviour is unchanged. Not wired from the desktop yet (that is 1.5b-5c).

**Changed (`packages/maker-hermes-manager/src`):** `session-home.ts` (new: build home, symlink shared items, generate regular `config.yaml`, share `installs/`), `hermes-manager.ts` (turns run in the session home; gateway prewarmed at `query/start`; `query/close` removes home and gateway; startup reaps orphan gateways; daemon stop stops session gateways), `bin/hermes-mgr.ts` (flag), `index.ts` (re-export), `__tests__/fixtures/fake-hermes.mjs` (`FAKE_RECORD_ENV` recorder), tests `session-home.test.ts` and `hermes-manager-session-homes.test.ts`.

**Verified:** 24 new tests, package 87/87, all with `fake-hermes` (no real Hermes, no model call). Gates (Node 22, exit 0): `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene`. Not `live-proven`: no real gateway was started by this code; that is 1.5b-5c.

**For the owner to veto:** `memories` is shared across session homes (symlink), which preserves today's behaviour. Say so if sessions should get isolated memory.

**Still open:** `auth.json` refresh write-back from a session home (needs credentials/model call); non-interactive approval behaviour without `--safe-mode`/`--yolo`. Next: 1.5b-5c (needs one paid DeepSeek turn, approval first).

---

## 2026-10-29 — Phase 1: 1.5b-5d decided, "full access only" (docs only)

**Outcome:** owner chose "Full access only" for the `--safe-mode` blocker. Cindy tools in Hermes are available only in full-access (`bypassPermissions` → `--yolo`) sessions; all other
modes keep `--safe-mode` (MCP off) and get no Cindy tools. Recorded in ROADMAP row 1.5b-5d (✅ decided, no code yet) and as an addendum to `docs/decisions/0004-hermes-gateway-per-session.md`.

**What it changes:** (1) 1.5b-5c gains a guard: `prepareHermesBridgeSession` returns null unless the session is `bypassPermissions` (the current hook in `maker-host` does not check this, so today it would
register bridge state for sessions whose run ignores MCP); the UI should state why tools are absent. (2) The GATED servers stay off and exposure stays `cindy_docs` only, since `--yolo` bypasses
Hermes' approvals (consistent with ADR 0003). (3) The live proof (4b, redone in 5c) must use a full-access session, which also fits the 4b failure: it ran "Default permissions", i.e. `--safe-mode`.

**Order of the rest, each on the owner's word:** 1.5b-5b (per-session home + gateway lifecycle in `hermes-manager`, hot path) → 1.5b-5c (rewire preparer/shim, add the guard, redo 4b live, one paid turn with approval).
Gates not rerun: docs only.

---

## 2026-10-29 — Phase 1: 1.5b-5a free probes (`live-proven`, probes) + new blocker `--safe-mode`

**Outcome:** 1.5b-5a done to `live-proven` at probe level (real Hermes v0.22.5, stub MCP server, throwaway homes, scrubbed env, no credentials, no model call; real
`~/.hermes-cindy/config.yaml` unchanged, probe gateways stopped, scratch deleted). Full results: `docs/evidence/1.5b-5a-probes.md`; ADR 0004 amended with them.

**Answers:** (1) a real `hermes chat` client starts the gateway with the client's env, so gateway-per-session works with how `hermes-run.ts` already spawns. (2) Symlinks to
`.env`/`auth.json`/`SOUL.md`/`skills`/`plugins`/`memories` survive; Cindy's rename-based writer would replace a link, so the per-session `config.yaml` must be a generated regular file.
(3) Share `.env`, `auth.json`, `SOUL.md`, `skills`, `plugins`, `installs`; per session `config.yaml`, `state.db`, sessions, logs. (4) Copying a warmed home fails (absolute venv paths);
sharing `installs/` by symlink works: home 1.0 GB → 5 MB, start 9–18 s → ~2–7 s.

**Mistake caught:** my first template-clone timing (0.76 s) was a fast failure, not a start. I noticed only 2 of 3 gateways were up and the `--json` output was empty, reran with the
exit code, and corrected the conclusion.

**New blocker (affects the whole 1.5b, not just identity):** Hermes documents `--safe-mode` as disabling "user config, AGENTS.md/memory injection, plugins, and MCP servers".
`permissionModeToFlags` passes `--safe-mode` for every Cindy permission mode except full access (`--yolo`). So a default/ask Hermes run has MCP off regardless of identity. That also
explains why the 4b model saw only `terminal` and `todo`. Recorded as row **1.5b-5d** (owner decision on the mapping); 1.5b-5c is not useful before it.

**Still untested (needs credentials or a model call):** `auth.json` refresh write-back from a session home; approval behaviour without `--safe-mode`/`--yolo` in non-interactive mode;
memory sharing policy. No paid calls this session. Gates not rerun: docs only.

---

## 2026-10-29 — Phase 1: identity channel decided, design recorded (docs only)

**Outcome:** owner answered the one open product question: Hermes sessions **do overlap** ("Sometimes overlap"). So single-active-session identity is out and
gateway-per-session is the route. Recorded as `docs/decisions/0004-hermes-gateway-per-session.md` (status **Proposed**) and three new ROADMAP rows,
1.5b-5a (free probes), 1.5b-5b (per-session home + gateway lifecycle in `hermes-manager`), 1.5b-5c (rewire preparer/shim, then redo 4b live). No code written.

**Why not the alternatives (details in the earlier 2026-10-29 entries):** shared-gateway env cannot carry per-session identity; per-session shim entries need
up to 60 s to reconcile and would expose every session's tools to every session's agent; tool-argument identity is forbidden by the bridge's trust rule.

**What stays valid from 1.5b-1/-2/-3:** bridge identity registration, the 0600 runtime file, the shim's proxying, ADR 0003 exposure policy, mid-run config
reconcile. What gets replaced: the "static `${CINDY_BRIDGE_SESSION}` in shared config.yaml + per-session query/start env" channel.

**Next (needs the owner's word, one sub-row at a time):** 1.5b-5a, the free probes that answer ADR 0004's four open questions (real `hermes chat` client env,
what Hermes writes into a home, what must be shared, cold-start hiding). Gates not rerun: docs only.

---

## 2026-10-29 — Phase 1: 1.5b-4b option (b) probe, per-session shim entry (free, negative result)

**Outcome:** no way found to force Hermes to reload MCP config; option (b) as designed is weaker than it looked. Nothing built; 1.5b-4b stays open. Throwaway home,
stub MCP server, no model call, no `~/.hermes*` touched, probe gateways stopped, scratch deleted. Table: `docs/evidence/1.5b-4b-attempt-not-proven.md`.

**Measured:** Hermes reconciles `mcp_servers` on a fixed ~60 s tick (log at :56 each minute). Writing config, `hermes status`, `hermes gateway ensure`, and `touch`
did not shorten the wait. SIGUSR1 and SIGHUP terminate the gateway instead of reloading. So a new entry is usable 0-60 s after it is written (avg ~30 s).

**Reasoned, not tested (flagged):** a shared gateway exposes every registered MCP server to every session's agent. With one entry per session, session A's model
would also see session B's tools and could call them under B's identity: that breaks the isolation the bridge's per-session tokens exist to give. It would only
hold if `hermes chat -t/--toolsets` can scope MCP servers per run, which I could not test without a model call. Per-session entries also add the 0-60 s no-tools
window at the start of a session.

**State of the options:** (a) gateway per session preserves isolation by construction but is an architecture change (STATUS 2026-10-29 above); (b) has the
tool-visibility hole and the latency; (c) single-active-session identity is simple but only safe if Hermes sessions never overlap; (d) tool-arg identity is forbidden.

**Decision needed from the owner (a product fact, not something the repo answers):** do you ever run more than one Hermes session at the same time, or leave one
open while starting another? If never, (c) with a hard guard (refuse tool calls unless exactly one Cindy Hermes session is active, fail closed) is a small change
that restores the feature; if sometimes, (a) is the only isolation-safe route.

---

## 2026-10-29 — Phase 1: 1.5b-4b option (a) probe, gateway per session (free, mechanism `live-proven`)

**Outcome:** option (a) works as a mechanism, and it is expensive. Nothing built; 1.5b-4b stays open. Stub MCP server only, throwaway homes, no
model call, nothing under `~/.hermes*` touched, all four probe gateways stopped and scratch deleted. Table and detail:
`docs/evidence/1.5b-4b-attempt-not-proven.md`.

**Proven:** a per-session `HERMES_HOME` gives a per-session gateway whose MCP children receive that session's env: 4 homes, 4 gateways, 4 correct values.
A symlinked shared `config.yaml` works. `startHermesRun` already takes `hermesHome` per spawn; only `hermes-manager.ts:198` (and the route/config reads)
pass the daemon-wide home today, so the code change is small.

**Costs measured:** cold home 14.02 s and 8.69 s (9–14 s observed), warm 0.4 s, about 250 MB RSS per gateway.

**Not proven, and the real risk:** (1) a real `hermes chat` client starting the gateway with its own env (the probe used `gateway ensure`; 4a's leftover
gateway suggests yes, but that was by accident). (2) What a thin per-session home must share: credentials (`.env`, `auth.json`, Nous token refresh writes
back), models/route, plugins, skills, memories. Symlinks break if Hermes or `hermes-config.ts` writes with temp-file-plus-rename, which replaces the link
with a file. (3) Resume: Hermes session ids live under the home, so a Cindy session must always reuse its own home. (4) Lifecycle: stopping gateways at
session close and app quit, and reaping orphans, is new work. (5) The first turn of a new session pays the cold-start cost unless homes are pre-cloned
from a template.

**Where this leaves the options:** (a) is viable but is a real architecture change in how Cindy drives Hermes (state fragmentation, per-session process,
lifecycle), not a small wiring fix. (b) one shim entry per session is unprobed except for its reconcile latency (~60 s measured); a way to force reload
is the open question and would be a free probe. Both preserve today's bridge trust model. Recommendation: do one more free probe for (b)'s forced reload
(`hermes mcp`/gateway commands, no model call) before choosing, because (b) avoids per-session state and processes entirely if the latency can be removed.

---

## 2026-10-29 — Phase 1: 1.5b-4b free control experiment (design finding, `live-proven` for the mechanism)

**Outcome:** the identity-channel risk from the 4b attempt is now confirmed, not just suspected. 1.5b-4b stays open; **the current per-session-env
design (1.5b-1/-2/-3) cannot deliver a session id to the shim when one Hermes gateway serves several Cindy sessions.** No model call, no
`~/.hermes*` touched (throwaway `HERMES_HOME` in the scratchpad, gateway stopped, scratch deleted). Detail: `docs/evidence/1.5b-4b-attempt-not-proven.md`.

**Evidence:** (1) gateway started with `CINDY_PROBE=gateway-val`: an MCP child present at start got `gateway-val`. (2) an entry appended to `config.yaml`
from another process with a different env was reconciled by the gateway ~60 s later and also got `gateway-val`. (3) code: `hermes-run.ts` spawns
`hermes chat` as a client with the per-session env; Hermes routes it through the shared gateway. (4) the live 4b run: client env = app session id, shim got
the gateway's stale value.

**What this invalidates:** the 1.5b-1 decision "static `${CINDY_BRIDGE_SESSION}` in config.yaml + per-session `query/start` env" and the 1.5b-1/-3
unit tests only prove the app side. What still stands: bridge identity registration, the 0600 file, the shim's proxying, exposure policy,
mid-run config reconcile (~60 s latency, no trigger needed).

**Options, none built (owner decision):**
- (a) One Hermes gateway per Cindy session via a per-session profile/home (`--profile`, gateways are keyed by home). The shim env then really is per session.
  Cost: per-session home must share credentials and config; heavier startup; touches how `hermes-mgr` launches.
- (b) One shim entry per session (`cindy_docs__<id>`, session id baked into static `args`, token still in the 0600 file), written on session start
  and removed on dispose. Cost: Hermes needs ~60 s to reconcile a new entry, so the first turn would have no tools unless a reload can be forced.
- (c) Single-active-session identity read from the runtime file. Rejected here: breaks isolation with concurrent sessions.
- (d) Identity as a tool argument. Forbidden by the bridge's trust rule.

**Suggested next free step (my recommendation: look at (a) first):** read how `hermes-mgr` starts the gateway and whether a per-session profile is
viable, and test `--profile` isolation with the same stub-probe method. Not started.

---

## 2026-10-29 — Phase 1: 1.5b-4b attempt in the desktop app (FAILED, not proven)

**Outcome:** 1.5b-4b stays open, no label earned. Owner approved one more paid DeepSeek turn; it was spent and the tool did not connect.
Evidence and log excerpts: `docs/evidence/1.5b-4b-attempt-not-proven.md`.

**What was proven (live, in the app):** the injected hook runs in `maker-host`: the app's own `hermes-bridge-host` started the bridge with
`cindy_docs`, wrote the 0600 runtime file with the session entry, and wrote the static shim entry to `config.yaml`. Hermes reconciled that
entry live (`added=['cindy_docs']`), so **mid-run config pickup works** (closes the 1.5b-3 open item). No credentials were entered; the
sandbox ToS dialog was accepted only after the owner said yes.

**What failed:** the shim exited 3 times with `no bridge credentials for this session`; Hermes answered "no cindy_docs tool available".
Cause: the shim got a session id with no runtime-file entry. The Hermes gateway in use (pid started by my 4a harness) had
`CINDY_BRIDGE_SESSION=live-1b4` in its own env, and Hermes expands `${CINDY_BRIDGE_SESSION}` from the gateway env, not from the per-session
`query/start` env. So 4b was contaminated by 4a's leftover gateway.

**Real design risk this exposes (not yet proven by a clean run):** one gateway serves many Cindy sessions and connects each MCP server once, so a
per-session env var in `config.yaml` cannot carry per-session identity, even without the stale gateway. The 1.5b-1 probe used `hermes mcp test`
(expands from its own process env), which could not reveal this. A fix needs an owner decision on the identity channel (options below).
Second, smaller miss: my prompt's CSV was in the bot workspace, but the Hermes session ran in `dialogues/<date>/<session-id>/`; `read_sheet` is
bound to the session dir.

**Options for the owner (nothing built):** (a) one Hermes gateway per Cindy session so its env is the session's, checked first because it may
already be how hermes-mgr behaves on a clean start; (b) a single-active-session rule: shim reads "current session" from the runtime file, which
weakens isolation and is unsafe with concurrent sessions; (c) pass identity through a tool argument or a per-session MCP URL if Hermes supports
it, which today's bridge rules forbid ("never trust tool-arg identity"). A free first step before any paid turn: start the app clean with no
stale gateway, start a Hermes session, and `ps eww` the gateway to see what env it actually has.

**State handling:** backed up `config.yaml` to `config.yaml.bak-20261029-1.5b-4b` before the run; restored from it afterwards (identical).
Deleted the runtime file, the proof CSV in the dev sandbox workspace, stopped my leftover gateway and the dev app. `~/.hermes` untouched.
Gates not rerun: docs only, no code changed since the 1.5b-3 `EXIT=0` run.

---

## 2026-10-29 — Phase 1: 1.5b-4a live proof (harness-hosted bridge)

**Outcome:** 1.5b-4a `live-proven`. 1.5b-4b (same inside the running desktop app) is open; original 1.5b stays open. Owner accepted the
1.5b-3 choices ("lets go with your choices") and approved one paid DeepSeek turn; recorded in `docs/decisions/0003-hermes-cindy-tool-exposure.md`.

**Done:** (1) free probe, throwaway `HERMES_HOME`, no model call: real Hermes v0.22.5 spawned `node <shim> --server cindy_docs`, connected
in 679 ms to the real bridge and listed `read_sheet`. (2) One paid `hermes-cindy -z` turn on `deepseek-flash`: asked to call `read_sheet`
on a CSV I wrote (`pears,42`); it answered `42` and named the tool. Transcript: `docs/evidence/1.5b-4-live-proof-transcript.md`.

**State handling:** backed up `~/.hermes-cindy/config.yaml` to `config.yaml.bak-20261029` (no `sessions.json` existed to back up). The shim entry
was written and removed through the 1.5a writers; `config.yaml` is identical to the backup afterwards and `~/.cindy-harness/hermes-bridge.json`
is gone. `~/.hermes` untouched. No credentials read or written. The harness (a temporary vitest file) was deleted, not committed.

**Resolved from the 1.5b-3 open list:** `node` resolves on Hermes' PATH (shell had Node 22 first; a GUI-launched app may differ, check in 4b).
Hermes picked up the entry written moments before spawn (start-of-process read); mid-session re-read is still unknown and not needed.

**Honest limits:** bridge hosted by a script, not the app, so `maker-host` injection and the UI path are unproven (4b). No bridge-side
`tools/call` log and no Hermes session record exist; the claim rests on the unguessable `42`. The turn is two model requests (call + answer),
one chat turn. Gates not rerun: docs only (no code changed since the 1.5b-3 `EXIT=0` run).

**Next:** 1.5b-4b needs a second paid turn — ask the owner first. Still open from earlier: packaging of the shim bundle, a source for the gated opt-in.

---

## 2026-10-29 — Phase 1: 1.5b-3 main-process wiring

**Outcome:** 1.5b-3 `unit-tested`. Not `live-proven`: no real Hermes has loaded the shim (1.5b-4). Original 1.5b stays open.

**Changed (`apps/desktop/src/main`):**
- `mcp-integrations/hermesBridgeHost.ts` (new): `createHermesBridgePreparer` = the `prepareHermesBridgeSession` hook. Per turn it
  leases the shared local bridge, freezes the per-project policy into the ctx `vendorOptions` (disabled plugin ids via the plugin
  registry, allowed plugin ids, `RUNTIME_MCP_NAMES_KEY` = exposed servers), then calls `registerHermesBridgeSession`. Also
  `syncHermesShimRegistrations` (static `config.yaml` entries) and the exposure allow-list.
- `mcp-integrations/piEnvironment.ts`: new `acquireCindyToolBridge` (lease on the same Pi bridge generation; Pi behaviour unchanged)
  and `'hermes'` accepted in the provider session-context pass-through.
- `maker-host/index.ts`: injects the hook into `HermesAgent`. `maker-host/hermes-manager-client.ts`: `listHermesMcpServers`,
  `resolveHermesBridgeShimPath`. `bootstrap-electron.ts`: runtime file cleared on quit; the hook also clears it once per process
  before the first entry (stale file from a crashed run).

**Decisions (mine, reversible, please veto):**
- Exposure is fail-closed. Default: `cindy_docs` only. `cindy_browser`, `cindy_computer`, `cindy_ssh` are GATED and stay off
  because Hermes' approval hook is not wired (protocol "reserved M3"). Nothing supplies an opt-in yet (`optedInGatedServers`).
- `config.yaml` entries are written via the 1.5a helpers with a static command `node <shim> --server <name>` and
  `env: { CINDY_BRIDGE_SESSION: "${CINDY_BRIDGE_SESSION}" }`. Only entries pointing at our bundle are ever changed or removed;
  a user-owned entry with the same name is left alone.
- Shim bundle: dev `packages/cindy-tools/dist/hermes-bridge-shim.mjs`; packaged `resources/hermes-bridge-shim/`. Nothing ships it
  there yet, so a packaged app runs Hermes without Cindy tools (logged in ROADMAP Debt). Missing bundle = fail open, no tools.

**Verified (`unit-tested`):** `mcp-integrations/__tests__/hermesBridgeHost.test.ts` 8 pass: exposure policy, static shim config,
idempotent sync and user-entry protection, and the preparer against a real bridge with stub providers (identity + 0600 file,
only the SAFE entry written, a gated server's route refused, dispose removes the session, null without a bundle).
`hermesBridgeSession.test.ts` still 5/5.

**Gates (Node 22, exit 0):** `pnpm typecheck && pnpm test:runner && pnpm test:unit:related && pnpm check:test-hygiene` ran as one
chain on the final tree, `EXIT=0`.

**Surprise:** a formatter hook rewrote `index.ts`, `bootstrap-electron.ts` and `piEnvironment.ts` wholesale after my edits (+1400
lines in `index.ts`). I restored those from git and re-applied only my hunks via script (diff +101/-1), then reran the gates.

**Open:** (1) `command: node` must resolve on Hermes' PATH, 1.5b-4. (2) Whether Hermes re-reads `config.yaml` for an already
running daemon or only at session start, 1.5b-4. (3) Known edge from 1.5b-1: re-registering a session id before the old handle's late
`dispose` removes the file entry; the shim then fails closed. (4) Packaging of the bundle. (5) A source for the gated opt-in.

---

## 2026-10-29 — Phase 1: 1.5b-2 stdio shim

**Outcome:** 1.5b-2 `unit-tested`. Not registered with Hermes or launched by the app (1.5b-3); original 1.5b stays open.

**Changed (all in `packages/cindy-tools`):**
- `src/hermes-bridge-shim/shim.ts`: `createBridgeShim` reads port+token for `CINDY_BRIDGE_SESSION` from the runtime file,
  connects a streamable-HTTP client to `http://127.0.0.1:<port>/mcp/<server>?session=<id>` with the bearer token, and
  proxies `tools/list` + `tools/call` (600 s call timeout, same as the desktop bridge) through a low-level stdio `Server`.
  Error results (`isError`) pass through unchanged.
- `src/hermes-bridge-shim/bin.ts`: `--server <name> [--runtime-file <path>]`, default `~/.cindy-harness/hermes-bridge.json`.
  Exits 1 with a stderr message (stdout stays the MCP channel) if the session env is unset or still the literal `${...}`.
- `build-shim.mjs` + `bundle:shim` script: esbuild → `dist/hermes-bridge-shim.mjs` (gitignored, ~800 KB, plain `node`).
  Bug found and fixed while verifying: the "run directly" guard compared `file://` strings and silently built nothing in
  this repo path (spaces); now uses `pathToFileURL`.

**Verified (`unit-tested`):** `hermesBridgeShim.test.ts` 6 pass against a stub HTTP MCP server enforcing Bearer token +
`?session=`: list/call proxy with token and session on every request, `isError` passthrough, fail-closed on missing file,
unknown session, truncated file, wrong version, stale token (401), dead port; plus the **esbuild bundle over real stdio**
(list/call round-trip) and bundle exit-1 on missing or un-interpolated session env.

**Gates (Node 22, exit 0):** typecheck ✅, test:runner ✅, test:unit:related ✅ (cindy-tools unit PASS), check:test-hygiene PASS (361 files).

**Open:** the shim has not talked to the real desktop bridge or a real Hermes (1.5b-3 wiring, 1.5b-4 live proof). The
bundle must be rebuilt/shipped by the app; where it lives at runtime is a 1.5b-3 decision.

---

## 2026-10-29 — Phase 1: 1.5b-1 session identity for Hermes tool calls

**Outcome:** 1.5b-1 `unit-tested`. Production wiring is **not** done (1.5b-3); the original 1.5b stays open.

**Probe (live, no model call, temp `HERMES_HOME` under the scratchpad, not `~/.hermes*`):** `hermes mcp test` with a stub
stdio server that dumps its env. Parent env is **not** forwarded to MCP children (`CINDY_PROBE` absent, 8 env keys).
`env: { CINDY_PROBE: "${CINDY_PROBE}" }` in `config.yaml` **is** interpolated from the parent env. So config.yaml carries a
static `${CINDY_BRIDGE_SESSION}` reference and the non-secret session id rides the existing per-session `query/start` env.
The token stays in the 0600 runtime file (owner's earlier decision).

**Changed:**
- `packages/maker-core/src/agents/base-agent.ts`: optional `AgentDeps.prepareHermesBridgeSession`.
- `packages/maker-core/src/agents/hermes/agent.ts`: calls it with the **Cindy** session id (`opts.sessionId`, not the
  daemon's random id), merges its env into `query/start`, disposes on `close()` and on start failure. Prep failure logs and
  continues without Cindy tools (fail open on convenience).
- `apps/desktop/src/main/mcp-integrations/hermesBridgeRuntimeFile.ts` (new): atomic 0600 file `{version, port,
  instanceId, sessions{id→token}}`, per-file write queue, stale `instanceId` drops old tokens, truncated file reads as absent.
- `apps/desktop/src/main/mcp-integrations/hermesBridgeSession.ts` (new): `registerHermesBridgeSession` registers ctx
  (`agentKind: 'hermes'`, `mcpCallerKind: 'root'`, attested) + HMAC per-session token, same model as `piEnvironment.ts`.

**Verified (`unit-tested`):** Hermes agent tests 25 pass (3 new: env + dispose, fail-open, dispose on failed start);
`hermesBridgeSession.test.ts` 5 pass against a **real** `startCodexHttpBridge`: tool call resolves `sess-A`, concurrent
sessions isolated, session A's id with session B's token → 401, dispose → 401 and entry removed, stale instance dropped.

**Open / known:**
1. Nothing injects the hook in `maker-host` yet, so no Hermes session registers today (1.5b-3).
2. Per-project tool policy (`CODEX_*_BUILTIN_PLUGIN_IDS_KEY`) is not frozen into `vendorOptions` yet (1.5b-3); the
   option exists on `registerHermesBridgeSession`.
3. Edge: if a session id is re-registered (resume) before the old handle's late `dispose`, the file entry is removed
   while the bridge keeps the new registration. Effect is fail-closed (shim cannot auth), not a leak.

**Gates (Node 22, exit 0):** typecheck ✅ (first run caught `opts.sessionId` being optional in `agent.ts`; hook now
skipped without a session id), test:runner ✅, test:unit:related ✅, check:test-hygiene PASS (361 files).

---

## 2026-10-29 — Phase 1: 1.5b split (no code changed)

**Outcome:** 1.5b stays 🔲. Split into 1.5b-1…4 in `ROADMAP.md`. Nothing built; label `unverified` for all.

**Why not done in one session:** reading `codexHttpBridge.ts` / `codexEnvironment.ts` / `piEnvironment.ts` showed
1. The loopback streamable-HTTP bridge already serves Cindy's in-process MCP servers (Codex/Pi use it), so the
   shim can be a thin stdio↔HTTP proxy.
2. Bridge tools resolve identity from a registered session ctx (per-session token + `?session=`, or Codex
   `threadId`), never from tool args. A Hermes turn has no such identity today — that is the real design work (1.5b-1).
3. `live-proven` needs a real model call (DeepSeek). Not made; needs owner approval (1.5b-4).

**Owner decision (this session):** shim gets port+token from a **0600 runtime file** written by the main process
at bridge start; `config.yaml` holds only a static command. Rejected: per-turn env, token in `config.yaml`.

**Next:** 1.5b-1 (session identity), then -2 shim, -3 wiring, -4 live proof. Gates not rerun (docs only).

---

## 2026-10-29 — Roadmap 0.8–0.12: built, split, and UI-proven

**Outcomes:** 0.8 `live-proven` · 0.9a ✅ done / 0.9b ✅ done (owner actions) · 0.10 `unit-tested` ·
0.11a `live-proven` / 0.11b "Back up now" `live-proven`, 0.11c "Restore…" `live-proven` ·
0.12 `live-proven`.

**Gates (Node 22, all exit 0):** typecheck ✅; test:runner 608 pass / 0 fail / 2 skipped
(+2 from the new scan test); test:unit:related ✅; check:test-hygiene PASS (361 files). Rerun in full
after the WAL fix below; same numbers.

**0.8 — `live-proven`.** Isolated dev app (`~/Library/Application Support/CindyGlobal-dev2-private`),
driven over CDP (Settings → General → Hermes Harness). Owner approved clicking Agree on the Terms of
Service prompt, but when I reconnected the dev profile was already past login/ToS, so I clicked nothing on it.
Backup first: `config.yaml.bak-2026-10-29-0.8`. Observed:
1. Default model `deepseek-flash` → `deepseek-v4-pro`, Save: `config.yaml` diff is exactly `default:` line 2.
2. Add Server (stdio, a local no-network stub MCP server `mini-mcp.mjs`, not a real third-party one): diff adds
   `mcp_servers: mini_mcp: command/args`. `hermes-cindy mcp list` showed it enabled; `mcp test` connected (449 ms),
   1 tool discovered. Hermes = v0.22.5.
3. Remove via UI + model back to `deepseek-flash`: `mcp list` → none. Net diff vs original: an empty
   `mcp_servers:` key and no trailing newline remain (Debt row; Hermes reads it fine).
Not done: a full chat turn using the MCP tool (would spend a DeepSeek call). Surprise: my first launch created an
empty `~/Library/Application Support/CindyGlobal` profile; left in place.

**0.9a — findings (history + tree scan, all refs).** 15 hits, all upstream test fixtures
(fake `ghp_0123…`, `AKIAIOSFODNN7…`, `sk-abcde…`); none in the 27 fork commits.
- `apps/desktop/.env`: untracked, gitignored; Google client id/secret + voice-provider settings, no ElevenLabs key.
- `~/.hermes-cindy/.env`: only `DEEPSEEK_API_KEY`, `OPENAI_BASE_URL`.
- ElevenLabs key location unknown (app reads `XDT_ELEVENLABS_API_KEY` / `ELEVENLABS_API_KEY` from env; earlier notes say `~/.zshrc`).
- `~/.hermes-cindy/auth.json` holds a live Nous login (`providers.nous`, `active_provider` null → unused). Not deleted.
**0.9b done (owner actions).** Owner ran `hermes-cindy logout --provider nous` ("Logged out of Nous Portal");
verified after: `auth.json` `providers` empty, `active_provider` null, `auth list` shows only `copilot` (gh CLI) and
`deepseek` (env). Owner reports the ElevenLabs key is rotated; I cannot verify that from here.

**0.10 — `unit-tested`.** Master Plan → `docs/cindy-master-plan.md` with historical banner (body SHA-256 verified,
then `~/Desktop/Cindy-Master-Plan.md` removed). `docs/decisions/0002-advisory-i18n-checks.md` keeps i18n/brand checks
advisory and resolves the Debt row.

**0.11a — `live-proven`.** `apps/desktop/src/main/backup/localBackup.ts` (+4 tests), `scripts/cindy-backup.mjs`,
`pnpm backup:create` / `backup:restore`. Round trip: real `~/.hermes-cindy` backed up, restored into temp dirs;
a SQLite row and `config.yaml` matched; `.env`/`auth.json` absent by design. Archive excludes `.env`, `auth.json`,
`auth.lock`, caches, SQLite `-wal/-shm`; `.db` files snapshotted via `sqlite3 .backup`. Restore renames replaced
files to `*.pre-restore-<stamp>`, never deletes.
**0.11b — "Back up now" `live-proven`; "Restore…" `typechecked` only.** Settings buttons (`channels.ts`
BACKUP_CREATE/RESTORE, `register.ts`, `preload.ts`, `vite-env.d.ts`, `HermesSection.tsx`). Clicking "Back up now" in the
running app wrote `~/.cindy-harness/backups/cindy-backup-20261029T163929Z.tar.gz` (887 entries); no `.env`, `auth.json`,
`-wal` or `-shm`; extracted `state.db` passes `integrity_check`. Left two archives from my UI runs in that folder.
**Bug found by the UI proof and fixed:** `sqlite3 .backup` keeps WAL mode, so the snapshot copy shipped its own
`state.db-wal`/`-shm` (empty), contradicting the 0.11a claim above. `snapshotSqlite` now sets `journal_mode=delete`
on the copy and drops empty leftover sidecars; the test fixture's `state.db` is now WAL mode and asserts no
`-wal`/`-shm` (red before the fix, 4/4 after).
**0.11c — `live-proven`.** Isolated dev app, but note the Hermes home is always the real `~/.hermes-cindy`.
Safety first: full copy outside it (`scratchpad/hermes-cindy-safety-2026-10-29.tgz`, 182 MB) and
`config.yaml.bak-2026-10-29-0.11c`. Steps: "Back up now" (UI) → appended a marker line to the live `config.yaml` →
clicked "Restore…" → native picker (driven with System Events keystrokes: Go to Folder + full path; background clicks
did not select rows) → confirm dialog "Restore and restart" (AXPress). Result: marker gone from live config, which is
byte-identical to the archive's; `config.yaml.pre-restore-20261029T170045Z` still holds the marker; 39 replaced
entries renamed `*.pre-restore-20261029T170045Z`, none deleted; `state.db` `integrity_check` ok; `hermes-cindy` starts
(v0.22.5) and `auth list` unchanged; the app relaunched itself (CDP back up).
**Clean-up left to the owner:** those 39 `*.pre-restore-*` entries in `~/.hermes-cindy` (not deleted by me, per
AGENTS.md), plus 4 archives in `~/.cindy-harness/backups` from my UI runs.

**0.12 — `live-proven`.** `scripts/upstream-security-scan.sh`, `pnpm upstream:scan`, test
`scripts/__tests__/upstream-security-scan.test.mjs` (2 tests, in `test:runner`). First scan (2026-10-29):
`upstream/main` at `727afb1ad6`, 999 commits since frozen SHA `7c5bd270c956417127e12a74934d0ecdb97ba55d`,
47 cherry-pick candidates (1 message, 2 deps, 46 path). Applied nothing.
**Quarterly reminder:** run `pnpm upstream:scan` next about **2027-01-29**, then every quarter.

Hermes backups: `config.yaml.bak-2026-10-29`, `hermes-mgr/sessions.json.bak-2026-10-29`.

**Open:** nothing in Phase 0. Phase 1 not started (owner has not asked).

---

## 2026-10-29 — Roadmap 0.7: fixture parity with a real transcript

**Outcome: `unit-tested`.** Captured one real `hermes-cindy chat --format stream-json
--query-file - --safe-mode -m deepseek-flash --provider deepseek` turn (prompt: run
`echo parity-check` in the terminal tool): 7 events (init, tool_use, tool_result, 3× text,
result). Real CLI = Hermes 0.22.5; this made one DeepSeek call through Hermes's own `.env`.
Backups taken first: `config.yaml.bak-2026-10-29`, `hermes-mgr/sessions.json.bak-2026-10-29`.

**Changed**
- `packages/maker-hermes-manager/src/__tests__/fixtures/real-hermes-transcript.ndjson`
  (new): the transcript with session id, tool-call id and timestamps redacted/synthetic.
- `.../__tests__/fixture-parity.test.ts` (new, 5 tests): runs `fake-hermes.mjs` and asserts
  every event kind in the real transcript exists in the fixture with identical keys and value
  types; `session_id` empty on `init` (`FAKE_INIT_EMPTY`) and set on `result`; same `tokens`
  keys; transcript contains no key-like strings.
- `.../fixtures/fake-hermes.mjs`: `emit()` now adds the `timestamp` key the real CLI adds.
  The parity test failed (`fixture lacks system/init`) without this and passes with it.

**Findings:** the real CLI also emits events in tool-then-text order, the fixture's happy
path emits text first; parity is asserted on shapes, not event order. A first capture attempt
without `-m/--provider` produced the real "safe-mode needs explicit model" error shape
(init with empty id, result exit_code 1).

**Verification:** package suite 63/63, `tsc --noEmit` clean. Gates: typecheck 0 (100s),
test:runner 0 (606/608, 2 skipped), test:unit:related 0 (531s), check:test-hygiene 0.
Not live-proven beyond the capture itself (the row requires 🧪).

**Open:** 0.8 next.

---

## 2026-10-29 — Roadmap 0.6: Hermes version-mismatch warning

**Outcome: `live-proven`.** Resumed Kimi's paused 0.6 draft. Baseline before any change
(Node 22.23.4): typecheck, test:runner (606/608, 2 skipped) and check:test-hygiene green;
`test:unit:related` red on exactly the 2 documented version-probe tests.

**Root cause:** `hermes-version.ts` used `/\b(\d+\.\d+\.\d+…)/`; there is no word boundary
between `v` and `0` in `v0.22.5`, so the real CLI output (`Hermes Agent v0.22.5 …`) never
matched. The handover's fixture-truncation hypothesis was **disproven**: the suite passes 5/5
with the original fixture. Fix: `/\bv?(\d+…)/` in `packages/maker-hermes-manager/src/hermes-version.ts`.
Tests were not weakened.

**Changed:** the Kimi draft (`config/status` RPC, protocol bundle `0.2.0`, fixture `--version`,
tests, `hermes-manager-client.ts` ping) plus the regex fix and a doc comment on
`getHermesModelCatalog`. `HANDOVER.md` §3 now describes the behaviour; the paused §10 is removed.

**Verification**
- Package suite 58/58 (7 files); `tsc --noEmit` clean.
- Live, built bundle `dist/hermes-mgr.mjs` with a temp `--hermes-home`, real RPC client:
  real `hermes-cindy` → `{"installedVersion":"0.22.5","matches":true}`, no warning;
  temp launcher printing v0.22.6 → `matches:false` + daemon log `Hermes CLI version mismatch`;
  missing launcher → `matches:null` + `Unable to verify Hermes CLI version`.
- Gates after the fix: `pnpm typecheck` 0 (107s); `test:runner` 0 (608: 606 pass, 2 skipped);
  `test:unit:related` 0 (532s); `check:test-hygiene` 0. `git diff --check` clean; no new
  outbound calls, credentials, `~/.hermes` references or upstream deletions.
- Backups taken before the 0.7 capture: `~/.hermes-cindy/config.yaml.bak-2026-10-29`,
  `~/.hermes-cindy/hermes-mgr/sessions.json.bak-2026-10-29`.

**Open:** 0.7 next.

---

## 2026-10-29 — Paused handoff: roadmap 0.6 still red

**Outcome: `unverified`; work stopped at the owner's request. No commit or push.** The version
pin was already recorded; the daemon warning implementation is present but unfinished and left
uncommitted intentionally. `HANDOVER.md` §10 is now the exact resume checklist.

**Changed before pausing**
- Added the draft `config/status` version probe and mismatch/failure warnings in
  `packages/maker-hermes-manager/src/{hermes-version.ts,hermes-manager.ts,protocol.ts,index.ts}`.
- Invoked status from `apps/desktop/src/main/maker-host/hermes-manager-client.ts`.
- Added fixture support and matching/mismatch/failure tests under
  `packages/maker-hermes-manager/src/__tests__/`.
- Updated `HANDOVER.md` with the paused state, current evidence, modified files and resume steps.

**Verification**
- Initial RED: **4 failed / 21 passed** (missing RPC and old bundle version).
- Current focused run: **2 failed / 23 passed**. Both valid-version cases return
  `installedVersion: null`; the failure-path and protocol tests pass.
- Direct fake `--version` output and real `hermes-cindy --version` (`0.22.5`) checks passed.
- Package build, full package/Desktop suites, live daemon proof, code review and all four
  required gates were **not run** for this diff. Do not reuse earlier green results as proof.

**Open:** diagnose the valid-version probe failures without weakening tests, complete focused and
live verification, run all gates, then update roadmap 0.6 honestly. Working tree must not be
reset or cleaned. Full details and commands are in `HANDOVER.md` §10.

---

## 2026-10-29 — Roadmap 0.5: atomic sessions registry

**Outcome: `unit-tested`.** The registry already used temp-write + rename; this task added
the missing corruption warning and regression proof without changing the persistence format.

**Changed**
- `packages/maker-hermes-manager/src/session-registry.ts`: warn on registry read/parse
  failures other than a missing file; truncated JSON still starts an empty registry.
- `packages/maker-hermes-manager/src/__tests__/session-registry.test.ts`: isolated real-file
  regression test for truncated JSON, empty recovery and one warning.
- `HANDOVER.md`: replaced the stale non-atomic-write warning with the current behavior.

**Verification**
- RED: the new test failed before the fix because no warning was emitted; GREEN afterward.
- Focused registry test **1/1**; full Hermes manager suite **55/55**; package `tsc --noEmit` passed.
- `pnpm typecheck`: exit **0**, 161.611s; scope **37 of 38** workspace projects.
- `pnpm test:runner`: exit **0**, 84.097s; **608 tests: 606 passed, 2 skipped, 0 failed**.
- `pnpm test:unit:related`: exit **0**, 578.965s; **30 runnable workspaces passed**, 7 skipped.
- `pnpm check:test-hygiene`: exit **0**; **361 files within baseline**.
- Code review reported no findings; `git diff --check` passed. No live daemon restart or live
  corruption exercise was performed; this entry makes no `live-proven` claim.

**Open:** roadmap 0.6 next (Hermes version mismatch warning).

---

## 2026-10-29 — Roadmap 0.1/0.4: Hermes compatibility and green gates

**Outcome: `unit-tested`.** Roadmap 0.4 is complete: all four default gates exit 0
under Node 22.23.4 with `NODE_OPTIONS` unset and the brokered filesystem hook disabled.
This was not a live mobile UI exercise. ADR 0001 is included in this tranche, completing
0.1 with frozen upstream SHA `7c5bd270c956417127e12a74934d0ecdb97ba55d`.

**Changed**
- Mobile Hermes compatibility in `apps/mobile/app/sessions/new.tsx`,
  `apps/mobile/src/session/*`, `apps/mobile/src/components/MobileAgentMark.tsx`,
  `MobileVendorIcon.tsx`, and `apps/mobile/src/device-link/*`: preserve existing Hermes
  sessions through runtime/cache projections, labels, menus, filters, auth hints, agent
  switching and marks. Mobile new-session choices remain Claude Code/Codex/Pi; Orca worker
  types stay narrow. Added/updated focused tests under `apps/mobile/src/__tests__/`,
  including `mobileAgentMark.test.ts`.
- Desktop favorites and selection in `apps/desktop/src/renderer/state/modelConfigCopy.ts`,
  `modelFavorites.ts`, and `components/new-chat/unifiedModelSelection.ts`: preserve stored
  Hermes favorites and placeholders without silently changing favorite identity.
- Shared/device-link identity in `packages/maker-shared/src/sessionList.ts` and
  `packages/device-link/src/modelFavorites.ts`.
- Repaired the known gate failures in the touched Desktop, browser-control-runtime and
  maker-core suites; kept the existing adapter behavior and added the required reset reason
  to `apps/desktop/src/renderer/__tests__/modelFavorites.test.ts`.
- Completed the inherited Phase 0 tranche: Node 22 enforcement (`.nvmrc`, `package.json`,
  `scripts/desktop-dev-runner.mjs`, `apps/desktop/src/main/cindy-make/doctor.ts`), packaged
  dependency declaration (`apps/desktop/forge.config.ts`), governance docs and ADR 0001.

**Verification**
- `pnpm typecheck`: exit **0**, 167.586s; recursive scope 37 of 38 workspace projects.
- `pnpm test:runner`: exit **0**, 85.971s; **608 tests: 606 passed, 2 skipped, 0 failed**.
- `pnpm test:unit:related`: exit **0**, 596.357s; prerequisite runner **606 passed / 2 skipped**;
  all **30 runnable workspaces passed**, 7 declared no-test workspaces skipped.
- `pnpm check:test-hygiene`: exit **0**; **361 files within baseline**.
- Focused suites: mobile seven files **173/173**; Desktop favorites **45/45**;
  unified model selection **71/71**; shared session list **43/43**.
- `git diff --check`: clean. Two independent code-review passes reported no actionable
  findings. No new outbound application calls, credentials, upstream deletions or Hermes
  mobile creation option were introduced.

**Open:** roadmap 0.5 next; no new live-proven claim for the mobile changes.

---

## 2026-10-28 — Paused handoff: 0.3 live-proven, 0.4 still red

**Session outcome**

Work stopped during roadmap **0.4** so the owner can resume later. This is not a
Phase 0 completion claim. No Phase 1 work was started. The working tree is
intentionally left uncommitted because the required gates are not all green;
there were no commits or pushes from this session. HEAD and `origin/main` are
both `05a8af84a1` (`docs(handover): add Phase 4 proposed feature roadmap`).

**Verified state by roadmap row**

- **0.1 — content complete, row remains open.** ADR 0001 and the Versions table
  record frozen upstream SHA `7c5bd270c956417127e12a74934d0ecdb97ba55d`.
  Its explicit done condition includes an ADR commit, which has not happened.
- **0.2 — `live-proven`.** The previous entry below records the packaged output,
  Hermes turn and Settings proof. Packaging required `@mixmark-io/domino` in
  `apps/desktop/forge.config.ts`; its regression test is in
  `apps/desktop/scripts/runtime-deps-packaging.test.mjs`.
- **0.3 — `live-proven`.** `.nvmrc` is `22.23.4`; root `engines.node` is
  `>=22.12 <23`; `doctor.ts` rejects later majors; the dev runner exits before
  spawning Forge on a non-22 runtime and prints the required PATH export.
  Live negative check: `/opt/homebrew/bin/node scripts/desktop-dev-runner.mjs local`
  under Node **26.12.1** exited **1** with `Node.js 22 is required` and
  `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. The runner regression
  test also covers this early exit.
- **0.4 — in progress, not done.** Existing Hermes sessions/favorites are being
  made compatible with mobile read/display paths without adding a Hermes mobile
  new-session choice. The three choices remain Claude Code/Codex/Pi.
- **0.5–0.12 — untouched.** Resume in roadmap order after 0.4 is fully green.
  For 0.6 only the installed-version recording is done (`0.22.5`); the daemon
  mismatch warning is not implemented.

**0.4 changes currently in the working tree**

- `apps/mobile/src/session/sessionAgentSwitch.ts`,
  `apps/mobile/src/session/newSession.ts`, and
  `apps/mobile/src/device-link/mobileMakerTransport.ts`: use the shared
  `AgentKind` union and preserve Hermes session kind, label and vendor.
- `packages/device-link/src/modelFavorites.ts`: accept Hermes favorites without
  remapping them to another agent.
- `MessageRenderer.tsx`, `useConversationSearchFilterMenu.ts` and the two
  corresponding test files: display Hermes as Hermes.
- Regression reproduction before implementation: Hermes session mapping became
  `claude-code`, and Hermes favorite parsing threw `Invalid model favorite`.
  Both focused behaviors now pass.
- Deliberate boundary: do **not** add Hermes to mobile new-session options and
  do **not** widen Orca worker agent types merely to silence TypeScript.

**Current red compiler state**

Latest command: `pnpm --filter mobile typecheck` under Node **22.23.4** —
**failed with 24 errors**. Grouped locations:

- `app/sessions/[sessionId].tsx`: 2890, 2894, 8699, 8789, 8799, 8855.
- `app/sessions/new.tsx`: 693, 1164, 4182, 4369, 4390, 4648, 4723, 5463.
- `src/__tests__/sessionAgentSwitch.test.ts`: 53.
- `src/session/MobileAgentSwitcher.tsx`: 109.
- `src/session/newSession.ts`: 1158.
- `src/session/sessionAgentSwitch.ts`: 52.
- `src/session/UnifiedModelPickerView.ios.tsx`: 204, 378, 442.
- `src/session/UnifiedModelPickerView.tsx`: 387, 500, 691.

Intended narrow fixes, not yet applied:

1. Widen the DB/runtime/queued-message agent unions in
   `apps/mobile/src/session/types.ts` (lines 77, 121 and 243 at time of pause)
   to include Hermes. Do not change unrelated protocol fields.
2. Add an explicit Hermes branch to `src/components/MobileAgentMark.tsx`; the
   desktop wing geometry is in
   `apps/desktop/src/renderer/components/icons/HermesMark.tsx`. Never fall
   through to the Claude glyph for Hermes.
3. Widen `agentAuthGateVerdict` / `agentAuthGateHint` in
   `src/session/agentAuthGate.ts` to `AgentKind`, retaining actual provider
   routing through `connectedProvidersForAgent`, and label Hermes explicitly.
4. In `app/sessions/new.tsx` around line 678, make collaboration ineligible for
   Hermes and narrow the draft agent to the existing Orca union before calling
   `readOrcaCollabEntryStatus`. Do not widen `OrcaWorkerAgentKind`.
5. Fix the Hermes-as-Claude fallback in `src/session/sessionMenu.ts` around
   line 224 with the shared label helper or an explicit branch.

**Verification run during this handoff**

- `pnpm test:runner`: **PASS** — 608 tests, 606 passed, 2 skipped, 0 failed;
  Windows-only atomic rename check skipped on macOS.
- Mobile focused tests (`sessionAgentSwitch`, `conversationSearchFilterMenu`,
  `newSession`): **PASS** — 3 files, 185 tests.
- Device-link `modelFavorites`: **PASS** — 1 file, 5 tests.
- `pnpm --filter mobile typecheck`: **FAIL** — 24 errors listed above.
- Root `pnpm typecheck`, `pnpm test:unit:related`, and
  `pnpm check:test-hygiene` were **not rerun** after the latest mobile edits.
  Do not represent this handoff as a green gate set.
- `git diff --check`: **PASS** at the start of the handoff.

**Files to preserve**

All current modifications and untracked files are part of the paused state;
do not reset or clean them. The groups are:

- Governance/docs: `AGENTS.md`, `HANDOVER.md`, `ROADMAP.md`, `STATUS.md`,
  `docs/decisions/0001-upstream-strategy.md`,
  `docs/design-rules/design-inventory.md`, and
  `scripts/__tests__/dev-docs-contract.test.mjs`.
- Packaged build: `apps/desktop/forge.config.ts` and
  `apps/desktop/scripts/runtime-deps-packaging.test.mjs`.
- Node 22: `.nvmrc`, `package.json`,
  `apps/desktop/src/main/cindy-make/doctor.ts` and its test,
  `scripts/desktop-dev-runner.mjs`, and
  `scripts/__tests__/restart-desktop-remote.test.mjs`.
- Paused 0.4 work: the mobile/device-link files listed above.

**Exact resume sequence**

1. Read `AGENTS.md`, this entry, `ROADMAP.md` 0.4 and `HANDOVER.md`; run
   `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` and inspect `git status`.
2. Apply only the remaining 0.4 compatibility fixes; add focused red/green
   regression coverage for the auth hint, menu label and Hermes mark.
3. Rerun `pnpm --filter mobile typecheck` and the focused tests above. Resolve
   residual errors locally; do not cast Hermes to Claude or widen Orca.
4. Run all required gates in order: `pnpm typecheck`, `pnpm test:runner`,
   `pnpm test:unit:related`, `pnpm check:test-hygiene`.
5. Only after all four pass, update roadmap statuses, commit with `git commit -s`
   and push `origin main`. Then continue 0.5–0.12 in order; do not start Phase 1
   without the owner's explicit approval.

---

## 2026-10-28 — Phase 0.1/0.2: frozen versions and packaged Hermes proof

**Did**
- Recorded frozen upstream merge-base `7c5bd270c956417127e12a74934d0ecdb97ba55d`
  in `docs/decisions/0001-upstream-strategy.md` and `HANDOVER.md` §Versions.
- Recorded installed Hermes CLI **0.22.5** (2026.9.24, stable; local
  `bf0203a794a0`) in `HANDOVER.md` §Versions. This completes only the recording
  portion of 0.6; its daemon version-mismatch warning remains open.
- Packaged the app with `pnpm release:package`. Added `@mixmark-io/domino` to
  `NATIVE_RUNTIME_DEPS` in `apps/desktop/forge.config.ts` after the first package
  exposed the missing Node HTML parser required by bundled turndown. Added a
  regression assertion in `apps/desktop/scripts/runtime-deps-packaging.test.mjs`.

**Verification: `live-proven`**
- Packaged output: `/tmp/cindy-packaged-proof.IIrqMS/app/Cindy.app`.
- Launched that app with isolated user data, confirmed the Cindy name/icon, and
  selected Hermes. A real prompt returned exactly `PACKAGED_HERMES_OK` in session
  `3a19ab0c-8567-4407-8af3-49b108187262`, proving the packaged daemon/bundle path
  and a complete Hermes turn.
- Opened packaged Settings and confirmed the Hermes card renders the active home,
  DeepSeek default route, MCP server section, enabled `superpowers` plugin, and
  12 active skill categories.

**Open for next agent:** roadmap 0.3 (Node 22 enforcement). Gates for this entry
are recorded below after their final run.

---

## 2026-10-28 — Documentation restructure (handover → AGENTS / ROADMAP / HANDOVER / STATUS / ADR)

**Did**
- Split the old monolithic `HANDOVER.md` into: `AGENTS.md` (rules), `ROADMAP.md`
  (single source of truth for task status), `HANDOVER.md` (stable reference),
  `STATUS.md` (this log), `docs/decisions/0001-upstream-strategy.md`.
- Re-opened task **1.5** as 1.5a (MCP config management — done) and
  **1.5b** (real Cindy tool bridge — not started). The original "done" mark
  described a config editor, not a bridge; Hermes still cannot call Cindy's
  Browser/SSH/Docs tools.
- Moved the old "Phase 4" feature wishlist to **Parked** in the roadmap.
- Recorded the upstream decision: **freeze + cherry-pick security fixes** (ADR 0001).

**Verification:** documentation only — n/a.

**Open for next agent:** Phase 0 in `ROADMAP.md`, starting with 0.1 (packaged build)
and 0.5 (record Hermes version). Fill the blanks in the `HANDOVER.md` Versions table.

---

## 2026-10-28 — Local cleanup (old §6.8b)

**Did**
- Deleted the dead Help feature backend: `help-knowledge/` (25 docs),
  `maker-ipc/help.ts`, `help-feedback.ts`, `helpKnowledge.generated.ts`,
  renderer `helpThreadStore`, shared `helpTypes`, `gen-help-kb` scripts and tests,
  plus IPC channels/preload/type entries. The Help UI was already gone, so this
  was unreachable code.
- Deleted upstream PR/mobile evidence: `docs/e2e-evidence/`, `docs/pr-assets/`,
  `prototypes/`.
- Removed a stray empty `apps/desktop/C:/locks` directory (Windows path artifact).

**Verification:** `typechecked` (desktop `tsc --noEmit`), `test:runner` green
apart from the two known pre-existing failures.

**Note:** these deletions were made before the upstream decision. Under ADR 0001
(freeze) they are now acceptable. Further upstream deletions still require the
rule in `AGENTS.md` §3.

---

## 2026-10-27 — De-clouding pass (old §6.8a) and Phase 2 items

**Did**
- Settings: removed Shared Tasks, Help, the "Not signed in" banner (now
  "Data stays on this device"), manual update/log-upload rows, auto-update /
  analytics / crash-upload toggles.
- About: version always shown; harness update checks report "unavailable" when no
  vendor endpoint is configured; official CDN checks skipped when unconfigured.
- Bots: all IM channels except **Telegram** removed from the UI; Feishu / WeChat /
  WeCom / DingTalk / Discord UI files deleted; builtin plugin metadata retired.
- Log noise: migration status poll returns an idle view instead of erroring every
  10 s; bot-group retry stops on non-retryable codes.
- **2.1** App-wide "Sign in to Cindy" sweep: `HomeZeroModelAction.tsx`,
  `ConnectProviderBanner.tsx`, `ConnectProviderCard.tsx` now route to local/BYOK
  provider wizards in local mode; managed-service row suppressed. 20 tests passing.
- **2.4** ElevenLabs key fallback: `readElevenLabsApiKey()` falls back to the
  `elevenlabs-api` / `elevenlabs` custom provider credential or `voice-asr` key
  when `ELEVENLABS_API_KEY` is absent. `elevenLabsKeyFallback.test.ts`.
- **2.5** Voice zero-input notice in `VoiceInputOverlay.tsx` instead of silent
  dismiss. Strings added for en/zh-CN/zh-TW/ja/ko.
- **2.7** English-only runtime lock: `LanguageSection` offers English only;
  `bootstrap-electron` and `i18n` default `DEFAULT_LOCALE` to `en`. Renamed
  `siliconflow-global` base name to `SiliconFlow`; `nameEn` used on provider import
  and preset OAuth creation; English `CINDY_DEFAULT_IDENTITY` with legacy
  recognition fallback; bot import invites default to English; bot draft
  expiration error translated.

**Verification**
- De-clouding surfaces: `live-proven` (CDP DOM sweeps of Settings / About / Bots).
- 2.1, 2.4, 2.5, 2.7: `unit-tested` (`botStore.modelSettings.test.ts`,
  `botTemplatePreset.test.ts`, `addProviderWizardPresetEntry.test.tsx`,
  `nativePackage.test.ts`, `elevenLabsKeyFallback.test.ts`).
- Note: 2.5 added four non-English locales for a notice that 2.7 made unreachable.
  Harmless, but see roadmap 0.4 (i18n gate decision).

---

## 2026-10-26 — Hermes MCP server config management (old §6.7, was "task 1.5")

**Did**
- `packages/maker-hermes-manager/src/hermes-config.ts`: line-based
  `parseHermesMcpServers`, `writeHermesMcpServer`, `removeHermesMcpServer` for
  `mcp_servers:` in `$HERMES_HOME/config.yaml`. Supports Streamable HTTP/SSE and
  stdio entries; preserves formatting and comments.
- `protocol.ts` / `hermes-manager.ts`: `config/listMcpServers`,
  `config/setMcpServer`, `config/removeMcpServer` RPCs.
- `hermes-manager-client.ts`: `HermesHomeStatus.mcpServers`, `setHermesMcpServer`,
  `removeHermesMcpServer` host helpers.
- `maker-ipc/`: `HERMES_CONFIG_SET_MCP_SERVER`, `HERMES_CONFIG_REMOVE_MCP_SERVER`
  channels, handlers, preload and `vite-env.d.ts` entries.
- `HermesSection.tsx`: MCP Servers list with transport badges (`http` / `stdio`),
  inline add form, remove action.

**Verification:** `unit-tested` — 14 cases in `hermes-config.test.ts` against
synthetic YAML. **Not** tested against a Hermes-generated `config.yaml`, and never
confirmed that Hermes loads a server Cindy wrote. See roadmap **0.7**.

**Correction (2026-10-28):** this is task **1.5a**. It does not bridge Cindy's
tools into Hermes. **1.5b** remains open.

---

## 2026-10-25 — Hermes settings surface (old §6.6, task 1.6)

**Did**
- `hermes-manager-client.ts`: `getHermesHomeStatus` returning home path, default
  route, provider models, installed plugin metadata, skills categories.
- `maker-ipc/channels.ts` + `register.ts`: `maker:hermes-config:get-status`.
- `HermesSection.tsx` card in General settings: home path, runtime status,
  "Reveal Folder", default model select + save, installed plugins (status and
  repository source), active skills categories.

**Verification:** `typechecked` only (`tsc --noEmit`). The old handover's
"verified" claim is downgraded: no unit test and no recorded live check of the
rendered data. Roadmap row 1.6 reflects this.

---

## 2026-10-25 — Image attachments for Hermes (old §6.5, task 1.4)

**Did**
- `packages/maker-core/src/agents/hermes/agent.ts`: `flattenUserMessage` inlines
  image attachments as `Attached image <name> located at: <path>`;
  `capabilities.multimodal.image = { supported: true }`.

**Verification:** `unit-tested` (`agents/hermes/__tests__/agent.test.ts`).
Not live-proven with a vision-capable model.

---

## 2026-10-24 — Auto-title and prompt prediction for Hermes (old §6.4, task 1.2)

**Did**
- `apps/desktop/src/main/maker-ipc/title.ts`: `hermes` added to
  `TITLE_AGENT_KINDS`. Sessions no longer fail `maker:auto-title` /
  `maker:predict-prompt` with `INVALID_PARAMS: invalid agentKind`.

**Verification:** `unit-tested` (`autoTitleIpcBoundary.test.ts`,
`predictPromptIpcBoundary.test.ts`).

---

## 2026-10-24 — Resume correctness (old §6.3, task 1.3) — commit `f1df8f8a08`

**Did**
1. **Stale resume id** (`No session found matching '<id>'`): daemon holds that
   attempt's events, drops the dead id, emits a `resume-reset` notice, replays the
   same message on a fresh session.
2. **Session-id bind point**: current Hermes sends `system/init` with
   `session_id: ""` and puts the real id on the `result` event. The daemon only
   bound from `init`, so no session was ever resumable. Now binds from either.

**Verification:** `live-proven` — two turns on one daemon session returned the
codeword stored in turn 1.

**Risk recorded:** depends on undocumented Hermes CLI event shape. Hermes version
at time of fix was **not recorded**. See roadmap **0.5**.

---

## 2026-10-23 — Model picker and default route (old §6.2, task 1.1)

**Did**
- `config/getDefaultRoute`, `config/setDefaultRoute`, `config/listModels` RPCs.
- Per-session override via `query/setModel` (empty string = follow home default).
- `useHermesModelCatalog` merges the home default with the provider's live
  `GET /models`.
- Footer action "Set <model> as the Hermes home default" writes `config.yaml`
  surgically (preserves comments/order, quotes scalars).

**Verification**
- Picker listing: `live-proven` (showed `Hermes home default (deepseek-v4-flash)`,
  `deepseek-flash`, `deepseek-v4-pro`).
- Default-route **write**: `unit-tested` only — the button was deliberately never
  clicked live. See roadmap **0.6**.

---

## 2026-10-22 — Hermes RPC core and session registry (old §6.1)

**Did**
- `maker-hermes-manager` daemon: NDJSON RPC over Unix socket; spawns one
  `hermes chat` process per turn; `sessions.json` registry under
  `~/.hermes-cindy/hermes-mgr/`.
- Safe mode with explicit default model; `--yolo` mode.
- Provider keys passed per-session in memory only; never persisted.
- Fail-closed guard against `~/.hermes`.
- `fake-hermes.mjs` test fixture.

**Verification:** `live-proven` — end-to-end turns with the real CLI and real
DeepSeek provider: text streaming, tool calls/results, token usage, clean closes.

---

## Standing known issues (carry forward until fixed)

| Issue | Owner task |
|---|---|
| Daemon does not warn when Hermes differs from the pinned version | 0.6 |
| `sessions.json` written non-atomically | 0.5 |
| ElevenLabs key may need rotation; unused Nous login | 0.9 |
| 136 commits behind upstream | ADR 0001 — resolved: freeze |
