# xAI API catalog sync

This entry joins **two real provider APIs**, rather than inferring capabilities from model names
or copying a Pi SDK model list. It emits an account-scoped catalog using Cindy's existing V5
schema and exercises the production active-catalog, picker descriptor and reference-price paths.
The runtime refresh and this script share the same account-response parser.

```sh
node --import tsx tools/model-catalog/sync-xai.mts \
  --grok-auth "$HOME/.grok/auth.json" --output /tmp/xai-sync-run
```

An explicit `CINDY_XAI_ACCESS_TOKEN` environment variable can replace `--grok-auth`. Credentials
stay in memory; the script neither refreshes nor writes the login, follows redirects, nor sends
generation requests. The two authenticated destinations are fixed official hosts. Each output
run must use a new directory; an error never replaces a previous successful result.

- `catalog.json`: load through the existing `XDT_MODELS_PATH` Desktop catalog-source setting in
  an isolated development profile. The script validates both serialized-file import and the
  normal account-discovery overlay. It does not start or reconfigure a running app.
- `report.json`: resolved fields for Claude Code, Codex and Pi, price bands, API field provenance,
  and unresolved facts. `complete: false` is not full support. `--require-complete` exits **2**
  after writing the reviewable result if any required facts remain unresolved; transport, input
  or import errors exit **1**. Success fetching/parsing alone is never described as complete.

**Scope:** xAI subscription account discovery. Do not publish the artifact wholesale as a public
server catalog: an account's member list is not a universal model list. Public catalog changes
must preserve the existing server source and review scope. This script does not modify either
server sources or client bundled snapshots, user preferences, schedules, or historical tasks.
There is no model-version whitelist: the regression uses an unseen `grok-4.8` fixture, not a claim
that this model exists. A new transport still needs a real client adapter.

## Sources and conversion

- `https://cli-chat-proxy.grok.com/v1/models` supplies account members, display names, context,
  declared backend and effort ladder. Hidden entries are excluded. Explicit `responses` backend
  is carried through discovery/cache; other newly declared backends stop the sync for review.
- `https://api.x.ai/v1/language-models` supplies modalities and manufacturer reference prices.
  Join exact IDs or a **unique explicitly returned alias**, never version/suffix similarity.
  Extra models from this endpoint do not become account members.
- The current public Cindy V5 catalog supplies curated defaults and existing routing. Use
  `--catalog FILE` for a fixed baseline. Sparse metadata does not clear curated facts. Explicit
  native-only defaults are generated per harness; existing opt-outs remain. Local user overrides
  are still applied by the app, not written by this tool.

The [official REST contract](https://docs.x.ai/developers/rest-api-reference/inference/models)
expresses text prices in **USD cents per 100 million tokens**: divide by 10,000 for USD per million.
Long-context prices apply at `long_context_threshold` (inclusive); zero in a long-context price
field means the standard price, while a zero standard price is an actual zero. Cache reads are
not cache writes. Unknown/missing prices never become zero, and reference prices are not
subscription billing.

Unchanged tariffs keep their historical start date; changed tariffs close the previous interval
and start at the observation date. This is the first observed price, not an invented provider
launch date. Ambiguous same-day changes are rejected because V5 prices have day precision.
Other variants, markets, routes and historical prices are retained.
Missing cache-read fields retain verified active cache prices only for the same input-token
band, without advancing their verification date. The report still lists `apiCacheReadPrice`
as missing and identifies inherited cache prices as catalog facts. An explicit zero replaces
the previous rate; an absent field does not.

## Repeatable verification

```sh
node --import tsx tools/model-catalog/sync-xai.mts --catalog /tmp/baseline.json \
  --account-input /tmp/account-response.json --details-input /tmp/language-models-response.json \
  --observed-at 2026-09-24T12:00:00.000Z --output /tmp/xai-replay
pnpm exec tsc --noEmit -p tools/model-catalog/tsconfig.json
pnpm --filter desktop exec vitest run \
  src/main/maker-host/__tests__/xaiSyncImport.test.ts \
  src/main/maker-host/__tests__/xaiModelDiscovery.test.ts \
  src/main/maker-host/__tests__/activeCatalogDiscovery.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Never put account auth files or unfiltered API captures into repository fixtures. The sync report
contains allowlisted model fields, not request headers, user identity or raw upstream responses.

## Live check (2026-09-24)

Authenticated metadata GETs returned four account models and eight language-model detail records.
All four account members reached the three production picker projections (12 records); ordinary
Grok 4.7 reference prices resolved to $2/$0.5/$6 input/cache/output per million, and $4/$1/$12 from
200,000 input tokens. Claude Code's compatibility route was default-off. Pi native model-spec
conversion is covered by an unseen-model regression without an SDK entry.

Fast is now declared with a provider/harness `fastModelId` mapping: Grok 4.7 →
`grok-4.7-build-fast`. The [official 4.7 documentation](https://docs.x.ai/developers/grok-4-7)
identifies Fast as the same model on faster infrastructure, available via Grok Build / Cursor,
not the public API-key product. Account discovery determines whether this connection has it.
There is no verified Build Fast mapping for 4.6; do not manufacture one from its version number.

The [explicit Fast tariff](https://docs.x.ai/developers/pricing) is $4/$1/$12 per million
input/cache/output, rising to $6/$1.5/$18 when input **exceeds** 200,000 tokens. Do not calculate
long-context Fast pricing by doubling the ordinary long-context tariff. These curated facts
supplement API omissions; `fieldsFromCatalog` distinguishes them from live API evidence.

Claude bridge, Codex proxy and Pi native forwarding consume the same account-gated mapping.
Fast sends the target model without also sending `service_tier: priority`. Existing usage
accounting names its Fast price variant `priority`; that internal label is not an upstream tier.
Direct Fast model IDs remain callable for existing selections, default-off for new selection.

This execution adapter requires a client release. The optional mapping alone does not enable
Fast on old clients. After that adapter is installed, future verified model mappings and tariffs
can be updated in catalog data; neither a Fast-looking name nor discovery alone proves a mapping.
No production catalog has been published by this tool.

Remaining gaps: the Fast individual detail endpoint returns 404; both APIs omit maximum output.
The report retains those unknowns, rather than presenting existing Pi runtime output budgets as
verified provider limits. The metadata check does not launch the GUI or certify full agent turns.

A separate minimal live inference probe on 2026-09-24 verified the normal/Fast model IDs through
Claude's real translation handler and the Codex/Pi mapping helpers (HTTP 200). Full host proxy
chains are additionally covered by local request/response tests with a mocked upstream. These
probes are not a GUI or complete coding-task acceptance test.
