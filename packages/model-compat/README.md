# Cindy model compatibility

This package owns provider protocol corrections shared by Cindy's existing transports. It combines
pinned OpenCodex source with Cindy's established fixes. It does not own accounts, model catalogs,
pricing, routing, SDK installation, configuration export, or credential discovery.

Upstream: [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex), commit
`c155cc7923dbc0102e27d79185505a85d4357b2c` (MIT; see `LICENSE.opencodex`).
`UPSTREAM.json` records the original and ported SHA-256 for every imported module and test.
`upstream.patch` records the reviewed changes to those modules. Pure helpers extracted from larger
adapters are listed by symbol, with a reproducible import prefix, in the same manifest.

## Entry points and ownership

| Existing Cindy consumer | Shared behavior | Behavior that remains with the consumer |
| --- | --- | --- |
| Codex Responses proxy | Request-owned custom/function and namespace conversion; tool discovery; reverse JSON/SSE conversion; provider parameters and schemas; existing history/input repairs | Effective route resolution, OAuth, model rewriting, Guardian restrictions, server tool injection, recovery lifecycle |
| Codex Responses → Chat bridge | Existing Code Mode schema/context, upstream provider capabilities, final Chat parameter normalization | Responses/Chat protocol translation and stream transport |
| Codex Responses → Anthropic bridge | Existing bridge and shared proxy repairs remain in place | Anthropic serializer, auth and response translation |
| Claude Code Messages proxy | Existing empty thinking/text, duplicate tool IDs, tool-result adjacency, provider-field and image-history repairs now live here | Session routing and recovery decision wiring |
| Claude Code Messages → Responses bridge | Shared strict-schema predicate; final provider normalization (including xAI subscription schema) | Messages/Responses translation; no Codex custom/namespace conversion |
| Pi native SDK and native subscription forwarding | Existing shared proxy repairs continue through their existing callers | Pi SDK's native serializers, native forwarding and tool contract; no new Codex dialect adapter |
| Mobile / remote UI | Uses the selected Desktop execution path | No second model transport is introduced on the UI client |

`harness`, `protocol`, `upstreamBase`, and the **actual wire model ID** describe a request, not a
new user setting. Merely setting `harness: 'pi'` in a pure helper test does not mean the Pi host
calls that helper. Pi's existing native forwarding tests exercise its actual entry points.

Namespace support and custom-tool support are independent. Codex conversion is selected using
Cindy's existing `supportsResponsesCustomTools` route capability. Namespace lowering additionally
requires a known target endpoint or Cindy's explicit XD model dialect. A model named `xai/...`
on an unrelated custom gateway does not opt that gateway into xAI normalization.

## Consolidated implementation

| Previous location | Single implementation owner |
| --- | --- |
| `anthropic-compat-proxy/src/transform.ts` | `src/cindy/proxy/transform.ts` |
| Proxy headers / thread-strip controller / vLLM / xAI ModelInput | `src/cindy/proxy/` |
| `responses-chat-bridge` custom adapter / tool context / null-array repair / shared types | `src/cindy/` |
| `anthropic-responses-bridge/src/strict-schema.ts` | `src/cindy/strict-schema.ts` |
| Codex host xAI tool sanitizer and tool-choice reconciliation | `src/providers/xai.ts` |
| Codex host Seed tool/input/reasoning corrections | `src/providers/seed.ts` |
| Codex host strict gateway tool history | `src/providers/history.ts` |
| Codex host DeepSeek legacy custom-tool fallback | `src/providers/deepseek.ts` |
| Codex host MiniMax Responses reasoning correction | `src/providers/minimax.ts` |

The remote SSH companion build tracks this package as a source dependency, so a compatibility-only
sync invalidates its cached bundle. Its single-file artifact embeds the OpenCodex MIT notice.

Old module paths are explicit re-export facades for existing consumers and tests, not independent
implementations. Protocol bridges remain bridges; they are not replaced with OpenCodex's server,
configuration files, or account manager. Cindy's collision-safe `exec` conversion is retained ahead
of upstream's generic conversion, with reverse transforms applied in reverse order.

## Imported provider policy

`src/upstream-profiles.json` contains compatibility declarations extracted statically from all
92 entries in the pinned upstream registry. No upstream registry code or credential code is
executed. Matching requires exact URL origin and path boundaries. Equal endpoint identities that
cannot be distinguished are left unresolved, rather than choosing an account/provider by name.
Unclassified gateways retain Cindy's existing route-specific rules; they do not inherit every
patch for models with a familiar name.

Active mappings include unsupported sampling fields; Chat reasoning wire mappings/budget/toggle;
reasoning replay/placeholder and automatic-tool-choice capabilities; Moonshot function schemas;
Responses verbosity/reasoning policy; DeepSeek adjacency, empty result annotation, search history
query fields and item IDs; xAI Responses web-search fields and subscription-only function schemas;
OpenCode Go additional-tool declarations; and Codex custom/namespace/tool-search round trips.

The imported declarations also retain upstream transport metadata (`modelWireDefaults`,
`responsesPath`, `googleMode`, `authKind`) and policies owned by OpenCodex's transport
(`modelResponsesTerminalRepair`, `openaiChatEofTolerance`, `promptCacheKey`,
`escapeBuiltinToolNames`). They are **not automatically activated** in Cindy. In particular:

- `modelWireDefaults` does not change Cindy's selected wire protocol or model catalog.
- Native Pi Gemini/Anthropic SDKs are not replaced with another serializer.
- The upstream Gemini sanitizer, snapshot repair, field-backfill and undeclared-tool guard are
  available source modules; importing them alone does not enable them for every transport.
- OpenCodex's Cursor/Kiro/CodeBuddy/Qoder execution backends require their own authentication and
  executors. They are not generic provider patches and this package does not enable those accounts.
- A stateless Responses request with an unexpanded `previous_response_id` is rejected explicitly.
  This package does not discard the reference and pretend its missing history was reconstructed.

These boundaries must remain visible when reporting coverage. “92 declarations imported” does
not mean 92 live providers or all OpenCodex execution backends were tested or newly enabled.

## Search semantics and local delta

xAI `external_web_access: true` is removed while retaining a valid search declaration. An explicit
non-true value fails closed: remove that search declaration and reconcile dependent selectors and
empty-tool controls. Cindy's existing server-search injection checks the original prohibition
before normalization; moving normalization ahead of that check would silently re-enable search.
Top-level tools and `input[].additional_tools` are both covered. `tool_search` is client tool
discovery and is handled independently of hosted `web_search`.

The local vendor patch also keeps Cindy's `index_gated_web_access` cleanup and restricts upstream
custom-tool traversal to protocol containers. Schemas, defaults, metadata and tool-result payloads
may contain objects shaped like tool declarations; those literal values must remain unchanged.
Other deltas remove unused runtime/configuration imports from the vendored dependency closure.

This migration does not establish the root cause of the installed Grok incident. That still needs
the exact packaged route and redacted final outbound request; existing first-party xAI cleanup
already existed before this work.

## Repeatable sync

From the repository root:

```sh
# Fast local integrity check.
node packages/model-compat/scripts/sync-upstream.mjs

# Reproduce modules, reviewed patch, original tests and provider data from the pinned source.
node packages/model-compat/scripts/sync-upstream.mjs --source /path/to/opencodex

# Update from an explicitly selected, clean checkout at a full commit SHA.
node packages/model-compat/scripts/sync-upstream.mjs --source /path/to/opencodex --update --commit FULL_40_CHARACTER_SHA
```

The updater checks current port hashes, prepares changes in a unique temporary directory, applies
`upstream.patch`, regenerates the selected helpers/tests and statically extracts provider policy
before writing tracked files. Unknown selected expressions, changed test dependencies and patch
conflicts fail with an explicit error. The updater does not fetch or run upstream code.

`upstream-inventory.json` inventories **all upstream source files**, including unimported adapters.
An update writes `UPSTREAM-CHANGES.json` with new, changed and deleted paths. Review this report as
well as the ported diff: a new upstream compatibility module outside the imported closure requires
an explicit port decision. Sync is a reviewed dependency update, not a promise that upstream can
change arbitrarily without integration work. Preserve upstream license notices on every update.

Run package conformance tests and all affected bridge/host tests, package typechecks and the
repository's `pnpm test:unit:related` gate before delivery. Original Bun tests are transpiled to
JavaScript with only their runner/import paths changed; their assertions are retained. Live-account
checks are separate and must be reported separately from deterministic request/stream tests.
