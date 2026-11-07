# Personal developer builds / 通用个人开发版

`pnpm personal:build` combines an application repository's default branch with the authenticated
GitHub user's open PRs (including drafts), and optionally does the same for plugins. It works from
existing checkouts, without fixed usernames, home directories, signing identities or a cloud service.
Node.js, Git 2.38+, Git LFS, pnpm and authenticated GitHub CLI are required.
Use the versions in the root package manifest. No token belongs in the configuration.

这是开发脚本，不是正式应用更新器。默认使用仓库现有的隔离数据启动入口；不会替换已安装的
Cindy。只有显式配置的 macOS 托管模式支持沿用共享数据和排队更新；不会自动放行未合并 PR 的数据库迁移。
Mac、Windows 和 Linux 共用 Node 入口；运行应用仍取决于各平台的现有开发工具链。

## Quick start

Run from the Cindy source checkout. Put config and generated builds outside tracked source files.
Paths below are examples; paths containing spaces are supported.

```sh
pnpm personal:build init --config ../personal/config.json --app . --plugins ../cindy-official-plugins
pnpm personal:build prepare --config ../personal/config.json --out ../personal/build-001
pnpm personal:build status --report ../personal/build-001/report.json
pnpm personal:build check --report ../personal/build-001/report.json
pnpm personal:build start --report ../personal/build-001/report.json
```

Omit `--plugins` to build the app only. `init` detects the GitHub account and checkout repositories;
review the generated owner/repo when working from forks (set the upstream repository explicitly
if its PRs, rather than your fork's PRs, are intended). Run `gh auth login` in your own terminal if
needed. Config is JSON, never executable shell. `init` refuses to overwrite an existing config.
The CLI can also be invoked with `node scripts/personal-build.mjs`.

## Configuration

Paths are relative to the config file, not the shell's working directory. `author` can be omitted to
use the current GitHub CLI identity on each prepare. `base` defaults to the repository default branch.

```json
{
  "version": 1,
  "name": "personal",
  "region": "global",
  "app": {
    "checkout": "../../cindy",
    "repository": "makecindy/cindy",
    "exclude": [],
    "localRefs": []
  },
  "plugins": {
    "checkout": "../../cindy-official-plugins",
    "repository": "makecindy/cindy-official-plugins",
    "exclude": [],
    "localRefs": []
  },
  "localPlugins": {}
}
```

- `gitIdentity`: optional `{ "name": "Your Name", "email": "your-address" }`, used for local composition commits in both repositories. Otherwise each repository needs its own Git identity. No global Git config is changed.
- `name`: stable isolated app-data profile name; use different names for independent test accounts.
- `region`: `global`, `cn`, or `dev`; dev needs the repository's existing endpoint setup.
- `exclude`: PR numbers not to merge directly. A selected stacked child can still include its parent;
  to exclude the parent's changes, also exclude dependent children.
- `localRefs`: explicitly selected committed local branches/SHAs, merged after PRs and recorded by SHA.
  Uncommitted application changes are not copied; keep development in its source task worktree.
- `localPlugins`: `{ "plugin-id": "path/to/plugin" }` copies that working directory, including
  uncommitted files, instead of the composed plugin. Dotfiles, node_modules and `.cindy` archives are
  excluded; symlinks and other non-regular entries are rejected. Plugin IDs must match manifests.
  Use `{ "plugin-id": { "source": "repository" } }` to follow the composed plugin repository's
  main + selected PRs/local refs, instead of a possibly stale working directory.
- `localPluginSources`: optional path to a JSON registry
  `{ "version": 1, "plugins": { "plugin-id": { "source": "repository" } } }`.
  It accepts the same source values; paths inside it are relative to the registry file. Duplicate IDs
  across both mappings are rejected. When an older supervisor still runs, keep `localPlugins: {}`
  and add this separate registry: older tooling ignores the new property instead of failing to parse
  object-valued sources. The updated supervisor/build tooling is required to consume the registry.

## Preparation and updates

Each `prepare` uses a **new output directory**, preserving existing builds and dirty source worktrees.
It fully paginates the open PR list, orders selected stacked PRs by dependency, fetches exact main/PR
commit IDs and records them. Fork PRs use their exact SHA, not a same-named local branch. Local merge
commits use the developer's Git identity and Signed-off-by; no branch is pushed and no PR is created.

Conflicts preserve the worktree and a `state: failed` report. Resolve and commit the merge in the
reported worktree, then run `continue --report FILE`. Git rerere reuses previous resolutions.
Generated design-inventory conflicts are regenerated from the combined source, and the final inventory
is refreshed before recording the target. Other conflicts remain for inspection. Continuation verifies the merge contains both the prior target and the pending PR; the discovered
SHA list stays fixed. Alternatively fix/exclude the source PR and prepare a new directory. No PR is
silently skipped. A conflict in startup plugin synchronization retains the previous complete seed set and its working
directory in `plugins-report.json`. Resolve and commit there, then repeat `sync-plugins` with the same
config to resume the pinned list. The next successful fresh sync discovers current PR heads again.

`check` installs locked dependencies and runs migration validation, design inventory validation and
Desktop typechecking. It does not claim full functional coverage. `start` requires a successful check,
unchanged HEAD/tracked files and matching plugin hashes/inventory, then delegates to
`restart:desktop:remote -- --region=... --isolated=...`. Existing startup/migration guards remain active.
The portable commands do not execute private SQL migrations. The managed engine below retains an explicit migration-script protocol; shared-profile guards and the application updater remain separate.

To update, repeat prepare → check → start with a new output directory. The old directory remains a
rollback candidate; its compatibility with data created by a newer build must still be verified.
There is no automatic rollback of data and no automatic cleanup of worktrees. When finished, use
normal Git worktree management after checking no process or uncommitted work depends on the directory.

## Plugins and duplicate installations

Plugins changed by selected PRs/local refs become public-instance seeds under the generated app's
`apps/desktop/resources/builtin-ghosts/official`, except IDs registered in `localPlugins` or the source
registry. Registered local plugins instead go to `apps/desktop/resources/personal-plugins` with a
content-hashed index and source provenance. They never overwrite the public seed. Other installed
plugins continue using the marketplace. Removed plugins are listed in `omittedPlugins`; installations
are not deleted by this script.

All prepared manifests retain their source version and `minCindyVersion` exactly. There is no artificial
patch bump or `-personal` relabeling. A package hash proves prepared content, not runtime installation.

The supervised developer launcher requests local updates only after the app has passed its healthy
probation and is idle. The request expires after 30 seconds and is bound to the current generation/PID.
The host validates the complete bundle, then updates only existing, confirmed, approved `local`
instances through the ordinary installer, preserving instance identity, enablement, data and grants.
First installs, version downgrades, source changes, added permissions and busy instances are not silently
accepted. They retain the current installation and report a deferred or failed result. Legacy
`sync-plugins` refuses registered local sources; use prepare/check and the supervised launcher.

Before each update, a verified code-only `.cindy` recovery package is retained in the active owner's
`personal-plugins/backups`; it contains no instance data or credentials. Installation uses the existing
durable transaction/recovery path. A failure stops the remaining batch; earlier completed updates are
not rolled back as a group. No data rollback or plugin business-function health guarantee is implied.
An applied hash/revision receipt prevents repeat installation of unchanged prepared content.

The supervisor release fingerprint includes the local bundle; old release IDs without one stay stable.
An app trial never updates installed local plugins. Public seeds, data/runtime changes and migrations
retain their existing conservative compatibility gates. A bundle requires a candidate with the new
host handler; merely updating the launcher cannot add the handler to an old app.

`auto-status` includes `localPluginUpdates` from `automatic/launches/<generation>/plugins-result.json`
(or pending/expired requests). `completed` means the handler returned: inspect `report.state` and each
plugin's result before claiming success. An `applying` result left by a crash is unknown, not success.
There is no blind retry in the same launch. Inspect/recover through Cindy before launching again.

Inspect installed identities with:

```sh
pnpm personal:build audit --brain "/path/to/the/chosen/owner/cindy-brain"
```

Audit reports all instances and duplicate IDs with namespace, version and path. It is read-only and
makes no assumption that enterprise/local data can be merged. The host's daily discovery selects the
newest available public/local copy by SemVer, choosing public on a tie. A newer local build wins again
on the next query; both installations and their data remain intact. Explicit namespace addressing stays
exact, while organization and unresolved legacy identities remain independent. See
[discovery policy](../ghost-progressive-discovery.md#22-日常调用的-publiclocal-版本选择).
Do not delete directories or ledgers to resolve duplicates. Older running hosts still expose both
copies until upgraded; a source change or an audit report alone does not activate this policy.

## Report and verification

`report.json` distinguishes `preparing`, `failed`, `prepared` and `checked`. It records the author,
repositories, main/PR/local-ref SHAs, excluded PRs, target commits, paths, plugin source/override/version,
package hashes and check failures. `prepared` does not mean installed; `checked` does not mean the app
is running. Confirm runtime identity and plugin tool receipts after start. No launch success is invented.

Regression entries: `node --test scripts/__tests__/personal-build.test.mjs scripts/__tests__/personal-build-managed.test.mjs` (also in `test:runner`). Each file runs in about 3 seconds on macOS.
Real temporary Git repositories cover preservation of source work, composition and conflict reporting;
GitHub responses are fixtures, with no account/network access. Script tests are separate from renderer
or application package tests. Windows/Linux live startup and marketplace takeover require platform
verification; passing portable logic tests is not evidence of those operations.

## macOS managed launcher: one lifecycle

For a long-lived personal client, add `runtime` to the same config. Paths can be absolute or relative
to that config; application source, active client, staging and state directories must be distinct.
The source repository and the existing client/staging worktrees must share a Git object database.
The client must already be a checked-out application (for a new setup, create a detached worktree).

```json
{
  "runtime": {
    "mode": "shared",
    "clientDir": "../personal-client",
    "stagingDir": "../personal-staging",
    "stateDir": "../personal-state",
    "dataDir": "/Users/your-user/Library/Application Support/CindyGlobal",
    "node": "/path/to/neutral/node/bin/node",
    "toolPaths": ["/path/to/neutral/node/bin", "/opt/homebrew/bin"],
    "installedApp": "/Applications/Cindy.app",
    "idleMinutes": 120
  }
}
```

`mode` is explicit: `shared` keeps existing regional application data and login, while `isolated`
uses the named sandbox. `dataDir` must equal the directory derived by the repository restart entry
for that region/mode/name; it is not an arbitrary redirect. Never monitor one database while launching
against another. Use an independent Node/pnpm installation and deploy launcher tools outside the
source/client worktrees, so process cleanup cannot confuse them with a checkout's app processes.

| Command | Result |
| --- | --- |
| `doctor --config FILE` | Reads active commit, selected manifest, stage/apply results, plugin synchronization and duplicate instances. `ok: false` means an issue remains. |
| `launch --config FILE` | Opens the configured client, synchronizes plugin seeds, checks migration policy and watches update requests. If already running, leaves it alone. |
| `select --config FILE --report FILE` | Verifies a prepared build and selects its commit in `manifest.json`; does not switch code. |
| `request --config FILE --action stage` | Asks the running launcher to check the selected version in staging. |
| `request --config FILE --action stage-restart` | Stages, then queues the update for the next normal quit and launch; the running app is never terminated. |
| `request --config FILE --action restart` | Queues the selected version to install at the next normal quit and launch. |
| `stage --config FILE` | Direct staging checks while the active application continues. |
| `apply --config FILE` | Applies while the managed application is stopped; saves the prior commit. |
| `rollback --config FILE` | Restores the prior commit only if database history is compatible. |
| `sync-plugins --config FILE` | Prepares a complete replacement seed set and records `plugins-report.json`. |
| `export --report FILE --out NEW_DIRECTORY` | Produces a Git object pack, digest, exact fetch prerequisites, manifest and report for another machine. |
| `bundle-tools --out NEW_DIRECTORY` | Copies the complete CLI and adapters with a content-hash manifest for a stable launcher deployment. |

The engine retains staging dependency installation, migration/design/type checks, Electron keychain
preauthorization, LFS restoration, rollback references and status/log files. It rejects tracked edits
before switching; only byte-verified sqlite-vec LFS materialization is exempt. Untracked path collisions
are left to Git's non-forcing checkout. Database query failures are not a compatible/idle verdict.
Startup becomes ready only on the real `DESKTOP_DEV_VERDICT=ready`, never merely elapsed time.

A startup failure can automatically roll back a just-applied code-only update. A migration update
cannot: `.database-transition` blocks further apply/start/rollback until its outcome is inspected.
An explicit `DB_SCRIPT` basename in the selected manifest runs only after target checks, then database
history is rechecked. The generic tools never generate a SQL repair or silently loosen migration policy.
Private historical migration scripts/allowlist patches remain recovery artifacts, not automatically
applied steps. Test unmerged migrations in an isolated profile or supply a reviewed migration workflow.

Legacy `manifest.env` is parsed as data (never sourced); JSON is preferred. The newer manifest wins if
both exist. Executable `pending.zsh` is not run implicitly: migrate its intended work into a reviewed
manifest first. Requests refuse to overwrite an existing pending request. Inspect `stage-result`,
`apply-result`, `plugin-sync.log`, `plugins-report.json` and `app-console.log` when an operation fails.

Plugin retirement first refreshes a no-longer-active seed to main. A seed is removed only when installed
root bytes match main and no owner's provisioning ledger still claims it as seeded. Otherwise the
canonical seed is retained, avoiding orphan deletion on older hosts. Installation/ownership ledgers and
local duplicate instances are never rewritten by these scripts. Marketplace takeover is a host action.

## Replacing an existing private setup

1. Back up scripts, manifest, previous-version reference and seed resources. Put personal choices into
   one config: author, Git identity, application/plugin checkouts, local refs, local plugin directories,
   region and runtime paths. Empty old plugin conf files become comments pointing to `localPlugins`.
2. Deploy a versioned tool bundle under a neutral tools directory. Point a stable `current` symlink to
   it. Old desktop commands/update-engine/plugin-sync/probe files become thin forwarding wrappers;
   keep their familiar names and the desktop shortcut. The bundle is a deployable copy, not another
   implementation to edit: subsequent updates replace the bundle from the repository source.
3. Forward the old build wrapper to `legacy-build` with `PERSONAL_CONFIG`. It accepts `--author`,
   `--exclude`, `--continue`, `SCRATCH`, and `OUT`; uses the same prepare/check/export commands;
   preserves conflict state; exports into a new directory instead of overwriting previous artifacts.
   `last-build.json` identifies the most recent wrapper build. Full check now includes typechecking.
4. Check the actual desktop wrapper's doctor result and perform plugin synchronization before claiming
   migration complete. Copy the old previous-version ref to `personal-build/<name>/previous`.
   Do not manufacture a new application target merely to migrate tooling.
5. The running shell keeps its already-loaded launcher. New wrapper dispatch is used by its future
   engine/plugin calls; the new launcher takes over on the next normal launch. Replacing scripts does
   not prove a cold application launch, successful marketplace takeover or data migration.

Windows/Linux use the portable workflow; the managed terminal/keychain lifecycle is macOS-specific.
Do not force the macOS adapter onto other platforms. Retain backups until a normal startup/update has
been observed; stop the managed application before restoring old wrappers and their matching manifest.

## Unattended updating: implemented developer path, gated rollout

The legacy managed launcher is not an unattended-update guarantee. Its rollback retains a Git
commit, but reuses the client directory/dependencies, synchronizes plugin seeds separately, and ends
probation at the first ready verdict. Candidate startup or package installation can still leave the
user without a working client. Do not enable a periodic restart job around this implementation and
call that recovery.

### Commands and current implementation

`automatic.mjs` implements the macOS supervisor and candidate preparation; `recovery.mjs` owns the
fsynced promotion journal. `personalBuildMonitor.ts` supplies a dev-only host heartbeat and normal-quit
handoff, explicitly requested by a launch generation. This does not enable the dormant Cindy Make
product or change the packaged updater. The configuration must contain:

```json
{
  "automatic": {
    "enabled": false,
    "intervalMinutes": 360,
    "startupSeconds": 900,
    "probationSeconds": 120,
    "requireRemote": true
  }
}
```

Keep `enabled: false` until an observed isolated recovery acceptance run passes. `auto-launch --config
FILE` starts the independent supervisor; after activation, the existing `launch` also delegates to it.
`auto-check` prepares one candidate, `auto-status` reads its state, and `auto-recover` starts the separate
known-good receipt without requiring a readable promotion journal. Successful manual recovery archives the old journal and pending candidate, then restores a stable journal. Run these commands through the
neutral deployed tool bundle in Terminal (a live TTY is required, including background preparation inherited from the supervisor). Headless invocation fails before starting a version. No launchd job or persistent restart service is installed.

`automatic.mock: true` is available only for isolated acceptance profiles with `requireRemote: false`; it cannot be used with a shared profile. It exercises the same supervisor/startup path using the repository mock flag. Never use that acceptance result as evidence of live remote connectivity.

The supervisor first establishes a known-good generation from a verified startup. Preparation creates
another complete worktree with its own dependencies. It runs the existing checks, materializes runtime
assets, and performs an isolated mock startup before publishing candidate.json. Preparation failure
leaves current/known-good untouched. A host heartbeat must be fresh, from the exact launch generation
and PID, and match whoami's checkout/commit/data directory/region. Readiness plus a default 120-second
observation period is required before promotion. Remote relay availability is also required by default.

The first compatibility gate deliberately defers changes to migration artifacts, plugin seeds,
dependency manifests/lockfile, Desktop main/preload code, shared packages, startup scripts or dependency patches. Equal SQL filenames alone are
insufficient. This allows automatically verified presentation changes while backend/data/runtime
changes wait for a separately reviewed baseline update. It is conservative, not a proof that arbitrary
new application code can never affect persisted data. Do not expand the gate by treating absence of a
migration file as full compatibility.

The host reuses the complete relaunch activity probes (including scheduler, background work and remote
controllers), rechecks after awaits, and uses normal app.quit. The supervisor never treats a missing
heartbeat as permission to terminate an active version. Candidates without the heartbeat protocol are deferred. Upgrading an old baseline to include the host monitor is an explicitly observed bootstrap update before unattended activation. A normal user quit is respected; no infinite respawn loop.
Bad candidates are recorded by content identity and skipped. Lock reclamation is serialized; an interrupted lock critical section fails closed and needs inspection of the `.guard` directory before retrying. An interrupted trial is rejected on next
supervised start. Recovery failure moves to blocked instead of repeatedly cycling versions.

Once a supervised journal exists, legacy apply/rollback/seed synchronization cannot mutate retained
versions. Good/current/candidate directories are not automatically deleted. The tool bundle supervising
an update remains pinned; this rollout does not automatically replace its own recovery implementation.
The old private launcher backup remains the independent bootstrap recovery route.

Real cold-switch/rollback and compatibility acceptance remain required before enabling this on the
live shared profile. Unit/state-machine success and a mock startup are distinct evidence, not a claim
of a completed live upgrade. The following target constraints describe the complete acceptance bar;
where stronger than the implemented conservative path, they remain rollout requirements.

### Target behavior and initial rollout boundary

- Keep immutable version directories for the application, its installed dependencies, plugin seeds
  and a tool-bundle manifest. Keep current, candidate and last-known-good references. Never overwrite
  the only working installation. Preserve the original private setup until recovery is exercised.
- A small independent supervisor lives outside those directories and does not load application code
  to select/recover a version. The candidate updater must not be its own only recovery path. Changes
  to the supervisor itself require a separate verified handover; do not upgrade both recovery
  generations together. This is a developer-launcher workflow, not a second packaged-app updater.
- Discover the configured application/plugin base and personal PR SHAs together. Prepare a complete
  candidate away from the active checkout. Detect unchanged inputs without recomposing/restarting;
  local plugin hashes participate in the identity. Record conflict and check failures without
  modifying the current pointer. Network/auth/disk failures leave the current version available.
- First validate dependency installation, build/check results, bundle integrity and an isolated
  application startup. An isolated test proves startup capability, not compatibility with the live
  user's data or working remote connection. Recheck those conditions before promotion.
- Initial unattended switching permits only updates with compatible persisted-data behavior and no
  pending DB_SCRIPT. Compare migration artifacts as well as schema history, retain the repository's
  migration-policy gate, and defer unknown compatibility. Database migration and new system/keychain
  permission requirements stay prepared/pending for explicit handling. Equal migration names alone
  are not proof of full backward compatibility.
- Stop accepting new work through a host-supported update handoff, drain current work, and recheck
  exclusivity before switching. A single read of the busy-session count is not a race-free drain.
  If that handoff is unavailable, keep the candidate for a normal shutdown/start instead of killing
  the active application. Missing/failed idle evidence must never become an idle verdict.
- Persist a switching journal before changing a pointer, atomically select the candidate, and start
  exactly that generation. Prove process identity, window/auth/database readiness and, for remote
  operation, host-side device-link readiness. Correlate every signal with a launch generation/nonce;
  a stale log line or merely surviving process is not success. Keep startup deadline and a subsequent
  health observation period before committing last-known-good.
- On failed startup, timeout, wrong identity or probation crash, stop only the candidate process,
  restore the last-known-good version when data compatibility is still valid, and record a rejected
  candidate identity. Do not repeatedly retry the same bad update. Avoid infinite fallback loops:
  if recovery also fails, preserve the evidence and offer an independent recovery entry.
- Plugin application can mutate installed plugin files/ledgers/preferences. A seed-directory backup
  alone cannot guarantee plugin rollback. Use the host's install ownership/data contracts for an
  explicit transactional update or defer that plugin promotion; do not restore plugin ledgers/files
  behind the running host. Automatic code rollback must not erase user work created after startup.
- Journal interrupted phases so a subsequent launch can recover after process termination/reboot.
  Keep a recovery command that needs neither a working renderer, network nor dependency installation.
  Protect known-good slots from automatic cleanup. Disk exhaustion and corrupt state must preserve
  the old pointers and provide a readable recovery result.

### Verification before enabling on a real profile

Fault-inject incomplete preparation/download, conflicting PRs, failed installation, corrupt bundle,
process termination at each journal/pointer boundary, stale ready signals, startup timeout, probation
crash, a rejected candidate discovered again, busy/unknown task state, DB incompatibility, and a failed
fallback. Assert the selected version and preservation of user data rather than only exit codes.

Then exercise a real isolated start, forced candidate failure and successful offline recovery on the
actual macOS toolchain. Validate host drain/device-link readiness and plugin transaction behavior before
claiming unattended switching for a shared remotely operated profile. The live profile's first switch
must be an observed acceptance run with a usable external recovery entry. Until then, report the feature as implemented but awaiting shared-profile activation and keep automatic activation off.


### Recorded isolated acceptance (2026-11-07, macOS)

The actual supervisor launched a clean snapshot with its own pnpm installation and an isolated mock
profile, and established the initial known-good receipt. Normal app exit ended supervision without a
respawn. A second independently installed snapshot differed only in a disposable fixture document;
its candidate receipt was explicitly marked as a fault-injection fixture (this did not exercise GitHub
discovery or candidate preflight). After its real window/database readiness and first health observation,
the test terminated only that candidate's Electron process. The supervisor rejected that content ID,
restarted the original directory, waited for its fresh process/generation health signal, and restored a
stable journal. An isolated user-data sentinel survived. Both test instances then exited normally.

The run found and fixed the non-TTY startup problem: `/dev/null` ended Forge before window readiness,
and macOS script rejected Node socket-backed stdin. The supervisor now requires the same live Terminal
input as the existing `.command` launcher and passes it to preparation children. Its PTY dimensions are
set explicitly. Runner shutdown checks the PTY child process groups, not just the outer script PID.

Related runner suites passed (122 tests), the host monitor tests passed (2 tests), and Desktop typecheck
passed. The repository-wide test-hygiene command remains blocked by the existing baseline increase for
`pi-extra-dirs-prompt.test.ts` (sourceReads 0 to 1); the baseline is unchanged in this work. Direct hygiene
scans of all four new test files report zero violations. This is not a passing full hygiene gate.

Still unverified: shared-profile bootstrap/handoff, live remote reconnection during a switch, offline
recovery, and the full fault matrix above. Automatic activation remains disabled for the live profile.


### First observed health-bridge handover

`auto-bootstrap --config FILE --report BOOTSTRAP_REPORT` is an explicit operator handover, not an
automatic-update exception. The report must name the observed ready original checkout, a separately
checked and smoke-started candidate, and the exact region/data profile. Both directories are reverified
before use. The candidate must descend from the baseline, retain identical migration/runtime/plugin
fingerprints, and change only the host health monitor, its test, bootstrap wiring and restart environment
forwarding. Other backend changes are rejected. Unattended updates must remain disabled.

The original process must have exited normally before calling it. The supervisor preserves that original
checkout as the first known-good version, tries the candidate through the same startup/probation/recovery
path, and retains the stable journal for subsequent launches. The desktop entry then follows the journal;
`doctor` reports the selected checkout rather than confusing the retained original with the active choice.
A failed first candidate restores the original directory. This path does not migrate a database, install
an official release, or enable the old Cindy Make product. A one-use external Terminal handover can wait
for current turns to finish and quit the explicitly selected source instance after the user has selected
that developer-launcher method; it must not install a persistent restart job or force-kill an unknown PID.
