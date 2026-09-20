# Cindy Headless

Cindy Headless is Cindy's container-friendly runtime. It reuses Cindy's `maker-core` and MCP contracts, then exposes the Claude Code, Codex, and Pi harnesses through a CLI and a Harbor `BaseAgent` adapter. It does not recreate Cindy Desktop, Electron UI, or the Agent binaries.

Version `0.4.2` is based on Cindy upstream commit `e2089e1e0d9f6f5aceed73b1d3550656d5f72359`. The CLI compatibility report and bundle manifest expose this revision so source, prompt, and benchmark evidence can be frozen together.

The current feature-by-feature parity inventory is maintained in
[`CINDY_FEATURE_PARITY.md`](CINDY_FEATURE_PARITY.md).

For the complete Chinese maintenance procedure, including how to diff a user's
local Cindy checkout from the last synchronized Cindy revision, exclude
Desktop-only changes, port runtime capabilities, and build a formal bundle,
see [`UPDATE_AND_PACKAGE.zh-CN.md`](UPDATE_AND_PACKAGE.zh-CN.md).

## Create an upload-ready bundle

For ordinary users, the recommended workflow is one command from a clean,
committed Cindy checkout:

```powershell
pnpm --filter cindy-headless package:release
```

It builds the Linux x64 bundle, verifies it, creates the self-contained `full`
archive, verifies the archive, and prints its exact path and SHA256. Upload the
reported `apps/cindy-headless/release/cindy-headless-linux-x64-full-<version>.tar.gz`
file to Headless Benchmark Tool. Users do not need to create a development
bundle first.

When only `apps/cindy-headless` contains source changes, the command keeps the
version synchronized, automatically increments the patch version when needed,
and creates a signed local checkpoint commit before building. It refuses to
auto-commit when other Cindy paths are dirty. It may safely reuse the sole
generated formal manifest when that manifest already identifies the current
HEAD.

Generated `bundle/` and `release/` directories are ignored. A fresh checkout builds them from source; release manifests and checksums are retained alongside the archive, not committed to Git.

## Local development quick start

From a source checkout on Windows:

```powershell
# Supply CINDY_HEADLESS_BASE_URL and CINDY_HEADLESS_API_KEY through your environment.
./apps/cindy-headless/scripts/setup.ps1
cd <your-harbor-checkout>
uv run harbor eval execute <freeze-id> --workspace-root . --approve
```

The bundle directory is useful for local development and direct Harbor work.
For web upload, use the verified `full` release archive produced by
`package:release`.

`package:public-runtime` is a separate public-distribution workflow. It creates
only `cindy-headless-linux-x64-public-runtime-no-vendor-<version>.tar.gz`, which
does not contain the Claude Code, Codex, or Pi harness binaries. It is not the
default upload package and must be used only when a no-vendor artifact is
explicitly requested. The low-level `package:full` command exists for release
pipeline diagnostics; ordinary formal delivery should use `package:release`.

## Layout

```text
apps/cindy-headless/src/       Runtime, profiles, benchmark and artifact code
apps/cindy-headless/profiles/  Pinned backend/model/profile definitions
apps/cindy-headless/scripts/   Bundle and compatibility verification scripts
apps/cindy-headless/bundle/    Reproducible Linux x64 bundle output
apps/cindy-headless/harbor-compatibility.json  Harbor adapter contract and pinned features
```

## Prerequisites

- Node.js 22 and the repository dependencies installed with pnpm.
- Pinned Linux x64 Claude Code, Codex, and complete Pi runtime distributions for bundle creation.
- Harbor 0.20 for container tests.
- Either a temporary isolated Codex home or the unified gateway configuration.

Never put an API key in a profile, manifest, bundle, Git-tracked file or result artifact. Use environment variables or a configuration file outside the repository.

## Local configuration

```powershell
# Set CINDY_HEADLESS_BASE_URL and CINDY_HEADLESS_API_KEY in your process environment.
# Alternatively point CINDY_HEADLESS_CONFIG_FILE to a config outside this repository.
```

The config file is ignored. It supports an Anthropic-compatible gateway for Claude and Pi, and an OpenAI Responses-compatible `/v1` route for Codex. Offline commands such as `version`, `plan` and `report` do not load gateway credentials.

## Build and verify

Run the normal checks:

```powershell
npm --prefix apps/cindy-headless run typecheck
npm --prefix apps/cindy-headless test -- --run
npm --prefix apps/cindy-headless run build
```

Build the scored Linux bundle with pinned binaries:

```powershell
$env:CINDY_CLAUDE_BINARY = 'D:\path\to\pinned\claude'
$env:CINDY_CODEX_BINARY = 'D:\path\to\pinned\codex'
$env:CINDY_PI_BINARY = 'D:\path\to\pinned\pi-runtime\pi'
npm --prefix apps/cindy-headless run bundle:linux
npm --prefix apps/cindy-headless run verify:bundle
```

One bundle contains Claude Code, Codex, and Pi. Harbor discovers all three from
`bundle-manifest.json` and selects exactly one harness for each Trial through
the effective profile. Harness protocols remain independent and are never
translated into one another.

`bundle-manifest.json` records the vendored source commit, upstream Cindy commit, prompt digests, binary digests, observed versions and Headless contract version. Rebuild it whenever runtime source or pinned binaries change.

The bundle does not contain a Harbor adapter. Scored Benchmark runs
use the adapter maintained in the pinned Harbor checkout:
`harbor.agents.installed.cindy_headless:CindyHeadlessAgent`. Run Harbor from
its own checkout and pass `--workspace-root` there. Keep `bundle_dir` and
`profile_path` relative to that root; never copy an adapter into this repo or
put a maintainer's local path in a job file. The required adapter contract is
recorded in `harbor-compatibility.json`.

`bundleMode: "formal"` means only that the bundle was built from a clean,
committed source state. `bundleMode: "development"` identifies a dirty local
build. It is an identity field in the same bundle format, not a second package
or archive workflow.

Do not weaken this boundary for convenience. The normal user workflow produces
a formal bundle from a local checkpoint commit; that commit does not need to be
pushed or merged. A dirty checkout is supported only for diagnostic builds by
setting `CINDY_HEADLESS_ALLOW_DIRTY_BUNDLE=1`, but a scored bundle must remain
clean.

## CLI

Inspect a bundle's credential-free web capability catalog:

```powershell
node apps/cindy-headless/dist/cli.cjs capabilities --manifest apps/cindy-headless/bundle/linux-x64/bundle-manifest.json
```

New bundles publish `capabilityCatalog` in `bundle-manifest.json`. It declares
all packaged harnesses, the deliberately maintained set of profile-controlled
feature switches, and explicit defaults used by upload services to render
configuration choices. It is not an automatic inventory of every Cindy feature. This catalog
describes what the package offers; the effective profile and runtime evidence
record what a particular Run actually enabled.

The single source of truth is `capability-registry.json`, maintained explicitly
by the Headless maintainers. Every Cindy update still requires a source diff and
feature-parity review, but a discovered Cindy change is added to `features` only
when it is intended to become a user-selectable evaluation switch. The build copies the registry into
`capabilityCatalog` automatically; no second feature list in the build script
or web client should be maintained. Registry entries describe controls and
declared adapter coverage only. Route support, proxy enforcement, and runtime
evidence must still be checked before a capability is reported as enforced.

This README is a quick reference, not a replacement for the operating manual.
For the required registration fields, feature/control distinction, harness
mapping, security rules, contract tests, and formal-bundle procedure, follow
[`UPDATE_AND_PACKAGE.zh-CN.md`](UPDATE_AND_PACKAGE.zh-CN.md), section 5.1.

Generate a portable profile directly from the bundle manifest, then validate it:

```powershell
node apps/cindy-headless/dist/cli.cjs profile generate --manifest apps/cindy-headless/bundle/linux-x64/bundle-manifest.json --harness codex --output apps/cindy-headless/bundle/linux-x64/effective-profiles/codex.json
node apps/cindy-headless/dist/cli.cjs profile validate --profile apps/cindy-headless/bundle/linux-x64/effective-profiles/codex.json
```

Use `--features` with a comma-separated list to opt into declared boolean switches.
Compaction and the packaged Cindy system prompt currently follow the maintained
profile defaults and are not exposed as web switches. A
custom Pi model additionally requires `--provider`, `--base-url`, `--api`,
`--context-limit`, and `--max-output-tokens`; the generator writes the matching
`nativeProviders` entry so the result remains valid and reproducible.
Keep generated profiles inside the bundle before upload. Their binary and
prompt paths are intentionally relative to the profile location so the whole
bundle remains relocatable in the Harbor task container.

Validate a profile and inspect compatibility:

```powershell
node apps/cindy-headless/dist/cli.cjs profile validate --profile apps/cindy-headless/profiles/cindy-production-codex/profile.example.json
node apps/cindy-headless/dist/cli.cjs compatibility-report --profile apps/cindy-headless/profiles/cindy-production-codex/profile.example.json
node apps/cindy-headless/dist/cli.cjs doctor --profile apps/cindy-headless/profiles/cindy-production-codex/profile.example.json
node apps/cindy-headless/dist/cli.cjs doctor --profile apps/cindy-headless/profiles/cindy-production-pi/profile.example.json
```

Run a local task:

```powershell
node apps/cindy-headless/dist/cli.cjs run --profile <profile.json> --task "Inspect the repository and report the result" --working-dir . --output-dir results
```

The output directory contains identity, config, trace, usage and result artifacts. Prompt bodies and secrets are excluded. Usage artifacts use schema 2 and explicitly report `COMPLETE`, `PARTIAL` or `MISSING`; timeout results must not be interpreted as exact zero token or cost. They also expose `usageCompleteness`: `exact` for a complete provider event, `lower-bound` for observed partial usage, and `incomplete` when no trustworthy count exists. Reports count these categories separately. Evaluation report schema 2 sets `totals.costUsd` to `null` when any trial has unknown cost; `knownCostUsd`, `costKnownCount` and `costMissingCount` expose the auditable known subtotal. A configured cost budget fails closed with `cost-unknown` instead of silently treating missing cost as zero. A disconnected provider stream is infrastructure failure; it is not converted into an agent failure or an estimated token count.

Harbor's token fields overlap by design: `n_input_tokens = inputTokens + cacheCreationTokens + cacheReadTokens`, `n_cache_tokens = cacheReadTokens`, and `n_output_tokens = outputTokens`. Do not add `n_cache_tokens` to `n_input_tokens` a second time. The original components and completeness flags remain in `usage.json`.

`identity.json.identityEvidence` identifies whether each actual-identity field came from a provider event, configuration, an operator assertion, or is unknown. These are provenance labels, not independent gateway attestation. Unless a gateway supplies a request-ID lookup or signed billing record, Headless cannot independently prove the actual upstream provider/model and records `gatewayAttested: false`.

`trace.raw.jsonl` is the lossless native Cindy event stream. `trace.jsonl` is
the normalized analysis stream: when a provider emits incremental `text` or
`thinking` deltas followed by an `isFinal` snapshot, the earlier deltas are
removed from the normalized stream so downstream analysis does not count the
same content twice. Headless itself does not emit Harbor's `trajectory.json`;
the current Cindy Harbor adapter preserves it as a Cindy-native artifact and
declares `SUPPORTS_ATIF = False` rather than claiming an unimplemented
conversion.

## Harbor smoke test

Run the Harbor workspace's hello-world smoke/freeze workflow from its own
repository. Set `--workspace-root` to the Harbor workspace root; job paths must
be relative to that root. Use a unique `run_id` and frozen `manifest_digest`.

## Collect and report results

Harbor writes the raw trial artifacts under its configured jobs/evaluation
output directory. Use the Harbor viewer or its report tooling from the Harbor
checkout to inspect those artifacts, then pass a normalized results file to:

```powershell
node apps/cindy-headless/dist/cli.cjs report --manifest <manifest.json> --results <results.json> > report.json
```

Reports include per-agent and per-benchmark pass rates, paired outcomes, four-state statuses, tokens, cost, duration, provider routing, unsupported combinations and Wilson 95% intervals. A hard-30 list is publishable only after freezing at least 30 independent historical task records with `freeze-hard-30`.

The adapter is intentionally maintained in Harbor, not here. To run a local
smoke from a source checkout:

```powershell
$root = (Resolve-Path ..\harbor).Path # any Harbor checkout; do not hard-code a maintainer path
uv run --project $root harbor eval execute <freeze-id> --workspace-root $root --approve
```

The `<freeze-id>` job must use the registered `cindy-production` agent backed
by `harbor.agents.installed.cindy_headless:CindyHeadlessAgent`. Harbor resolves
the bundle and profile paths relative to `--workspace-root`, so the same job
works after cloning to another directory. Use `harbor-compatibility.json` to
check the required Harbor commit and adapter contract before a scored run.

The `cindy-claude-parity-all-off` profile is a whole-surface parity control. Because it changes Maker Memory, project context, compaction and the Cindy system prompt together, it cannot attribute an outcome to any one dimension. Use a derived profile with exactly one declared `changedDimensions` entry for causal comparisons.

## Maintenance after Cindy updates

The checklist below is the short policy summary. Follow
[`UPDATE_AND_PACKAGE.zh-CN.md`](UPDATE_AND_PACKAGE.zh-CN.md) for exact commands,
decision points, expected outputs, upload layout, and rollback rules.

Treat Headless as a compatibility surface, not a floating checkout:

1. Update/rebase the Cindy source and inspect changes to `maker-core`, Agent event types, usage, Memory/MCP and Desktop prompt sources.
2. Run typecheck, all tests, prompt parity and compatibility tests.
3. Rebuild the Linux bundle with pinned binaries and run `verify:bundle`.
4. Run the Harbor hello-world smoke test, then a small multi-task pilot before a scored benchmark.
5. Retain the new bundle manifest and checksums with the release archive; generated bundle output is not committed.

Classify changes as `COMPATIBLE` (rebuild only), `REQUIRES_ADAPTER_UPDATE` (Headless or Harbor code changes), or `UNSUPPORTED` (Desktop-only capability). Do not silently enable new permissions, providers or throughput caps in a scored run.

By default the bundle builder refuses a dirty worktree. Local development can
set `CINDY_HEADLESS_ALLOW_DIRTY_BUNDLE=1`; the resulting manifest is marked
`bundleMode: "development"` and must not be used for a scored run. In both
modes, `generatedAt`, `cindyCommit`, `cindyUpstreamCommit`, and the digests bind
the artifact to its inputs.

### When upstream changed before a smoke test

Do not silently run newly updated Cindy sources with an old Headless bundle. Before the smoke test, compare the vendored source commit and `package.json.cindyUpstreamCommit` with `bundle/linux-x64/bundle-manifest.json.cindyCommit` and `.cindyUpstreamCommit`, then choose one of these paths:

1. **Test the previous frozen bundle:** keep the old Cindy checkout and bundle together, record both revisions, and state that the smoke test covers the previous frozen bundle. This is valid for regression checks, but it does not validate the new upstream commit.
2. **Upstream change is `COMPATIBLE`:** sync/rebase the change, run all Headless tests, rebuild and verify the bundle, update the frozen manifest digest, then run Harbor smoke. Typical examples are internal `maker-core` fixes that preserve public contracts.
3. **Change is `REQUIRES_ADAPTER_UPDATE`:** stop the scored run. Update Headless and/or the Harbor adapter, add contract regression tests, rebuild the bundle, run smoke and a small pilot, then freeze new revisions. This applies to changes in Agent APIs, event/usage schemas, Memory/MCP behavior, profiles, permissions or provider routing.
4. **Change is `UNSUPPORTED`:** do not imitate or partially enable it in Headless. Record the Desktop-only capability and applicable scope in the compatibility/report output.

Before any scored benchmark, freeze and verify the Cindy commit, Headless commit, bundle manifest digest, Agent binary versions, prompt digests, profile digest, model/endpoint and Benchmark revision. If any one of these differs from the planned run, regenerate the plan or stop the run; never mix a new source checkout with artifacts from an older bundle.

The canonical Pi baseline is `cindy-production-pi`. Its profile enables
workspace-confined file/image turns and Cindy-approved project Skills from
`.pi/skills` and `.agents/skills`; the exact discovered Skills are snapshotted
per session. Pi loads local root task project resources in place, so Headless
inspects the workspace before every run: Skills the profile did not approve are
denied for that session, and `identity.json.piProjectResources` (mirrored in
`config.json`) records the effective in-repo Skills, prompt templates, and
extensions the run received. Prompt templates and extensions have no profile
switch yet, so they are evidence-only. Its custom MCP list is deliberately frozen empty. The canonical
Claude Code baseline remains `cindy-production-claude` (also referred to as
“CC”); do not create a duplicate `cindy-production-cc` identity.

The Pi gateway route in this baseline is deliberately fixed to the
Anthropic-Messages-compatible Claude model declared by the manifest. Pi BYOM
profiles carry their own exact API and model metadata. Headless does not yet
claim Cindy Desktop's dynamic Pi gateway catalog resolution for arbitrary
Gateway models (`compat`, `samplingParams`, or custom `thinkingLevelMap`).

Structured turns preserve the old string-array format and add attachments:

```json
[
  {
    "text": "Inspect the attached fixture.",
    "attachments": [
      { "type": "file", "path": "fixtures/input.txt", "mimeType": "text/plain" }
    ]
  }
]
```

Attachment paths are relative to `--working-dir`; absolute paths, parent
traversal, symlink escapes, non-files, and policy limit violations fail closed.
Remote MCP and Pi BYOM declarations live in the profile. They pin endpoint,
transport/API and exact model metadata, while bearer/header/API-key values are
read only from the environment-variable names declared by that profile.

## Profiles

`model.contextLimit` is optional for Claude Code and Codex, and required for Pi. When present, Headless injects that exact
context window into Maker Core for the selected model; when omitted, the
underlying Agent/model capability remains authoritative. This setting controls
Headless context accounting and compaction thresholds, but does not increase an
upstream model or gateway's actual context capacity.

`run` defaults to `--timeout-owner headless`. In this standalone mode,
`--timeout-ms` is enforced by Headless and defaults to **1800 seconds
(1,800,000 ms)**. Headless derives the Maker turn-stall watchdog from that
deadline and records `timeoutOwner`, `timeoutMs`, and `turnStallMs` in
`config.json`.

When Harbor owns the run, the Cindy adapter must pass
`--timeout-owner external` and must not pass `--timeout-ms`. External mode does
not create a Headless scoring deadline and disables Headless-injected turn and
upstream-idle watchdogs. Harbor gives the Agent the complete task budget, marks
the timeout at its own deadline, and signals Headless during the non-scoring
cleanup grace period. Headless keeps its signal handlers installed until result,
usage, identity, and trace artifacts have been persisted.

The five-second session-close bound applies only after execution has ended or
been interrupted. It protects artifact persistence from a stuck SDK close and
does not subtract time from the Agent's scoring budget.

## Building a usable Harbor bundle

Build the scored bundle from a clean, committed feature branch. It must be
Linux x64 and include `dist/cli.cjs`, `dist/eval-cli.cjs`, Node, all three
harness runtimes, all three prompts, profiles, and `bundle-manifest.json`.
Never mix a newly built bundle with an older profile or upload an unverified
directory.

Minimum bundle checks:

```powershell
pnpm --filter cindy-headless typecheck
pnpm --filter cindy-headless test
pnpm --filter cindy-headless build
pnpm --filter cindy-headless bundle:linux
pnpm --filter cindy-headless verify:bundle
```

Register the resulting runtime in Headless Benchmark Tool, run package
verification, and require `READY` before a Harbor benchmark. A one-task Harbor
smoke should verify `config.json`, `identity.json`, `result.json`, `usage.json`,
`trace.jsonl`, and `trace.raw.jsonl`; only then admit the bundle for scored
runs. Preserve its exact manifest and the command used to reproduce it.

The Kimi gateway examples are
`profiles/cindy-production-claude/profile.kimi-k3.example.json` and
`profiles/cindy-claude-parity-all-off/profile.kimi-k3.example.json`. They pin a
1M declared context window; supply gateway credentials through the ignored
local config file, never by editing these tracked profiles.

For the DeepSeek smoke campaign, use
  `profiles/cindy-production-claude/profile.deepseek-v4-flash.example.json`.
It pins `deepseek/deepseek-v4-flash` and a 1,048,576-token declared context
window. The gateway must actually advertise/support this model; the profile
does not turn a gateway route into an independent model attestation.

For the production Pi benchmark, use
`profiles/cindy-production-pi/profile.deepseek-v4-flash.example.json`. It uses
the neutral `example-gateway` native provider while preserving the complete
`deepseek/deepseek-v4-flash` model ID on the OpenAI-compatible request. Do not
rename that provider to `deepseek`: Pi's built-in provider handling would send
the bare `deepseek-v4-flash` ID, which the benchmark gateway rejects.

Production profiles are pinned and should be changed only for an explicit experiment:

- `cindy-production-claude`
- `cindy-production-codex`
- `cindy-production-pi`
- `cindy-native-memory`
- `cindy-planning`
- `cindy-no-compaction`
- `cindy-tool-surface`

Keep `profile.local-smoke.json` restricted to local testing. In particular, unsandboxed bypass permission is explicitly unsafe and must never be used for untrusted benchmark tasks.
