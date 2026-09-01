# Mobile Simulator Debugging

This guide is the fixed local loop for testing `apps/mobile` in an iOS Simulator
or Windows Android Emulator. It exists because Expo Go, a development client,
and an installed distribution build look similar during manual testing but prove
different things.

On Windows, the explicit Mainland China one-command entry starts or reuses the
`cindy-api36` AVD, waits for Android to finish booting, configures `adb reverse`,
and then keeps the current worktree's Metro in the foreground:

```bash
pnpm mobile:sim:start:cn
```

`mobile:sim:start` keeps the repository-wide Global default. Use
`-- --avd <name>` for another AVD or `-- --no-emulator` for Metro only. Android
SDK tools are resolved from `ANDROID_SDK_ROOT`, `ANDROID_HOME`, or the standard
Windows Android Studio SDK location; they do not need to be on `PATH`. The
command does not rebuild the native app, so install the matching development
package first when switching build identity.

## Current Source Verification Contract

Before anyone claims "the simulator is already showing the new version", they
must produce evidence. The #1 time sink in mobile debugging is staring at a
**stale bundle from another worktree's Metro** and concluding "my change didn't
apply". Treat the following as a contract, not optional steps:

- **The native build number does NOT prove JS freshness.**
  `CFBundleVersion` / the version label only identify which native *development
  client* is installed. A pure JS/UI change (most edits) never bumps it. So a
  matching build number is necessary-but-not-sufficient.
- **JS freshness = which Metro the app is connected to.** With multiple mobile
  worktrees open, several Metro servers run at once and the app silently
  connects to whichever it last used (often `8081`, which is frequently a
  *different* branch). "The app opened" ≠ "it loaded my bundle".
- **Evidence required before trusting the simulator:**
  1. The `__DEV__` build label at the top of the new-session screen shows
     `branch@commit+dirty-fingerprint · vX (build) · <metro host:port>`, and the
     fingerprint is **your current worktree**. (Injected by `mobile:sim:start`; see below.)
  2. `pnpm mobile:sim:whoami` exits nonzero unless a booted development client,
     the current worktree's `8081` Metro, and the exact source fingerprint all
     agree; the label's port must map to your worktree.
  3. The Metro terminal printed a fresh `iOS Bundled …` after your edit.

### Tools (use these instead of ad-hoc `lsof`/`PlistBuddy`/deep-link dances)

```bash
pnpm mobile:sim:start      # start THIS worktree's Global dev-client Metro; injects git
                           # branch/commit into the __DEV__ build label (EXPO_PUBLIC_*)
pnpm mobile:sim:start:cn   # Mainland China; on Windows also starts cindy-api36
pnpm mobile:sim:start -- --region=cn # 中国大陆版 JS region；先 rebuild 对应 native app
pnpm mobile:sim:whoami     # doctor: booted install + which port = which worktree
pnpm mobile:sim:whoami -- --region=cn # inspect the cn native app + Metro ownership
pnpm mobile:sim:rebuild    # rebuild + reinstall the Global native dev app (native changes only)
```

`mobile:sim:start` and `mobile:sim:rebuild` default to `global`; the China
Mainland build requires explicit `--region=cn`. Before touching
Expo, all `mobile:sim:*` commands initialize the protocol submodule and repair
the workspace dependencies when needed. The start/rebuild scripts also
synchronize
the selected build region and the matching `config/endpoint*.json` bootstrap
base into `apps/mobile/.env`. Local Xcode / Simulator builds also read the selected
block from the gitignored `apps/mobile/scripts/self-host-regions.json` for bundle
identity, TapDB, and global Google client configuration. If this gitignored file
is absent, the scripts automatically reuse and validate it from a registered
personal-client or main worktree without printing its values; if no valid copy
exists, the file is created automatically from the blank
`self-host-regions.json.example` template with a warning (built-in app
identity, analytics and Google sign-in disabled). You do not need to
inject those public values or endpoint variables into `.env` by hand.

For local builds only the bundle identity fields of the selected region
(`iosBundleId` / `androidPackage`) are required. `tapdb` and `global.google`
may be left empty: analytics then no-ops at runtime and Google sign-in is
skipped, so external contributors can build without TapDB or Google OAuth
accounts. The self-host release scripts still require these fields.

The new-session build label reads the exact source fingerprint plus branch/commit
from `EXPO_PUBLIC_XDT_GIT_*` (set by `mobile:sim:start`) and the Metro host from
`Constants.expoConfig.hostUri`. The fingerprint is `branch@commit` for a clean
worktree and adds a hash of tracked/known untracked changes for a dirty one, so
an amend/rebase/reset or later edit cannot masquerade as the old Metro. It is
`__DEV__`-only and compiled out of release builds. branch/commit/fingerprint are
intentionally NOT injected via `app.config.js`/`extra`: that would change the
`@expo/fingerprint` runtime version on every commit and break OTA. `EXPO_PUBLIC_*`
lives in the JS bundle and does not affect the fingerprint. The sim scripts also
live in the **root** `package.json` (`mobile:sim:*`), not
`apps/mobile/package.json`, because the latter's `scripts` field IS a fingerprint
input — adding a script there would bump the mobile runtime version.

### Multi-worktree Metro pitfall

- The debug app has **no `expo-dev-client` dependency**, so it only ever loads
  its compiled default packager port (`8081`) — a `xdmaker://expo-development-client/?url=…`
  deep link or a `--dev-client` "No apps connected" state will NOT switch it.
  Starting Metro on any other port leaves the app loading a stale `8081` bundle.
- Therefore `mobile:sim:start` **insists on `8081`** (never auto-bumps): if `8081`
  is held by *another* worktree it refuses and tells you to stop that Metro first
  (you can only run one mobile dev session at a time); if it's this worktree's own
  Metro it just says "already running". Use `mobile:sim:whoami` to see who owns
  each port. Override with `-- --port <p>` only if you'll point the app there yourself.
- If `8081` belongs to this worktree but its injected fingerprint no longer equals
  the current worktree, `mobile:sim:start` refuses instead of claiming Metro is
  reusable. Stop it and start Metro again after the amend/rebase/reset or edit.

### Native build gotcha

- Do **not** build with `CODE_SIGNING_ALLOWED=NO` for runtime verification: the
  resulting app lacks the keychain entitlement, so `expo-secure-store` fails and
  login/storage break. Use `mobile:sim:rebuild` (signed debug build) instead.

## Runtime Choice

Use these runtimes for different jobs:

- Current source debugging: iOS development client, bundle id
  resolved from the selected local region config (`com.xd.cindycn` for the
  current cn config, `com.xd.cindy` for global), attached to Metro.
- An installed distribution build does not consume local Metro changes.
- Expo Go: only for explicit Expo Go compatibility checks. It is not the normal
  regression target because this app depends on native config, secure storage,
  Feishu/Lark app handoff, audio, image picker, app scheme, and build-time iOS
  metadata.

When testing a code change, state explicitly whether it is the development client or an installed
distribution build. Do not just say "the app".

## Clean Simulator Loop

From the mobile worktree:

```bash
cd <current-mobile-worktree>
pnpm mobile:sim:start
```

Keep that Metro terminal open. In another terminal, install or run the native
development client:

```bash
pnpm --filter mobile ios -- --device "iPhone 17 Pro"
```

If the app is already installed and only JavaScript changed, reload instead of
reinstalling:

```bash
xcrun simctl terminate booted com.xd.cindycn || true
xcrun simctl launch booted com.xd.cindycn
```

Then press `r` in the Metro terminal, or open the Expo dev menu in the simulator
and choose Reload.

Reinstall only when native state or native config changed:

```bash
xcrun simctl uninstall booted com.xd.cindycn || true
pnpm --filter mobile ios -- --device "iPhone 17 Pro"
```

Native rebuilds are required after changes to `app.json`, app schemes, iOS
permissions, plugins, native modules, or `expo prebuild` output.

> Note (Xcode 26.5+): `pnpm --filter mobile ios` (`expo run:ios`) can fail device
> resolution with `xcodebuild: error: Unable to find a destination matching the
> provided destination specifier: { id:<udid> }`. On this Xcode, `expo`'s
> devicectl parsing breaks and xcodebuild only enumerates placeholder
> destinations, so a concrete simulator UDID never matches. Use the rebuild
> script instead — it builds against a generic simulator destination and installs
> via `simctl`, sidestepping device resolution:
>
> ```bash
> pnpm mobile:sim:rebuild           # rebuild + reinstall onto the booted simulator
> pnpm mobile:sim:rebuild -- --clean # uninstall first (clean login-state test)
> ```
>
> It passes `EXCLUDED_ARCHS=''` plus `ARCHS=<host sim arch>` (arm64 on Apple
> Silicon, x86_64 on Intel — derived from `process.arch`) to override the LarkSSO
> pod's simulator arm64 exclusion and build a binary the host's simulator can run
> (otherwise the app won't install / runs under Rosetta). Pure JS/TS changes never
> need this — Metro Fast Refresh covers them.

## Confirm The Installed Build

Before asking someone to retest, confirm which native app is installed:

```bash
xcrun simctl list devices booted
pnpm mobile:sim:whoami                    # cn(default)
pnpm mobile:sim:whoami -- --region=global # global
```

`mobile:sim:whoami` resolves the selected identity from `app.config.js` plus the
gitignored `scripts/self-host-regions.json`, then prints the installed version
and build number from that app's `Info.plist`. It is a doctor command: no booted
device, no selected native app, no current-worktree `8081` Metro, or a source
fingerprint mismatch makes it exit nonzero. Expected version values come from
`apps/mobile/app.json`:

- `ios.bundleIdentifier`
- `version`
- `ios.buildNumber`

The native build number only proves native installation. For JavaScript
freshness, the Metro terminal must show a new bundle/reload after the source
change.

## Environment And Login

`EXPO_PUBLIC_*` values are read by Metro at bundle time. After changing
`apps/mobile/.env`, restart Metro and reload the app.
`mobile:sim:start` / `mobile:sim:rebuild` create or repair the required
functional values automatically from `eas.json`, without enabling dev-only flags.

Online login no longer requires a Feishu App ID. Business endpoints come from
the repo's `config/endpoint.json` manifest in dev; no API base env is needed.

If the simulator starts already logged in, app data is still present. Use the app
logout path for normal testing, or uninstall the app for a clean login-state
test:

```bash
xcrun simctl uninstall booted com.xd.cindycn
pnpm --filter mobile ios -- --device "iPhone 17 Pro"
```

If Feishu login opens Safari and lands on `Cannot GET /api/auth/callback`, do
not assume the backend auth exchange failed yet. First check:

- The app is the development client, not Expo Go or an installed distribution build.
- The installed build contains the selected region scheme (`cindycn` or `cindy`).
- Metro was restarted after env changes.
- Metro logs show whether `WebBrowser.openAuthSessionAsync` returned success,
  cancel, or dismiss.

## Logs

Use Metro first for JavaScript warnings, React Navigation warnings, fetch
errors, auth errors, and Expo runtime warnings:

```bash
pnpm --filter mobile start -- --dev-client --host lan
```

Use the simulator system log for native crashes or native auth/session issues:

```bash
xcrun simctl spawn booted log stream --style compact --predicate 'process == "Cindy"'
```

The in-app "Open debugger to view warnings" banner means a JavaScript warning is
active. Read Metro before changing UI code.

For device-link network symptoms, collect:

- Metro log around the symptom.
- The selected device id/name and connection state shown in the app.
- Desktop app logs if the controlled computer is involved.
- Server/device-link relay logs only when both mobile and desktop show relay
  symptoms.

## Render Storm Forensics And Regression Measurement

背景:2026-07 会话白屏/卡死排查确立的取证与回归测量体系(手机端无落盘日志,
这套是唯一的量化通道)。触碰 `remoteSessionStore` 订阅链、首页/详情页列表派生
(索引 useMemo、sections、行 memo)、或做相关重构时,改动前后各测一轮对比。

三层信号,从粗到细:

1. **`[js-stall]` 停摆探测器**(dev 常驻,`src/debug/jsStallWatchdog.ts`):JS 线程
   停摆 ≥2s 即在 Metro 日志打带时长的 WARN(≥120s 判 suspend-suspect,是整机睡眠
   假象)。日常开发的金丝雀——正常应为零或零星 2-3s(dev 调试开销);出现 ≥10s
   或连发即回归。
2. **渲染 trace 采集 + 组件归因**(按需):

   ```bash
   # App 连着 Metro 时录制;期间复现目标场景(典型:桌面端流式输出 + 手机首页/会话来回)
   node apps/mobile/scripts/render-trace.mjs --seconds 120
   node --max-old-space-size=8192 apps/mobile/scripts/render-trace-analyze.mjs /tmp/render-trace/trace.json
   ```

   判定基准(~2 分钟采样、桌面端流式场景实测):病态 = HomeSessionRow 数千次、
   SectionList 全列表 pass 数十次 × 秒级;健康 = HomeSessionRow 两位数、壳层
   pass 收敛到变化行。「Changed Props 供词」里的 *referentially unequal but
   deeply equal* 就是引用不稳定处,优先修。
3. **CI 不变量**(自动):`remoteSessionStore.test.ts` 的「引用调和」组(含
   风暴不变量:消息/运行态高频 churn + 内容等价重算下 `getSessions()` 引用零漂移)、
   `homeDesktopFirst.test.ts` 的保鲜契约断言(storeVersion 裸订阅 / 分钟心跳 /
   SessionRelativeTime)。重构必须保持这些绿灯——它们钉住的是「无关更新不惊动
   列表」与「memo 化后该刷新的仍会刷新」两个方向的语义。

## Keyboard, Rotation, And iPad

Virtual keyboard:

- Simulator menu: `I/O > Keyboard > Toggle Software Keyboard`
- Shortcut: `Cmd+K` in most Xcode Simulator versions

Rotation:

- Simulator toolbar rotate buttons
- Or `Device > Rotate Left` / `Device > Rotate Right`

iPad:

```bash
xcrun simctl list devices available | rg "iPad"
pnpm --filter mobile ios -- --device "<iPad simulator name>"
```

`apps/mobile/app.json` has `supportsTablet: true` and `orientation: default`, so
phone portrait, phone landscape, and iPad should all be treated as layout
regression targets.

## Common Failure Map

`Project is incompatible with this version of Expo Go`
: Wrong runtime. Use the development client for current source testing.

`The action 'GO_BACK' was not handled`
: The screen called stack back without a previous route. Top-level and modal-like
screens need an explicit destination such as `/devices`.

Local source change is not visible
: Usually one of: wrong runtime, stale Metro bundle, an installed distribution build instead of
development client, or native rebuild required.

No controllable devices
: Wait for the initial device-list read to finish. If it remains empty, verify
same account, desktop online state, remote control enabled, and device-link
WebSocket connectivity.

Global "connecting" UI when only one device is slow
: Treat connection state as per-device UI. The device chip should show its own
connecting/offline/online state; the whole home screen should not block if other
devices are usable.

Keyboard covers the composer
: Reproduce with the software keyboard enabled, then inspect `KeyboardAvoidingView`
behavior, safe-area insets, and composer bottom spacing together. Do not validate
keyboard layout with only the hardware keyboard.

## Before Asking For Manual Retest

Run this checklist:

- Confirm the exact runtime: development client, Expo Go, or an installed distribution build.
- Confirm `CFBundleIdentifier`, `CFBundleShortVersionString`, and
  `CFBundleVersion`.
- Restart Metro after env changes.
- Reload the development client and watch Metro print a new bundle.
- Reinstall the development client after native config changes.
- Run `pnpm --filter mobile typecheck` when TypeScript changed.
- Run the narrow relevant test when there is one.
- Manually touch the exact path that regressed in the simulator.
- Tell the tester which simulator/device, runtime, and build were used.
