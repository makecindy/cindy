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

The three commands share Metro worktree, source, region and environment checks.
`whoami` success proves identity consistency, not that the app has loaded a bundle
or displayed a page (`pageVerified` remains false). `rebuild` reports installation
separately from a launch request, and exits nonzero if launch is blocked, including
when Metro is absent. `--build-only` does not require Metro. A successful launch
request still requires fresh bundle logs and visible page verification.

### Which iOS Simulator

The repository does not pin a simulator; each developer chooses locally. By default
(`CINDY_MOBILE_SIMULATOR=auto`) `whoami`, `rebuild` and `open` use Cindy's own simulator — the
official Baguette plugin's private device set at
`~/Library/Application Support/BaguetteCindy/devices`, shown in Cindy's sidebar — and fall back
to the system (Xcode) simulator only when Cindy's is not installed or its plugin setting has
paused running. With nothing booted in Cindy's simulator they report `cindy-idle` with its
reusable devices instead of picking a system device; boot one through the plugin. `--udid` uses
whichever of those sets holds that device. Using the system simulator while Cindy's is available
reports `system-while-cindy-available` (`simulatorNotice` in `whoami --json`). Keep a personal
choice outside the repository, e.g. in your shell profile:

| `CINDY_MOBILE_SIMULATOR` | Effect |
|---|---|
| `auto` (default) | Cindy while it is available, otherwise system |
| `cindy` | Only Cindy's simulator; error when unavailable |
| `system` | Only the system simulator |
| absolute path | Only that CoreSimulator device set |

Devices outside the system set have no external window: `mobile:sim:open` refuses them and
`whoami --viewer` reports the viewer as unavailable; view Cindy's devices in its sidebar.
`rebuild` builds those with the generic Simulator destination (xcodebuild only sees the system
set) and installs with `simctl --set`. Cindy's simulator shuts devices down after its idle
setting (15 minutes by default; plugin input renews it, scripts do not). Native E2E (Maestro)
still uses the system simulator.

For the macOS external viewer, use `pnpm mobile:sim:open -- --udid <booted-udid>`.
It resolves the app inside the selected Xcode toolchain (including `DEVELOPER_DIR`),
opens Device Hub or Simulator by its absolute path, and exits nonzero on failure.
Do not use AppleScript app-name lookup or `open -a Simulator`: Xcode 27 has Device
Hub instead, and probing a missing name can display an application chooser.
The pinned Expo CLI patch shares discovery and opening with this entrypoint.

Use `mobile:sim:whoami -- --viewer --json` when handing off an external window.
`viewer.running` checks the selected app process; `viewer.windowVerified: false`
explicitly leaves visible-window acceptance to a screenshot/manual check. Without
`--viewer`, a missing external viewer does not fail embedded/headless identity checks.

## 截图与当前版本测试

“给我看这次手机改动的截图”与启动当前版本测试共用此流程。本节是 Agent 做手机模拟器测试的
唯一流程正本，不另设个人 Skill；开发者个人只保留常用机型、模拟器后端等偏好。

**授权范围。** 当前任务里用户要求“启动/切换/运行手机模拟器让我测”或要截图，即授权本任务：
启动匹配的模拟器、安装兼容开发包、普通 `rebuild`、启动/reload App、用 `--takeover` 重启本任务
自己的或 worktree 已删除的孤儿 `8081` Metro，以及按
[Parallel devices](#parallel-devices-another-task-owns-8081) 另开设备与端口。`8081` 属于其他仍
存在的 worktree 时默认走并行设备；只有用户在当前任务里明确要求接管，才用 `--takeover` 停掉它
（会打断那边的测试）。授权在本任务后续执行中持续有效，不因回合结束重新索要；其他任务、引用的历史
对话或 Agent 自己判断“应该测一下”都不构成授权，只调查原因时不启动设备。“不要动当前版本/
不要关模拟器”等保护要求优先。测试请求**不**包含：`--clean`、卸载或清登录态、重置/删除/关闭
不是本任务创建的模拟器、重启 Desktop 或 device-link、修改账号/凭证/私有端点/区域身份配置、
安装系统工具或下载 runtime、控制私人真机；需要时只问缺的那一项。普通截图优先 `--mock`。

1. 固定本任务的 worktree：本次明确给出的路径/分支 → 本任务已确认并实际编辑的 worktree →
   当前工作目录。会话初始目录可能仍是主 checkout；无法唯一确定时询问，不根据其他任务、最近
   的 Metro、模拟器画面或“看起来最新”的提交猜。读取 `git status --short --branch`，所有
   `mobile:sim:*` 在目标根目录运行。使用任务明确指定的机型，未指定时才使用个人选择；区域
   未指定时为 Global（`cn` 只能显式指定）。先枚举设备，选择精确 UDID；已有设备必须符合本次
   机型要求，不能因另一型号已经启动就把它当作目标，也不使用已知被其他任务占用的设备。机型
   和个人选择都没有时可复用唯一已启动设备，否则询问。后续命令保持相同 region、UDID、模拟器
   后端和 mock 开关。
   Cindy 模拟器经已安装的 `baguette-simulator` 插件操作：先查实时详情和 `devices`，按精确 UDID
   操作，只用 `environment` 列出的已安装 runtime，同机型有可复用设备时不重复创建。`auto` 只在
   插件未安装或 `RUNTIME_DISABLED` 时回退系统模拟器；固定 `cindy` 时报告不可用，不替用户重新
   启用插件。Cindy 模拟器的设备全部关机或都被其他任务占用，不是回退理由：通过插件复用或新建
   一台。Agent 不自行设置 `CINDY_MOBILE_SIMULATOR=system`，也不用 `simctl create` 在系统模拟器
   里建设备，除非用户明确要求或插件不可用。任务跨回合、rebase 或换提交后继续测试时，按当前
   流程和个人选择重新选设备，不因上次用过就沿用。
2. 先运行 `mobile:sim:whoami`，再决定是否需要启动设备、接管 Metro 或准备原生包。
   `simulatorNotice` 非空时先按其提示处理；`native.reason` 为 `target-not-unique` 表示还没有
   唯一目标、未检查安装情况，先确定 `--udid`，不要因此 `rebuild`。
   只检查 UI 时对 `whoami/start/rebuild` 都加 `--mock`。命令保留退出码；`pnpm` 的前后日志
   不属于 JSON，解析时从 stdout 末尾向前找最后一行合法 JSON 对象，不用 `grep | tail` 吞掉失败。
3. 若 `native-matched`，复用已安装包；缺包、不兼容或包本身无可验证指纹时运行普通
   `mobile:sim:rebuild`。它先查询 `~/Library/Caches/xdt-maker/sim-app-cache` 中的匹配条目，
   校验 bundle ID、架构和嵌入指纹，未命中才检查构建工具并编译。`SIM_CACHE` 给出查询位置与
   `cache-entry-missing`、`cache-bundle-mismatch`、`cache-architecture-mismatch`、
   `cache-native-mismatch` 等原因；有旧产物不等于兼容，未安装也不等于必须完整编译。
   不从任意目录捡 `.app` 绕过校验，日常不传 `--clean` 或 `--force-build`。
4. `SIM_BUILD_PREFLIGHT` 失败时按 [环境说明](../../../docs/dev-rules/environment-setup.md#macosios-模拟器构建工具链)
   修复具体工具。`whoami` 的 `probeErrors`、阶段失败或 `native.reason` 指向探测/计算故障时，
   先处理该故障，不能把“检查失败”当作“需要重建”。后台构建保留日志和退出码，用宿主的进程
   完成通知/状态查看推进，不用固定数分钟的 `sleep` 判断完成，不因等待较久重复启动构建。
5. 复用匹配的 Metro；需要接管且已获授权时只用 `mobile:sim:start -- --takeover`，不手工
   `kill`、不清登录态、不改端口来规避身份检查。`8081` 属于其他任务、又不接管时，按
   [Parallel devices](#parallel-devices-another-task-owns-8081) 给本任务单独的设备和端口，
   后续 `whoami` 同时传 `--udid` 和 `--port`。Metro 持续运行并保留日志。安装和启动是独立
   结果：`rebuild` 可能已经安装成功但因 Metro 未就绪而以非零退出；此时准备 Metro 后启动正确
   App，不必再次编译。只有 Metro 属于目标 worktree 后才 launch/reload App。
6. 按下方身份合同确认 `whoami healthy: true`、`native-matched` 和本次新的 `iOS Bundled …`，
   再进入真实目标页面。Cindy 模拟器用插件查看器（确认 `previewOpened`），系统外部窗口用
   `mobile:sim:open` 并以 `whoami --viewer` 检查；两者都需要实际截图/目检页面，窗口进程不等于画面。

截图和 `mobile-identity.json`、本次 bundle 日志放进同一任务产物目录，记录页面/场景、设备
UDID、方向、主题及未验证项。交付时简要说明模拟器后端（Cindy 或系统）与机型、设备/方向/主题、
区域与 bundle ID、worktree/分支、是否复用 Metro、身份与页面验证结果，并附实际图片；后端或机型
不是默认选择时写明原因；失败时指出具体失败层级和下一步，不把
device-link 故障说成模拟器故障。旧 checkout 缺少本流程所需入口（`--udid`、`--mock`、
`--takeover`、原生身份检查、查看器）时报告具体差距，不手工绕过。布局问题按本次要求覆盖横竖屏与深浅色；截图必须来自目标
版本的实际界面。身份未通过就报告未完成；仅缺目检则报告“版本及 bundle 已验证，画面未目检”。
本节不授权上传截图到公开平台。

`whoami` 会向 stderr 输出阶段开始与耗时，JSON 的 `checks` / `elapsedMs` 可定位慢在
配置、Git 源码身份、设备、原生指纹、Metro 还是查看器。Expo config 的单次检查上限 30s，
simctl/安装信息查询 15s，Git 子命令 30s，Metro 的主要进程查询 5s，原生指纹 120s；
这些是单步上限，不是总运行时间承诺。失败后按阶段排查，不降低原生/源码身份要求。
已找到监听 PID 后，命令、cwd、源码环境或 Windows 进程快照查询失败也会写入
`probeErrors`（`METRO_PROCESS_TIMEOUT` / `METRO_PROCESS_UNAVAILABLE`，附端口与阶段）；
身份检查未完成时不提示“没发现 Metro”或建议另启一个 Metro。

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
  worktrees open, several Metro servers run at once. Each device loads from its
  own `RCT_jsLocation` if that Metro answers, otherwise silently from `8081`
  (frequently a *different* branch) — see
  [Multi-worktree Metro and parallel devices](#multi-worktree-metro-and-parallel-devices).
  "The app opened" ≠ "it loaded my bundle".
- **Evidence required before trusting the simulator:**
  1. The `__DEV__` build label at the top of the new-session screen shows
     `branch@commit+dirty-fingerprint · vX (build) · <metro host:port>`, and the
     fingerprint is **your current worktree**. (Injected by `mobile:sim:start`; see below.)
  2. `pnpm mobile:sim:whoami` exits nonzero unless a booted development client,
     the current worktree's Metro on the expected port (`8081`, or `--port`), and
     the exact source fingerprint all agree, including `native.healthy: true` /
     `native-matched`; the label's port must map to your worktree. `whoami` does
     not read the device's `RCT_jsLocation`, so the label is what proves which
     Metro the app actually used.
  3. The Metro terminal printed a fresh `iOS Bundled …` after your edit.

### Tools (use these instead of ad-hoc `lsof`/`PlistBuddy`/deep-link dances)

```bash
pnpm mobile:sim:start      # start THIS worktree's Global dev-client Metro; injects git
                           # branch/commit into the __DEV__ build label (EXPO_PUBLIC_*)
pnpm mobile:sim:start:cn   # Mainland China; on Windows also starts cindy-api36
pnpm mobile:sim:start -- --region=cn # 中国大陆版 JS region；先 rebuild 对应 native app
pnpm mobile:sim:whoami     # doctor: booted install + which port = which worktree
pnpm mobile:sim:whoami -- --region=cn # inspect the cn native app + Metro ownership
pnpm mobile:sim:rebuild    # install a compatible cached dev app, or build it on a cache miss
```

`mobile:sim:start` and `mobile:sim:rebuild` default to `global`; the China
Mainland build requires explicit `--region=cn`. Before touching
Expo, all `mobile:sim:*` commands check dependencies without installing or deleting
anything. If the check fails, preserve the environment and explicitly run
`pnpm install --frozen-lockfile` in the current worktree after diagnosing the failure. The start/rebuild scripts also
synchronize
the selected build region and the matching `config/endpoint*.json` bootstrap
base into `apps/mobile/.env`. Local Xcode / Simulator builds also read the selected
block from the gitignored `apps/mobile/scripts/self-host-regions.json` for bundle
identity, TapDB, and global Google client configuration. If this gitignored file
is absent, the scripts automatically reuse and validate it from a registered
personal-client or main worktree without printing its values; if no valid copy
exists, the file is created automatically from the blank
`self-host-regions.json.example` template with a warning (built-in app
identity, analytics disabled, Google sign-in through the system browser on
Global). You do not need to
inject those public values or endpoint variables into `.env` by hand.

For local builds only the bundle identity fields of the selected region
(`iosBundleId` / `androidPackage`) are required. `tapdb` and `global.google`
may be left empty: analytics then no-ops at runtime, and on Global the Google
button uses the browser PKCE flow instead of the native SDK (as Apple does on
Android; CN never offers Google), so external contributors can build and sign
in without TapDB or Google OAuth accounts. The self-host release scripts still
require these fields.

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

### Multi-worktree Metro and parallel devices

How the iOS debug app picks its Metro (React Native `RCTBundleURLProvider`):

1. It reads `RCT_jsLocation` (`host:port`) from the app's user defaults. These
   are stored per simulator and per bundle ID. If that Metro answers, the app
   loads from it.
2. Otherwise it **silently** falls back to the compiled default `localhost:8081`
   (`RCT_METRO_PORT`). This also happens when `RCT_jsLocation` points at a Metro
   that has stopped.

The app has **no `expo-dev-client` dependency**: a `xdmaker://expo-development-client/?url=…`
deep link or a `--dev-client` "No apps connected" state will NOT switch it.

Consequences:

- Starting Metro on another port changes nothing until a device is pointed at it.
- Because the setting is per device, several simulators can run different
  worktrees at the same time, each on its own port.
- Both fallbacks are silent: a stopped Metro sends the device back to whichever
  worktree owns `8081`, and a leftover `RCT_jsLocation` keeps a device on an old
  port after you expect `8081`. `whoami` checks the Metro on the port you pass,
  not where the device points; the build label's `host:port` is the proof.

`mobile:sim:start` port policy:

- It defaults to `8081` and never auto-bumps. It reuses a Metro only when
  worktree, source, region and environment all match. If `8081` belongs to this
  worktree but its injected fingerprint no longer equals the current worktree, it
  refuses instead of claiming Metro is reusable.
- An authorized `--takeover` stops only a confirmed Cindy Metro on `8081` (and
  refreshes this worktree's own Metro after an amend/rebase/reset or edit);
  unknown/non-Metro owners are refused. Use `mobile:sim:whoami` to inspect ownership.
- An explicit `--port <p>` starts Metro only. It refuses an occupied port, cannot
  be combined with `--takeover`, and does not point any device; follow the
  parallel steps below. Never use it to make the identity check pass for a device
  that still loads `8081`.

#### Parallel devices (another task owns `8081`)

When `8081` serves another task and you are not authorized to take it over, give
this task its own device and port instead of waiting or taking over:

1. Use a device no other task is using, in the backend this task already selected:
   for Cindy's simulator create or reuse one through the `baguette-simulator` plugin;
   only for the system simulator use `xcrun simctl create`. Either set can
   `xcrun simctl clone` a shut-down device to keep its login (for Cindy's, add the
   `--set` below). One device follows one Metro; never repoint a device another task
   is testing on.
2. Boot it and wait until ready: `xcrun simctl boot <UDID> && xcrun simctl bootstatus <UDID> -b`
   (for a device in Cindy's simulator, add `--set "$HOME/Library/Application Support/BaguetteCindy/devices"`
   after `simctl`). `rebuild` only accepts a booted device and exits before
   installing otherwise.
3. Install the matching native app on it:
   `pnpm mobile:sim:rebuild -- --region=<region> --udid <UDID>`. While `8081`
   belongs to another worktree it installs, then exits nonzero with
   `launch blocked`; that is expected, do not rebuild again.
4. Start this worktree's Metro on a free port and keep it running:
   `pnpm mobile:sim:start -- --region=<region> --port 8082` (same `--mock` choice
   as the other commands). `whoami` scans `8081`–`8086` plus the explicit
   `--port`, so any other free port also works.
5. Point the device and relaunch the app (`<bundleId>` is `bundleId` in the
   `whoami` JSON). For a device in Cindy's simulator, add
   `--set "$HOME/Library/Application Support/BaguetteCindy/devices"` after `simctl`:

   ```bash
   xcrun simctl spawn <UDID> defaults write <bundleId> RCT_jsLocation localhost:8082
   xcrun simctl terminate <UDID> <bundleId>; xcrun simctl launch <UDID> <bundleId>
   ```

6. Verify all of: `pnpm mobile:sim:whoami -- --region=<region> --udid <UDID> --port 8082`
   passes; `xcrun simctl spawn <UDID> defaults read <bundleId> RCT_jsLocation`
   prints `localhost:8082`; the `8082` Metro log shows a new `iOS Bundled …` after
   the launch; and the build label shows `:8082` with this worktree's fingerprint.
7. Clean up when done: stop this Metro, then on that device run
   `defaults delete <bundleId> RCT_jsLocation` (via `simctl spawn`, as above)
   and relaunch. Delete devices you created if they are no longer needed. Do not
   leave a device pointed at a port nobody owns.

Before reusing any device, run `defaults read … RCT_jsLocation`. "Does not exist"
means it follows `8081`.

Android has the same per-app idea under a different name: React Native reads
the app's `debug_http_host` preference (dev menu → Change bundle location). Without
it, a stock emulator connects to `10.0.2.2:8081`, which is the host's `8081`
directly, so `adb reverse` alone does not repoint it. The Windows
`mobile:sim:start -- --port <p>` only adds `adb reverse tcp:<p> tcp:<p>`.
Parallel Android runs are not yet a verified recipe here; prove each one with
a new `Android Bundled …` in your Metro's log and the build label.

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
pnpm mobile:sim:whoami                    # Global(default)
pnpm mobile:sim:whoami -- --region=cn     # China Mainland
```

`mobile:sim:whoami` resolves the selected identity from `app.config.js` plus the
gitignored `scripts/self-host-regions.json`, then prints the installed version
and build number from that app's `Info.plist`. It is a doctor command: no booted
device, no selected native app, no current-worktree Metro on the expected port
(`8081` unless `--port`), or a source
fingerprint mismatch makes it exit nonzero. Expected version values come from
`apps/mobile/app.json`:

- `ios.bundleIdentifier`
- `version`
- `ios.buildNumber`

The native build number only proves native installation. `whoami` also compares
the installed `EXUpdates.bundle/fingerprint` with the current worktree's Expo
Updates fingerprint, using the same development environment and workflow as the
native build. A missing/unreadable fingerprint (`native-unknown`) or difference
(`native-mismatch`) fails the check even when Metro is correct. Run ordinary
`mobile:sim:rebuild` without `--clean`; it rejects incompatible cached artifacts
and checks the built and installed app before handing it off. For example,
switching worktrees with different `@expo/ui` versions can otherwise silently
break native gradient parameters while the app still opens.

For JavaScript freshness, the Metro terminal must show a new bundle/reload after
the source change. Matching native fingerprints does not prove page rendering.

If a freshly built app exits before loading JavaScript with `UIScene life cycle
is required`, check the SDK 57 scene backport: `expo >= 57.0.23` and
`expo-build-properties` with `ios.enableSceneSupport: true`. The repository enables
this official path for Xcode 27 / iOS 27. Prebuild should generate an
`EXExpoAppSceneDelegate` manifest for the main app and make AppDelegate conform to
`ExpoReactNativeFactoryProvider`; it must no longer create the legacy window.
This native migration changes the runtime fingerprint and requires a new native
build. Verify cold/warm links and background/foreground behavior as well as
startup; do not mask it with a JavaScript workaround.

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

Release 也可在设置 → 调试 / 开发者打开 Debug 日志，复现后导出。默认关闭；开启后记录
手机连接恢复、网络变化、错误与堆栈、滚动与键盘几何、渲染计数/解析耗时、JS 停摆。
不记录聊天正文、完整请求或凭证，不复制被控端任务日志，不捕捉任意 console 或原生日志。
详细日志最多保留 7 天、8 MiB；每 2 秒及前后台切换时落盘，突然杀进程可能丢失最后一批。
配置日志服务的构建还可手动上传筛选后的运行摘要（最近 7 天最多 500 条），成功自动复制编号。
上传摘要不包含详细 Debug 文件，需要详细现场时用导出或开发设备容器读取。

滚动几何在交互状态不变时最多每 250 ms 记录一次；拖动结束、拖动/惯性/读历史/贴底
状态变化仍立即记录。键盘日志只记录实际几何或显隐变化，关闭且已退出的弹层、不需要
键盘避让的弹层不注册键盘监听。日志条数不能直接当作原生事件次数或监听器数量。
`content recovery state` 的 `elapsedMs` / `foregroundElapsedMs` 只累计该任务页聚焦且
App 为 active 的等待时间，`wallElapsedMs` 单独保留包含后台与离开页面的总时长。
旧版本仅有 `elapsedMs`，其中可能包含后台时间，不能直接解读成用户等待或界面卡死。
实现与回归见 `src/debug/useContentRecoveryDiagnostics.ts`、`scrollDebugSampler.ts`
及相邻测试，键盘回归见 `src/__tests__/composerKeyboard.test.tsx`、`sheetKeyboardSubscription.test.tsx`。

### 真机排查与并存测试版

真机上的问题（缓存、推送、后台恢复等）先取证据再动手：读设备日志、核对正在运行的版本、
构建并安装测试版后用日志验证。不要把「可以用真机测」理解成在电脑上镜像手机画面逐步点按：
镜像只能看画面，看不到版本和日志，2026-10-17 曾因此耗掉整轮时间。

需要在真机上与正式 Cindy 并存安装测试版时，用另一个 bundle ID，不覆盖用户的正式 App
（心动团队用 `com.xd.cindytest`，该 App ID 已有自动签名描述文件；临时新建的 ID 签名不可靠）：

- 用临时 `self-host-regions.json` 覆盖 `iosBundleId`，通过 `CINDY_SELF_HOST_REGIONS_FILE`
  指给构建，并同时设置 `CINDY_USE_LOCAL_REGION_CONFIG=1`：`app.config.js` 只有这个开关
  （`mobile:sim:*` 脚本会自动设置）或自建发布线的 `EXPO_PUBLIC_XDT_OTA_SELFHOST=1` 打开时才读这份
  文件，漏了开关会静默回落到内置包名，与正式版同 ID 冲突；后者还会改变原生 OTA 策略，测试包不要用。
  `EXPO_PUBLIC_APP_VARIANT=beta` 与 `EXPO_PUBLIC_BETA_DEV` 只给显示名加「Beta (标记)」后缀，一眼
  分得清，不改 bundle ID。安装前用 `plutil -extract CFBundleIdentifier raw -o - <.app>/Info.plist`
  核对产物的 bundle ID 确实是测试 ID。
- 测试 App ID 没有 app group，`CindyNotificationService` 扩展也没有通信通知能力：只在生成的
  `ios/` 里删掉对应 entitlement（`com.apple.security.application-groups` 与
  `com.apple.developer.usernotifications.communication`；分享扩展、通知头像在测试版不可用），
  不改仓库里的配置。
- Xcode 27 需要 `SWIFT_ENABLE_EXPLICIT_MODULES=NO CLANG_ENABLE_EXPLICIT_MODULES=NO`
  （与 `scripts/build-ios.mjs` 相同），否则 WechatOpenSDK 模块解析失败。
- 安装：`xcrun devicectl device install app --device <udid> <.app>`。

### 从开发版 iPhone 读取历史 Debug 文件

手机与 Mac 配对、开启 Developer Mode 后，可通过 Xcode 设备管理窗口
（Devices and Simulators）选择对应开发版 App，使用 Download Container。
在下载的 `.xcappdata` 中查看 `AppData/Documents/cindy-debug/mobile-debug-*.ndjson`。
记录时不需要连着 Xcode；配对设备通过同网 Wi-Fi 可用时，也可以无线读取。
这不是任意互联网远程访问，实际权限取决于设备连接、开发签名与系统授权。

也可只拷出日志目录（bundle ID 必须取当前安装的开发版，不猜区域或包名）：

```sh
xcrun devicectl device copy from \
  --device '<paired-device-id>' \
  --domain-type appDataContainer \
  --domain-identifier '<installed-development-bundle-id>' \
  --source Documents/cindy-debug \
  --destination /tmp/cindy-mobile-debug
```

历史文件不会自动出现在 Xcode 实时 Console；该文件日志不是 Apple Unified Logging。
日志随 App 容器保存（可能进入系统备份），卸载会删除。尚未开启记录或尚未落盘时目录可能不存在。
Apple 参考：[配对设备](https://developer.apple.com/documentation/xcode/pairing-your-devices-with-your-mac)、
[下载容器](https://developer.apple.com/documentation/metal/creating-binary-archives-from-device-built-pipeline-state-objects)。

### 进一步测量

背景:2026-07 会话白屏/卡死排查确立的取证与回归测量体系。
触碰 `remoteSessionStore` 订阅链、首页/详情页列表派生
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

## Android Rendering Performance

- Record the running AVD's actual RAM, GPU backend, CPU count, resolution,
  installed build, source label, and uptime. `config.ini` can differ from the
  running emulator's command-line overrides (`hardware-qemu.ini`).
- First repeat a fixed scroll in Android Settings as an environment control.
  If it also stalls, save `dumpsys gfxinfo`, memory/swap counters and a Perfetto
  trace before investigating the app. Cold boot the same AVD without loading or
  saving a snapshot, preserve user data, and repeat the control with the same
  hardware settings. Do not attribute this recovery to an application patch.
- For the app, verify the updated bundle was actually loaded after restarting
  Metro through `mobile:sim:start`. A development client can continue running
  cached code after Metro exits. Focus/page assertions must pass before each
  scripted interaction; an aborted sequence is not a performance sample.
- Warm each version, repeat the same interaction at least three times, and keep
  builds, animation settings and simulator configuration identical. Do not run
  builds, type checks or tests concurrently with sampling. Record frame count,
  missed-deadline count and frame-time percentiles together: adding a native
  exit animation changes the denominator of the jank percentage.
- Use Perfetto to separate React/Fabric mount work, Compose recomposition,
  RenderThread and graphics-buffer waits. `gfxinfo` for a removed popup can omit
  that window's frames; retain snapshots while the popup is open as well as the
  process totals. Debug/emulator results identify regressions, but do not prove
  release-build performance on physical devices.

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
