# Developer-only personal builds / 开发者自用 Cindy

> Audience: contributors maintaining their own Cindy from source. This is optional developer
> tooling, not an end-user edition, installation prerequisite, or the official app updater.
> 普通用户继续使用官方应用及其更新流程；无需源码、GitHub PR、Xcode 或开发者证书。

`pnpm personal:build` combines an application repository's default branch with the authenticated
GitHub user's open PRs (including drafts), and optionally does the same for plugins. It works from
existing checkouts, without fixed usernames, home directories, signing identities or a cloud service.
Node.js, Git 2.38+, Git LFS, pnpm and authenticated GitHub CLI are required.
Use the versions in the root package manifest. No token belongs in the configuration.

这是开发脚本，不是正式应用更新器。默认使用仓库现有的隔离数据启动入口；不会替换已安装的
Cindy。只有显式配置的 macOS 托管模式支持沿用共享数据和排队更新；不会自动放行未合并 PR 的数据库迁移。
Mac、Windows 和 Linux 共用 Node 入口；运行应用仍取决于各平台的现有开发工具链。

## Scope and Push prerequisites

“个人版”在本文中特指开发者组合自己的源码与 PR、自行构建和维护的 Cindy，不代表另一款
面向普通用户的产品。入口只保留在开发文档的高级工具区；根 README、普通安装说明、应用
帮助和设置无需引导用户配置它。桌面源码预览与 iPhone 交付可分别使用：仅维护桌面版时，
可继续搭配官方手机版，无需准备自己的 iOS 签名。本脚本不改变官方发布或默认更新路径。

个人手机版不一定使用 sandbox；APNs 环境由最终签名与描述文件决定，不由“个人版”、
Release 优化或手写的 `isDevBuild` 决定。开发签名对应 sandbox，Ad Hoc 分发签名对应
production。**有安装证书并不等于具备服务端 Push 权限**：

| 使用方式 | Push 的前提 |
| --- | --- |
| 官方手机版（包括搭配开发者自己的桌面版） | 使用官方发布与推送配置，用户无需开发者证书；仍需登录并允许通知。 |
| 团队授权的个人手机版，保留该团队的 App ID | 需该团队授权的签名和设备描述文件，以及服务端对该 App ID / topic、APNs 环境有效的提供方凭证与路由。无需借用某位贡献者的私人证书；由团队按权限配置。 |
| 开发者自己的 Apple 团队与 App ID | 可以实现 Push，但需自己团队的签名、所需 capability 和匹配的 APNs 提供方服务。官方中转不承诺接收任意自签 App 的 token 或提供其 Push；修改 Bundle ID 或切到 production 并不会获得官方服务授权。 |

这个构建工具不提供多租户 APNs 凭证托管，也不配置或部署自建推送服务；仅有自己的 Apple
开发者账号仍不足以完成端到端 Push。不得共享签名私钥、APNs 提供方密钥或把它们写进配置。
APNs 提供方凭证留在发送服务，手机构建只使用本机授权的签名材料。

一次开发签名包的 Apple Console 直达测试可以成功，而同包经应用服务发送仍可能失败。
这只能把排查范围缩小到注册、环境路由或发送服务，不能据此断言 sandbox 不支持 Push。
已验证的替代路径是 Ad Hoc production 包通过 Cindy 正常链路送达；此结果不等于 sandbox
服务端根因已查明，也不保证其他团队无需配置就能复现。

依据：[Apple APS environment](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment)、
[APNs provider authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)。

## Quick start

### Choose the scope before setup

| Scope | Prerequisites and behaviour |
| --- | --- |
| Compose and check source | Your own GitHub login, repository checkout and the repository's Node/pnpm toolchain. App-only is supported; neither a plugin repository nor a phone is required. |
| Isolated Desktop preview | The platform's existing Desktop development prerequisites. Uses separate app data; it does not adopt a running official installation. |
| Stable signed Cindy identity | Currently Apple-silicon macOS 27.3+ with a compatible SDK and your own usable developer signing certificate. Older/other platforms record native capabilities as unsupported; they do not receive this fixed signed app path. |
| Shared-profile supervised upgrades | Explicit macOS runtime configuration, an independently installed Node toolchain and a live Terminal. Uses the existing regional profile only after an observed first setup; automatic switching stays disabled by default. |
| Personal iPhone delivery | Optional macOS/Xcode/CocoaPods setup, an authorized physical device and an Apple team able to provision the app and its required capabilities. Signing or entitlement failures must be resolved with that team's provisioning; the builder does not remove capabilities. |

Start with the app-only isolated preview below. Add plugins, a shared profile and a phone independently
after that works. The script can be operated by a Cindy task, but machine permissions, Apple sign-in
and signing authorization still belong to the user. This does not require another contributor's local
launcher, account, certificate, receipt, database or private endpoint file.

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

### Keep personal configuration local

Before adopting shared-profile upgrades, fill in the existing [runtime configuration](#macos-managed-launcher-one-lifecycle)
and check the values on the target computer:

- Choose the repository whose PRs you intend to include and your GitHub author. `init` captures the
  current author; omit `author` only if following the active CLI account on each preparation is intended.
- Leave `localRefs`, `exclude` and `localPlugins` empty unless explicitly needed. They are local choices,
  not a list of branches or plugins every contributor must reproduce.
- Select the regional profile using the repository's startup path resolver. Do not copy another
  machine's `dataDir`; shared mode uses existing login/data, while isolated mode has its own profile.
- Choose a stable `name`, region and `runtime.personalApp`. Changing name/region changes the bundle
  identity; changing the signing certificate requires an explicit identity migration.
- Obtain your public certificate fingerprint with `security find-identity -v -p codesigning`.
  Set `CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY` in the launcher environment when multiple certificates
  exist. Private keys/passwords stay in Keychain/Xcode, never in JSON or the repository.
- `runtime.node` and optional `toolPaths` refer to your installed tools, outside generated application
  checkouts. Homebrew, a particular home directory and a particular Xcode installation name are not
  requirements; `DEVELOPER_DIR` can select a compatible Xcode for this process.
- Keep config, generated reports, signed apps, mobile provisioning files and deployed tool bundles
  outside tracked source. Only generic scripts/tests/documentation belong in a PR.

For repeated upgrades, deploy `bundle-tools` to a new external directory and invoke that immutable
tool entry. Use a new build directory for each `upgrade-check`. A local shortcut or `current` link is
optional operator setup, not a prerequisite or an automatically installed background service. Do not
replace a running tool bundle; switch your shortcut only after the new version passes acceptance.

The supervised workflow starts with an already prepared client and an explicit normal stop of any
instance using its profile; `auto-launch` establishes its first known-good journal. Later upgrades use
`manual-check` and `manual-restart` as described below. Legacy mutable commands are retained for existing
setups; new immutable candidates do not need a personal SQL repair script or an old manifest copied
from another installation.

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

### macOS input permission identity

Signed personal runtimes also embed `cindy-macos-desktop-input` under
`Contents/Resources/tools/remote-desktop`, signed with the shell's developer certificate.
The native receipt declares `capabilities.desktopInput`; source-mode Main then uses that
sealed executable instead of compiling an ad-hoc copy in the profile cache. A declared but
missing helper fails permission detection rather than silently changing identities. Both Swift
sources participate in the runtime cache key so native changes rebuild the shell.

The personal helper's compile-time caller mode accepts only its enclosing signed personal app,
matching its team, exact Main executable, sealed helper bytes and kernel-audited stdio peer.
It does not claim the hardened security boundary of official builds: personal source apps still
run writable JavaScript. Official helpers retain their existing bundle allowlist and hardened
runtime requirement; ordinary development checkouts retain their existing development binding.

The system's app switch is not acceptance evidence. After an authorized switch, check screen
recording and the actual input helper separately. Existing macOS grants may need user renewal;
never edit the TCC database, substitute Main's grant for the helper probe, or report a grant merely
because the app is signed. Building and isolated probing must not restart the active instance.

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

## Personal iPhone companion delivery

The optional mobile step consumes the **same `report.json` and frozen source commit** as Desktop.
It never discovers another PR list, skips a draft, changes the Desktop restart decision, or enables
the unattended supervisor. This is local developer delivery, not App Store, TestFlight or OTA.

Set `mobileConfig` to a JSON file outside the repository (relative to the personal config):

```json
{
  "enabled": true,
  "platform": "ios",
  "region": "global",
  "bundleId": "com.example.personal",
  "appGroupId": "group.com.example.personal",
  "teamId": "ABCDEFGHIJ",
  "signingCertificateSha256": "YOUR_64_HEX_CERTIFICATE_FINGERPRINT",
  "deviceId": "EXACT_DEVICE_ID_FROM_CINDY_SIMULATOR",
  "hardwareUdid": "HARDWARE_UDID_FOR_PROVISIONING",
  "stateDir": "./mobile-state",
  "launchAfterInstall": false,
  "verifyInstallationMetadataOnly": true
}
```

An inline `mobile` object is also supported; do not configure both. `configFrom` resolves the shared
file into the upgrade snapshot. Changing it later cannot retarget an existing candidate. An optional
`regionConfigFile` points at the existing Mobile region-config format; credentials stay in Apple/Xcode
and are never placed in this JSON. Bundle ID, signing team/certificate, App Group and exact physical
device are explicit, with no personal account defaults in the repository.

`check` automatically follows successful Desktop checks with `mobile-build` when enabled, including
when called by `upgrade-check` or `auto-check`. A mobile failure is recorded separately in
`report.mobileDelivery`; Desktop remains checked. Each native build attempt has a new artifact directory
and a monotonic build number from the configured state directory. A failed attempt may be resumed with
`mobile-build --report BUILD_REPORT`; it keeps the PR snapshot and does not overwrite earlier artifacts.
The source report must describe a composed, disposable checkout; generated ignored iOS files are
regenerated there. Tracked native sources are refused before `prebuild --clean`.

Build uses Release mode, the existing endpoint/region loader and CocoaPods setup, and Xcode's exact
physical-device destination (not `generic/platform=iOS`).
Automatic provisioning uses the `Apple Development` certificate class: Xcode rejects an explicit
SHA-1 identity with automatic signing. Before delivery, every signed bundle must still match the
configured certificate fingerprint and its provisioning profile; a different certificate blocks
installation, even when Xcode reports a successful build.

For production APNs on a registered personal iPhone, set `mobile.distribution` to `ad-hoc`
and pin the existing trusted **Apple Distribution** certificate with `signingCertificateSha256`.
The default remains `development`; Release optimization alone does not select production APNs.
Ad Hoc builds archive first, then export using Xcode's `release-testing` method (the current name
for Ad Hoc). This does not upload to App Store Connect or TestFlight. The exported app, not the
development-signed archive, is passed to the device plugin. Export preserves the build number.
All four exported bundles must match the distribution certificate pin, authorize the selected
device, and disallow debugging. Enterprise profiles are rejected. The main signature and profile
must both say `aps-environment=production`; development builds must say `development`.

If Xcode is signed in and can manage all four profiles, automatic export remains the default.
For already provisioned profiles (for example, when Xcode has no signed-in account), optionally set
`mobile.exportProvisioningProfiles` to the exact four Bundle IDs mapped to local profile names or UUIDs:

```json
{
  "distribution": "ad-hoc",
  "exportProvisioningProfiles": {
    "com.example.personal": "Personal Ad Hoc",
    "com.example.personal.CindyNotificationService": "Notifications Ad Hoc",
    "com.example.personal.CindyHomeWidgets": "Widgets Ad Hoc",
    "com.example.personal.expo-sharing-extension": "Sharing Ad Hoc"
  }
}
```

This fragment extends the existing mobile configuration; replace the example IDs with your configured
`bundleId` and the names with your own installed profiles. Do not commit actual profiles or private keys.
An incomplete map or a map used with development distribution is rejected. Manual export uses the
existing `Apple Distribution` identity class and installed profiles without requesting provisioning
updates. The archive step still uses automatic Apple Development signing and needs the corresponding
local build materials or an authorized Xcode account; manual export does not provision those for you.
The configured SHA-256 pin always applies to the final exported bundles. No failed export is silently
switched to development, another team or another certificate. Remove the map to restore automatic export.

Changing distribution requires a new frozen build report and a full native installation. Keep
the existing team, Bundle ID, App Groups and keychain access groups when replacing an installed
app; compare those signed entitlements before delivery. Do not uninstall the existing app to
change signing. Its APNs token may change: open the newly installed app so it registers again,
then test the normal server path. Production signing alone does not prove server credentials or
notification delivery. Private keys remain in Keychain/Xcode, never in the configuration.

Persist a successful distribution choice in the source configuration used by the next `prepare`,
including a separate mobile configuration if configured. Updating only a one-off export request
does not change future builds. Back up the source configuration, retain historical reports unchanged,
and use a tool bundle that understands `distribution` and validates the final exported certificate.

Acceptance has separate receipts: signed artifact, installed build identity, registration outcome,
normal server-path delivery, and task completion/deep-link behavior. For the last step, lock the
phone without force-quitting Cindy, finish a real desktop task while the desktop window is not
focused, then confirm both notification receipt and navigation to that same task after tapping.
A synthetic notification or Apple Console delivery does not cover the completion trigger or routing.

#### Migrating an existing SHA-1 certificate pin

New configuration uses `signingCertificateSha256` (64 hex characters). SHA-1-only and mixed
SHA-1/SHA-256 configurations are rejected with migration guidance, including direct artifact checks.
There is no weak-hash fallback. Keep historical reports and requests unchanged; after migration,
prepare a new build rather than rewriting a frozen report.

Export the **previously trusted signing certificate** as DER from Keychain Access (public certificate
only, no private key). Confirm its identity against the certificate selected for the existing setup;
do not establish trust from an unverified new candidate. Compute its SHA-256 fingerprint:

```sh
openssl x509 -inform DER -in trusted-certificate.cer -noout -fingerprint -sha256
```

Remove colons from the fingerprint, set `signingCertificateSha256` in the source mobile configuration,
and remove `signingCertificateSha1`. Back up that configuration first. A SHA-1 digest cannot be
converted to SHA-256 without the certificate. If the original trusted certificate is unavailable,
stop and explicitly select a replacement signing identity; never pin whichever certificate a new
build happens to use. The archive/build step selects the `Apple Development` class; Ad Hoc export re-signs with
`Apple Distribution`. All four final bundles must match the configured SHA-256 pin and the
profile's authorized certificate bytes before delivery.
This configuration migration does not change the signing identity, install an app, or restart it.

APNs registration uses the installed native provisioning environment, never JavaScript `__DEV__`:
a Release build signed for development registers with sandbox APNs. Artifact verification requires
`aps-environment` to be `development` or `production` and to agree between the code signature and
the embedded provisioning profile; `verification.json.pushEnvironment` records the signed and
registration environments. Missing or mismatched values stop delivery. The existing ExpoApplication
reader is reused without adding native dependencies; App Store re-signing without an embedded profile
uses its native App Store release type. Unknown signing environments do not upload a token.
This check does not prove server APNs credentials, notification permission or physical delivery;
those require a separately authorized real-device push test.

All three shared-container readers and
entitlements use the configured App Group. Every extension is checked independently: a main-app deep
signature check alone can miss a provisioning file replaced by incremental Xcode signing. Verification
checks profile expiry, certificate, team, App ID, device authorization, App Groups, embedded JavaScript,
version agreement and disabled OTA. No Apple capability is deleted to get past a signing failure.

### Cindy task continuation (installation stays in the device plugin)

1. Inspect `mobile-status --report BUILD_REPORT`; after a build, run `mobile-next --report BUILD_REPORT`.
2. Execute its `next` object through `ghost_call` for `cindy-simulator`. Only `devices`, `app info` and
   `app install` can be emitted. Save the actual receipt outside the source tree, then call
   `mobile-record --report BUILD_REPORT --action devices|info|install --receipt RECEIPT`.
3. Repeat `mobile-next` after recording each result. Offline devices remain `awaiting-device`; end
   this task's attempt and resume on the next explicit update/continuation. Do not spin or create a
   background schedule. A newer installed version ends as `superseded`, without downgrading.
4. Installation intent is persisted before returning the install call. If the task is interrupted,
   the next action is **read installed metadata**, never repeat installation blindly. An old/missing
   installation after an uncertain result becomes `installation-unconfirmed`; investigate the original
   operation before retrying. A successful install receipt still requires a matching metadata read.
5. `installed-metadata-verified` proves the phone reports the intended bundle/version. It does not prove
   every installed byte matches, login works, remote service works, or notifications work. Do not launch,
   screenshot or test phone UI as part of this flow. Never uninstall either identity or clear its data.

The native builder and Desktop supervisor do not call the plugin themselves. **A Cindy update task owns
the installation continuation**; when no task is running, the package simply remains pending. There is
no newly enabled daily schedule, always-on device watcher, silent phone rollback or implicit Desktop
restart. Keep Desktop and mobile results separate in the final report.

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
[discovery policy](../../ghost-progressive-discovery.md#22-日常调用的-publiclocal-版本选择).
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

Both the legacy launcher and supervised terminal source `credential-signing.zsh` before invoking
the restart wrapper. It resolves `CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY` from the explicit
environment, interactive shell, a previously signed credential helper, or the sole available developer
certificate, in that order. Multiple unselected certificates remain ambiguous. This is the remote
desktop credential helper's identity, not the Electron application's signature. `remoteReady` only
proves device-link connectivity; it does not prove saved-credential automatic login. A changed launcher
does not inject environment variables into an already running host: verify helper signing and remote
login separately after the next authorized safe restart.

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


### Explicit manual upgrade after the health bridge

When the user requests an immediate upgrade that changes backend/runtime/plugin content, use
`manual-check --config FILE --report BUILD_REPORT --out NEW_MANUAL_REPORT` followed, after the old
instance exits normally, by `manual-activate --config FILE --report NEW_MANUAL_REPORT`. These commands
do not enable automatic updates and do not pretend that the automatic compatibility gate passed.
The checked build, exact baseline/candidate/profile, unchanged migration fingerprint and isolated
startup proof are required. A failed/rejected candidate cannot be silently retried. The existing
restart wrapper still enforces profile exclusivity and runtime startup checks.

Manual activation journals an explicit manual rollback policy before starting the candidate. It
requires the same continuous readiness/remote-health probation before promotion. Failure/interruption
after any spawn attempt blocks further starts instead of launching old code against potentially changed data; the independent
rescue receipt also marks rollback compatibility unverified until successful promotion. This does not
restore or overwrite databases, credentials or plugin ledgers. Preserve both version directories for
inspection. A caught failure proven to precede any spawn attempt can restore the old version;
its result is `recovered`, not `verified`. Missing readiness or an interrupted supervisor is not that proof.
This path does not accept changed migration artifacts or private database scripts.

For an explicitly authorized immediate restart, use the single Terminal command:

```sh
node scripts/personal-build.mjs manual-restart --config FILE --report NEW_MANUAL_REPORT --expected-pid OBSERVED_PID --out NEW_HANDOFF_RECEIPT
```

This command acquires `supervisor.lock` **before any shutdown**, validates the frozen candidate,
isolated proof, baseline and launch profile, then rechecks the exact ready PID before sending normal
SIGTERM. It retains that same lock through shutdown, startup, health probation and the new supervisor's
lifetime. Never generate an external script that quits the app before calling `manual-activate`, or
check the lock and release it before quitting: either can leave no working app when another supervisor
wins the lock. `manual-activate` remains available after an independently requested normal quit.

A live supervisor owner causes `manual-restart` to fail before touching the app. Do not delete its lock,
kill an unverified PID, or stop the app to get around it. With an older already-running supervisor,
use the explicit `supervisor-release` command when supported. An older supervisor without the
control protocol needs an independently verified normal exit; the app must remain running. Compatible supervisors accept a generation-bound cooperative release request; older supervisors fail closed. A competing launcher can
still win the lock, but then this command leaves the current app running. Dead owners are reclaimed by
the existing lock implementation, never by the handover script.

The output receipt is created exclusively: use a new path for each approved attempt. It records
`blocked-before-stop`, `stopping`, `shutdown-unconfirmed`, `starting`, `activation-failed`, `recovered`, or `verified`.
A crash leaves the last durable phase; inspect the receipt, journal and actual processes instead of
replaying an old restart command. `verified` requires continuous readiness/remote-service probation,
not phone UI testing. A startup failure keeps the existing manual rollback policy; it does not blindly
launch old code against possibly changed data. No force kill, fabricated idle result, automatic enable,
or persistent restart job is added. A current restart confirmation is still required when tasks run.

`desktop-whoami` exit 1 means no matching ready instance, not necessarily a scan failure: parse
`processScan.ok` and use `--all` when checking shared profile exclusivity. Record no-instance,
readiness, and scan errors separately. Regression coverage is in
`scripts/__tests__/personal-build-recovery.test.mjs`.

### First observed health-bridge handover (legacy bootstrap)

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

### Native capability acceptance for source personal builds

`check` also prepares native Live Activity components on Apple-silicon macOS 27.3+.
It uses an explicitly selected `DEVELOPER_DIR`, or discovers a compatible installed Xcode
without changing `xcode-select`. A missing SDK or skipped required component fails the check.
Older systems record `unsupported`; startup readiness is not complete feature acceptance.

The source addon alone is insufficient: the candidate's own Electron app must contain the
WidgetKit extension, Live Activity plist declaration and silent alert sound. The builder copies
Electron before changing it (pnpm store hard links must not affect another checkout), retains the
original runtime, preserves the extension's sandbox signature, and verifies the resulting bundle.
It refuses a running candidate. No installed application or user data is modified.

`resources/personal-native.json` records SDK, capability state and artifact hashes. Supervised
release identity includes this receipt and validates its files before activation. Missing/replaced
native artifacts invalidate the candidate. A rebuilt native runtime can therefore be a distinct
release even when its source commit has not changed. Test actual Live Activity availability after
isolated startup; do not equate a built addon, a visible setting, or `remoteReady` with a rendered
system activity. New macOS native personal builds use the same developer certificate resolver as the remote credential helper.
The main app, nested Electron code and WidgetKit extension are signed inside-out; the extension retains
its sandbox entitlements. Ad-hoc signing is no longer an accepted final identity for new native builds.
Previously checked receipts remain readable for recovery; do not rewrite a live or approved bundle.

Native source builds launch through macOS LaunchServices within Forge's existing startup wrapper.
Directly spawning the Electron executable leaves ActivityKit without an application identity even
when the addon and extension are present. `open -W -n` inherits the launch environment without
putting credentials in arguments/files; the early main import restores Forge's working directory.
The personal app bundle identifier is stable for a configured name/region and distinct from generic
`com.github.Electron`, whose LaunchServices record can resolve to another development checkout.
The profile and credential-helper identity remain separate. Changing from the generic identifier
may require fresh macOS privacy permissions; never grant or bypass those automatically.

Personal native bundles set `CFBundleDisplayName` to `Cindy` and use the repository's
`icon.icns` before signing, so macOS does not prefer Electron's inherited display name
and icon. The icon is included in the capability receipt. This display-only branding
does not rename the executable/helpers, change the stable bundle identifier, or alter
the profile / safeStorage identity. Existing checked candidates are immutable: prepare
and check a new candidate to apply branding; do not patch a running or approved bundle.


### Upgrade-start snapshots

Every new upgrade starts with `upgrade-check --config FILE --out NEW_DIRECTORY` (or
`prepare`, then `check` and `manual-check`). It queries the current main branch and every
open PR by the configured/authenticated author in both repositories, including drafts,
before composing either repository. Merged PRs arrive through main; closed unmerged PRs
are omitted. Only explicit configured exclusions may omit an open PR. Local refs are
resolved to commits at the same preparation stage.

The report stores `upgradeSnapshot` with capture time, author and both complete selections.
Build, conflict continuation, isolated startup and activation use that fixed snapshot.
New commits during the build belong to the next upgrade, not an endless rebuild loop.
`continue` resumes the same attempt without querying GitHub again. Every new `prepare`
queries again and requires a new output directory. Never clone an older report to begin
another upgrade. Old reports without snapshots must be prepared again for upgrade.

`snapshot --config FILE --report BUILD_REPORT` verifies that the composed PRs, commits,
local refs and exclusions exactly match this attempt. Manual and automatic activation
use this offline check plus artifact/commit verification. `freshness` remains an optional
live comparison for diagnostics, not a switching gate. Existing known-good launch and
recovery stay available offline. Conflicts/check failures remain visible and never
silently drop a PR. Capturing a snapshot does not authorize a restart.


### Shared signed runtime and independent business releases

On supported native macOS builds, `check` prepares a signed runtime in
`<stateDir>/runtimes/<personalBundleId>/versions/<inputHash>/Cindy.app`. Without managed
runtime configuration, the store is under `~/Library/Application Support/CindyPersonal`.
The hash covers the original Electron bytes/version, architecture, native sources and
assets, SDK/compiler, build logic and signing certificate. Business commits, PR lists and
plugin bundles are deliberately not runtime inputs. Equal inputs reuse the exact signed
bundle at the exact same path; changed inputs produce another immutable bundle. Never
patch a cached or running runtime, re-sign on every launch, or prune previous runtimes
as part of preparation. Full contents and developer signature are verified before reuse.

Each independent business checkout records its runtime and native-resource hashes in
`resources/personal-native.json` (version 2). Forge launches that runtime through the
existing LaunchServices wrapper, passing the explicit business checkout. Process discovery
uses both the shared executable and the business path, and readiness still requires a live
renderer for that checkout. Multiple checkouts sharing a runtime must not be mistaken for
one process. Ordinary non-personal development and existing receipt v1 launches are retained.

The shared-profile supervisor installs a **physical directory**, not a runtime-cache symlink,
at `runtime.personalApp` (default `~/Applications/Cindy Personal.app`; ` CN` / ` Dev` suffix
for those regions). Both the installation path and the actual launched executable stay fixed
when native dependencies change. `runtime.installedApp` still denotes the official app and
must not equal this personal destination. Existing ordinary applications at the destination
are never adopted/overwritten. Isolated previews continue to launch the immutable cache and
never install/replace the formal entry automatically.

`fixed-install.mjs` copies and verifies the signed candidate next to the destination, then
records a durable transition before renaming anything. The old physical bundle is retained
under the immutable runtime store’s `install-backups/previous-<uuid>.bundle`, outside
Applications; old runtime caches and business journal pointers are also retained. The store must
be on the installation volume so renames remain atomic. Existing version-1 sibling transitions
can still be completed; legacy backups are reported by `doctor`, never silently deleted.
An unchanged runtime is verified and reused without replacing its directory. A changed
runtime requires the exact installed app to be stopped, the same Bundle ID and developer
certificate, and the existing supervisor profile/stop guards. Changing signing identity is
an explicit migration, not an automatic fallback. A retry completes an interrupted recorded
filesystem transition, including a crash between moving the old bundle and promoting the new
one. Invalid or missing artifacts stop recovery for inspection; no unknown files are replaced.
The shared owner lock also serializes different configurations targeting the same app path.
This is installation recovery only: business rollback still requires data compatibility.

The launch wrapper verifies the installed receipt, full contents and developer signature
against the selected business release before opening the fixed path. The fixed app setting
is forwarded explicitly to Terminal and stale inherited values are cleared for previews.
Process discovery binds the physical executable to its installation receipt and business
checkout; a changed location must not make a live instance invisible or another checkout ready.

Continue using the personal launcher to supply the selected business release and its interface
server. The fixed runtime is not a standalone packaged business app; double-click-only cold
startup without the personal launcher is not implemented. Automatic switching stays opt-in;
preparation never authorizes a restart or enables it. Moving from an ad-hoc shell to a developer
identity can require macOS permission approval once; signature verification does not prove
privacy permission or remote login works. This is local signing, not notarized public distribution.

The supervisor and dev server share one Terminal window. It passes live stdin and
`--reuse-terminal` to `desktop-restart-runner.mjs`; coordinator output still goes to the
generation's `console.log`. The repository wrapper writes dev output directly to that input
terminal, using one `script` PTY with the existing bounded `apps/desktop/logs/dev-terminal.log`
drain. It does not open another Terminal window. Missing terminal input fails before stopping
anything; ordinary headless developer launches retain their existing new-window behavior.
Do not add another detached PTY or pipe PTY output through the supervisor: a blocked/lost
consumer can leave Electron alive after Forge/Vite exits and produce a white window.
A nonzero wrapper exit immediately fails acceptance even if a main PID remains.
A successful wrapper exit means readiness only, not the end of the running app. The interface
still uses the development server; prebuilt static UI delivery is not part of this change.


Manual shutdown retains the observed original PID until the OS reports it gone, in addition to
waiting for the instance record and launch runner to disappear. `will-quit` can remove the record
before the process ends; that gap must not authorize installation. The wait is bounded at 60 seconds;
unknown observations or timeout stop the switch without a forced kill. Fixed-app installation checks
`ps` executable paths (`comm`), not text anywhere in command arguments, and reports blocking PIDs.
A diagnostic shell/grep mentioning the app therefore cannot masquerade as its running main process.
Regression coverage: `personal-build-recovery.test.mjs` (original PID outlives metadata, timeout,
unknown observations, and executable-path ownership).

### Personal app open events and push diagnostics

The signed personal runtime declares the current and legacy Cindy URL schemes, folders and
`.cindy` cartridges before signing. File types use Alternate rank: do not take over the official
app's defaults. This repairs Finder eligibility for an already running personal client, not
standalone cold startup: keep using the personal launcher when the runtime is stopped.
Test cold-start routing separately before changing default handlers. Never edit the installed
app's Info.plist in place: that breaks its signature and runtime receipt.

Mobile debug recording includes non-secret push registration stages, realm, app variant, APNs
environment and numeric HTTP failure status. It never records the native token or authorization
headers. A registered event confirms only registration, and a desktop notify-sent log confirms
only enqueueing; neither proves APNs acceptance or notification display. Verify provider logs
and the target phone before calling delivery successful.


## 个人版交接与故障验收（2026-11-10）

这套流程面向具备源码、GitHub 登录与本机签名环境的贡献者；目前仍运行签名外壳加源码
开发服务，不是面向普通用户的独立分发包，也不承诺升级后自动继承 macOS 授权。

- 每次新的升级请求重新 `prepare`，冻结 main、全部选中 PR（含草稿）的最新 SHA、插件仓
  与本地补丁。用户等待确认期间不暗中改候选。确认前可运行 `freshness --config FILE
  --report BUILD_REPORT` 查询是否有变化；失败表示需展示差异并选择重建或明确接受冻结版，
  不能宣称它仍是最新。合成冲突留在候选目录供检查；优先更新冲突 PR，不重复维护私有解法。
- `manual-check` 当前只对候选目录做隔离 smoke。禁止在当前运行基线的源码目录启动
  第二个所谓隔离实例：仓库 restart 的终止范围按 checkout，不按数据目录。
  mock/smoke 用候选自己的进程分区器检查整个 checkout，并要求启动器支持
  `--refuse-running`，在实际停止/清缓存前再次拒绝占用；不支持此保护的旧候选必须重建。
  正常隔离启动/恢复使用随工具发布的同一分区器做启动前检查，因此不要求旧版自带
  标记。残留进程仍拒绝启动，不自动清理身份不明的进程；不能与另一个启动器并发操作同一 checkout。
  完整真实交接演练暂未交付，不能把单版 smoke 或注入时钟的测试称为双实例验收。
- `manual-restart` 先请求旧监督程序交出锁（绑定监督 PID、锁 token、应用 PID、启动代次
  和版本），旧程序只退出监督循环，保持应用运行。新程序取得锁并复核身份后才正常退出
  应用。也可显式用 `supervisor-release --config FILE --expected-pid PID` 单独交出监督。
  旧版监督程序不支持此协议时明确阻断，不通过 kill/删锁兼容；升级工具自身仍需独立验收。
  交出锁后旧进程仍持有 runner 子进程引用，终端在 runner 退出前不可关闭或复用；
  释放监督权不等于释放界面服务所在的终端。
- 签名要求变化在退出旧版前阻断。证书续期/身份迁移尚无自动命令，须单独准备和审核，
  不接受静默换证或放宽校验。遗留安装事务可显式 `install-recover --config FILE --report
  CHECKED_BUILD_REPORT`，要求监督锁可取得、应用与 runner 均已停止、报告和事务的 runtime
  key/digest 一致；只完成文件事务，不启动应用、不更改业务 journal。候选开始尝试执行后，
  数据兼容性未知仍禁止自动退回旧版。
- 换壳后注销退役包的 LaunchServices 登记并重新登记固定安装路径；隔离 smoke 正常停止
  后注销预览包，仍被别的实例使用则保留并警告。改名为 `.bundle` 本身不保证系统注销。
  系统登记失败不得阻断文件安装或旧版恢复：完成文件事务，在安装元数据记录
  `registrationPending`，由 doctor 提示、registry-clean 成功后清除；smoke 的登记错误
  写入 `registrationWarnings`，不改变候选启动结果。停止进程失败仍使 smoke 失败。
  `doctor` 列出同 Bundle ID 的登记路径；显式 `registry-clean --config FILE` 只注销
  同 ID 且未运行的副本：状态目录内或固定包同级受管备份前缀内的退役包允许旧/临时签名，
  其它位置仍要求同证书有效签名；同 ID 查询中已不存在的路径只注销陈旧登记。真实路径
  是固定包的别名、异 ID、运行中或身份不明的条目保留。固定包始终验证原签名和摘要。
  此命令不删除文件、不重置 TCC；登记查询限时 60 秒，注销/登记各限时 15 秒。
  无法识别/核验的条目保留，命令报告未完成，不能据此宣称授权已经生效。
- 主进程启动时消费并清除监控环境变量，生成目录只允许一个主进程写心跳；准备子进程
  同样清除继承值。读取方继续验证 PID、代次与新鲜度，未知活动仍视为忙。
- 只有当前调用栈确认**尚未尝试 spawn**，才允许恢复旧版；没有 ready、超时或监督程序
  被中断都不构成这一证据。恢复结果标为 `recovered`、`verified:false`，不是新版升级成功。启动前的瞬时失败
  不写入内容拒绝名单，修复环境并显式重新检查后可以手动重试同一候选；自动候选选择
  排除 `launchFailure.id`，防止同一坏候选不断退出并恢复应用；恢复后监督异常仍保留 recovered 标志。
  候选一旦尝试启动且无法确认兼容性，保持 blocked。使用 `doctor` / `auto-status`
  检查及受保护的 `auto-recover`，不得手改 journal 或删除拒绝记录绕过检查。
- 每次实际切换后分别核对屏幕录制与辅助功能的当前进程检查结果。系统设置里的开关、
  codesign 成功、窗口出现、远程设备在线均不能替代这两项检查；未实测就保留未验收状态。

`node scripts/personal-build.mjs prune-plan --config FILE` 只生成保留建议：保护 journal 的
当前／上一版／失败版、独立 known-good、待切换候选、最新已检查版和最近两次准备；证据
缺失则全部保留。没有删除能力，不遍历或删除任意 worktree、工具版本、原生缓存、旧备份。
实施清理前必须再次检查运行进程、脏文件、Git 引用和恢复依赖；不能把按时间排序当成安全删除证明。

验收分层：`personal-build-recovery.test.mjs` 在临时目录通过生产交接、安装器和 journal
覆盖正常晋升、启动前恢复、启动后阻断，应用进程与时间为注入模型；另用两个真实 Node
进程验证监督锁交出、接管和旧进程存活，只验证控制协议，不冒充真实 GUI 演练。
真实双版本演练仍未验收，尤其需要独立 checkout 和独立应用身份；不得启动当前基线来伪造演练。
自动升级仍默认关闭，不能仅凭若干次通过就打开。

后续独立阶段：正式打包产物、完整真实交接演练、执行文件删除的清理流程、证书身份迁移。
这些需要独立验收，不能从脚本单测通过推断当前实例已部署或手机已安装。Push 注册缺陷
也影响普通手机版；即使与个人版工具同批交付，仍需单独验证。注册成功不是 APNs 送达证据，
应分别核对签名环境、注册回执与目标真机收到通知。

本地补丁收拢到 PR 后，先确认远端 PR 的最终内容包含所需修复，再从源配置移除对应
`app.localRefs`。其它功能已有自己的未合并 PR 时由正常 PR 发现流程纳入，不重复挂本地
分支，也不混入个人版 PR。保留原分支、冻结报告和已安装版本用于追溯；下一轮重新发现
PR 并冻结新 SHA，不能修改已验收候选来冒充新构建。
