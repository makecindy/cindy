# UI Implementation Contract: Mobile plugin management

## Objective
在手机查看目标电脑插件、安装/升级/卸载，以及直接编辑插件原设置页。

## Inputs
- 用户 2026-10-19 确认四项布局，并追加两个 Use it in 按钮吸底。
- 用户随后授权开发，并明确允许原设置页中新输入凭证的限定 WebView 例外。
- 统一开发基线 a83a9a0d1f3bda5e399dcd81844a567307de6663。

## Scope
- iOS / Android；Host 既有管理和加密设置接口。
- 不包括文件导入、替换市场来源、服务端或新增原生依赖。
- 存量插件无需重装、重授权或重新配置。

## Current Implementation Map
- PluginsScreen：目标电脑、详情读取、启停、导航与任务入口。
- PluginDetailView(.ios)：两端详情布局。
- pluginDetailModel：Host 事实到展示状态；原权限缺少语义图标字段。
- Host remotePluginManagement / mobilePageService：已有管理事务与 settings:open。

## ASCII To Layout Contract
1. 导航栏右侧齿轮菜单，按真实安装状态提供安装、升级、卸载。
2. 页面顶部统一状态 Banner；无状态不预留空白。不在身份区重复。
3. 插件身份、简介及目标电脑；保留启停开关。
4. 头部下方独立配置卡，原 settingsHtml 负责字段和交互；高度随内容，窄屏可操作。
5. 工具与权限；权限为 icon + 标题/说明的精简卡，无逐项展开。
6. 按用户后续反馈恢复 Details：主标题下展示有值的作者、版本等详情，不渲染空字段。
7. 两个使用按钮从正文移到底部固定操作区；留足安全区，不覆盖滚动内容，键盘出现时收起。
8. 离线和旧 Host 保留可读信息；未知结果只查询原操作，不自动重做。

## Platform Mapping
| 区域 | iOS | Android |
| --- | --- | --- |
| 管理菜单 | reuse Stack.Toolbar.Menu 与系统 gearshape | reuse Material DropdownMenu |
| 详情 | adapt SwiftUI List + RNHostView 原内容 | adapt RN ScrollView + 原生 Switch |
| 原配置 | new 独立非持久 WebView + 加密桥 | new 同合同 WebView + 加密桥 |
| 吸底按钮 | adapt 原生按钮，List 外布局 | adapt RN 按钮，ScrollView 外布局 |
| 权限 | adapt Host kind/labelKey，未知用通用图标 | adapt 相同语义 |

## File-Level Plan
- 总控：PluginsScreen、PluginDetailView(.ios)、pluginDetailModel、必要小组件与五语文案。
- T1：mobile 管理客户端、能力/回执解析、事务控制器及其测试。
- T2：原配置 client/document/bootstrap/card 与独立测试。
- T3：合成 fixture、Host 边界回归、权限 kind/labelKey 的兼容投影。
- 三份独立 worktree；总控审核 diff 后集成一个预览分支，不覆盖旧脏树。

## Validation Matrix
- 真实组件测试：菜单、确认/取消、顶部状态、配置挂载、任务按钮与跨目标迟到失效。
- 管理回执：未知/断线/过期/Host 重启不重放；取消不覆盖已提交结果。
- 原配置：合成原 HTML 的读取/保存、主题、资源路径与桥，秘密不回读/不落盘。
- 定向单测、受影响包 typecheck、mobile scope/smoke；提交前遵守仓库门禁。
- 原生 iOS/Android：宽窄屏、滚动、键盘、安全区、菜单；Light/Dark 分别记录证据。
- 未执行的实机 OAuth 或真实 Host 闭环单独标记，不以 mock 代替。

## Known compatibility limits
- 原 settings OAuth 的 127.0.0.1 固定端口 GET 回调由新原生包 CindyPluginOauth 接收，code 经原加密事务交回 Host，原 PKCE/redirect 不改；缺模块旧包提示更新。localhost/IPv6/CORS 回调仍拒绝。打开或关闭系统浏览器不算成功，须等待 Host 成功；Host 在原 deadline 内保活。第三方实机验收结果另记，不以单测代表登录成功。
- 原页依赖浏览器本地存储/固定宽度等兼容缺口按实际结果记录。

## Approval Gate
- 页面实现已获用户授权，不再重复请求布局批准。
- 新输入凭证只可瞬态存在隔离原设置页，走专用加密通道送目标；不入手机存储/日志/BC，不回读 vault。普通 mobile fetch 门禁不变。
- 未授权 push/PR/合并；如实际改动触发原生冷更或插件基座合并门，按仓库规则处理。

## Implementation and validation (2026-10-19)
- 已集成安装/升级/卸载客户端、原设置卡、菜单/顶部 Banner/权限卡/吸底按钮及五语文案。
- 目标与选择同步绑定；切电脑/插件的迟到菜单确认无效。成功回执后只有新快照读取成功才导航，读失败保留真实回执。
- settings:open + 原 v3 密封请求；普通页面原有 fetch 门禁未放开。新输入只在隔离原页短暂存在，存储 API、页面日志、外部资源出网被禁；已存 vault 值不回读。
- 设置页卸载时关闭租约；清理只绑定原账号/电脑/连接/安装批准，不因页面不可见拦住自己的关闭。普通命令仍要求当前页面有效。
- 原页退后台后清理页面；浏览器授权返回重开原 HTML 读取目标事实，不重放保存。未提交输入不持久化，也不承诺后台草稿恢复。
- Mobile 管理/设置/页面/原生组件定向共 144 项通过（10 文件 143 项 + 卡片生命周期 1 项）。Host 事务/权限投影 62 项通过。Mobile / Desktop typecheck、scope、smoke（2 项）、bootstrap --check 通过。
- 系统 iOS QA 设备 423C9ECB-82C6-4398-AA64-ACC0FB65C306（iOS 26.5、402 pt）已从本 worktree 构建安装；原生指纹 5946001c5dbbe2ec1994a804dd2b88644536ebf6 匹配。首个 Metro 失败因忽略的 endpoint.dev.json 缺失，按仓库模板补齐后成功打包。
- 原生 QA 使用 /plugin-management-preview 和显式 visual mock。原生组件/真实 WebView/原资源服务器均实际运行，后台为合成内存数据；不作为真实 Host、密码库或 OAuth 端到端证明。
- iOS 已观察：Light/Dark 原页主题、原字段读回、长表单输入与保存后回读、长列表滚动、键盘弹出隐藏底部操作、齿轮原生菜单、底部安全区。修复 RNHostView 无界高度下 WebView 根容器坍缩：卡片根容器使用内容测量高度。
- Maestro 最初点中了同名头部文字，随后 HideKeyboard/长列表 15 秒断言未通过；改用截图定位输入、系统完成按钮和足够滚动范围后，保存后的回读文本与 Light 模式断言通过。未把失败脚本算作通过。
- 截图保存在仓库外验收目录 `mobile-plugin-management-2026-10-19/`。ios-detail-light.png、ios-detail-dark.png、ios-menu-dark.png、ios-keyboard-dark.png、ios-settings-readback.png。
- 未验证：真实账号 B/C 隔离 Host 完整安装→配置→使用→升级→卸载、第三方 OAuth/MFA、320 pt/平板/旋转、真实两台电脑弱网与休眠。没有操作真实插件/凭证，没有提交、推送或 PR。

## Final Android QA and review
- Android 14 arm64 系统 AVD Cindy_Plugin_Detail_Acceptance（emulator-5554，1080×2400）已构建安装；APK 与当前 Expo Updates 开发指纹均为 c40ef6512351ecbd30a4a96d82ea8c94e8c5c623。没有修改原生配置、依赖声明或 lockfile。
- 首次构建使用了尚未稳定的 Gradle 生成缓存；增量任务沿用旧 fingerprint。显式 Global 环境重新生成该构建资源并重新打包后匹配。QA App 遗留 localhost:8082 调试偏好已改为本 worktree 的 8081；没有读取 SecureStore。
- Android 真实原生菜单、原 HTML/JS 表单、Light/Dark、字段输入、键盘出现时收起底部按钮、保存及回读已观察。Maestro 断言 Ordinary settings read back: QA Mac Android 及长表单滚动到 Permissions 通过；后台仍是合成数据，不代表真实目标电脑闭环。
- Android 截图与 iOS 同目录：android-detail-light.png、android-menu-light.png、android-keyboard-light.png、android-settings-readback.png、android-detail-dark.png、android-permissions-dark.png。部分操作截图保留开发环境 Refreshing 提示，不作为生产 UI 内容。
- 最终独立只读复核覆盖管理 controller/hook/页面的目标切换、取消、快照/回执与不重放，未发现可证实的严重问题；未把复核等同运行测试。
- 最后一次 Mobile typecheck 退出 0；git diff --check 通过。全量单测未运行，未提交或发布。

## Final runtime follow-up
- iOS 最终核对出现开发指纹变化后，已按仓库脚本重新构建并安装同一系统 QA 模拟器；新包 fingerprint 为 d00d1303a3e13cbddacc58b12fb8698364e5b33c。构建/安装成功，脚本因文档更新使 Metro source label 陈旧而在启动检查返回 target-stale；随后单独刷新开发服务核对身份。
- Android 17:47:28 在长表单底部输入派发出现一次 ANR（等待 5232 ms），当时 iOS 正在本机原生编译。主线程栈停在 ART/JNI 系统等待，JS 线程处于 Looper 等待；这些证据不能单独断言根因是编译资源竞争。
- 编译结束后重启同一 QA App，完整重跑长表单滚动到 Permissions → 继续滚动 → 打开管理菜单，Maestro 全部通过，lastanr 时间未增加。没有为未证实的原因修改生产代码；保留该次 ANR 作为后续实机稳定性观察项。最终权限截图更新为此次复测结果。

## Follow-up: native layout and production integration (2026-10-19)
- 用户确认沿用现有 Expo SwiftUI 原生组件。iOS 顶部改为系统 Toolbar 菜单；配置、工具、权限、详情使用统一主标题层级。详情恢复非空元数据与版本。底部改为上下排列的原生主次按钮，渐变透明承托背景，文案明确新建任务或在已有任务中使用；键盘出现仍收起。
- iOS 合成原页已目检浅色/深色、顶部菜单、Details 和底部按钮；这一轮 Android 布局尚未重新目检。截图：/tmp/plugin-details-footer-light.png、/tmp/plugin-details-footer-dark.png、/tmp/plugin-toolbar-light.png、/tmp/plugin-toolbar-dark.png、/tmp/plugin-menu-dark.png。
- GPT-6.1 手机接线修复：市场已安装项只导航到快照唯一匹配的物理实例；旧菜单/Alert 绑定账号、选择代次及 controller；回读失败不使用旧快照导航；旧 Host 状态不得发布到新目标。生产 hook/controller/client 页面回归 38 项、controller 28 项通过，mobile typecheck 通过。transport 隔离测试不等于真实网络验收。
- GPT-6.1 Host 修复：仅绑定在途授权在原 transaction deadline 内保活；取消、显式关闭、账号/控制端/approval 失效仍关闭；完成恢复普通 idle TTL。同一 requestId 在成功或失败后均不可重复执行。相关 5 文件 94 项测试通过，desktop typecheck 通过。没有扩大 OAuth 支持范围。
- 总控复核发现并要求修复一次性 running 标记的回归；新增成功/失败重放断言先失败后通过。最终 git diff --check 通过。未运行提交前全量门禁，未提交/推送。
- 当前专用 iOS 预览已关闭 EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK 与 EXPO_PUBLIC_CINDY_PLUGIN_DEMOS，并完整重开 App。正式入口停在真实登录页，等待用户自行登录；未复制账号令牌或读取凭证库。MCP 宿主存在真实插件，但尚未证明它与手机目标电脑相同。
- 仍未完成：真实账号/目标电脑的管理能力发现、真实插件原表单读取、安装/升级/卸载及第三方 OAuth 闭环。上述单测和合成截图不作为这些项目通过的证据。

## Real login and Host capability follow-up (2026-10-20)
- 用户报告停在浏览器登录等待页。确认本任务 Metro 已因 `WS_ERR_TOO_MANY_BUFFERED_PARTS` 退出；使用标准脚本恢复并重开专用测试 App 后，用户确认真实登录成功。没有清除账号数据或读取登录令牌。
- 只读内存复现确认 dev-middleware 所用 ws 7.5.12 未在消息结束重置片段计数：上限设 3 时第四条独立完整消息同样失败。当前仅恢复服务，未改依赖或原生指纹；开发服务长连接复发风险仍在。
- GPT-6.1 修复登录等待页：捕获原生浏览器启动拒绝并显示既有错误；等待期间允许取消；过期原生结果返回 false，不污染新登录尝试或产生未处理拒绝。总控复核补强迟到结果测试，最终 148 项定向测试、mobile typecheck 和 diff 检查通过。真实用户登录成功发生在恢复服务后，不冒充故障注入运行验收；没有为测试退出用户账号。
- 已目视确认真实目标「公司电脑-new」的 Google Calendar / Remotion 插件详情。Remotion 顶部明确显示目标电脑需更新才能管理插件，原设置仍为电脑端配置提示，齿轮禁用。因此真实详情读取已验证，当前目标尚未提供 management 能力，不能宣称安装/升级/卸载或原配置闭环通过。截图 /tmp/plugin-real-detail-top.png。

## Real settings failure diagnosis and repair (2026-10-20, after login)
- 本次实际目标回执已是 management `supported`、snapshot.settingsPage=true，且已匹配真实安装实例。前段记录的 unavailable 状态不能用于解释用户 10:37 的新截图；本次无需用户更新目标电脑。
- 根因一：Host 资源声明使用 `text/html; charset=utf-8` 等完整 MIME，手机解析器只接受裸类型；TapTap Maker 的 13 个资源共 9,055,462 bytes，12 个文本资源因此被拒绝。修复为校验 UTF-8 参数并保留原声明用于逐块一致性校验；交给现有 native preview 的文件表转换为裸类型。未改 native 接口、依赖或指纹。
- 根因二：配置内容已运行、WebView 已回报内容高度，但 iOS SwiftUI List 内嵌 VStack 中的 RNHostView 不显示配置子树（加载提示及临时原生文本也不可见）。配置承载视图改为独立 List 行，保留原生标题和原作者表单；真实 Google Calendar 与 TapTap Maker 均已显示。临时诊断文本和日志已移除。
- 根因三：Host `fetchGhostSettings` 返回 `PluginPageFetchResult.base64`，原设置桥误读 `body`，原页无法解析账号状态。桥改为按协议还原字节后构造 Response，保留状态码、MIME、UTF-8 和无正文响应；合成预览及 smoke fixture 同步改用真实返回格式。桥测试先复现 OAuth 返回和 XHR JSON 两个失败，再修复通过。
- 错误提示分开加载失败、操作未完成与提交结果未知；提供“重新加载设置”，只重新读取 Host 状态，不重放提交。未知结果只在变更请求交给加密传输后标记。
- 验证：本次相关 5 文件 45 项测试通过，mobile typecheck、test:scope、bootstrap generator --check、git diff --check 通过。沿用此前登录修复的 148 项验证，未重跑无关全量测试。
- 实际 iOS 正式入口、真实目标“公司电脑-new”：Google Calendar 原配置正常读回；TapTap Maker 原配置显示已连接状态和脱敏凭证摘要，能滚动到真实项目列表。Maestro 对“已连接 TapTap Maker”及长表单滚动通过。没有更改真实配置、点击连接/保存/安装/升级/卸载，也没有实际执行第三方 OAuth。配置包约 9 MB，首次资源读取仍有可感知等待，不能称为即时打开。
- 真实 TapTap Maker 原页已目检 Light/Dark，主题切换后仍显示已连接状态；截图存于任务 artifacts 的 real-settings 子目录。这轮 Android 未复测。未提交、推送或发布。

## Permission summary card correction (2026-10-20)
- 用户再次明确：权限只显示主标题、无说明正文；逐项图标与 PC 语义一致，集中在一张卡片。iOS 原生 List 现在复用通用 PluginPermissionCard，取消之前重复的 SwiftUI 长描述/统一盾牌实现；窄屏标题自然换行，不截断权限含义。
- GPT-6.1 只读复核确认移动端 20 项 kind 与 panelLeft / networkSecret* 特判均与 PC permissionItemIcon 一致；图标采用同款 Lucide、20dp 与手机轻描边 token，旧 Host 回退也使用 PC 的 Shield。
- 真实目标仍缺 kind/labelKey：重新打开真实 TapTap Maker 后，9 项回执的两字段均为 undefined；normalizeRemoteBlocks 保留 data、model 未裁剪，不能把本地已改 Host 投影当作真实目标已运行。现有集成树 mobilePageService 已透传两字段并有回归，但目标 Host 尚须运行配套实现后重验逐项图标。没有按文案猜图标、没有为截图伪造类型。
- 本轮真实 iOS 已看到单卡片且无描述；21 项原生视图测试、mobile typecheck、diff 检查通过。图标真实验收未通过（当前仍是兜底）；Android 未做此次原生目检。未提交/推送或更新目标安装包。

## Permission Host integration acceptance (2026-10-20)
- 核实“公司电脑-new”是本机 /Applications/Cindy.app 正式实例，保持原进程 PID 67635 运行，没有更新、重启或改其插件数据。此前该实例的 9 项权限缺 kind/labelKey 的事实不变。
- 复用既有隔离测试 profile remote-plugin-target-1015；标准入口 `pnpm restart:desktop:remote --region=global --isolated=remote-plugin-target-1015 --passive` 返回 DESKTOP_DEV_VERDICT=ready，desktop:whoami 的 match=true、分支 feat-mobile-plugin-management、HEAD a83a9a0d1 和当前未提交集成树一致。测试设备“插件测试 B · 目标端”在线且 remoteControlEnabled=true，无需复制正式凭证或重新登录。
- 测试 profile 仅保留 TapTap Maker 历史数据，当前未装包。通过手机真实市场→齿轮 Install→真实权限确认→Allow and continue 安装 2.1.22；Host listSync 回读 `_root__taptap-maker`、namespace=null、enabled=true。测试范围仅这个隔离目标，未调用插件工具、保存配置、卸载或触发第三方 OAuth。
- 手机真实详情回执的 9 项 kind/labelKey 已完整收到：node/nodeChildSpawn、node/nodeMcp、pick/pick、session-context/sessionContext、preview/preview、command/command、card/card、card/cardExternalLink、code/code。未根据文字猜测、未注入 mock 回执。临时只记录这两字段和目标/实例的诊断日志已从代码移除。
- iOS 实际详情 Light/Dark 均目检：一张卡片只显示标题，无描述，9 项图标对应 PC 同款 Cpu、FolderOpen、MapPin、AppWindow、Terminal、LayoutTemplate、FileCode2；自然换行且图标左侧对齐。截图和精简回执在 artifacts/real-settings/permissions-testb-{dark.png,light.png,receipt.json}。此前 permissions-summary-*-host-metadata-pending.png 是正式旧 Host 的历史证据，不代表本次结果。
- 复用已完成的 21 项权限原生视图测试及 mobile typecheck；此次没有再次改动正确映射或字段透传，git diff --check 通过，无提交/推送/发布。Android 此次未目检。
- 配置失败定位仍保留上一节三项真实根因（MIME 参数、RNHostView 嵌套布局、base64 响应桥）与已验证的读取范围；真实配置写入/第三方 OAuth、升级/卸载及 Android 完整闭环仍未验收，不将本次权限与隔离首装通过扩大为全功能通过。正式实例仍需将来正常集成发布后获得字段透传。

## Corrected whole-page layout check (2026-10-20)
- 用户再次提供实测截图：原配置加载后头像移到屏幕外、标题消失、开关越界、设备名挤窄、描述横向裁切。总控在同一 iOS 模拟器、同一真实测试 B/TapTap Maker 页面复现。上一节仅核对权限卡及回执，未覆盖配置加载后的头部，不构成整页验收通过；该遗漏明确保留。
- 具体责任点是 iOS 头像 RNHostView 的首 UIView 不稳定：fallback View 与加载后的 Image 互换，而 Expo ApplySizeFromYogaNode 的 StateObject 尺寸观察器仍持有首次 UIView。未改 Expo/native：用固定 72×72、collapsable=false 的 RN View 作为永久根，仅在其内部切换图片，并用 SwiftUI 72×72 外框约束头像。没有给整页加裁切或写死描述宽度来掩盖问题。
- GPT-6.1 执行这一处修复，总控增加 fallback→remote image→fallback 根身份回归。22 项 pluginNativeViews 测试、mobile typecheck、git diff --check 通过。
- 实机路径（系统 iOS 模拟器）：真实列表重进 TapTap Maker→等 Connected to TapTap Maker 与完整原配置→配置中部→Tools→Permissions→Details/安装路径→回顶。Dark 与 Light 均执行、逐张目检；头像、标题、开关、描述恢复正常，滚动回顶未再横向溢出。原配置加载仍需等待，未修改凭证/配置、未执行授权或插件工具。
- 前后及各模块截图在 artifacts/real-layout/{overflow-before.png,reopen-dark.png,reopen-light.png,form-*,tools-*,permissions-*,details-*,return-top-*}。当前仅证明上述 iOS 路径的布局修复；Android/iPad/大字体未在本轮验证，管理与 OAuth 其他未验项仍保留。无原生指纹改动，无提交/推送。


## App Store information rows and bounded settings card (2026-10-20)
- 按用户提供的 App Store Information 参考，iOS Details 使用左侧次要标签、右侧主值、50pt 行与细分隔线；包含内容和安装路径默认单行摘要，可分别展开完整 Host 原值。复用现有 Expo SwiftUI，不新增原生依赖。
- 原生实测发现：同一 List row 内两个 DisclosureGroup 会一起响应；仅 plain buttonStyle 不足。改为每项独立 Section 子行后，Light/Dark 均验证内容与路径独立展开/收起，切换插件清除展开状态。没有删减原始详情字段。
- 配置卡沿用页面 20pt 外侧对齐，统一 16pt 内边距。短表单随内容收缩；长表单外框上限为窗口高度一半且不超过 420pt（含内边距），超过后仅 WebView 内部滚动，保留主题滚动指示器。窗口尺寸变化不重开配置会话。
- 真实 TapTap Maker 的原输入继承 13px，聚焦会触发 iOS 自动缩放及横向裁切。桥仅将小于 16px 的文本输入/textarea/select 字号提高到 16px，保留原本更大字号；新增控件同样处理，pagehide 解除观察，不读写输入值，不禁用手动缩放。真实原页重新打开后，聚焦 PAT 输入不再横向放大，退出聚焦恢复底部 CTA；未输入、保存或提交凭证。
- 同一系统 iOS 模拟器、隔离目标“插件测试 B · 目标端”、真实已装 TapTap Maker：最终 Light/Dark 卡片边距、高度、内部滚动已目检；Details 独立展开/收起均实测。截图位于任务 artifacts/real-information-settings/。输入聚焦使用模拟器硬件键盘模式，仅验证焦点/原生工具条及布局，不声称软件键盘完整验收。
- 本轮三个定向测试文件 36/36 通过，mobile typecheck、bootstrap generator --check 与 git diff --check 通过。未改 native fingerprint 输入、依赖或正式客户端；无提交/推送。Android、iPad、大字体本轮未目检；真实配置写入、第三方 OAuth、升级/卸载的既有未验范围保持不变。


## Details directional motion correction (2026-10-20)
- 用户要求 Details 向下展开、向上收起，不使用 bounce out。替换默认 DisclosureGroup 弹性事务为现有原生 Button + 受控有限高度，沿用 motionDuration.base 的 200ms easeInOut；系统减弱动态效果开启或尚未读取时不播放。
- 此节更新前一节布局实现：Details 合为一个 List 行，内部各项仍独立原生 Button 和细分隔线。原先独立 List 行会在动画前先重排行高，造成标题跳位；List 级动画还会产生行快照重影。最终仅 Details 原生 VStack 一处动画、内容顶部锚定与裁切，所有后续信息行同步移动。切插件重挂载测量节点并清展开状态，关闭内容对辅助功能隐藏。
- 真实测试 B/TapTap Maker 系统 iOS 模拟器录屏逐帧验证：最终展开分隔线从 y1226 单调增加至1343，收起从1343单调回1226（942px宽归一化帧）；无超出终点或反向回弹。最终 Light 模式另验安装路径与包含内容独立展开/收起；完整原值保留。录屏和开合帧图位于 artifacts/real-information-settings/plugin-details-motion-accepted.mp4、plugin-motion-group-{open,close}.png。
- 最终 23 项原生视图测试、mobile typecheck、git diff --check 通过。无原生指纹/依赖改动，无提交/推送。Android、本轮系统减弱动态效果开关的实机路径未验；既有配置写入/OAuth等未验范围不变。


## Scoped plugin notices and native presentation (2026-10-20)
- 用户确认同时修改提示 UI 与优先级。去除管理→配置→市场→状态→运行异常的跨区域互斥链：顶部只显示离线、详情读取失败、停用/安装恢复/运行暂停；配置状态和错误留配置区，管理事务单独显示，权限确认进入现有系统 sheet。加载使用进度，禁用由开关表达，未安装不再重复提示，普通通知/取消反馈使用不占位浮层。
- iOS 使用现有 SwiftUI 图标、文字和按钮；提示为紧凑圆角，单操作放右侧，说明只在有额外信息时出现。Android 对应语义 token 实现。未知操作保留原 operationId，仅核对结果；离线+未知结果可以并存。确认包含来源、版本、增减权限及原风险说明，迟到确认绑定原账号/控制器/operation/request。
- 复用系统 iOS 模拟器与隔离目标“插件测试 B · 目标端”。目标本轮退回登录页，经用户重新登录后恢复。真实 Gmail 原配置页 Light/Dark 已目检：需要配置提示在配置标题下，顶部无重复提示，原账号配置卡正常加载。
- 对已核实的隔离 Host 进程短暂 SIGSTOP 并 finally SIGCONT 自动恢复，复现真实 settings 请求超时。55 秒内服务端 presence 未变为 offline，因此该证据仅证明配置读取失败，不作为新顶部离线态实测。发现并修复嵌套 Host 自测水平尺寸造成说明截断、Reload 不可见；现采用 RN 实宽约束与仅纵向测量。外层最小高度从160缩到44，保留原 Card 高度与lease规则。最终错误态 Light/Dark 说明完整换行、重新加载可见；点击 Reload settings 后成功读回真实 Gmail 原页。
- 组件/Screen/原设置边界首轮69项、移动五语结构20项通过；后续新增尺寸回归后 native views 30项及原设置2项分别复跑通过。mobile typecheck、i18n/glossary与 git diff --check 通过。截图及源码指纹位于 artifacts/real-plugin-notices/。
- 本轮未触发真实安装/升级权限确认、真实保存或第三方 OAuth；新确认弹层与离线+未知组合由组件回归覆盖，未声称原生全状态实测。Android/iPad/大字体本轮未目检。测试 B 已恢复，正式客户端及其数据未操作；未提交、推送或改动原生依赖/指纹。
