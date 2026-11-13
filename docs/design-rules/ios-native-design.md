# Cindy iOS 原生界面规范

本规范整理自任务顶部、任务详情和搜索的产品走查，适用于 iOS 27 体验目标下的新增与改造界面。它是 [DESIGN.md](./DESIGN.md) 的平台补充，不是 Apple 官方规范，也不代表全部存量页面已完成迁移。实现应以项目已安装的公开原生 API 为准，版本名称不构成增加原生依赖的理由。

## 1. 原生行为与 Cindy 内容

- **能用原生的都用原生**（用户定稿 2026-11-07）：系统已有的控件、材质与交互一律用原生实现，不用 React Native 自绘去模仿。已安装的 `@expo/ui`（SwiftUI）能覆盖的就用它；确实没有公开原生 API 的部分才自绘，并在代码注释里写明原因。
- **浮动玻璃按钮**：浮在内容上的按钮（全屏预览、内置浏览器、远程画面等）用 SwiftUI 原生控件，并复用 App 共用的玻璃组件，保持各处风格一致：单个圆钮用 `NativeChromeButton`（`platform/chrome/NativeChromeButton.ios.tsx`），成组按钮用 `useNativeGlassGroupStyle` 的一枚胶囊、组内 borderless `Button` + SF Symbol，带菜单的圆钮用 `useNativeGlassButtonStyle({ shape: "circle" })`（见 `HomeDisplayMenu.ios.tsx`），Host 统一 `colorScheme` 与 `seedColor`；载入用 `ProgressView`。新界面不另写一套 `glassEffect` 参数。不要在 `expo-glass-effect` 的 `GlassView` 上叠 React Native 画的图标和文字再压一层底色——那样图标颜色是固定的，只能靠底色保证可读，玻璃就成了实色胶囊。玻璃的明暗、图标颜色、按压与禁用效果交给系统，不另加底色。共用样式见 `apps/mobile/src/platform/chrome/nativeGlassButtonStyle.ios.ts`，用法参考任务页顶栏 `SessionHeaderNativeControls.ios.tsx` 与全屏预览 `PreviewNativeChrome.ios.tsx`。
- **容器**：导航、sheet 的呈现、拖拽、收起、安全区和键盘协调优先交给系统。不要用自绘圆角、假把手和 JS 位移动画冒充原生 sheet。
- **控件**：分组表单优先使用原生 Form / Section 或原生分组 List；输入、按钮、开关、选择器优先用现有原生组件。原生外壳包着手工卡片，只能称为“原生外壳”，不能称为整页原生化。
- **内容**：消息、Markdown、代码、业务图标和复杂数据可继续由 React Native 渲染。不要为原生化替换用户已熟悉的业务图标；远程桌面和文件保留现有 Monitor / Folder。
- 系统管理的圆角、材质、字体和反馈遵循系统；不要强制覆盖成桌面几何或自行重画系统阴影。此范围只覆盖真实系统组件，自绘内容继续遵守 Mobile token 和双模式规范。系统导航符号可由原生控件提供，不扩展成任意混用图标库。
- Android 保留平台实现与同等业务能力；不能为统一代码而退回 iOS 自绘外壳。存量复杂面板可以分阶段迁移，但新增 iOS 面板不再默认走 SheetSurface。

## 2. 顶部导航

- 设置页与其他普通页面统一使用系统默认转场，不因入口位于左侧抽屉而反转方向。从首页抽屉进入设置、设备管理或插件页面时，抽屉退场（含遮罩淡出）与系统页面转场同步开始，不先等抽屉关完，也不额外叠加整页淡入。搜索与账号面板仍等待抽屉关闭回调，避免浮层重叠及键盘焦点丢失。实现见 `apps/mobile/app/_layout.tsx` 与 `HomeSurface`。
- 首页与任务页导航内容的垂直位置保持一致；安全区只计入一次。对齐的是返回按钮、标题和操作的实际中心，不是容器外框高度。
- 任务顶部整体透明，与中部内容保持连续背景，不另铺一条不一致的底色。
- 标题只显示任务名称，不叠 Harness 图标或第二排元信息；完整信息进入任务详情。长标题截断，不挤压两侧操作。
- 标题可有少量玻璃质感的药丸背景，但它是非交互标签，不应有按钮式强调、按压效果或交互语义。唯一的例外是双击标题直接打开重命名（单击无动作）：它不加按压效果与读屏按钮语义，读屏用户经任务详情重命名；不能重命名的任务不响应双击。
- 右侧保留远程桌面、文件、更多的组合操作；更多直接打开任务详情，不再先弹一层菜单。
- 消息上滑到顶部时逐渐变模糊，控制项始终清晰。渐变应覆盖完整过渡区，避免突然出现一条重度模糊带。
- 本轮任务顶部的参考调校为模糊强度 55、连续渐隐蒙版；标题与输入框上方状态胶囊统一使用强度 20 的浅磨砂和 surfaceTranslucent 半透明底色。它们是局部实现参数，不是所有页面的通用 token。当前蒙版是固定强度模糊的渐隐，不应称为可变模糊半径。

## 3. 面板与材质

- 任务详情默认中等高度，允许上拉展开、下拉关闭；不要默认占满屏幕。
- 可直接下拉关闭的任务详情和搜索不放右上角关闭按钮。需要显式取消、保存或防丢输入的编辑流程另按其语义设计，不把此规则扩展到所有弹窗；同时保留无障碍可用的关闭途径。
- 保留系统 sheet 的玻璃材质。内部不要铺满不透明白底削弱玻璃感，也不要把每个内容块做成玻璃按钮。
- 分组之间必须有清晰间隔，组内分隔线由统一分组组件管理。确有必要的自定义数据区域使用语义背景与轻量层次，避免卡片紧贴、重叠和多层边框。
- 面板底部的确定／取消在软键盘弹起时必须完整可见；系统对内嵌内容的键盘避让不足时，按实际遮挡高度补齐，不用固定高度猜测。
- 短工具按内容决定高度；长详情用可滚动内容和系统展开档位。不要用空 Spacer、固定大高度或多余说明撑大面板。
- 从详情进入搜索等另一个面板时，等前一个真正关闭后再呈现；不能叠加两个遮罩，或仅依靠任意延迟安排切换。
- **任务标签**：任务选项面板不重复任务标题，左滑所在的行已说明操作对象。标签色块 28pt，沿整行等距排开，每格不小于 44pt 触控；彩色色块不描边，只有白色标签保留细描边以免在浅色面板上消失，这是对 [DESIGN.md](./DESIGN.md) 标签色球「细描边」在 iOS 原生面板的收窄。末尾的「…」用同尺寸的灰色实心圆。
- **标签管理页**使用原生分组列表，与选项面板同一套材质：「‹ 标签」导航，行内是色块、名称和编辑铅笔，列表下用一行说明提示长按拖动排序，「添加标签」单独成组。编辑页依次是名称输入、两行六列色板、说明和整行主按钮，「删除标签」作为独立的危险操作组放在最后。返回即取消，不再另设「取消」「完成」按钮。

## 4. 任务详情的信息顺序

1. 任务名称与必要的来源／用量摘要。
2. 同组管理操作：重命名、复制任务链接、置顶／取消置顶、归档。
3. 适用时展示其他任务能力入口，例如分支；保留原有能力条件。
4. 搜索放在管理操作之后。
5. 删除作为独立危险操作组。

文件和远程桌面已有常驻入口，不在这里重复。功能不可用时遵循真实业务状态，不为对齐布局伪造入口。

来源显示供应商名称；若绑定订阅账号，同时显示该供应商实际绑定的账号身份，并去除重复内容。不展示内部 provider ID、随机后缀或无助于决策的“未确认使用此套餐”说明；不拿其他账号身份补缺失值，不把未知套餐写成确定事实。

## 5. 搜索与触控

- 任务内搜索是一件紧凑工具：原生输入框、清除、命中计数、上一条／下一条即可；仅在需要时出现加载更早消息的入口。
- 不重复展示命中消息预览，不用说明文字和空白填满半屏。无结果、加载中等真实状态仍要表达清楚。
- 命中后在原消息位置定位，让用户看上下文；键盘打开时仍应能输入、清除、切换结果及关闭搜索。
- 按钮整行都可点击，包括文字右侧空白；独立触控目标至少 44×44pt。外观尺寸和热区独立，不能仅把字号或图标放大。
- SwiftUI 自定义行须在尺寸与内边距确定之后设置完整命中形状；禁用、危险色、按压反馈和无障碍名称必须与实际行为一致。

## 6. 输入框与附属面板

- 输入框默认收起为一行；点击后才展开多行编辑与工具栏，不默认占据消息区域。
- 富文本编辑器保留草稿、引用、长文本折叠、选择与撤销语义。当前任务输入框使用 WebView；原生面板隐藏键盘后可能残留 DOM 焦点，恢复编辑时须先释放旧焦点。
- 玻璃用于外层承载，正文必须清晰。录音中的识别文字直接进入编辑器；停止录音不自动发送，保留既有按住与滑动发送交互。
- 附件面板默认半屏，最近媒体在前，照片／拍照／文件在同一原生分组，模式入口放后面。系统选择器须等附件面板关闭后再打开。
- 最近照片仍在点选时同步校验并入队，恢复输入则由面板真正关闭的回调驱动，不用固定延迟猜测动画结束；关闭期间只接受第一次选择，快速重开不得重放旧焦点恢复。
- 模型面板遵循 [统一模型选择器](../product-rules/model-selector-unified.md)：直接选模型，收藏配置优先，已有任务再展示当前模型与同引擎推荐，随后按来源分组。主列表不提供 Harness 切换栏。
- 搜索与来源筛选保持可见，搜索跨来源；模型行与设置入口分别有完整点击区域。Harness、推理强度、Fast、收藏与恢复推荐进入单个模型的原生设置页，返回保留搜索条件。
- 收藏以被控电脑当前账号的已有收藏为真源：手机和桌面远程连接共享该电脑的完整配置副本，新增、编辑、删除等待被控端持久化确认。不同被控电脑相互独立，控制端自己的本机收藏不参与合并。引擎偏好仍按手机登录账号及被控设备隔离；当前任务选中标记只落在模型本体。深度/Fast 沿用既有草稿记忆和远端镜像；旧远端没有删除偏好的协议时，恢复推荐仍沿用桌面兼容快照写法。

## 7. 验收与迁移

- 自绘内容的 Light / Dark 都必须实现，系统组件跟随应用主题。不能把“用了 themed 样式”当成两种模式已经目检。
- 核对长中文／英文标题、大字体、窄屏与 iPad，避免把截图中的单台设备尺寸写成全局固定布局。
- 实际检查：行右侧空白点击、半屏滚动、上拉展开、下拉关闭、快速重开、详情到搜索切换、软键盘、无结果和多结果导航。
- 检查增加对比度、减少透明度等系统设置下的可读性；非交互标签不能被读成按钮。不能以保持玻璃感为由覆盖用户的无障碍偏好。
- 交付分别写清“代码实现”“静态验证”“模拟器目检”“真机验证”。确认运行的是包含改动的源码后再宣称效果生效。
- 不因文档要求而批量重写所有页面。迁移优先级及当前缺口见 [本轮审查](../design-evidence/2026-09-15/ios-native-audit.md)；原生配置变动仍遵守 [冷更边界](../dev-rules/mobile-development.md)。

## 8. Mobile iOS navigation chrome / iPhone Duo

> 迁自 `DESIGN.md` §5，规范效力不变。本节未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。

- The home menu artwork is the narrow 20pt glyph centered in a transparent 26pt canvas, with semantic template tint in both modes; do not use an empty Stack.Toolbar.Badge (the current header bridge creates a large string badge). Duo uses the same template. The menu carries no attention dot: it only marked tasks needing attention from the retired teammate home.

- The home takes its iOS navigation container, menu control and centered-title width from HomeStackHeader (2026-10-13). The bar's measured-height blur is drawn once by the home route behind the bar. The home menu uses the slightly narrower three-line template in assets/navigation/menu.svg (owner refinement, 2026-10-13); only artwork changes, not button geometry or hit targets. System toolbars own ordinary menu/create/action geometry, with the existing Duo top-left exception. Task scope titles retain their long-name toolbar avoidance. Android retains its existing fallback; chat, secondary-page and sheet headers are not claimed migrated.

- Teammate and group chat headers (`ChatIdentityHeader`) keep their left-aligned identity (mark, name, one subtitle line) next to back (owner decision, 2026-10-13). Back is the task header's system `chevron.backward` (`NativeChromeBackButton`). For teammates, the trailing glance (LayoutGrid) and settings actions stay **two separate glass circles** with their existing Lucide artwork (18pt); only their stroke rises to `CHAT_HEADER_GLYPH_STROKE` (`iconStroke.medium`, about 1.65pt) so they read level with back — do not group them into one capsule or swap their artwork. On iOS the header floats on the same feathered `SessionHeaderNativeBlur` as the task header and content scrolls beneath it; an opaque header band is not allowed because its hard bottom edge reads as a divider. Because the two-line identity runs to the header's lower edge, chat headers keep the whole header over solid blur and feather only below it (`CHAT_HEADER_BLUR_FADE_INSIDE = 0`); single-line task and home bars keep the default 24pt inside feather. All iOS header blurs are progressive (owner request, 2026-10-13, to approach the softer system scroll edge on Settings): three equal layers (`HEADER_BLUR_LAYER_INTENSITY`) start fading together and finish at one third, two thirds and the end of the fade, which reaches `HEADER_BLUR_FADE_OUTSIDE` (24pt) past the chrome edge, so the blur thins toward content instead of one layer cross-fading into a double image. The composer's bottom blur keeps its single 55 layer. Android keeps its existing header.

- Teammate rows share the task list typography: 18pt medium (500) titles with 28pt line height, 15pt regular previews with 26pt line height, and 13pt metadata with 22pt line height.

- Wide Home and task-sidebar presentations share one native list instance in `ResidentHomeListProvider`, outside route lifetimes. Route slots supply layout and callbacks; do not key the host by task/route or restore a cached offset over its live scroll position. Collapse/expand its bounds, keep native headers outside its touch area, and pause hidden row subscriptions. Narrow screens retain their route-local list.

- Home's main menu is a top-left affordance, including when Duo moves native toolbar actions into the right rail. Host this home-only exception in the native header's left custom view with its shared background hidden, never in an absolute screen-content overlay under the transparent navigation bar; remote-desktop and display actions remain native toolbar items.
- When Duo moves those actions into the vertical bar, Home's task-scope title rides in a trailing custom view (shared background hidden) spanning the gap after the menu to the content edge, because UIKit caps a title view to the mirrored space around its center (owner decision, 2026-11-06). It keeps the phone's long-name rule mirrored: centered over the content column when it fits, otherwise against the tight side — the menu — growing toward the trailing edge before it ellipsizes. Never let that view ask for more than the gap: a wider one is moved into the vertical bar's overflow menu.
- Custom iOS home/sidebar icon buttons and standalone back buttons share `NativeChromeButton` (SwiftUI Button with native glass style). Preserve existing icon artwork inside the native label; do not substitute a React Native Pressable with a separate GlassView for this button family.
- Mobile glass button styles are configured in `platform/chrome/nativeGlassButtonStyle.ios.ts`: neutral circles, text/primary actions and grouped toolbar material share that entry. Home floating new-task and share-cancel actions use the same native button path; text buttons retain intrinsic label sizing. Keep light/dark semantic colors and native disabled/activation behavior. Non-iOS retains the React Native fallback.
- Login actions use `LoginNativeButton.ios.tsx` with the same shared glass styling. SwiftUI owns activation, disabled state and loading indicators; existing brand artwork can remain inside RNHostView labels. The login stage retains its design-coordinate frames and scaling, while text actions use native borderless buttons. This supersedes the hand-painted button feedback in the login skin on iOS only; inputs, consent checkbox, inline legal links and non-iOS controls retain their existing implementations.
- The home main menu remains a left-edge drawer on every platform and window shape, using `HomeChromeDrawer.tsx` (iOS uses FullWindowOverlay above the native header; Android uses a transparent Modal window, because wide layouts mount the resident home list and connection notices in root layers that an in-route overlay cannot cover). Preserve backdrop dismissal, swipe-left dismissal and the drawer's close lifecycle. Native glass button unification must not replace this navigation drawer with a bottom sheet. Device-scope/display pull-downs keep their existing system UIMenu path and native toolbar menus; their custom panels are fallback code, not a reason to replace working native menus. System navigation/toolbars remain native container-owned.
- Standalone custom navigation controls use a 44pt visible circle and 44pt hit frame (`navigationChrome.target`), with 20pt artwork (`iconSize.action`) centered inside. Apply the native interactive glass effect after the explicit frame on a borderless SwiftUI Button; do not add `controlSize(large)` or another glass/padding layer. System toolbar items retain native sizing and positioning: never replace them with `Toolbar.View` to enforce this custom-control rule, because that breaks Duo's vertical adaptation.
- Prefer the native navigation container for page back/close and toolbar actions. On Duo, let the system adapt navigation to the shared status/toolbar region; only the detail column gets the vertical bar in a split view. Sidebar-local menus stay in the sidebar.
- Floating page chrome that a native bar cannot host (file preview's close, title capsule and menu) takes its edges from `floatingTopRow`: in Duo portrait it shares the status row and ends before the status area, the same way the native bar does; beside a vertical bar its close and menu become native toolbar items and the title keeps a top margin instead of touching the screen edge. Chrome inside a Modal stays fully in the Modal and never writes the host route's bar. Full-screen Modal controls add the side safe insets, which hold the landscape notch or Duo's vertical bar (2026-10-29).
- Full-screen custom overlays (remote desktop) keep back and tools on the right in both Duo landscape rotations, centered on one rail below the system status area. Back comes before tools. Respect safe areas and reserved folds; do not mirror the rail from a video orientation event.
- Portrait tabletop remote desktop on iPhone Duo defaults to the Macintosh II-inspired case and functional keyboard (owner request, 2026-10-24). The lower-pane appearance rail accepts left/right swipes and an accessible tap to cycle directionally through classic, slim classic, full-screen retro, Macintosh II, PowerBook 170, ThinkPad 701C and modern (wrapping at either end), retaining the choice for this viewer. Slim and full-screen variants maximize the viewport and use a nearly full-width keyboard and invisible palmrest pointer surface; retain the original classic as a comparison. Switching between any two appearances releases held input. Pointer gestures cover the entire palmrest below the keys, independently of the much smaller visible touchpad, trackball or buttons; never extend this region over the keyboard or appearance rail. Use photorealistic classic Macintosh-inspired hardware artwork: textured ivory plastic, a deep CRT recess, a floppy slot and beveled keycaps (owner refinement, 2026-10-24). Hardware artwork keeps each model’s material in Light/Dark mode, with Light text tokens on ivory keycaps and Dark text tokens on graphite keycaps. Macintosh II and PowerBook retain their rainbow Apple badge; ThinkPad retains its black material and red TrackPoint. These are space-adapted homages, not mechanically exact replicas; surrounding app chrome follows the active theme. Fit the live viewer within the screen opening. Do not substitute flat CSS/vector panels for the physical material. Keep the live viewer and lease mounted across switches. Unfolded/landscape layouts and system keyboard panels retain their ordinary appearance. Implementation: `apps/mobile/src/remote-desktop/FoldDesktopSkin.tsx` and `RemoteDesktopScreen.tsx`.
- Duo retro hardware draws the upper display case and lower keyboard deck edge-to-edge across their respective physical halves, meeting at the fold center. Scale the original artwork itself; never fill unsafe strips with a separate texture, tiled background or substitute image. Only the live screen, keyboard and interactive controls respect safe regions and toolbar clearance (owner correction, 2026-10-24).
- Android foldables share the same adaptive pane and portrait tabletop remote-desktop layouts, including the keyboard, touchpad and appearance selector (owner request, 2026-10-24). Use Jetpack WindowManager's separating folds/hinges in local dp; a zero-thickness crease is valid. Flat continuous screens return to ordinary responsive layout, while a physical hinge stays reserved. Preserve Android's own safe areas, navigation appearance and keyboard-driven window resize; do not emulate iOS vertical system bars or infer a fold from a device name or aspect ratio. Unsupported devices and older packages retain the responsive fallback.
- Retain the first three appearances (classic, slim classic, full-screen retro), but apply the same space optimization to all three: enlarged host-aspect screen openings, nearly full-width keys, shared beveled spacebar and bounded legends. This supersedes keeping the classic layout unchanged as a comparison. Reserve the lower safe area and toolbar before allocating keyboard height; a short lower pane scrolls the keys rather than pushing the palmrest outside the screen (owner refinement, 2026-10-24).
- Floating back/menu controls use the shared `navigationChrome.target` size; grouped actions use the same target breadth, without an extra outer padding ring. Use native Liquid Glass (regular for app navigation; clear over immersive remote desktop imagery), circle for a single icon and capsule for a group; do not tint neutral glass with opaque surface colors. Use semantic foregrounds and the existing non-glass fallback in both themes.
- Clear glass over remote imagery follows the navigation theme: dark icons in Light and light icons in Dark. A localized light/dark backing inside the control outline protects contrast, with a matching translucent selected-state fill. Keep the material clear and the desktop outside the controls unchanged. This explicit two-mode palette is Cindy’s design choice; Clear material does not provide automatic foreground adaptation.
- The mobile in-app HTML browser's floating controls sit over arbitrary page content. They keep regular glass and add the translucent `navigationChrome.pageTint` theme tint (70%, never opaque). Untinted regular glass adapts to the page behind it. Over a light page in Dark mode it turned light under light icons. The tint keeps the control polarity aligned with the app theme. The user approved this design on 2026-10-11.
- These are Cindy's shared component rules, not a claim that Apple's status glyph is an app button or that Apple mandates our precise size. Content actions and keyboard accessories retain their own hierarchy.
- References: [Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo), [Raise the bar with iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111462/), [Design for iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111466/).
