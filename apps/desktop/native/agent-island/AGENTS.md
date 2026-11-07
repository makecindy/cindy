# 灵动岛原生 helper：角色（mascot）开发说明

本目录是 macOS 灵动岛的 SwiftUI helper（`macos-agent-island-helper.swift`，单文件、
顶层脚本模式）与其素材。产品运行时由 `src/main/agent-island/MacAgentIslandNativeHost.ts`
以子进程方式拉起，通过 stdin/stdout 逐行 JSON 通信。

## 角色动画预览（开发调试）

```bash
pnpm --filter desktop preview:island-mascots
```

会用 `swiftc` 编译本目录的 helper，并以命令行参数 `--mascot-preview` 启动一个
独立预览窗口：**行 = 角色，列 = 动画状态**，可切 Dark / Light / 两种模式同屏、切换真实
渲染尺寸档位、放大倍数、暂停动画、从头播放。关窗即退出进程。

尺寸档位给的是产品里的**真实值**，取自 helper 内 `AgentIslandMascotView` / `RunningMascotIcon`
的各个调用点（grep `AgentIslandMascotView(` 可一次看全）：16pt（收起 pill）、18pt（紧凑行与
`RunningMascotIcon`）、20pt（展开态）、40pt（设置页「图标皮肤」列表的角色本体，renderer 侧
`h-10 w-10`，见 `AgentIslandSection.tsx`；那套 UI 是 React/CSS 重画的，档位只作同尺寸参照）。
默认 20pt 且 1:1 显示 —— 角色在灵动岛里本来就只有 20pt 上下，
放大档位只做 `scaleEffect` 视觉缩放、不改渲染尺寸，所以放大后看到的几何比例仍是真实的。
调角色参数时**不要**靠放大后的观感下结论，最终一定要回到 1× 看。

这条分支只创建普通窗口，不读 stdin、不创建刘海面板，因此不会干扰正在运行的 Cindy。

另有一个更早的单状态 harness：`XDT_AGENT_ISLAND_DEBUG=idle|completion|interaction`
（见 `AgentIslandDebugHarness`），用来在真实刘海面板里看整块 UI，与角色预览互补。
日志开关是 `XDT_AGENT_ISLAND_DEBUG_LOGS=1`。

## 新增一个角色

角色 = 一张身体 PNG + 一组眼睛几何参数 + 一套配色，**动画时间线是所有角色共享的**
（`SpriteMascotView`：`idle` / `working` / `waitingApproval` / `completed`），新增角色
不需要写动画代码。

1. `mascots/<skin>.png` —— 128×128 透明底（`whitesnow` 是 134×134 的历史例外，不要照抄）
2. `macos-agent-island-helper.swift`
   - 顶部加 `<skin>MascotFileName` 常量
   - `AgentIslandAssets` 加 `<skin>MascotImage`
   - `SpriteMascotConfig` 加 `static let <skin>`（眼睛坐标按素材实际眼位量）
   - `AgentIslandMascotCatalog.skins` 加 id，`spriteConfig(for:)` 加 case
3. `src/shared/agentIsland.ts` —— `AgentIslandMascotSkin` 类型 + `AGENT_ISLAND_MASCOT_SKINS`
4. 设置页 —— `src/renderer/assets/agent-island-<skin>.png` 预览图，以及
   `AgentIslandSection.tsx` 里的 `MASCOT_PREVIEW_URLS` / `MASCOT_PREVIEW_CONFIGS`
5. 角色名文案走 i18n，先查 `i18n/GLOSSARY.md`

角色清单的单一真源是 `AgentIslandMascotCatalog.skins`（Swift 侧）与
`AGENT_ISLAND_MASCOT_SKINS`（TS 侧），两处必须一致；预览网格从前者派生，所以加完
第 2 步就能在预览窗口里看到新角色的全部状态。

## 本文件的两个 SwiftUI 陷阱

单文件顶层脚本（`main.swift` 语义）下踩过的坑，改这个文件时注意：

1. **`@State` 的内联默认值不可靠**，会退化成零值（`false` / `0`）。现有视图之所以正常，
   是因为它们的期望初值恰好就是零值，或在 `onAppear` 里显式重置。需要非零初值时，把状态
   放到 `ObservableObject` 的 `init` 里显式赋值（见 `AgentIslandMascotPreviewModel`）。
2. **控件初值会被吞掉**。`Slider` 首帧会把绑定值写回下界（`CGFloat`/`Double` 都复现），
   `Picker` 会写回首项。预览工具条因此改成自绘的 `AgentIslandPreviewChoice`（Button +
   自管高亮，显示与 model 必然一致）。
   遗留未解：换成自绘按钮后，`AgentIslandMascotPreviewModel.init` 里 `zoom = 3` 仍然只生效
   为 `1`（=档位首项），而同一个 init 里的 `appearance` / `mascotSize` / `animationsActive`
   初值都正常。根因未查明，当前把 `zoom` 默认值取成首项 `1` 规避（1× 也正是我们想要的默认
   真实尺寸）。若以后要给这类档位设非首项默认值，先验证初值有没有被改写。

## 余量芯片

空闲灵动岛与展开后的顶栏会显示各套餐余量，数据来自菜单栏的余量概览
（`src/main/agent-island/quota.ts` 投影 `MenubarView.sources`），展示哪些、顺序、隐私遮罩都跟菜单栏。
**灵动岛宽度由用户决定，不为余量加宽**：放得下几个显示几个。菜单栏「最低余量」对应的套餐
（`AgentIslandQuotaItem.lowest`，与菜单栏图标旁的数字同源）先占位，其余按菜单栏顺序补，显示仍按菜单栏顺序；
连它的完整芯片都放不下时（如刘海屏默认宽度）收成只有百分比。这样拉宽过程只会在它周围增加套餐，不会把它换掉。
展开时余量一律在顶栏居中（空闲时连同角色一起居中，与收起时同位；有任务时角色在最左），只在会碰到
角色或右侧工具按钮时让开；刘海屏展开时中间被刘海占住，余量跟在左侧角色后面。芯片的标称宽度由 main 算好随 `AgentIslandQuotaItem.width` 下发，helper 用它判断
放得下几个、不测字体；改芯片字号、logo 尺寸或间距时，同步 `shared/agentIsland.ts` 的 `AGENT_ISLAND_QUOTA_*`
与 `AgentIslandQuotaRow` 的常量，并重新实测「标称 ≥ 实绘」（见 `agentIslandCompactBadgeWidth.test.ts`）。

## 系统灵动岛（PROLED MacBook Pro）与实时活动

**命名**：本目录做的顶部任务面板，界面上叫「任务胶囊」（繁中「任務膠囊」，其他语言 Agent Notch），原名「灵动岛 / Agent Island」；
「灵动岛」只指 Apple 的（繁中「動態島」），设置页分区标题沿用「灵动岛」统称两者。代码标识（`agentIsland`、`AgentIsland*`）不改。
术语见 `i18n/glossary.json` 的 `agent-notch`、`macos-dynamic-island`。

2026-10 发布的 PROLED MacBook Pro 用摄像头挖孔取代刘海，系统自己的灵动岛（`MenuBarAgent`
的 CenterHUD）画在屏幕顶部正中。macOS 27.3 实测（模拟形态，与 Apple 设计资源的边框图一致）：
空闲约 57×32pt、距顶边 8pt；计时器实时活动紧凑态约 147×32pt；点开后约 261×58pt。

- **识别**：`AgentIslandScreenMetricsProvider.screenHasSystemIsland`——内建屏且
  `NSScreen.touchCapabilities` 含多点触摸，或私有 `_centerHUDDefaultFrame` 非空；两者都走运行时
  查询，旧 SDK 也能编译。这类屏幕 `hasNotch` 一律为 false（挖孔不是可躲的刘海），也不做居中吸附。
- **默认位置**：main 侧 `getLayoutPreferenceForDisplay` 在没有保存位置时，把岛放在系统灵动岛展开
  上限（`AGENT_ISLAND_SYSTEM_ISLAND_EXPANDED_HALF_WIDTH`）右侧；用户拖动后照常记住自己的位置。
  原因：系统灵动岛**画在我们的面板之上**（窗口列表报层级 26，我们是 27，合成时它仍在上），而且
  **不吞点击**，重叠时会挡住我们的内容并让一次点击同时触发两个岛。
- **模拟测试**：`XDT_AGENT_ISLAND_SIMULATE_SYSTEM_ISLAND=1` 把主屏当作系统灵动岛屏。真实的系统
  灵动岛只能在关闭 SIP/AMFI 的 27.3 虚拟机里用 `MenuBarAgent` 的 `EmulateCenterHUD` 打开；这种
  虚拟机里第三方 `_centerHUD*` 读数全为 0，`liveactivitiesd` 也查不到第三方应用，不能用来验证实时活动。

### 实时活动（`live-activity/`）

设置页「在系统灵动岛显示任务」，默认开启，与我们自己的岛是否开启无关。有灵动岛的 Mac 显示在
系统灵动岛，其他 27.3 Mac 显示在菜单栏右侧的实时活动区。

- **只能由 Cindy 主进程发起**：ActivityKit 按发起进程的应用身份找 `NSSupportsLiveActivities` 与扩展；
  本 helper 是父进程直接拉起的子进程，即使放进 `Contents/MacOS` 也会被拒（`unsupportedTarget`）。
  所以 main 通过 N-API 扩展 `cindy-agent-activity.node`（`addon.mm` + `CindyAgentActivityController.swift`）
  调用，状态投影与节流在 `src/main/agent-island/liveActivity.ts`。
- **发起时必须有可见窗口**：没有窗口会被拒（`visibility`），发起后转入后台照常更新。被拒后等下一次
  窗口获得焦点或 15 秒后重试；全程只保持一个活动，启动时先结束上次运行残留的活动。
- **Widget 扩展** `CindyAgentActivity.appex` 在 postPackage 装进 `Contents/PlugIns`，bundle id 为
  `<应用 id>.agent-activity`。必须按 Xcode 的方式用 `-e _NSExtensionMain` 链接：从 Swift `main`
  启动会跳过 ExtensionFoundation 的进程身份初始化，被 chronod 拉起即崩溃。共享的
  `CindyAgentActivityAttributes` 在扩展与原生扩展里都以 `-module-name CindyAgentActivity` 编译。
- **扩展里的界面**：图片只认编译进 Asset Catalog 的，从文件读的 `NSImage` 会渲染成灰块。`mascots/`
  里的素材没有眼睛（眼睛由本 helper 绘制），所以 `build.mjs` 先运行打包好的 helper
  `--export-mascots <dir>`，导出每个角色在运行中／等你处理／已完成三种姿态的静帧
  （`<skin>-running.png` 等），再用 `actool` 编成 `Assets.car`；改角色画法后实时活动会自动跟上。灵动岛与菜单栏药丸背景恒为深色，文字用白色而
  不是 `.primary`；菜单栏会省略只有文字的紧凑右侧区域，状态位要带一个图标。
  伙伴的任务在等你处理或已回复时，左侧换成伙伴头像（`ContentState.companion`：沿用岛上已压到 2 KB 以内的
  JPEG 缩略图，没有图时用表情或首字配色相底）；运行中仍显示角色。内容更新整体不能超过 4 KB，超限的头像
  直接丢掉、改用首字。动态图片用 `NSImage(data:)` 可以正常显示，只有从文件读的才会变灰块。
  颜色与计数格式跟我们的岛一致：运行中橙、等你处理青、未读完成绿，计数写成「等你处理 · 运行中」。
- **提醒展开**：只有「等你处理的任务变多」或「转为已完成」时带 `AlertConfiguration` 更新，系统会把活动
  短暂展开（菜单栏里是药丸下方的展开卡片）；计数下降和普通进度更新不提醒，首次发起也不提醒。提醒音用
  应用 `Resources` 里的静音 `cindy-live-activity-silent.caf`（`build.mjs` 生成），声音仍由我们的岛和通知负责。
  系统会限制提醒频率，连续提醒时后一次可能延迟出现。
- **和任务胶囊的分工**：角色与事件音效两边共用（设置页「共用设置」）。任务胶囊关闭时它的 helper 已挂起，
  事件音效改由主进程用 `afplay` 播放同一组文件（`src/main/agent-island/soundFallback.ts`），不为放声音拉起 helper。
  只开实时活动时，完成与待回复的系统通知由它代替（`AgentIslandService.ownsTaskAlert`），前提是用户在系统设置里允许、
  且它正在显示或此刻有可见窗口能发起（`AgentIslandLiveActivity.ownsAlerts`）；出错仍发系统通知（实时活动没有出错样式）。
- **构建条件**：`live-activity/build.mjs` 需要 macOS 27.3 SDK 与 Apple 芯片，否则整段跳过、应用不带
  此功能；`CINDY_LIVE_ACTIVITY=0` 可主动跳过。本地验证：
  `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer node build.mjs addon <out.node> arm64`，
  再对打包好的 `.app` 运行 `build.mjs extension <App.app> arm64`。
- **发布签名**：扩展必须带 App Sandbox。`scripts/ci/lib.mjs` 的 `signMacAppWithIdentity` 在签主 app 之前，
  先用 `live-activity/extension.entitlements` 和发布身份单独签 `Contents/PlugIns/*.appex`；对整个包 `--deep`
  统一签会丢掉扩展的沙盒权限，扩展将无法加载。
