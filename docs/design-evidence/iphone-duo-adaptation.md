# iPhone Duo 适配实现与验收

本次按窗口几何适配，不通过设备名称判断 Duo，不将 phone idiom 等同于窄屏。

## 三阶段实现

1. **基础布局**：安全区四边独立处理；旧 iOS 手机旋转残留修正显式限于旧布局。登录新增中等横向窗口构图，折叠分区不足时表单滚动。远程桌面使用窗口而非物理屏幕尺寸。自绘 Modal 声明双向旋转，输入 sheet 根据键盘剩余空间重新选择折叠区域。
2. **展开导航**：有足够空间时任务列表与详情并列；折叠分界可以偏离中线。详情内消息与交互面板按实际 pane 宽度排版。系统推荐纵向栏时将操作移到对应物理侧边。宽窄转换保持详情、编辑器和消息列表组件身份；抽屉导航仍等待真实退场完成。
3. **折叠区域**：现有 iOS 本地模块提供窗口 safe area、size class、verticalBarEdge 与 active reserved regions。自绘输入区域避让 division/occlusion；高键盘覆盖下半区时回到上半区。远程桌面在第一分区显示画面，第二分区提供相对触控板和既有鼠标/键盘操作；视频层和 WebView 使用同一矩形，不改变远程控制协议或重建连接。

登录表单、输入 sheet 和远程桌面均复用已有主题颜色；没有引入新的颜色或图标体系。

## 原生桥接与兼容

- 使用 `UIView.reservedRegions(of:)` 对应 Objective-C API，以及 `verticalBarEdge`；同时有编译期头文件检测和 iOS 27.1 运行期检查。
- 旧 SDK、旧系统及 Android 使用普通窗口几何，不虚构折痕位置。
- attached、foreground active scene 内至多 10 Hz 采样区域变化；快照去重后才向 JS 发送。CADisplayLink 使用弱引用中间对象，离开窗口/后台时停用。
- 此原生能力无法由 JS 准确替代，因此需要冷更。未升级原生包的装机不会获得新 runtime 的 OTA；现有包保留旧 runtime 的更新通道。发布需配合新商店包或自建重装，不能作为纯 OTA 发布。合并前须按 mobile-development 冷更规则取得指定把关人的明确确认。
- 本机相同 `@expo/fingerprint 0.20.13` production 计算：iOS `8b048bf11a9c8a2c24ea80992641aa9545118e37` → `97cb76162f50bfd4387f697018d3c5e801726ded`；Android `ac812fe4744bde795af40e2ad3ef207b6a8c3065` → `98e7d33558ec65b95612f8a303bc3c838b1d13ba`。本地模块目录参与指纹，虽然没有 Android 原生逻辑改动，其指纹也变化。最终发版仍以 release check 为准。

## 验证范围

- 覆盖独立安全边、窄分屏、偏心折痕、摄像头遮挡、键盘覆盖下半区的几何回归。
- 覆盖触控板相对坐标、无效输入、隐藏鼠标按钮时 tap、拖拽中的 tap 不释放按键，以及折叠前后 viewer/lease 连续性。
- Xcode 27.1 模拟器原生构建两次成功；新增桥接也通过旧 Xcode SDK 的 Objective-C 语法编译。Mobile TypeScript 检查通过，shared viewer 生成文件一致性检查通过。
- Mobile 全量复跑：486 个文件、6,219 项测试通过。Desktop 首轮失败的 10 个文件复跑：137 项测试全部通过。复跑清除了宿主 CINDY_AUTH_REGION / VITE_CINDY_AUTH_REGION，且不与原生构建并行，未延长测试超时、跳过测试或弱化断言。
- 根 pnpm test:unit:related 第一轮退出非零：Desktop 含环境相关断言与超时；Mobile 含本次布局改变需更新的旧断言/mock 与超时。受影响断言/mock 已更新并通过上述复跑。maker-core、maker-shared、lizi-mcps、orca-workflow 在第一轮全部通过。未宣称重新完整执行过第二轮根命令。
- 上述为早期验证记录；最终模拟器验收与门禁结果见下方「本轮收尾检查」。源码与自动测试不替代设备验收。

## Apple 依据

### 全 App 核对清单（2026-09-19）

| 规则 | Cindy 落点 |
| --- | --- |
| 竖栏遵循系统物理边缘，可左可右，不以横屏或 RTL 推断 | 原生 Stack toolbar；不增加自绘侧栏或重复扣除侧栏宽度 |
| 返回／关闭在竖栏顶部；图标保留辅助功能名称 | 登录流程、任务页、文件浏览／预览和简单页面使用原生 toolbar button；远程桌面保留原有全屏控制 |
| 自绘控件不会自动参与 UIKit 竖栏；不能把横排多个按钮视为一个可自适应项 | 首页沿用原生导航容器内的自定义横向项；任务动作组维持横向，不再额外造栏 |
| 内屏竖屏恢复水平栏；居中 sheet 不强行继承主页面竖栏 | `barEdge: none` 保留普通布局，`SheetSurface` 保留局部导航 |
| 四边 safe area 独立；控件整体避让 division / occlusion | 登录表单、`SheetModal`、重命名弹窗、首页下拉菜单 |
| 外屏横屏及键盘状态下操作可滚动到达 | 登录表单、新建页、重命名弹窗；Android 不重复扣系统缩窗后的键盘高度 |
| resize 保留输入与页面状态，分页基于实际内容宽度 | `SheetModal` 固定组件层级；文件预览测量 pager 宽并重锚当前页 |
| 键盘附件栏保持贴键盘，不搬到页面侧栏 | 任务编辑器及远程桌面键盘维持原归属 |

以上为实现核对，不等同于全部运行验收。需分别验证内外屏、两种横屏方向、
左右 Split View、键盘、Light/Dark、读屏，以及真实设备连接下的文件／远程桌面操作。

### 本轮收尾检查（2026-09-19）

- 移除登录布局与启动遮罩的临时调试日志；启动遮罩及首页恢复逻辑未改变。
- 早期自绘侧栏方案已于 2026-09-20 撤除；下面旧截图不能作为最终导航验收。
- Mobile TypeScript、9 个文件的 147 项定向回归、scope guard、2 项远程流程 smoke 均通过。
- 全仓单测首轮被设计台账快照过期拦下；已通过正式生成器更新机器区块，保留人工标注。
- 更新台账后，根 `pnpm test:unit` 的脚本检查、Desktop 与其它包全部通过；Mobile 为 487 个文件、6,230 项通过，1 项 Android splash introspect 超时，因此该次根命令仍退出 1。
- 超时项单独复跑仍耗时 54 秒。`EXPO_DEBUG=1` 显示配置解析不足一秒，退出前等待落在 CLI 遥测链路；仅本次命令设 `EXPO_NO_TELEMETRY=1` 后，同文件 5 项全部通过，introspect 用时 594ms。未改断言、超时阈值、原生配置或永久遥测偏好；不将组合验证写成整轮根门禁通过。
- 关闭本次命令的 Expo CLI 遥测后，完整重跑根单测门禁退出 0（`cindy-duo-complete-gate.log`）。随后修正连接提示层按所在内容区测量横向范围，避免覆盖侧栏；相关 4 个文件、53 项回归通过，Mobile TypeScript 再次通过。
- 移除登录表单测量容器的临时背景并恢复入场透明度；保留原有登录状态与启动逻辑。
- 当前 Duo 模拟器原生包与 worktree 开发指纹匹配（`3faa006daa206d295c834418966c63c02a8ca1aa`）。已启动本 worktree Metro 并加载新 JS bundle。

### 模拟器画面验收

| 场景 | 结果 |
| --- | --- |
| 内屏横向、浅色首页与任务双栏 | 已目检，列表与详情分区、侧栏可见 |
| 内屏纵向、深色任务页 | 已目检，水平导航和底部输入区域可见 |
| 外屏横向、深色任务页与软件键盘 | 已目检，输入区域位于键盘上方，侧栏保留 |
| 外屏两种横向、深色设置页 | 已目检，原生返回键随系统切换到右／左侧栏 |
| Book 姿态、深色设置页 | 已目检，返回键与内容可见 |
| 连接提示 | 已修复并目检，提示宽度限制在内容区，不覆盖侧栏 |

本地截图在 `/tmp/cindy-duo-*.png`，含个人账户与任务信息，不作为公开附件上传。
当前电脑连接停留在握手重试，因此文件内容、远程桌面控制和折叠触控板的端到端操作未验收；
保留已登录账户，没有为重测登录而退出账户。最终登录态页面、左右 Split View、VoiceOver、
Android 实机以及所有页面的浅／深色全矩阵仍未逐项目检，不把上述局部验收写成全设备验收。

详细 Apple 说明：
[导航和工具栏](https://developer.apple.com/videos/play/tech-talks/111462/)、
[窗口和安全区域](https://developer.apple.com/videos/play/tech-talks/111461/)、
[折叠姿态与保留区域](https://developer.apple.com/videos/play/tech-talks/111463/)。

- [Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo)
- [Preparing your app for iPhone Duo](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo)

按实际窗口和系统保留区域布局；纵向操作栏遵循硬件相对边缘，不随内容语言镜像。UIKit 原生展示和 React Native 自绘层的适配分别验证。

## 用户截图复查：弹层（2026-09-19）

用户指出账号面板在内屏横向偏左、过宽且底部悬空。这说明前轮“全部落地”的结论过早：
主页面导航通过不代表共用弹层已验收。

- iOS 账号切换改用现有 `ComposerSheet` 系统容器，系统负责呈现位置、圆角、档位和关闭完成通知；账号切换与新增账号的业务逻辑不变。
- 存量 `SheetModal` 在宽窗／横窗内使用有限宽度、四边留白和垂直居中；`SheetSurface` 浮动时四角圆角，不重复添加主页面底部安全区。窄屏竖向保留原贴底呈现。
- 重命名等 `ModalContentArea` 消费同一弹层区域计算。文件浏览的路径菜单与长按菜单补齐双向横屏、区域内滚动，去掉固定顶部 96 点定位。
- 模型、上下文、任务菜单已有 iOS 原生分支；Android 和仍使用自绘容器的分支统一受上述边界约束。图片查看／全文预览为全屏内容，不改成小弹窗；锚定引用预览不改成居中 sheet。
- 新增宽窗、短窗键盘、折痕区域与窄屏竖向回归；Mobile 全量 489 个文件、6,235 项通过，TypeScript 通过。画面验收另行记录，不以测试代替。
- 本轮最终弹层画面尚未验收：Device Hub 的窗口存在，但桌面工具返回 `ax_window_unresolved`；改用 Maestro 后，其截图读取到未激活的外屏黑画面，未找到首页菜单。两者均不计为产品验证通过；没有执行账号切换或清除账户数据。

## 新 Worktree 本机启动

Metro 会静态解析所有 region 分支，即使运行 Global，也需要本地存在 `config/endpoint.dev.json`。首次启动前从仓库 `config/endpoint.dev.json.example` 复制生成这个 gitignored 文件；它不改变 Global 的生效端点。若 Metro 已缓存缺失文件错误，补齐后重新启动 Metro。

## 导航纠正（2026-09-20）

移除首页、任务、文件、预览和登录中的自绘侧栏及其额外 56 点占位。
返回／关闭通过原生 Stack 工具栏注册，由系统安置到共享栏；标题与页面操作组保留原布局。
登录的嵌入式新增账号流程保留所在弹层导航，不修改底层页面导航。
安全区、双栏、折叠触控板、弹层与预览分页修复保留。
最终 Mobile 全量 488 个文件、6,230 项通过，TypeScript 与 diff whitespace 检查通过。
已加载新 bundle 并目检内屏横向浅色首页：菜单与动作组恢复横向，右侧无第二列自绘栏，
截图 `/tmp/cindy-systembar-current.png`。其它页面、旋转后的返回操作与深色模式尚未完成本轮目检。

## 双栏设计收敛（2026-09-20）

- 常驻左栏沿用主页的设备范围、分组与排序偏好；项目头和任务行共用 `HomeListVisuals` 的样式与 Agent 状态图标，子任务保持列表虚拟化。临时抽屉仍保留原导航操作。
- 移除常驻栏底部“主页”。Duo 竖向系统栏承担返回和新建任务，不增加自绘栏；页面标题与文件／远程桌面等动作组仍为横向布局。
- 两栏顶部增加同档留白，任务页顶部使用主题背景，避免滚动文字透入留白。输入框区域扣除已经由内容内边距承担的底部安全区，消除重复留白。
- 回归：Mobile 全量 488 文件、6,231 项通过；Mobile TypeScript 与 `git diff --check` 通过。新增常驻栏分组折叠、选中任务、任务切换与移除重复导航入口的交互测试。
- 实际目检：Duo 内屏横向，Global `com.xd.cindy`，当前适配 worktree 的 Metro；原生 fingerprint 匹配。通过现有任务深链进入截图所示任务，浅色 `/tmp/cindy-pane-task-final.png`、深色 `/tmp/cindy-pane-task-dark.png` 均确认单列系统导航、顶部留白、侧栏选中态及输入框底部间距。目检后恢复浅色。
- 限制：Device Hub 的 AX 窗口不可解析，本轮未完成系统按钮实点、软件键盘、旋转／外屏的新增目检；未修改任务内容或账号数据。

## 主页主体复用（2026-09-20）

此前 `HomeListVisuals` 只共用行样式，侧栏仍维护自己的列表与数据控制器，没有满足“主页收窄到左侧”。本轮以完整主体替代该实现：

- `HomeSurface.tsx` 的 `MobileHome` 承接原主页全部列表、项目／自动化展开、设备范围、搜索、菜单、滑动操作和数据同步。主页路由只渲染该组件；任务抽屉只提供宽度、当前选中任务和导航回调，不再包含第二套 `SectionList` 或任务行。
- 当前账号的内存视图状态在两种容器之间保留搜索条件、设备范围、分组展开和滚动偏移；账号／realm 换代清空，旧回调不能写入新账号状态。失焦页面卸载控制器，避免后台主页与前台侧栏重复订阅。
- 系统栏的新建入口调用同一主页操作，遵循主页选择的设备。临时抽屉导航仍等关闭完成后执行，常驻侧栏原地切任务，不重挂主页。
- Mobile 全量 489 文件、6,225 项通过；TypeScript 通过。新增实际状态 hook 的容器交接、批量展开更新、账号隔离与搜索条件保留测试；抽屉测试改为验证共用主体的挂载和导航生命周期。路由包装调整后补跑对应定向测试及 TypeScript。设计台账已重生成。
- Duo 内屏横向目检：完整主页 `/tmp/cindy-shared-home-full.png`、窄栏浅色 `/tmp/cindy-shared-home-light.png`、窄栏深色 `/tmp/cindy-shared-home-dark.png`。同一组项目和任务在两个宽度下呈现，窄栏选中态清晰，系统返回／新建只有一列，常驻栏没有“主页”底栏。目检后恢复浅色。
- 交互限制仍在：Device Hub 无可用 AX 窗口，未实点菜单、拖动列表或执行键盘／旋转操作；滚动偏移的原生恢复效果未手动验收，不能用状态测试替代。没有清除登录态或发送任务消息。

## 窄窗口返回与快速切换（2026-09-20）

- 窄窗口保留独立返回键，快速切换使用顶部右侧侧栏图标；普通手机与平板共用入口，不再用宽屏门槛替换返回。宽窗口继续常驻主页列。
- 临时面板仍使用 `MobileHome`，左上角提供关闭操作，删除底部“主页”；选中任务继续在关闭完成后原地替换参数，不增加路由层级。
- 面板存续期间页面返回操作先关闭面板，iOS 页面侧滑返回暂停，Android 返回及退场期拦截沿用既有逻辑。面板关闭后恢复页面返回。
- 窄窗口顶部也采用主题背景，正文不再透进顶部留白和导航区域。
- Mobile 全量 489 文件、6,229 项通过，TypeScript 通过；最后的顶部背景调整补跑 header 定向测试和 TypeScript，通过。设计台账重生成、diff whitespace 检查通过。
- Duo 竖向内屏已目检左右独立导航入口，深色截图 `/tmp/cindy-quick-switch-dark.png`；已匹配当前 worktree Metro 和原生 fingerprint。面板点击、连续任务切换和返回手势仍未完成自动化实机操作验证，不能以源码及单测替代。

## 快速切换关闭后点击被拦截（2026-09-20）

- 用户报告所有按钮无响应后，保留进程现场检查原生 hit-test：返回、快速切换、输入框均命中 `sessionDrawer.overlay`。面板已移出屏幕、遮罩透明，但全屏容器仍挂载；此前仅做视觉目检遗漏了这一交互故障。
- 关闭收尾改由可清理的 JS 生命周期定时器负责，不再依赖 Reanimated 完成回调；动画只控制视觉。重新打开或布局变化会取消旧收尾，导航仍等原生子树卸载后的 effect 才执行。
- 新增动画回调不执行、关闭中重新打开两项行为回归；抽屉相关 13 项测试、Mobile TypeScript 和 diff whitespace 检查通过。
- 当前 Global Duo 竖向内屏通过热更新验证，未重启 App 或清除登录态：辅助功能按钮操作关闭面板、重新打开、再次关闭、返回主页均得到实际界面变化。关闭后的原生 hit-test 分别命中返回的 SwiftUI 控件和快速切换图标，不再命中透明容器。截图 `/tmp/cindy-drawer-after-close.png`、`/tmp/cindy-drawer-back-home.png`，hit-test 记录 `/tmp/cindy-drawer-hit-fixed.txt`。
- 本轮未验证物理触屏、Android 或关闭中的旋转操作；不能将辅助功能操作等同于完整手势验收。

## 窄窗口导航最终收敛（2026-09-20）

- 按用户最新决定，移除窄窗口快速切换按钮及其打开、焦点归还逻辑，只保留返回主页。此前关于窄窗口快速切换入口的设计记录被本条替代。
- 宽窗口继续常驻同一个 `MobileHome` 侧栏，Duo 系统返回位置不变；保留共用面板已有的关闭卸载修复。
- 相关 14 项测试与 Mobile TypeScript 通过；本轮未做新增模拟器目检。

## 竖向任务顶栏与系统状态区对齐（2026-09-20）

- iOS 无常驻侧栏且系统栏为横向时，任务页改用 Stack 原生标题和工具栏；返回居左，任务操作居右，由 UINavigationBar 负责与状态区对齐及避让。不再在顶部安全区下面叠加自绘导航行。
- 正文顶部占位使用系统实际 headerHeight，分享选择模式仍使用原全选行；常驻双栏与系统竖栏保持既有布局。颜色沿用主题语义色。
- 当前 Global Duo 竖向内屏浅色目检确认按钮与时间、信号同一行，截图 `/tmp/cindy-native-top-app.png`。7 项顶栏测试、Mobile TypeScript、diff whitespace 检查通过。深色、普通 iPhone 和旋转切换未做本轮目检。

## 再次进入任务的阅读位置（2026-09-20）

- 复用现有历史缓存，首屏不等待网络校验；补充最近 8 个任务的内存阅读位置，按账号、设备和任务隔离。记录消息标识及其相对视口偏移，而非单独保存整页像素位置。
- 再进入时一次无动画定位到原消息，原来处于底部则保持跟随最新；搜索／消息链接优先，原消息已不在缓存时回到最新。定位得到原生滚动确认后立即揭示内容，保留原有 300ms 显示上限以避免长期空白，不启用曾引发滚动风暴的 initialScrollIndex 属性。
- 不增加消息落盘或后台页面常驻；账号切换、历史删除／重置同步清理位置。位置仅在本次 App 运行期间保留。
- Mobile 全量 491 文件、6,238 项通过，TypeScript 和 diff whitespace 检查通过。新增账号隔离、失效与旧回调、容量限制、实际初始定位回调测试。本轮未做模拟器往返滚动位置和不同宽度重排的目检。

### 往返首屏实测：尚未通过（2026-09-20）

- 已核对 Global Duo 内屏竖向、当前 worktree Metro 与原生指纹，并实际打开「本地构建」、返回主页、再次打开同一任务。录屏 `/tmp/cindy-reentry-warm-before.mov` 捕获到数百毫秒的空白，再出现原内容；不能以历史缓存命中或单测通过宣称无空白重入。
- 临时诊断确认重入 MessageRenderer 时已有 2 个渲染项；将这类首屏的 opacity 直接设为 1 后，录屏 `/tmp/cindy-reentry-warm-after.mov` 仍捕获到空白。数据缓存没有避免列表重新挂载、测量与定位；单改透明遮罩不足以解决。
- 已撤去这次无效透明度实验、对应实验测试和临时诊断日志，保留原有实现。无空白重入仍未完成，非底部阅读位置、横屏和深色模式未在本轮验收。

### 原生路由常驻实验：交互不合格，已撤下（2026-09-20）

- 尝试将最近 3 个退出的任务路由保留在 Home 之前，再进入时复用 route key。录屏及前后截图证明非底部内容位置能够保留，但重新进入后正文滚动及输入区按钮失去响应；不能将保留画面当成可用的页面缓存。
- 关闭冻结、完整重启 App、关闭动画、对非焦点页面禁用触摸均未解决。原生 hit-test 命中 `_UIReplicantView`（`Snapshot of <RNSScreenView>`）。当前 `react-native-screens` 在 Fabric 子视图移位触发的 unmount 中调用 `setViewToSnapshot`，再次挂回相同屏幕时仍显示快照。证据：`/tmp/cindy-retain-hit3.txt`、`/tmp/cindy-retained-verified.mov`、`/tmp/cindy-reading-retain-before.png`、`/tmp/cindy-reading-retain-after.png`。
- 已移除本次自定义路由、原型测试、诊断日志和关闭动画实验，恢复原有 Stack；未改依赖或原生代码。先前的数据缓存与阅读位置实现保留。真正的列表常驻仍未完成，需要稳定的列表承载位置，不能继续通过重排原生页面冒充保活。

### 标准 Stack + 最近任务预加载（2026-09-20）

- 保留系统 push/pop，通过 Expo Router `router.prefetch` 在返回首页后的空闲时间挂载最近打开的一个任务，提前用缓存消息完成列表布局。默认非 singular Stack 只保留同路由名的一个预加载项；未修改原生 route 排序，也不承诺多个已退出页面仍是同一实例。未访问的任务、预加载尚未完成即点击的情况仍按普通进入路径加载。
- 首页取消失焦即卸载内容的条件，保留原列表实例。覆盖期间暂停列表订阅和设备同步；全页与侧栏各自持有订阅 owner，共享筛选状态通过订阅同步。账号代际变化重建 Stack，释放旧账号的预加载页面。
- 修复阅读位置的实测偏移：首次 seek 使用估算行高后，随实际布局变化进行有界定位校正，不从 scroll 回调循环重试；用户触摸、拖动、跳到最新和显式消息定位立即接管。离屏预加载及退出中的滚动事件不能覆盖用户书签。
- Global iPhone Duo 内屏竖向实测：`/tmp/cindy-official-preload.mov` 中约 32.5 秒处，重新进入「本地构建」时正文随页面滑入；逐帧未见先空白后补正文。重新进入后输入区加号可打开面板，正文可滚动。切换另一任务显示对应正文。历史长表格停留位置前后截图 `/tmp/cindy-preload-reading5-before.png` 与 `/tmp/cindy-preload-reading5-after.png` 在正文裁剪区域 `(0,250)-(1300,1600)` 逐像素一致。
- Mobile 全量 492 文件、6,245 项通过，TypeScript、scope、smoke 通过。预加载焦点/账号/后台取消、共享首页状态、行高测量后的校正及用户接管有定向覆盖。当前轮未验证普通 iPhone、Android、深色模式、旋转后位置恢复及返回手势取消；自动手势操作未取得可靠触发证据，不计作通过。
- 此次导航修复没有新增依赖、修改原生配置或原生代码；以上不覆盖同分支先前已有的 Duo 原生改动。

### 重新进入时的顶部高度跳变（2026-09-20）

- 实测普通任务往返：预加载 Native Stack 的 `useHeaderHeight()` 为 120.67pt，进入后原生报告 82pt；顶部 padding 从 129pt 降至 90pt，随后触发 contentSize/贴底校正。没有连接横幅，不能把这次变化归因于网络加载消息。
- 新增 `useSessionHeaderHeight`：按窗口尺寸、字体缩放、安全区和栏位置保存最多 8 个已完成转场的实测高度，预加载及推进转场期间复用。转场结束继续跟随原生高度。只存几何值，无持久化、账号或任务内容；不改图标和正文滚动算法。
- 验证：67 项相关测试通过，mobile typecheck、diff whitespace 检查通过。模拟器 com.xd.cindy / Duo iOS 27.1，当前 worktree 源 `7c1c004a5+78a5aa11fa`，原生 fingerprint 匹配。
- 修前录屏 `/tmp/cindy-jump-before.mov`；修后 `/tmp/cindy-jump-fixed.mov`。竖屏往返复查的 `/tmp/cindy-jump-fixed-before.png` 与 `after.png` 正文裁剪 `(0,300,2000,2500)` 逐像素一致。修后转场片段未见滑入结束后的额外纵向跳动。
- 此验证只覆盖已捕获的顶部几何变化；不能据此排除异步图片、长表格测量或其他姿态下的独立跳动。普通 iPhone、深色、旋转后的修复效果本轮未目检。临时数值诊断日志已移除。未提交或推送。

### 横屏侧栏切换保留最近消息列表（2026-09-20）

- `RecentMessageHistories` 在常驻双栏下保留最近三个消息列表实例，按账号代际隔离、按设备和任务组合定位；切回窄屏释放隐藏列表。保持相同视口布局，不重排 Native Stack 路由。
- 隐藏列表退出触摸和无障碍树，暂停自动补页、贴底跟随、书签修正及可见消息读取回调；图片、正文查看器和消息操作弹层关闭。再次激活不重放其它任务期间的跳底请求。
- Global iPhone Duo 横屏，Metro 8081 当前工作区，源码 `7c1c004a5+57ce8841e0`，原生 fingerprint 匹配、whoami healthy，重新加载日志有 `iOS Bundled 4988ms apps/mobile/index.js`。随后仅更改测试夹具和本证据文档，产品源码不变。
- 在「远程连接安全风险防范」与「本地构建」之间来回切换，截图 `/tmp/cindy-wide-a-before.png` / `a-after.png` 和 `/tmp/cindy-wide-b-before.png` / `b-after.png` 的正文区域 `(950,250)-(2550,1680)` 分别逐像素一致。自动拖动未取得内容移动证据，本轮不声称已验证非底部手势阅读位置或无瞬时空白。
- 84 项定向测试、mobile typecheck、scope、2 项 smoke 通过。Mobile 全量先跑 494 文件（6248 通过、5 个旧夹具失败），补齐可见状态及更新图片查看器断言后，两个失败文件共 20 项全部通过（含新增隐藏列表不补页测试）；未重复整包执行。
- Light 模式已目检；Dark、Android、普通 iPhone、横竖屏旋转期间的列表位置本轮未实测。没有新增颜色、依赖或原生配置。未提交或推送。

### Duo 导航与悬浮控件统一（2026-09-20）

- 查阅 Apple `Designing for iPhone Duo`、`Raise the bar with iPhone Duo`（111462）、`Design for iPhone Duo`（111466）。规则已写入 DESIGN §5：原生容器优先，分栏仅详情竖排，侧栏菜单留在侧栏；全屏自定义远程桌面两种横屏都在右侧。44pt 是 Cindy 悬浮控件规格，不冒充 Apple 状态图标的规范尺寸。
- 首页原来的 `Stack.Toolbar.View` 横排包裹改为系统 Button/Menu；已实测进入右侧竖排，显示菜单保留分组、选中态。任务页与远程桌面共用 NativeChromeBackButton；侧栏菜单、任务动作和远程工具栏共用 navigationChrome.target，移除远程工具栏额外 padding。中性玻璃不再使用不透明 surface tint。
- 远程桌面返回使用单一横坐标及固定宽度，修复旋转中左右约束切换后返回残留在左边的实机问题；工具栏与弹出菜单锚点共用右侧几何，优先读取顶部 occlusion 保留区。按当前模拟器系统栏的中心线校准 6pt 内移；未把该校准说成 Apple API 合同。
- Duo iOS 27.1 / Global com.xd.cindy：Light 两个横屏截图 `/tmp/cindy-chrome-a-light-final.png`、`/tmp/cindy-chrome-b-light-final.png`；Dark `/tmp/cindy-chrome-a-dark-final.png`。实际远程画面下返回、工具栏与信号中心线一致；连接实例保留由单测覆盖。恢复 Light。首页菜单展开已目检。
- 193 项定向测试通过；后续定位修正后再跑远程 140 项通过，mobile typecheck 通过。整包先跑 6249 项通过、1 个文件因新增 token 缺少 mock 未加载；补齐 mock 后该文件 5 项通过。不宣称整包最终重跑全绿。
- 普通 iPhone、Android、系统多任务左右分屏及全应用每个页面的视觉回归未覆盖。原生系统导航继续由系统决定位置；自定义悬浮控件此次统一。无新增依赖或原生配置改动，未提交、推送。
- 最终运行身份：`7c1c004a5+6014a8f831`，Metro 8081 PID 35363，whoami target-fresh/native-matched；重启 com.xd.cindy 后日志 `iOS Bundled 921ms apps/mobile/index.js`，前台首页右侧原生导航已截图复核。此后仅补证据文字。

### 保留图标并减轻玻璃蒙层（2026-09-20）

- 按用户要求保留原有图标。首页远程桌面入口恢复 Lucide Monitor 的原始轮廓，22pt、stroke 2；直接栅格化同一 SVG 为 Metro 引用的 1x/2x/3x template 图片，保留系统工具栏竖排能力，不改原生资源目录。远程桌面四个操作图标未更换。首页恢复后已目检，41 项相关测试及类型检查通过。
- 远程桌面的圆形返回与胶囊工具栏改用系统 Clear Liquid Glass，减少 regular 材质的白灰蒙层。保留尺寸、位置、图案及非玻璃回退；其它常规导航保持系统 regular 材质。
- Global Duo iOS 27.1 / com.xd.cindy，源码 `7c1c004a5+8e77d0e27b`，whoami 原生及 Metro 身份通过；启动日志 `iOS Bundled 936ms apps/mobile/index.js`，前台远程画面已检查。截图 `/tmp/cindy-clear-glass-light.png` 与 `/tmp/cindy-clear-glass-dark.png`；检查后恢复 Light。5 项 nativeChrome 测试、mobile typecheck 和 diff whitespace 检查通过。本次材质修改未重复其它设备或方向验证，未提交或推送。

### Clear 玻璃上的白色图标与局部暗衬（2026-09-20）

- 用户确认按 Clear 材质规范处理：远程返回与四个工具图标固定白色，按钮轮廓内叠 35% 黑色暗衬；选中态使用 18% 白色薄层，避免浅色主题白底白图标。共用 navigationChrome 语义值，不更换图案、不压暗整个桌面；非玻璃回退维持原主题配色。
- 重新打开原 Duo（用户关闭后为 Shutdown）、启动 Device Hub 和 Global com.xd.cindy。源码 `7c1c004a5+5ca8683e23`，Metro 8081 PID 8426，whoami `healthy:true`、native-matched，日志 `iOS Bundled 7558ms apps/mobile/index.js`；前台远程桌面已验证。
- Light/Dark 均通过 Device Hub 窗口目检：返回及工具图标保持白色，暗衬局限在圆/胶囊轮廓内。Dark 窗口证据 `/tmp/cindy-glass-contrast-dark-window.png`。simctl 默认抓取外屏会得到黑图，不能当本轮内屏证据。检查后恢复 Light，保留远程桌面供用户测试。
- mobile typecheck、5 项 nativeChrome 测试及 diff whitespace 检查通过；此轮不重复声明其它姿态或设备的验证。无原生指纹改动，未提交或推送。

### Clear 玻璃双模式配色（2026-09-20，取代上一节固定白色方案）

- 用户确认浅色用深图标、深色用浅图标。返回与工具栏共用 `navigationChrome.clear[mode]`：Light 黑色前景、局部白色 35% 底衬、黑色 10% 选中层；Dark 白色前景、局部黑色 35% 底衬、白色 18% 选中层。保留 Clear 材质及原图案，没有整屏蒙层。
- Duo 当前横屏、实际远程锁屏背景下目检 Light/Dark：信号和操作图标颜色极性一致；恢复 Light。此轮未重复另一横屏、其它设备或任意远程背景的对比度验收。
- mobile typecheck、5 项 nativeChrome 测试、git diff --check 通过。Metro 仍为当前 worktree，源码指纹更新为 `7c1c004a5+d49cee641d`；无原生配置改动，未提交、推送。

### 远程菜单顶部文字裁切修复（2026-09-20）

- 横屏 Popover 内容原先按窗口计算固定高度；系统给出的弹窗空间更小时，固定 SwiftUI frame 会让过高内容居中溢出，顶部标题被裁掉。改为独立宽度约束和可收缩的 min/max 高度，让 RNHostView 按实际布局提案获得尺寸。
- 标题区域明确不收缩，正文 ScrollView 可缩至剩余空间；保留单一 RN surface、子页滚动重置与原有菜单交互。未改图标、配色或原生配置。
- mobile typecheck、5 项 nativeChrome 测试及 git diff --check 通过。按用户要求仅代码检查；本次修复未做模拟器视觉验收，未提交或推送。

### 菜单高度收缩回归修正（2026-09-20）

- 用户截图确认上一版 min/max 高度方案使菜单仅剩标题，不能视为视觉修复完成。原因是弹窗首次查询理想尺寸时，RN flex ScrollView 没有内在期望高度；仅给最大高度不能建立正文空间。
- 在可收缩 frame 中补齐 idealHeight，使用窗口安全高度作为期望及上限，保留固定宽度与弹性高度的独立 modifier（Expo 的固定 width/height 分支会忽略同一 modifier 中的 ideal/min/max）。标题不收缩、正文滚动的约束保持。
- 新增配置回归测试，防止理想高度缺失或重新引入固定正文高度。6 项 nativeChrome 测试、mobile typecheck、diff whitespace 检查通过；这些不模拟 UIKit/SwiftUI 排版，按用户要求未使用 computer use，仍需实际视觉验证。

### 首页与返回共用 SwiftUI 原生玻璃按钮（2026-09-20）

- 用户要求统一画法。新增 iOS NativeChromeButton，由原返回按钮实现抽出；首页/侧栏 HomeHeaderGlassButton 的 iOS 分支及 NativeChromeBackButton 共用该组件。SwiftUI Button 负责圆形玻璃和点击反馈；自定义图标经 RNHostView 放入原生 label，保留 Lucide 原图，不更换远程桌面图标。44pt 目标、浅深色、Clear 分支保持。
- 首页左上位置不变。非 iOS 继续使用原平台回退，不引入 SwiftUI 依赖到 Android。原生工具栏项目与已使用 SwiftUI 的胶囊动作组保持各自原生容器。
- 47 项定向测试、mobile typecheck、git diff --check 通过。按用户要求未使用 computer use；原生视觉及点击、菜单触发需实际验证，不将源码测试当作视觉证明。无原生配置或依赖改动，未提交、推送。

### 分栏系统栏按钮统一（2026-09-20）

- 补齐此前漏掉的 SystemNavigationBack 路径：iOS 的返回/关闭、新建按钮使用与首页侧栏相同的 NativeChromeButton。保留系统工具栏定位，用 Toolbar.View hidesSharedBackground 承载，避免容器另加一层玻璃。disabled 继续传入 SwiftUI modifier，原系统图案保持。
- 从当前 8081 Metro 请求 iOS index source map，确认 HomeHeaderGlassButton.ios、SystemNavigationBack.ios、NativeChromeButton.ios 均进入 bundle，两个入口确实引用共同按钮。这证明打包解析正确，不证明设备已加载该 bundle 或视觉完全相同。
- 47 项相关测试、mobile typecheck、git diff --check 通过。按用户要求未使用 computer use，分栏原生工具栏的实际布局/交互和浅深色视觉仍待目检。未提交、推送。

### 撤回破坏 Duo 原生竖排的自定义工具栏替换（2026-09-20）

- 用户在重新加载后的截图确认：返回覆盖左侧菜单，新建挤入顶部操作栏。上一节把 Toolbar.Button 换成 Toolbar.View 的方案破坏 Duo 自适应，不能保留。
- 删除本轮新增的 SystemNavigationBack.ios.tsx，让入口恢复既有 SystemNavigationBack.tsx 原生 Toolbar.Button；保留首页/侧栏 SwiftUI 原生按钮。统一视觉不能以破坏系统导航定位为代价，此时两处仍分别为 SwiftUI 按钮和系统 toolbar item，不能宣称底层全部相同。
- 41 项相关测试、mobile typecheck 通过；更新结构回归断言禁止系统导航路径再次使用 Toolbar.View。按要求未使用 computer use，待用户核对实际布局。

### 独立圆形按钮尺寸规范（2026-09-20）

- 自定义导航按钮明确三层：44pt 可见玻璃圆形、44pt 点击区域、20pt 图标。NativeChromeButton 使用 borderless SwiftUI Button，先设 frame 再施加系统 interactive glassEffect，取消 large/buttonStyle glass 的隐式尺寸。首页及侧栏对应 Menu/X/Monitor/Ellipsis 使用 iconSize.action，保留原图形和笔画。
- Light/Dark 配色及 Clear 材质选择不变。系统 Toolbar.Button 保留原生定位与尺寸，不再用 Toolbar.View 替换。规范记入 DESIGN §5。
- mobile typecheck、47 项相关测试、git diff --check 通过。按用户要求未用 computer use，不宣称实际玻璃视觉完全一致或目检通过。

### 历史恢复期间顶部留白重复补偿（2026-09-21）

- Duo 内屏竖屏运行期诊断捕获：预加载列表开始按书签 scrollToIndex，随后 topPadding 从 0 变成 90；此时 native offset 仍为 0，旧补偿 effect 另发 scrollToOffset(90)，与正在进行的书签定位冲突。
- 修复只在恢复期间让书签 resolver 负责定位；尚未收到原生滚动坐标时不做相对补偿。正常历史阅读期间顶部高度变化仍补偿。没有修改缓存数量或原生路由顺序。
- 新增 4 项生产 effect 回归测试，相关三文件 74 项测试通过。Duo 内屏竖屏同一任务两个历史位置往返截图位置一致，修复后日志未再出现上述 offset=90 指令。此检查覆盖预加载完成后重进；未证明极快连续点击、其他设备和所有消息类型均无跳动。临时诊断日志已移除。
### 五个消息列表的公共承载层（2026-09-21，设备验收待完成）

- `RecentMessageHistoriesProvider` 放在账号隔离边界内、Native Stack 外。按设备和任务 ID 保留最近五个消息列表；页面退出仅释放显示槽，第六个任务才淘汰最久未使用的列表，账号切换清空。不再并行预加载五个原生路由。
- 路由发布最新消息属性、导航上下文和显示尺寸。新路由的历史数据／顶部高度未就绪时保留旧内容与布局，不把初始零高度和载入占位覆盖到已有实例上。隐藏列表暂停自动定位与历史补拉。
- 初版 JS 根层浮层实测挡住了 iOS 边缘返回，不能作为 iOS 交付实现。改为 Expo 原生 host／slot：React 一直持有 host，原生只移动普通 UIView 内容容器到路由内的 slot。Fabric 管理的 host 及其子组件不重新挂载；原生页面层级继续承载返回手势、转场、标题栏、输入框和抽屉。非 iOS 使用公共容器浮层；缺少新原生能力的旧 iOS 包退回页面内渲染，避免阻塞返回手势。
- 本次新增原生模块视图，改变 iOS runtime fingerprint，需重新出原生包；旧安装包不能通过 OTA 获得完整保活。Android 虽未新增原生逻辑，但本地 `modules/` 目录也参与其指纹计算，指纹同样变化，需要匹配的新 Android 原生包，不能向旧 runtime 仅发 OTA。两端指纹记录见上文「原生桥接与兼容」，最终发版以 release check 为准。建议随下一次原生版本发出；合并前仍须完成冷更确认。
- 自动验证：Mobile 497 文件、6,278 项测试通过，包含列表实例跨路由销毁、旋转、五项淘汰、账号隔离、未就绪布局保护和原生槽重接测试；Mobile TypeScript 与 scope guard 通过。
- 设备验收尚未完成：最初 JS 浮层版的实例保留与阅读位置检查不能代替最终原生承载层验证。Mac 锁屏导致 Device Hub 无法采集有效画面或触摸，需解锁后补测 Duo 的边缘返回、历史位置往返、横竖屏、侧栏切换、输入框和抽屉。未验证 Android、普通 iPhone 和最终版本的浅／深色实机表现。

### 缓存命中仍白屏的显示条件修复（2026-09-21）

- Duo 安装包指纹与 Metro 均匹配上述公共承载层版本。运行日志确认两项已打开任务来回切换没有列表卸载／重建；白屏源自原生 slot 的 `selected={focused && ready}`，新页面初始顶部高度尚未测量时会关闭显示槽。
- 改为聚焦就接回已有原生内容，`ready` 只控制新属性、定位和交互。新任务没有 host 时继续正常等待初始化，不显示其他任务；缓存命中不再等待新路由测量才能显示。
- Duo 内屏竖屏实测：历史长表格拖到中间→原生边缘返回→打开另一任务→返回→重进长表格，正文区域逐像素一致，期间实例挂载／卸载计数不变。过渡录屏 `/tmp/cindy-resident-switch-fix.mov` 末次进入时正文随页面进入，没有先出现整页空白；边缘返回可用。
- 新增“新路由未就绪仍接回缓存”的回归测试，相关 69 项通过。临时诊断日志已移除。此轮未追加其他设备和横屏验收。

### 登录按钮原生化（2026-09-21）

- 登录主操作、第三方入口、返回、登录方式、组织历史、重发、协议弹窗动作、人机验证重试／取消、注销状态提示、账号切换／添加接入 SwiftUI Button；添加账号关闭复用 HomeHeaderGlassButton。原有品牌图标保留，原生 ProgressView 表达提交中状态。
- 通过 LoginNativeButton 复用 nativeGlassButtonStyle；使用语义色和有效主题，原有设计坐标及缩放保留。iOS 禁用与忙碌时同时阻断 native Button 和回调；其他系统继续原 RN 分支。没有改动原生依赖、配置、认证协议或凭证处理。
- 输入框、协议勾选、内联法律链接和弹窗布局不在这次按钮迁移范围。
- 登录及相关原生控件 290 项测试通过，Mobile 类型检查通过。iPad Pro 13 英寸 iPadOS 27.0 浅色横屏登录页已检查；深色、VoiceOver、其他设备、账号切换弹层和完整真实认证尚未实机验收，不将组件测试等同于系统交互验收。

### 五项统一保留与磁盘恢复验收（2026-09-21）

- 历史控制器跟随最近五个任务列表保留，移除独立的八项／4 MiB 未使用历史视图池。仍有消费者的控制器在释放后清理，避免同一任务产生两个控制器。磁盘快照格式和配额不变。
- Duo 外屏竖屏实测六个不同任务，第六个打开后捕获历史控制器淘汰；重进最早任务捕获有效磁盘快照命中（20 项），正文正常显示。重进最近任务、展开横屏侧栏往返没有新增磁盘命中。此轮未做逐帧动画分析、断网实机测试或其他设备验收。
- 实测发现并修复磁盘 IO 清理错误：Expo File.moveSync 会更新源对象 URI，finally 删除源对象实际删除了正式快照。现在只清理原始临时 URI。模拟器确认快照和索引真实保留；新增回归覆盖移动成功、写入失败、移动失败。
- 63 项相关测试、Mobile 类型检查通过。测试覆盖淘汰后的离线磁盘恢复；不等同于模拟器断网验收。临时诊断日志已移除。
