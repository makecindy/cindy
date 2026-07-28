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
