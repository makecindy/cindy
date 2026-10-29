# 开发环境与依赖准备

> **读取时机**：首次克隆、创建新 worktree、缺少依赖或安装命令失败时

## 环境要求

- Node.js 与 pnpm 版本以根 `package.json` 的 `engines` 和 `packageManager` 为准。
- Git 与 Git LFS。

先核对实际版本：

```bash
node --version
pnpm --version
git lfs version
```

## 安装

```bash
git clone https://github.com/makecindy/cindy.git
cd cindy
git lfs pull
pnpm install
```

`pnpm install` 的 postinstall 会按当前平台 **best-effort 自动下载 Desktop runtime
二进制**（claude／codex／ripgrep／pi，不入 git；失败只告警不阻断）。dev 启动前
的 guard 会按同一份 runtime kind 清单再确认：全新 clone／worktree 缺少任何一项时都会
自动补下载，仍无法准备才会中止 dev 启动并给出明确错误。
正常情况下无需手动安装二进制。

macOS/Linux 的 `apps/codex-package-bin/<平台>/codex-path/codex` 由上述检查流程在
完整包校验通过后补入，并更新目录清单；运行中的开发版不改包目录。脚本转发到同包的
`bin/codex`，使任务里的 shell 使用与任务相同的版本；已有的非 Cindy 脚本不会被覆盖。

postinstall 最后还会按 Electron `install.js` 的语义复核 `node_modules/electron/dist`，
缺失或版本不符就补装（`node scripts/ensure-deps.mjs --electron-binary`；设置了
`ELECTRON_SKIP_BINARY_DOWNLOAD` 或 `ELECTRON_OVERRIDE_DIST_PATH` 时跳过）。原因：pnpm 的
side-effects cache 一旦记下「electron 已构建但没有产物」，同机之后每次安装都会跳过 Electron
自己的 postinstall，留下缺 dist 的安装，桌面端单测会整片报 `Electron failed to install
correctly`。`pnpm test:unit` 等 workspace 测试开跑前也会只读检查一次依赖与 Electron，
未就绪时以 `DEPENDENCY_SETUP_INCOMPLETE` 直接给出处置命令，不再让几十个测试文件各自报错。

新 worktree 不共享 `node_modules`。确认 checkout 已完成且根 `package.json` 存在后，
在该 worktree 内重新运行 `pnpm install`；不要加 `--ignore-scripts`，上述补装都在安装
脚本里完成。

Mobile 的 Global / CN 开发与打包只需仓内公开端点清单，不要求本机存在
`config/endpoint.dev.json`。Metro 在这两个区域将私有 dev 清单排除出依赖图；不能靠从
另一个 checkout 复制私有配置来修复新 worktree。只有显式选择 `--region=dev` 时才需要
按 `config/endpoint.dev.json.example` 准备该文件，缺失时保持明确失败，不切换区域或端点。
模拟器与运行源码身份检查使用 [Mobile 开发入口](mobile-development.md#日常模拟器入口)。

Cindy Make 的设置入口和指令前置弹窗共用源码准备流程：切到 `cindy-personal` 后，
按锁文件预热包含开发依赖的 pnpm store 缓存，成功后才标记源码就绪。预热使用
`pnpm fetch --frozen-lockfile --prefer-offline --prod=false --ignore-scripts
--config.node-linker=isolated --config.enable-modules-dir=false`，只下载／复用缓存，
不为个人分支建立依赖目录、不执行安装脚本；这两个 config 参数仅作用于预热子进程。
每次准备都由 pnpm 校验当前锁文件和缓存，缺失或变化的包才补下载，不用就绪标记跳过校验。
实现与回归见 [sourcePreparation.ts](../../apps/desktop/src/main/cindy-make/sourcePreparation.ts)
及其[测试](../../apps/desktop/src/main/cindy-make/__tests__/sourcePreparation.test.ts)。
用户继续后，开发任务的 worktree 使用已选定的系统或 Cindy 管理
工具（含原生依赖构建所需的 Python），并通过
`pnpm install --frozen-lockfile --prefer-offline --prod=false` 优先复用
准备阶段填充的 pnpm store 缓存，并执行必要的安装脚本；各 worktree 仍保留独立的 `node_modules`，不复制或
链接个人分支的依赖目录。安装失败或取消可在现有 checkout 上重试，不重置个人分支。

## macOS：SwiftUI helper 缺少宏插件

开发版的菜单栏 helper 会由本机 `swiftc` 按需编译；正式安装包使用随包提供的二进制。
若开发日志出现 `plugin for module 'SwiftUIMacros' not found`，或
`external macro implementation type 'SwiftUIMacros.StateMacro' could not be found`，
先核对当前选择的工具链与 SDK：

```bash
xcode-select -p
xcrun --find swiftc
xcrun swiftc --version
xcrun --show-sdk-path
```

2026-10-18 已复现的组合为 Command Line Tools 的 Swift 6.4 与 macOS 27.0 SDK：
一个只含 SwiftUI `@State` 的最小程序也因缺少该宏插件而无法编译。同机指定已安装的
macOS 26.5 SDK 后，最小程序和 Cindy 菜单栏 helper 均编译成功。

遇到这一组合且本机已有兼容 SDK 时，可在交互式 Terminal 中只为本次启动设置
`SDKROOT`。标准输入和标准输出都必须连接 TTY；Agent 需要先为执行工具分配 PTY
（例如设置 `tty: true`），再在该会话中运行下面的命令。无 TTY 时，启动器会另开
Terminal，当前转发的环境变量白名单不含 `SDKROOT`，因此直接执行本例不会应用该设置。
示例先检查 TTY；检查未通过时，应切换到交互式 Terminal 或分配 PTY 后执行。
以下是中国大陆版隔离实例的已验证示例；Global 使用 `--region=global`：

```bash
test -t 0 && test -t 1 &&
  test -d /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk &&
  SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  pnpm restart:desktop:remote --region=cn --isolated=swiftui-sdk --passive
```

该设置只影响此命令及其子进程，不修改系统默认工具链。26.5 是此次验证过的兼容 SDK，
不是项目的固定版本要求；若未安装该 SDK，应先核对所选 Xcode / Command Line Tools
是否包含所需宏插件，再选择兼容且完整的开发环境。

启动成功后，还应核对菜单栏 helper 的编译与启动日志；`DESKTOP_DEV_VERDICT=ready`
只说明 Desktop 启动就绪，不能单独证明菜单栏功能已通过验收。编译入口与失败处理见
[`MacMenubarNativeHost.ts`](../../apps/desktop/src/main/menubar/MacMenubarNativeHost.ts)，
隔离与启动参数见 [`desktop-development.md`](desktop-development.md)。

## macOS：iOS 模拟器构建工具链

首次安装开发包不等于首次完整编译。先按 [Mobile 模拟器流程](../../apps/mobile/docs/simulator-debugging.md#截图与当前版本测试)
检查已安装包；需要安装或更新原生包时，`mobile:sim:rebuild` 会先检查跨 worktree 的
fingerprint 缓存。命中兼容产物就直接安装，不要求 CocoaPods；只有缓存不可复用时才编译。

完整编译需要选中的完整 Xcode、iOS Simulator SDK、目标设备所需的已安装 runtime，
以及当前 Agent 的 `PATH` 中可运行的 CocoaPods。仅安装 Command Line Tools 不够。
在实际运行任务的终端核对（终端 App 可用不代表 Agent 子进程也可用）：

```bash
xcode-select -p
xcodebuild -version
xcrun --sdk iphonesimulator --show-sdk-path
xcrun simctl list runtimes
pod --version
```

Xcode 选择由本机 `xcode-select` 或本次进程的 `DEVELOPER_DIR` 决定；首次启动设置、许可和
runtime 下载在 Xcode 完成。机器上的实际安装位置、选中的设备和工具是否可用应现场检测，
不写成仓库默认值。模拟器的 SDK/runtime 不等于 CocoaPods，也不等于可复用 App。

CocoaPods 使用开发者已有的工具管理方式：

- 已安装 Homebrew：`brew install cocoapods`，随后确认当前 Agent 的 `PATH` 能找到它。
- 已有独立 Ruby（例如 rbenv/RVM 管理）：先核对 `ruby --version` 和 `gem --version`，
  然后 `gem install cocoapods --user-install`；将 `ruby -r rubygems -e 'puts Gem.user_dir'`
  输出目录下的 `bin` 加到该工具环境的 `PATH`，再验证 `pod --version`。
- 两者都没有：先按开发者选定的方式准备独立 Ruby 或 Homebrew，再安装 CocoaPods。
  不因系统带有 Ruby 2.6 就假定当前 CocoaPods 及其依赖可安装，也不自动替换系统 Ruby。

这遵循 [CocoaPods 官方安装说明](https://guides.cocoapods.org/using/getting-started.html)
推荐的独立 Ruby 与用户目录安装方式；安装命令成功仍须通过上面的本机检查。工具链安装、
系统路径调整与许可证接受遵循当前用户授权，不由仓库脚本静默执行。

缓存未命中时，`rebuild` 在生成 `ios/` 前运行只读工具检查，输出 `SIM_BUILD_PREFLIGHT`；
缺失、执行失败或超时以 `IOS_BUILD_TOOLS_UNAVAILABLE` 结束。先修复回执中失败的工具，
用原来的 region / UDID / `--mock` 参数重试，不通过换区域、清缓存或换真机掩盖环境故障。

## Linux：Electron SUID sandbox 权限

较新的 Ubuntu（23.10+ 默认用 AppArmor 限制非特权 user namespace）上，Electron 会退回
SUID sandbox，dev 启动时报
`The SUID sandbox helper binary was found, but is not configured correctly`。修复：

```bash
cd node_modules/electron/dist
# 先原位复制一次，断开与 pnpm store 的硬链接——pnpm 的 side-effects cache 会把
# electron postinstall 产物 hardlink 进共享 store，直接 chown/chmod 会把 store 副本
# 一并改成 root+setuid，波及本机其它复用同版本 Electron 的项目/worktree。
cp chrome-sandbox chrome-sandbox.tmp && mv -f chrome-sandbox.tmp chrome-sandbox
sudo chown root:root chrome-sandbox
sudo chmod 4755 chrome-sandbox
```

注意：

- `node_modules/electron/dist` 由 electron postinstall 解包／从 store 链接，**每次重装
  依赖或 electron 升版本后该权限都会被重置**，每个 worktree 需要各自重跑上面的步骤
  （包括断链那一步）。
- 只做上述针对性修复；不要放开系统级 user namespace 限制，更不要用 `--no-sandbox`
  绕过（违反 Electron 安全边界，参见
  [`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)）。

## 不变量

- 公开版本不包含内建插件种子；插件通过 SkillHub 或手动安装。不要把任何访问令牌写入
  仓库、Git 配置或脚本。
- Desktop runtime 二进制（claude／codex／ripgrep／pi）的版本由仓库维护者统一判断与升级；贡献者和
  Agent 不要修改 `tools/<kind>/latest.json` 的版本 pin，也不要主动升级二进制。
- 依赖和命令的事实源是当前 checkout 的 `package.json` 与脚本。文档和脚本冲突时，
  先核对代码并修正文档，不要继续执行已失效命令。
- 不要把其他 checkout 的 `node_modules`、用户数据、授权文件或数据库复制进当前工作区。

贡献方式与 PR 流程见仓库根 [`CONTRIBUTING.md`](../../CONTRIBUTING.md)。
