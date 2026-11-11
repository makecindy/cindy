# Mobile 开发、模拟器与验证

> **读取时机**：开发、启动、调试或验证 `apps/mobile` 及其共享能力时

本文是 Mobile 日常开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/mobile/package.json` 为代码事实源。

## 日常模拟器入口

macOS 上启动手机版只需要一条命令，可重复运行（比如设备闲置关机后）：

```bash
pnpm mobile:sim:up            # 只看界面加 -- --mock
```

它依次选设备、开机、准备 Metro、安装匹配的原生包、启动 App 并核对身份。进度写 stderr，stdout
最后一行是结果 JSON：`ok`、`code`、`step`、`udid`、`port`、`bundleVerified`、`foreground`，以及下一步 `next`。
`pageVerified` 始终是 `false`，页面仍要截图目检。原生层变化时会完整编译，可能要 20–30 分钟，放后台
运行并等完成通知，不要重复启动。失败时按 `next` 处理，再看
[`simulator-debugging.md`](../../apps/mobile/docs/simulator-debugging.md#截图与当前版本测试)。

判断手机版无法启动或编译，须以本轮运行返回的 `code` 为据；之前的对话、其他任务的结论、手动运行
`pod --version` 都不算证据（Agent 进程的 `PATH` 常常不含已安装的 CocoaPods）。

需要单独控制某一步时使用根脚本，它们维护 Metro、区域配置和 worktree 归属：

```bash
pnpm mobile:sim:start
pnpm mobile:sim:whoami
```

只看界面时加 `--mock`（`pnpm mobile:sim:start -- --mock`）：App 不登录、不连电脑，直接显示
与 Desktop 共用的模拟任务；`whoami`、`rebuild` 也要带同一个开关，见
[UI 模拟数据](ui-mock-data.md)。

iOS 模拟器不在仓库里固定：`whoami`、`rebuild`、`open` 默认用 Cindy 模拟器（官方 Baguette
插件的独立设备目录），只有插件未安装或关闭运行时才用系统（Xcode）模拟器；个人选择用
仓库外的 `CINDY_MOBILE_SIMULATOR=auto|cindy|system|<设备目录绝对路径>`，细节见
[`simulator-debugging.md`](../../apps/mobile/docs/simulator-debugging.md#which-ios-simulator)。

macOS 外部模拟器窗口统一使用 `pnpm mobile:sim:open -- --udid <booted-udid>`。
入口按当前 Xcode 工具链解析真实应用路径，兼容 Device Hub（Xcode 27）与旧版
Simulator，不用 `open -a Simulator` 或 AppleScript 按名称查询应用。它只打开已启动
设备的窗口，不切换 Metro、不重建或重置设备。Expo CLI 的对应探测与聚焦修复由根目录
`pnpm.patchedDependencies` 管理，升级 CLI 时需保留或确认上游已修复。

外部窗口验收使用 `pnpm mobile:sim:whoami -- --viewer --json`：在原有身份检查上要求
所选 Xcode 的窗口程序正在运行。普通 `whoami` 只报告这一独立维度，不因此阻断内嵌或
无窗口运行；`viewer.windowVerified` 与 `pageVerified` 仍为 false，设备窗口和新 bundle
必须另外验证，进程存在不等于窗口已显示。

Windows 下 `mobile:sim:start` 还会复用或启动 `cindy-api36` Android AVD，等待系统启动完成，
并为 Metro 端口建立 `adb reverse`。中国大陆版的一键入口名称带有明确区域限定：

```bash
pnpm mobile:sim:start:cn
```

可用 `-- --avd <name>` 选择其它 AVD；只需 Metro 时传 `-- --no-emulator`。脚本从
`ANDROID_SDK_ROOT`、`ANDROID_HOME` 或 Windows 标准 Android Studio SDK 目录解析工具，
不要求把 `adb`、`emulator` 加进 `PATH`。

Windows 的 `mobile:sim:rebuild` 会给 Gradle 传入
`-Pexpo.android.cmakeObjectPathMax=0`，让 App 和原生依赖保留 CMake 的平台默认路径上限与
哈希缩短行为。Expo SDK 58 默认把上限提高到 1024，但 Android SDK 附带的旧 Ninja 仍可能
在深层 worktree 中报 `mkdir(...): No such file or directory`。该参数只作用于本次 Windows
开发构建，不修改系统长路径设置、SDK 或应用原生配置；macOS 构建保持原有行为。
同一次 Windows 构建还通过 `sim-windows-native.gradle` 缩短 App 的 CMake staging 目录，
在当前 worktree 根目录的 `.cxx/` 与系统临时目录的 `cx-<项目路径哈希>/` 中选较短者，给
Gesture Handler 等生成目标的长名称留出路径空间；显式配置的 `buildStagingDirectory` 保持原值。
缓存按当前 worktree 的 App 项目路径隔离并供后续构建复用，根目录的 `.cxx/` 已由 Git 忽略；
临时目录被系统清理后会自动重建。这些目录只含可再生成的原生构建产物，不搬动源码、
不修改 prebuild 生成文件，也不改变 APK 的输出位置。
这不能保证任意深度的目录都可构建：若 CMake 仍警告对象文件 `cannot be safely placed under
this directory`，需进一步缩短显式构建输出路径，或使用支持长路径的 Ninja 并启用 Windows
长路径。单个原生库通过不能代替完整 APK 构建验证。

修改原生依赖、Expo 原生配置，或切换到尚未安装对应开发包的区域时，重新构建：

这里的 `rebuild` 是“准备兼容原生包”的入口：先复用匹配缓存，未命中才完整编译。
未安装 App 不等于必须编译；纯 JS/TS 改动且 `native-matched` 时直接复用已安装包。
截图和交付测试的完整流程见 [截图与当前版本测试](../../apps/mobile/docs/simulator-debugging.md#截图与当前版本测试)，
缺少工具时见 [iOS 工具链](environment-setup.md#macosios-模拟器构建工具链)。

`whoami` 还会比较已安装 `.app/EXUpdates.bundle/fingerprint` 与当前 worktree 的
Expo Updates 开发指纹。`native-mismatch` 或 `native-unknown` 不能作为可测试状态，
即使版本号、Metro 和页面都正常也不能交付。若未知源于工具探测或指纹计算失败，先修复检查；
确认包缺失、不匹配或缺少兼容性证据时走普通重建。重建入口同样检查缓存、构建产物和安装后
的真实指纹，避免跨 worktree 复用不兼容的原生包；不匹配的缓存会跳过。不要通过临时修改
JS 参数协议来适配另一版本原生依赖。此检查不修改 App 配置或发布指纹。

Xcode 27 构建的 App 在 iOS 27 上必须采用 UIScene 生命周期。SDK 58 默认由 prebuild
生成主 App 的 Scene manifest 和工厂入口，不再使用 SDK 57 的
`expo-build-properties.ios.enableSceneSupport` 回移开关。不要只改忽略目录里的 AppDelegate。
升级原生依赖会改变 runtime fingerprint，必须按下文冷更边界审核；链接唤起、前后台切换
与页面显示须单独验证。

```bash
pnpm mobile:sim:rebuild
pnpm mobile:sim:rebuild -- --region=cn
pnpm mobile:sim:start -- --region=cn
```

不传 `--region` 的日常入口默认运行 Cindy（Global）；中国大陆版必须显式传
`--region=cn`，或使用名称已明确限定区域的 `mobile:sim:start:cn`。发布构建继续要求显式
指定 region。

Global / CN 在全新 worktree 中不需要 `config/endpoint.dev.json`；Metro 会将该私有清单
排除出它们的 bundle，即使本机已有该文件也不打入。显式 `--region=dev` 仍读取 dev 正本，
缺失或非法时应修复配置，不得回落到 Global / CN，也不要从其他 checkout 复制私有配置。

复现或验收时，将现有身份检查保存在该任务的产物目录。先安装依赖、创建产物目录，再把
下例 UDID 和区域换成实际目标；直接调用同一脚本，避免 pnpm 与依赖检查日志混进 JSON：

```bash
node apps/mobile/scripts/sim-whoami.mjs --region=global --udid <UDID> --json > outputs/<任务>/mobile-identity.json
```

JSON 已包含 `worktree` / `expectedSource`、`region` / `bundleId`、目标设备 UDID、安装版本、
`native` 指纹检查和 `metros` 运行归属，无需再维护一份手工版本台账。保留退出码：非零或
`healthy: false` 表示身份链未通过；`healthy: true` 仍不证明 App 已加载新 bundle，
`pageVerified: false` 明确保留这个边界。页面／bundle 验证与截图按模拟器调试手册另外完成，
证据放在同一任务目录。

### 仓库与个人配置的边界

- 仓库维护工具要求、脚本参数、缓存与身份校验、mock 场景、测试授权范围、接管与并行规则和
  验收合同；Agent 直接按模拟器调试手册「截图与当前版本测试」执行，不另设个人测试 Skill，
  也不实现第二套指纹、bundle ID 或缓存解析。
- 只有完全属于个人的偏好留在仓库外：常用机型、模拟器后端（`CINDY_MOBILE_SIMULATOR`）等。
  本次明确指定的设备或区域高于个人默认；本次覆盖不自动写回个人偏好。
- 自定义 bundle ID、签名团队与私有端点留在本地配置；仓库提供模板和校验，凭证进入凭证存储。
- 设备在线状态、已安装包、Metro 占用、工具位置和缓存命中是现场事实，每次探测，不作为长期偏好。

不要用临时 Metro、端口探测或手工修改 `.env` 代替这些脚本。多 worktree、原生构建、
登录态和日志排查见 `apps/mobile/docs/simulator-debugging.md`。

多个 iOS 模拟器可以同时跑不同 worktree：每台设备的开发版 App 按自己的 `RCT_jsLocation` 选择
Metro，那里没有 Metro 响应时才退回 `8081`。`8081` 属于其他任务、又不接管时，给本任务单独的
设备和端口，步骤、验证与收尾见该手册的
[Parallel devices](../../apps/mobile/docs/simulator-debugging.md#parallel-devices-another-task-owns-8081)。

## 分层验证

### iPhone 任务灵动岛

`AgentActivityBridge` 注册独立的 ActivityKit start/update token；成功后由官方 Device Link
服务按执行电脑上报的完整快照汇总并发送 APNs，手机挂起时也可以接收系统更新。
旧服务端返回 404/405、旧原生包或自建中转时，保留 Home 与 host live-activity 的本地同步。
`cindy-agent-activity` 用 ActivityKit 维护一个聚合活动；等待操作的任务优先，其次未读完成／错误
结果，最后是运行中；标题、角色状态与展开后的任务链接使用同一优先级。排除缓存种子、未确认新建、归档
和离线电脑的任务，结果已读后移除。
内容只包含截断标题、本地化状态、任务数和带电脑 ID 的任务深链，不放工具参数或消息正文；
锁屏标题使用系统 `privacySensitive()`。退出账号／切换账号会结束旧活动。

WidgetKit 的收起、最小、展开与锁屏视图在 `plugins/usage-widgets/CindyAgentActivityWidget.swift`，
复用已有扩展；ActivityAttributes 从原生模块复制到扩展编译，避免两份 schema 漂移。
收起／最小灵动岛点击固定进入首页，不因未读计数或最近一次推送的任务而改变。展开后点击
任务标题／状态区域进入显示的任务，角色与计数区域仍回首页；锁屏／横幅展示具体任务，
点击进入该任务。系统标记内容过期后，所有入口回首页，不再沿用旧任务目标。
首页 URL 使用扩展的 `CindyURLScheme`，保持 Global／CN／beta 安装身份；任务深链继续
使用既有 payload 的 `url`，本地同步与服务端 APNs 更新共用这套呈现逻辑，无须更改推送协议。
现有实时活动 payload 不含消息 ID，因此任务链接进入对应任务，不承诺精确定位某条消息。
美术直接复用桌面角色目录中的 Cindy（手机版选定角色）：`node apps/mobile/scripts/export-agent-activity-artwork.mjs`
调用桌面 helper 的 `--export-mascots`，导出含眼睛和姿态的三张静帧，并从桌面实时活动导出
运行中橙／待处理青／完成绿的颜色目录；手机计数使用「待关注 · 运行中」，待关注包含等待操作和
未读完成／错误结果。有等待操作时左侧为青色，否则为完成绿；例如一个未读结果和五个运行中
显示绿色 `1` 与橙色 `5`，只有未读结果时也显示数量。左侧数量由既有总数减运行数得到，兼容旧活动数据。
生成物随原生 Asset Catalog 编译，不另画手机角色。桌面角色或颜色更新后重跑导出并提交生成物；加 `--check`
可在任意平台核验角色选择、源文件与生成物的哈希。手机固定使用 Cindy，不同步电脑的个性化皮肤选择。
Android 与没有此模块的旧安装包不调用 ActivityKit。

推送权限与实时活动权限分开：ActivityKit 读取系统 `areActivitiesEnabled`，不读取普通通知
偏好，也不要求普通 APNs device token。iOS 17.2+ 注册 push-to-start token，iOS 18+ 声明
`supportsInputPushToken`；较早系统须先前台创建活动，再注册该活动的 update token。
没有新增 App 内开关，用户仍通过 iOS 的实时活动设置控制。关闭普通通知不会注销实时活动。
APNs 环境复用普通推送的原生签名环境读取：development 对应 sandbox、production 对应 prod，
不以 JavaScript 的 `__DEV__` 判断；环境未知时保留本地同步，关闭／注销不依赖环境读取成功。

Desktop 仅在官方连接在线时上传本机完整活动摘要，排除远程镜像与群聊，不受 Home 分页或岛面
显示 TTL 限制；一秒合并变化，相同摘要在一分钟心跳之前不重复发送，最多一条请求在途。
服务端保存每台电脑的一份摘要和账号单调版本；角标只接受全部电脑在线且快照新鲜的完整汇总。
灵动岛可展示在线电脑的任务；部分离线且在线任务为空时不发送结束，保留旧内容。
服务端配套 PR #1318（4ddf9601a）的 APNs 内容采用 5 分钟 `staleDate`、同内容 2 分钟续期；
没有后续更新时保留原过期时间。该实现尚不能作为已部署的证据。
账号切换／退出先清本地活动，再等待已发注册收尾并注销旧注册；原生用「端点＋账号」scope
拒绝迟到的旧账号活动。离线注销不能撤回已被 APNs 接受的消息，新账号 token 注册会转移旧归属。
用户手动移除活动后，本地与服务端均抑制重新创建，直到任务清空或重新登录；更新与结束不发提醒。
原生将已观察到的移除账号 scope 保存在现有 UserDefaults 偏好中，进程重启后恢复；不保存 token。
任务清空、账号清理或切换时同时清除该标记，旧账号迟到的移除事件不改写当前账号偏好。
后台启动由系统决定，APNs 可能延迟、限频或丢失，不能承诺强杀后持续实时更新。
本地降级模式按聚合任务有效期续期：包含运行中任务为 15 分钟，仅等待操作为 1 小时，
仅未读结果为 4 小时。这是容纳长任务与日常锁屏的产品默认值，不是推送延迟的实测保证。
前台每分钟确认，前台无法确认连接时立即标记过期。后台本地 store 事件和进入后台前排队的
写入均不结束、续期或提前标记过期，保留最后确认的内容与原有效期，让系统自然到期；
账号退出／切换仍直接清理原生活动，不受此门控影响。回到前台立即核对并恢复／结束活动。
后台 APNs 仍由系统正常接收；此处只约束本地镜像，不干预服务端内容或有效期。
原生为每次本地确认写入可选 Unix 秒 `confirmedAt`；锁屏与展开态过期后保留最后一次状态，
另显示上次更新时间，计数改为次要颜色。旧活动／服务端未提供时间时显示本地化“等待更新”，
不伪造时间，不把到期当作刷新失败。服务端期限不由客户端覆写。
前台恢复或前台观察到活动刚过期时，通过既有注册 PUT 请求服务端重新同步；同一个同步器
30 秒内至多一次额外刷新，不增加定时网络轮询。新原生包未过期时不额外请求；旧包缺少
`isStale` 观察值时在前台恢复做受限刷新。`isStale` 仅在 native/JS 间使用，不发送给服务器。
成功注册后的刷新失败保留服务端汇总所有权，禁止用可能不完整的 Home 列表替换／结束活动；
首次注册失败仍降级本地同步。账号清理与无任务结束不等待一秒合并。
本地诊断记录注册结果／HTTP 状态、过期转换和本地确认；原生系统日志记录内容到达及有效期，
不记录 token、账号、标题、深链或正文。网络接收成功不等于 APNs 已送达，仍需签名真机验证。

接口与发布顺序见[协议兼容的任务汇总与实时活动](protocol-compatibility/task-activity-summary-activitykit-push.md)。
定向验证覆盖 token 轮换、旧服务端、自建中转跳过、账号切换与在途注册后注销；服务端另有真实
PostgreSQL 的多电脑、版本、设备移除和活动 start/update/end 集成测试。原生编译不是系统
推送验收：后台／冷启动、跨端已读与真实 APNs 仍需在部署后的签名安装包上核验。
新增原生模块与扩展源码需要新 iOS 安装包，不能只发 OTA。共享 config plugin 的变更也会
改变 Android 指纹（虽然没有新增 Android 功能），应随计划内双端原生发版交付；两端存量
安装均需升级对应原生包才能继续接收新指纹的 OTA，PR 须按冷更边界写明原因、影响与发版节奏。
原生验收需检查紧凑／展开／锁屏、浅深模式、点击任务定位、账号切换、后台过期和关闭实时活动。
TypeScript 测试不能替代这些原生验收。`node apps/mobile/scripts/test-agent-activity-native.mjs`
直接编译并执行生产 Codable 数据模型，验证旧 payload 解码、混合任务有效期和时间戳往返；
测试仅替换 macOS 不可用的 ActivityKit 标记协议，不替代真实 iOS ActivityKit／界面验收。
此次界面与原生状态改动不可由 OTA 单独交付；指纹比对显示 iOS / Android 均变化，应随计划内
双端新安装包发布，旧指纹继续保留原更新轨道，不能向旧安装推送不兼容 OTA。

### 推送 token 事件与验收

iOS 每次 `getDevicePushTokenAsync()` 完成都会发出 token 事件，不代表 token 已轮换。
`PushNotificationsBridge` 的监听器必须直接把事件携带的 token 交给注册函数，不能再次
读取原生 token；否则“读取 → 事件 → 注册 → 读取”会持续向两个推送端点重复注册。
事件注册必须持有本代次非事件注册成功产生的内存许可；相同 token 不再请求，真实轮换
仍注册。注销同步撤销许可，注册全过程复查 AuthOwner，防止 React 仍显示已登录的清理
窗口重新 PUT 旧账号。原生读取在注销时产生的事件也只能 skipped。
回归分别由 `pushNotificationsBridge.test.ts`（事件接线与去重）和
`pushNotificationsRealm.test.ts`（真实注册函数与端点请求）覆盖。

注册 API 成功、桌面提交 notify 帧成功都不是 APNs 送达证明。验收需分别记录签名环境、
手机注册结果、服务端 APNs 回执（可取得时）和真机是否实际收到，不能用本地通知代替。

Release 构建必须使用 `NODE_ENV=production BABEL_ENV=production`，包括手动调用
`xcodebuild`、Gradle 或 `expo export:embed --dev false`。Expo 会保留父进程的环境变量，
因此 `__DEV__=false` 或 Xcode 的 Release 配置本身不能证明 Worklets 已按生产模式编译。
仓库 iOS/Android 构建脚本会固定这两个变量；Metro 的 Babel transformer 另按每次请求的
`dev` 标志统一编译模式，防止外部开发环境把动画调试堆栈编进 Release 包，同时保留开发包调试能力。

```bash
pnpm --filter mobile typecheck
pnpm --filter mobile exec vitest run <测试文件路径>
pnpm --filter mobile test
pnpm --filter mobile test:scope
pnpm --filter mobile test:smoke
```

- TypeScript 改动至少运行 typecheck 和相关定向测试。
- 修改跨端协议、Device Link、导航主流程或原生边界时，追加 scope、smoke 或相应 E2E。
- 用模拟器验证后运行 `pnpm mobile:sim:logcheck` 并汇报结果：`ERROR` 要修复或说明与本次改动无关，新 `WARN` 要写进汇报，无法判定不算通过。详见[模拟器调试手册](../../apps/mobile/docs/simulator-debugging.md#logs)。
- 视觉改动同时遵守 [Cindy 设计规范](../design-rules/cindy-design-system.md) 与
  [Mobile 设计规范](../../apps/mobile/docs/mobile-design-guide.md)。
- 记录实际执行和结果；未执行的高相关检查必须说明原因。

消息与任务行的尺寸订阅、代码着色优化及测量边界见
[手机消息渲染的共享优化](../../apps/mobile/docs/mobile-render-performance.md)。

## 专项入口

### Android 组字与发送快照

普通任务与伙伴私聊点击发送时保持编辑器可编辑、保留焦点与软键盘；发送防重由提交锁和发送按钮负责，
不通过 `editable=false` 锁住原生输入框（iOS 会因此收起键盘）。异步发送只清除与已捕获快照相同的草稿，
后续输入不能被完成回调覆盖。排队消息保存成功后，将等待期间的新输入（含引用等结构化节点）
接在编辑前暂存草稿之后再持久保存；保存失败则将已清空的提交快照与后续输入合并回编辑器并持久保存，
同一次失败只恢复一次，未清空时保留当前完整编辑，已取消或切换编辑不回填。放弃编辑仍只恢复原草稿。附件调整与语音操作仍沿用发送期间的禁用规则。
发送期间新发起的图片粘贴与附件按钮同样关闭，不能把后粘贴的图片交给已点击发送的消息；文字粘贴仍可用。
WebView 图片批次在 start 事件记录是否接收与交付/失败回调：发送前已占位的批次继续交付；
发送期间被拒绝的批次即使在发送结束后才完成也不接收、不触碰别批占位。
iOS 原生的空图片事件（如超过剪贴板上限）与未接收批次也不能触发占位失败回调；
只有已建立占位的批次才沿其原回调完成交付或失败清理。
回归：`sessionComposerLayout.test.ts`、`composerRichInputLifecycle.test.tsx`、共享 `sessionOperation.test.ts`。

WebView 输入框把屏幕可见的组字文本同步为草稿；React Native 接受本地编辑的回传时不重写
DOM，保留输入法组字与光标。点击发送后，在发送防重锁内等待编辑器返回当前完整
`ComposerDocument`，再做空内容判断、命令解析和入队，不依赖失焦或 `compositionend` 的顺序。
等待期间账号、设备、任务、编辑器或排队编辑目标变化时取消本次提交；读取失败、超时或
粘贴尚未替换完成时保留输入并提示重试，不回退到旧草稿发送。语音结果、独立快捷发送和
显式传入的文档保持各自的快照来源，iOS 原生编辑器保留现有原生路径。
快照回包在写回编辑器状态或草稿之前核对调用方作用域；不能只在 `await` 返回后检查，
否则取消排队编辑与下一帧渲染之间到达的旧快照会覆盖已恢复的原草稿。
取消排队编辑时同步向编辑器应用暂存的个人草稿，立即轮换文档标识；不能只等待下一帧
传入新 props，否则迟到的普通 `change` 消息也可能写回旧内容。恢复不主动聚焦或弹出键盘。

实现：`ComposerRichInput.tsx`、`composerRichInputHtml.ts` 与 `app/sessions/[sessionId].tsx`；
回归：`composerRichInputLifecycle.test.tsx`、`composerRichInputHtml.test.ts`。Android 模拟器
可用 mock 模式配合 CDP `Input.imeSetComposition` 检查点击原生发送按钮后的完整文本；
它不替代三星真机键盘或真实跨设备送达验收。

### iOS 键盘坐标异常（画中画后）

iPhone Duo（iOS 27）在远程桌面返回并进入画中画后，系统发来的键盘通知坐标会改按另一块屏幕的
坐标系（如 `{192,524} 274×154` 落在 466×678 的右下角，或整宽却悬在屏幕中间），键盘实际仍停靠在
窗口底部；画中画结束、切后台都不恢复，直到冷启动。错的坐标就是画中画小窗的位置（16:9，随小窗动画变化）。
系统原始通知本身就是错的，不是 RN 换算问题：出错与正常时第一响应者（我们的输入框）、所在窗口、
`UITextEffectsWindow` 与屏幕完全相同；改按宿主窗口换算、让隐藏的远程桌面 WebView 放弃键盘焦点都无效，
只有私有键盘视图位置正确（不可依赖）。判定为 iOS 缺陷（双屏设备 + 画中画，约三分之一的进入小窗会触发）。
`keyboardOverlap.ts` 因此在 iPhone（非 iPad，没有悬浮键盘）上把「显示中却不整宽或不贴底」的
坐标视为异常，改用「同窗口宽度下见过的最高完整停靠高度」与「按窗口高度估算（竖屏 38%、横屏 42% 且不低于
220pt）」中较大者：转屏中途和换输入法会出现更矮的整宽帧，沿用偏矮会盖住输入框；转屏后 1 秒内的整宽帧也不记录（过渡帧偏高，记下后会一直抬得过高）；记录持久化在本机，
冷启动后直接进远程桌面也能用（记录异步读出，读完后两个 hook 会重算已显示的键盘占位），并记 `keyboard` scope 的
`implausible frame replaced`。复现：开「后台运行」、等远程画面出来后返回进入小窗、点输入框，多试几次；
冷启动后不先打字、从首页直接进远程桌面最容易触发；
看 Debug 日志里 `frame received` 的 `frame` 是否整宽贴底。输入卡片（`useMobileKeyboardState`）与浮动输入框（新建任务页的 `useComposerDockKeyboardHeight`）必须共用这一判据，
只修一条会出现「任务页正常、新建页仍被盖住」。RN 自带 `KeyboardAvoidingView`（群聊、共享任务、部分弹窗）
在这种状态下会抬得过高，尚未处理。回归：`composerKeyboard.test.tsx`、`composerDockKeyboard.test.tsx`。

浮动输入框仅在键盘显示期间采纳 `keyboardDidChangeFrame`：隐藏结束后仍可能收到零尺寸或异屏坐标，
不能把它送入上述异常坐标补偿，否则会重新抬起输入框并压缩消息列表，留下没有键盘的大片空白。
`willHide` 后的交互式收起继续跟随原生动画；`didHide` 将最终占位归零，下次 `willShow/didShow` 才重新启用。

### 相册选图与 iCloud 原图

iOS 的系统选图器在确认后立即把选中项交给现有附件队列。首帧预览只读取本机小缩略图，
不等待 iCloud 原图；受限照片权限下拿不到缩略图时保留附件占位，不扩大照片库权限。
原图由选图器授予的 `NSItemProvider` 在队列的 `resolve` 阶段读取，随后沿用格式转换、
压缩、上传和持久发件箱交接。发送自动等待原图就绪，不要求用户另行下载或再次发送。
原图就绪后立即更新上传中预览，已打开的查看器同步换成清晰图片，不等待压缩或上传结束。
失败回收原图临时文件时，预览回到仍有效的选图缩略图；重试就绪后再次更新。
失败保留选中项供重试，移除／换任务／成功交付后释放原生句柄；取消后的迟到文件只清理不回填。
临时副本使用 App 私有 `Caches/ImagePicker`，由现有附件生命周期回收。

实现：`modules/cindy-photo-picker/`、`src/session/deferredPhotoLibrary.ts` 与
`useMobileLocalAttachments.ts`；回归：`deferredPhotoLibrary.test.ts`、
`useMobileLocalAttachmentsAbandon.test.tsx`。新增原生模块需要冷更，不能作为旧安装包的 OTA
独立交付；旧原生包缺模块时继续使用 Expo 选图入口。首次发布应随下一次 iOS 原生包交付，
指纹与存量装机影响仍须按下文冷更边界在 PR 中写明。Android 保持系统选图器和既有附件队列。

### 相册照片与视频附件

新建任务、已有任务及群聊的「+」面板使用单个「照片与视频」入口，支持同批混选。
iOS 的 `CindyPhotoPicker.pickMedia` 在选择后立即把图片占位与视频文件交给现有附件队列；
原图／视频字节在 resolve 阶段读取，沿用 iCloud 下载、取消、重试和发件箱交接。
视频按文件上传，不经过图片转换或压缩；Live Photo 维持静态图片路径。仅使用选择器的访问授权，
不为混选扩大相册权限；最近照片条的既有授权流程保持不变。数量与传输体积规则沿用普通附件。

旧原生包缺 `pickMedia`（包括只有 `pick` 的包）时，回退 Expo 混合选择器，避免统一入口只能选照片。
此回退在选择器内等原件就绪；新原生包保留延迟读取体验。原有 `pick` 方法继续提供照片选择合同，
拍照仍仅拍照片，「文件」继续接收视频，不新增录像或专用视频编辑器。
扩展原生模块会改变 iOS fingerprint，需随原生包发布，不能作为旧安装包的独立 OTA 交付；
PR 须按冷更边界写明原因、影响与发版节奏。Android 使用现有 Expo 系统混合选择器，无原生改动。

实现：`modules/cindy-photo-picker/`、`deferredPhotoLibrary.ts`、`useMobileLocalAttachments.ts`；
回归：`deferredPhotoLibrary.test.ts`、`useMobileLocalAttachmentsAbandon.test.tsx`。

### 已发送图片的离线读取

相册、粘贴及后台发件箱共用 `uploadMobileAttachmentFromFile`：上传成功后、删除上传快照前，
把实际发送的图片保留到已有 `sentAttachmentThumbStore`。OSS 与直传引用都留底；从既有引用
的完整性指纹重建查询索引，正式消息换成 `cindy-media://blobs/…` 后仍使用同一副本。
留存记录、原地址和指纹查询均带账号及区域归属；同账号重启恢复无需重新下载。
旧版无账号归属的记录不能猜测分配给当前登录者，需联网重新读取。没有指纹的有归属引用仅按原地址匹配。
上传开始时捕获现有账号代次，留存前后复核账号、取消信号及发件箱记录有效性；失效副本立即回收，
不得在编辑器完成回调里以新账号重新登记。登出期间不提供缓存读取或写入。
缓存文件扩展名按图片格式保存，不能因上传快照没有后缀而把 PNG/GIF 当成 JPEG 分享。
缩略图、原图查看和分享均先读取本地副本；原图读取须等索引恢复并检查文件存在，
副本缺失或强制修复时沿用远端取件。缓存失败不阻断已经成功的上传。

回归：`sentAttachmentThumbStore.test.ts`、`mobileAttachmentUpload.test.ts`、`remoteMedia.test.ts`。

### 任务入口与创建失败恢复

- 非本机发起的任务来源未确认时不挂载远端任务内容，但必须显示读取状态和返回入口；读取失败、空记录或
  超时允许手动重读当前任务，不重置共享设备连接。冷启动入口等待 relay 上线，
  普通设备已知离线时等待 presence 恢复；共享任务的未建链状态不作为离线门禁。
  建链和元数据读取复用有界瞬时错误重试，连接或目标设备状态恢复后自动重读。
  离页、退后台、账号或设备切换会取消本地等待与后续重试，迟到结果不回填；
  回到页面/前台重新读取。真实缺失和永久错误仍保留手动重读与返回入口。
- 新建页与普通任务页始终保留底部活动提示行的位置（沿用活动行的 44pt 最小高度），
  慢发送、思考中和运行结束只改变行内内容，不因提示出现或消失改变消息列表与输入区的位置。
- 本地新建任务立即显示乐观消息与输入框，不因远端来源尚未返回而显示整页等待卡。
  仅创建失败时自动带回草稿与附件并返回编辑，不提供重试、返回编辑等选择菜单；
  已建成任务的首条消息发送失败仍在原任务内恢复，不退回新建页。失败原因带到编辑页。
  自动跳转前同时保存当前输入框的未发送文字和已上传附件，保存成功才移交附件并清空旧输入框，
  避免卸载清理删除已交给草稿的文件；失败后的移交期间停止继续编辑，正常创建期间仍可输入。
  正常创建期间也允许继续发送。创建失败时先等当前发送保存落定，把同一账号、设备和任务的
  未投递后续消息按发送顺序合并，再追加输入框文字；后续附件字节经原发件箱留存，冷恢复与
  即时返回共用合并入口。合并内容与已纳入的消息 ID 一次保存后才清理原记录，清理中断后不
  重复合并；复制或保存失败保留原记录，删除或换账号后的迟到保存不得复活内容。重新提交
  沿现有附件刷新路径重新上传，不能将手机本地路径直接交给电脑。
  尚未关闭的相册、相机或文件选择器、未完成上传及粘贴占位统一通过附件 hook 的
  `hasAttachmentInput()` 判断并告知，不把上传槽位数当作完整输入状态；选择器内数量未知，
  提示不猜测附件数量。超出托盘上限的附件也须告知，持久恢复同时保存这些告知。
  返回编辑复用 worktree 补偿和持久草稿恢复流程；
  回收或保存失败保留原任务与草稿。回收开始后离页仍完成同账号的草稿恢复，
  仅取消跳转；账号切换后停止旧账号操作，并移除旧代次的内存创建记录及同步阻挡，
  避免切回原账号后阻塞发件箱恢复；保留持久发件箱草稿，不执行远端删除。
  同一账号代次内，非持久化草稿留在对应失败任务中，
  只有带匹配任务与设备标识、同账号代次的新建表单可领取；领取后才清理原任务。
  领取前保留失败任务，重新进入时自动返回编辑，禁止重试已回收的创建；不写全局单槽，不混入普通新建表单。
  持久发件箱保存完成后同样保留失败任务与恢复入口，直到匹配账号、设备和任务的新建
  表单实际恢复内容才清理任务；离页重进不重复回收或保存，也不解除暂停自动发送。
  返回编辑意图写入持久发件箱；退出编辑或应用重启后保留草稿，不重建任务列表行，不启动创建管线。
  即时返回、冷恢复和任务内重试进入表单共用发件箱的可编辑判据；后台失败记录缺少编辑标记时，
  由共享恢复入口先持久补齐，再展示内容。投递中、已投递、取消或清理中的记录不能转成编辑草稿。
  恢复后用户修改文字或移除附件，同步更新原恢复记录；文字和附件清空后删除记录及其附件副本，
  离页、重启和迟到的旧编辑不得恢复已删除内容。再次提交先等待这些编辑落盘；离页也须等
  已发起的编辑结算后才释放原领取，空白页监听同一领取与发件箱通知，只恢复已提交版本。
  后续消息合并超出附件上限时，父草稿提交并移除源记录后，仅回收父草稿未引用的上传对象；
  清理中断重进沿原记录推导待回收引用，保留已承接和同路径引用，不新增回收账本。
  空白新建页自动恢复当前设备（项目入口还须匹配目录）的最新未领取草稿；
  不覆盖用户已输入的文字、附件、设备、模型或目录选择，也不覆盖带预设内容的新建入口。
  自动进入恢复与异步合并完成后写入表单共用同一输入判据；等待期间已有输入就放弃本次恢复，
  保留当前表单与未领取草稿，不在随后通知时重新覆盖，也不增加恢复选择菜单。
  文件选择器、上传和粘贴占位按同步状态判定已有输入；接收到系统分享的表单不再自动领取旧草稿。
  明确删除或归档失败任务时复用 worktree 回收，并持久结束发件箱恢复；列表、详情与批量入口一致，
  离页、重启和后台恢复均不能复活已删除记录。回收或持久保存失败时保留恢复材料。
  认领按持久存储身份跟随草稿更新与取消后的任务 ID
  轮换；重新提交保留恢复标记及发送暂停，直到后台创建管线接管。未交接就失败或离页时，恢复
  最新文字与附件，不复活旧记录。提交仍在进行时保持互斥；保存的草稿不阻塞 worktree
  账本对账。已交接、移除或换账号的记录不由旧表单恢复。
  worktree 回收成功确认一到达即禁止重试原创建；后续持久保存失败时保留返回编辑，
  重新进入任务或连接恢复后自动补做保存与恢复账本收尾，不重复回收或重用已删除目录。
  远端回收前必须先持久暂停匹配发件箱记录；写入失败不发回收请求。回收中切换账号
  仍保留该暂停和恢复账本，切回后先对账，不自动向可能已删除的目录投递。
  已确认来源的任务在重连时保持内容挂载。
- 返回编辑的忙碌状态由创建任务持有，覆盖回收与持久保存；离页重进仍禁止并发重试或
  重复返回编辑，失败后释放。页面入口统一释放创建管线预订阅的任务 topic；恢复页切到
  正常内容时保留订阅，最终离页时清理。

实现与回归：`CindyMakeSessionGate.tsx`、`SessionEntryRecovery.tsx`、
`useFailedCreationReturnToEdit.ts`、`returnNewSessionToEdit.ts`、`cindyMakeSessionGate.test.tsx`、
`useFailedCreationReturnToEdit.test.tsx` 与 `newSessionCreation.test.ts`。

### 消息缓存与首页偏好

- 首页冷启动缓存不能把单条详情或发件箱恢复当成整份设备列表已加载：首轮列表尚未返回、
  且尚无列表变更时，用缓存补齐缺失任务，已有任务与待创建状态优先。收到权威列表
  （包括空列表）、列表变更或设备移除后，不再补入旧缓存；缓存行继续保留 `cacheSeeded`
  标记。实现见 `remoteSessionStore.ts`，回归见 `mobileHomeListCache.test.ts`。
- iOS、Android 的最近消息窗口统一写入私有 `cache/session-messages-v1/` 文件，
  不设总容量或按时间淘汰；分页、内存窗口、消息净化与显式删除语义不变。
  该目录属于可再生缓存，系统低空间回收后会从主机重新获取，不作为消息权威副本。
- 旧 AsyncStorage 消息按需迁移：仅在文件缺失时读取旧条目，成功原子写入后再删除旧值；
  失败保留旧条目。回退到旧版不会读取新文件，会重新从主机获取消息。
  迁移与同一任务的写入／删除共用队列，退出账号等待在途迁移后清理两种存储。
- 每次启动把剩余旧 AsyncStorage 消息条目逐条迁成文件（走同一按需迁移与按 key 队列，
  成功后才删旧值；同 key 已有文件时以文件为准，只删旧值）：未打开会话的旧副本会占满 Android AsyncStorage 的 6 MiB 库，使发件箱、
  草稿写入报 `SQLITE_FULL`（#5403）。旧副本含没有服务端副本的 `mobile-system-*` 卡片，
  不能直接丢弃。
- 发件箱写入遇到 `SQLITE_FULL` 时先执行上述迁移再重试一次；仍失败提示「手机本地存储已满」，
  不把原始 SQLite 报错直接给用户，也不清理草稿、发件箱或其他非缓存数据。
- 发送消息先沿用持久化发件箱保存；电脑上的用户消息已落库后，还须确认手机重开时使用的
  历史快照已写入本地，才释放发件箱记录。快照尚旧或写入失败时保留原记录，退出、离线
  重开仍能显示，后续按 `clientId` 与正式历史去重。已交给电脑的消息在任务不可见时不为
  显示交接继续轮询或保留原始消息窗口；重新进入后沿用现有调度完成交接。旧电脑使用原始
  消息窗口缓存；消息已经早于最近缓存窗口时正常交接，不在末尾留下旧的待发送气泡。
  对账时已由电脑接管、且本地历史已包含同 `clientId` 用户行的记录，优先完成本地交接，
  不再先请求网络队列和历史；原始消息窗口为空不否定历史缓存的证据。未确认投递或正在
  取消的记录继续走原对账流程，缓存写入失败仍保留发件箱。
  实现与回归见 `outboxHistoryCache.ts`、`outboxHistoryCache.test.ts`、`durableOutbox.test.ts`。
- 首页预读最新历史页时，复用聊天页的连续边界判据，保留能够衔接的已读历史及其分页游标，
  不能直接把多页缓存缩成最新一页。已读工作详情只按内容版本是否有效保留，收起不等于
  删除缓存；离线重开仍可读取。无法证明连续、主机返回完整历史或明确回退时沿用原替换语义。
  后台预读写入前按平台现有容量检查：超限先省略收起详情，再退回最新页，必要时省略展开详情；
  退回最新页时同时恢复该页的分页游标。最新页本身仍超限则保留旧缓存，不标记预读成功。
  实现见共享 `historyViewPrefetch.ts`，回归见 `remoteHistoryPrefetch.test.ts`。
- 删除逐项尝试旧条目和文件，不依赖新增文件写入；任一后端失败不阻止另一后端清理，
  单个文件失败也不阻止后续文件删除，全部尝试结束后统一报告失败。清理报错时可能仍有
  无法删除的残留，不能视为清理成功。新登录或切换账号必须在持久化
  新身份前完成缓存清理；清理失败沿用登录错误与回滚路径，不能激活下一账号。
  退出账号仍完成凭证清除；若缓存清理失败，下次登录会先重试。无有效账号期间禁止
  读取或写入消息缓存，避免退出后的卸载回调重新落盘。
- 首页任务行与伙伴速览的 PR 关联和状态按账号存入 AsyncStorage
  `cindy.mobile.homeSessionPr.v1.<userId>`（最多 200 条、128 KB，只存 PR 引用与最近一次状态）。
  冷启动先显示上次结果，读回的结果算作本次未查过，连上电脑后照常重查；查询失败保留旧值，
  查到「没有 PR」则不再写回。退出与切换账号随首页列表缓存一起清除。
  实现见 `homeSessionPrStore.ts`，回归见 `homeDisplaySettings.test.ts`。
- 首页分组等偏好继续使用 AsyncStorage。合并保存时读失败不得当成空配置；写失败
  必须向用户提示，不能把未落盘的选择当成已保存。
- 文件写入失败（含磁盘空间不足）会提示检查剩余空间，并说明离线内容可能不完整。
  同一次启动最多提示一次，后台失败延后到前台提示；不把所有 I/O 错误都断言为磁盘已满。

实现见 `src/session/messageCacheStorage.ts`、`mobileSessionMessageCache.ts`、
`homeViewPreferenceStore.ts`，回归见 `src/__tests__/` 下对应测试。

### 中国大陆版微信个人登录

- 仅 iOS 中国大陆版登录页恢复微信入口；开关位于
  `src/auth/mobileSocialLoginMode.ts`。入口要求构建包含微信 AppID 与 Universal Link，
  并由 OpenSDK 确认已安装微信；Global 与 Android 均不显示。开关只影响 JS 行为，
  不额外触发原生冷更。
- iOS 复用 `xdt-wechat-login` 拉起微信取临时 code，再由 auth-server 交换；Android
  原生能力保留，但本轮不显示入口。PC 使用同一服务端的网站应用扫码入口。登录结果
  统一进入手机号补绑或身份选择流程。
- 在 Mobile `.env`（本地）或打包机环境中成对填写
  `EXPO_PUBLIC_CINDY_WECHAT_APP_ID` 与 `EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK`，
  说明与空值占位见 `apps/mobile/.env.example`。AppID 必须匹配服务端
  `WECHAT_MOBILE_APPID`；服务端两组 Secret 不进入客户端。自建构建继续继承这两个
  公开环境变量，不从服务端环境文件读取密钥。
- 仅 cn 和显式配置的 dev 构建消费微信配置；Global 忽略残留值。全空关闭入口，
  半配置或非法 Universal Link 在原生配置生成前报错。首次启用需重新出原生包，
  仅 OTA 无法添加回调配置；按下方冷更规则比对 fingerprint。
- iOS config plugin 按[微信官方接入说明](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/iOS.html)
  生成 `weixin`、`weixinULAPI`、`weixinURLParamsAPI` 三项查询白名单，并保留 AppID URL Scheme
  与 Universal Link 的 Associated Domains。遗漏白名单需重建原生包，不能通过 JS 热更补齐。
- 真机验收需验证 iOS Universal Link/AASA，覆盖
  同意授权、取消、未安装微信、回到前台超时后重试。iOS Simulator 不支持微信授权。
  iOS 登录页在回到前台时重新检查安装状态；凭据获取前仍须二次检查，不能只依赖页面显隐。
  未绑手机号须短信验证，已绑用户免短信；用同一微信在 PC 和 iPhone 上确认账号一致。

- 微信 OpenSDK 的 `oauth` / `refreshToken` 回调会同时到达原生 delegate 与 Expo Router；
  Universal Link 校验还会回跳配置路径下的 `<AppID>/?_wechat_sdk_biz_data=…`，Router 可能
  将 HTTPS 链接转成 Cindy scheme 或路径形式，这些形式也必须识别；仅按路径与参数名分类，
  不解析 SDK 的不透明 payload。
  `app/+native-intent.ts` 只负责将这些非页面链接送回首页，避免 404 展示授权参数。
  微信 code/state 仍只由原生 SDK 校验，不得复用 auth-server `/auth` 的 PKCE 交换。
  真机回归需分别覆盖微信已在后台与微信冷启动，确认回跳后继续完成登录而非进入错误页。

- 模拟器与真机排错：
  [`simulator-debugging.md`](../../apps/mobile/docs/simulator-debugging.md)。

## iOS 入站分享的消费与取消

- 分享副本使用每次分享独立的 `cindy-share-<UUID>` 目录。新建页领取前保留原生
  记录；领取必须先完成持久确认，之后才把附件交给上传管线。
- 原生记录清除失败时保留待接收批次，在既有附件错误行说明失败，重新进入页面可重试。
  不写每文件处理标记，不尝试部分领取，避免回滚失败隐藏尚未领取的附件。
  已领取附件的原生记录已清除，因此用户移除附件后，即使副本清理失败也不会重放。
- 仅经可读目录列表确认不存在的副本才过滤；目录暂不可读不能视为文件已删除。
  主动重新分享同一文件仍可领取。临时副本沿用原有取消及七天过期回收流程。
- 冷启动分享链接先进入首页，由信箱确认待接收内容后跳转，旧启动链接本身不能再次打开
  新建页。原生异常的具体原因只写无文件内容的诊断状态，不把路径或文件名写入日志。

实现：`src/session/incomingShareNative.ts`、`incomingShare.ts`、`incomingShareCleanup.ts`
与 `IncomingShareBridge.tsx`。回归：`src/__tests__/incomingShare*.test.ts` 和
`nativeIntent.test.ts`。上述 TS 层修复不修改原生配置或模块，不需要为此改变 runtime fingerprint。

## Android release 代码优化

所有地区共用 `app.json` 的 `expo-build-properties.android` 配置，在 release 构建中开启
R8 代码混淆／裁剪与资源裁剪。`plugins/with-android-release-optimization.js` 在每次
prebuild 时将 Expo 模板默认的 `proguard-android.txt` 换成
`proguard-android-optimize.txt`，避免默认规则中的 `-dontoptimize` 禁用代码优化。
不要手改生成的 `android/` 工程；clean prebuild 会覆盖它。应用和依赖 SDK 的必要 keep
规则继续生效，遇到反射／JNI 兼容问题时只补充实际需要保留的入口，不整体关闭 R8。

这些原生配置参与 runtime fingerprint，首次启用须按下文冷更边界处理，并使用 release
原生包回归启动、登录、通知和原生模块调用。

SDK 规则随依赖一起进入应用的最终 R8 配置，不在应用侧重复保留全部依赖：

| Android SDK / 桥接                  | 保留规则来源与边界                                                                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React Native、Reanimated / Worklets | 使用依赖自带的 consumer rules，保留 JNI / TurboModule / Fabric 入口。                                                                                                                                                                                                                         |
| Expo 原生模块                       | 使用 `expo-modules-core` 的 consumer rules，保留模块构造与 `definition()`、Record、视图等动态入口。自定义模块的函数名通过 `ModuleDefinition` 字符串注册。                                                                                                                                     |
| 微信 OpenSDK 6.8.38                 | Maven AAR 自带 `com.tencent.mm.opensdk` / `com.tencent.wxop` 规则；微信回调 Activity 由 config plugin 写入 manifest，由 Android 构建规则保留。                                                                                                                                                |
| TapSDK 4.10.5                       | `modules/xdt-tapdb/android/consumer-rules.pro` 按[官方接入要求](https://developer.taptap.io/docs/sdk/access/quickstart/#android-code-obfuscation)保留 `com.taptap` / `com.tapsdk`，覆盖服务发现及反射调用。                                                                                   |
| ONNX Runtime Android 1.30.0         | `modules/cindy-speaker-onnx/android/consumer-rules.pro` 保留 `ai.onnxruntime` 的类与成员，覆盖 JNI 按原名查找的 `TensorInfo` 等类型及构造方法。声纹录入与过滤须用开启 R8 的 release 包验证，mock 原生桥的 JS 单测不能替代。                                                                   |
| Nimbus JOSE JWT 10.9.1              | 远控凭证模块直接调用 JOSE API，协议 JSON 使用显式键名的 `JSONObject` / Map，不依赖业务类字段名反射序列化。`cindy-remote-credentials/android/consumer-rules.pro` 仅忽略未启用的 XC20P 算法所需的可选 Tink 类；当前协议创建和接收均限制为 `ECDH-ES + A256GCM`。若扩展算法，须重新核对可选依赖。 |

升级 SDK 时核对其 AAR/JAR 的 consumer rules、应用的最终 `configuration.txt` 和 release
运行结果。共享的 Expo 配置也可能改变 iOS 指纹，冷更范围以指纹比对为准。

## Android 掌机模式

含 `cindy-handheld` 原生模块的 Android 包在「设置 → 掌机 → 掌机模式」提供入口，默认关闭。
开启后十字键 / 左摇杆移动焦点、A 确认、B 返回，右摇杆滚动，L1 / R1 翻页；近乎不可见的
预热 WebView 不作为手柄焦点目标。语音键默认 X，可从列表选择或直接按手柄键录入；改用
A、B、L1、R1 会占用其原有操作，设置页有明确提示。

长按语音键开始录音，松开停止，识别文字留在输入框，不自动发送。首页长按先打开新建任务页，
新页接手同一次按住及松手。录音复用既有权限、音频与转写入口，不另建语音通道。
默认在开启时移到首个非默认显示屏；关闭模式或副屏选项回到主屏。换屏只在偏好意图改变或
冷启动恢复时执行，用户之后手动换屏不会被持续拉回；没有副屏时继续使用当前屏幕。
偏好只保存在本机，不跟随账号或其他设备同步；只保存显式选择，「恢复默认」删除覆盖值。
旧原生包和 iOS 不显示入口。

实现：`modules/cindy-handheld/`、`src/handheld/` 和 `app/settings/handheld.tsx`；
偏好与跨页按住交接回归：`src/__tests__/handheldMode.test.ts`。Android 窗口按键拦截和换屏
必须随新原生包交付，仍受下文冷更审核门约束。

## 手机推送排障：注册不等于投递

`cindy.push.enabled` 只记录偏好；`cindy.push.registered` 是请求前写入的注销补偿标记，
不能证明服务器注册成功。Desktop 的 `sendNotify()` 返回 true 也只说明已向 relay 发送，
不是 APNs 接受或手机展示的回执。不要据此宣布推送恢复。

手机在 AsyncStorage `cindy.push.lastRegistration` 保留最近一次启用注册尝试的单条状态，
CindyDev 按 `.dev` / `.release` 分开。状态记录时间、账号区域（不含身份）、签名对应的
APNs 环境、失败阶段和 device-link/chat 分别接受、失败或不支持的结果及 HTTP 状态码。
它不依赖调试日志开关，不含 token、账号 ID、地址、正文或原始错误；写入失败不影响注册。
这是有时间戳的历史尝试，关闭推送或切换账号后不能当作当前订阅状态；`registered` 只证明
注册 API 请求完成，不能替代实际通知验收。回归见 `pushNotificationsRealm.test.ts`。

若注册成功仍无通知，继续核对签名 team/topic 与服务端配置、服务端 token 选择及 APNs
响应，最后核对手机的系统通知展示条件。本地服务器源码不能证明线上部署；缺少投递日志时
保留“尚未确定”的结论，不让用户反复切开关，也不通过不断广播测试通知替代定位。

## 原生配置与 runtime fingerprint(冷更边界)

### 伙伴通信通知

`plugins/with-communication-notifications.js` 为当前 bundle identity 生成
`CindyNotificationService` 扩展，并向 EAS 登记扩展签名。Communication Notifications
权限仅声明在主 App target 上；通知扩展负责处理通知内容，不重复声明该权限，否则
Xcode 自动签名会以 entitlement 无法写入 profile 拒绝构建。
扩展消费伙伴回复与群消息的可选 `sender` 数据；保留正文、深链和系统隐私设置，任何处理失败或
系统超时都回退原通知，且只交付一次。头像不发起网络请求、不读取用户账号存储。
Swift 源码和打包头像显式进入 fingerprint。首次发布需要原生新包和重新生成的签名配置；
服务端须先支持可选发送者透传和 `aps.mutable-content = 1`，未升级双方保持普通推送。
这不是 OTA 可独立交付的功能，仍受下述冷更审核门约束。

### iOS 桌面与锁屏小组件

`plugins/with-usage-widgets.js` 生成 `CindyHomeWidgets` WidgetKit 扩展（订阅余量、每日用量，iOS 17+），
与 expo-sharing 共用 `group.<bundle id>` App Group，并向 EAS 登记扩展签名。App 内
`src/widgets/UsageWidgetBridge.tsx` 在前台且已连接时约每 5 分钟经
`device-link:usage-widget:snapshot:v1` 读取电脑快照，由本地模块 `cindy-usage-widgets` 写入 App Group 并刷新组件；
App Group 里存每台电脑最近一次的快照和「自动」所选电脑（优先上次回应的那台）。组件「编辑小组件」里的
「数据来源电脑」可选自动或某台电脑；组件绘制时把所选电脑记进 App Group，App 每次刷新也会读取这些电脑。
「订阅余量」另有两项，与 Mac 菜单栏设置同一思路：「排在前面的账号」（小 / 中 / 大最多 4 / 6 / 7 个，可拖动调整、删除）
和「隐藏的账号」。可选项是所选电脑快照里的账号（电脑上隐藏的不在快照里）。显示时先排所选账号，其余账号（含以后新加的）
按电脑顺序跟在后面，隐藏的不显示，既排在前面又隐藏时以隐藏为准；同一账号重复只算一次；全部隐藏时照常显示全部（仍按排在前面的顺序）。
连接 id 只在所属电脑内有意义（各电脑内置的 OpenAI 连接 id 相同、登录账号却可以不同），所以跨电脑按同一图标与名字认同一账号，id 只作确认，不单凭 id 回退。在编辑页改「电脑」时系统会清空这两项。
这些选择只存在系统的组件配置里，不写 App Group；改尺寸会保留。
切换或退出账号时清空。组件只读快照，回满倒计时按 `resetsAtMs` 在本机推进。Swift 源码、图标资源与数字字体
显式进入 fingerprint；旧包没有该原生模块时 JS 侧静默跳过。真机测试包若签名缺少 App Group，组件只会显示空状态。

锁屏同时支持圆形、矩形与日期旁的单行组件，复用同一份快照、电脑选择和打开 App 的深链。
锁屏余量沿用安卓紧凑版的选取规则：先放用户固定的账号，其余优先订阅，没有订阅时才用余额类账号。
一格圆形单行并排 2 个账号，两格矩形单行并排最多 4 个；日期旁单行从未隐藏的订阅中按剩余比例升序最多显示两个账号，同余量保持原顺序；使用单个 Text 内嵌各供应商图标，ViewThatFits 在文字过长时退回最低余量的一个账号（Credits 储备按订阅耗尽处理），不把美元余额与百分比比较；无订阅时才回退余额。固定账号上限分别为 2 / 4 / 1，固定顺序不覆盖单行最低余量规则。
锁屏余量每个账号由上方供应商图标、中间数字和下方横向细进度条组成；优先用户固定的账号，不把多个账号余量平均。
进度条沿用桌面组件的内胆裁切：从描边内缘计算的最多 2 个物理像素间隙（2× 强调条缩为 1px，保证内胆至少 2px）、轻圆角液面和独立外壳描边（普通 1px、强调 2px）；填充从左向右，满格仍保留留白。
账号作为紧凑组居中排列，少于满额时保留两侧留白，不拉开间距或改变字号。一格 / 两格分别使用 24pt / 28pt 长、4pt 高的进度条，数字 11pt / 13pt、图标 13pt / 14pt；百分号缩小到 6pt / 7pt，数字采用常规字重。每组内部纵向间距 4pt，账号组间距 6pt / 10pt。
日期旁单行使用各自供应商图标加余量，以间隔点分开。内嵌图标使用专用 `inline-logo-*` 模板（20pt 画布、16pt 图形、顶部 4pt 光学留白），保持文字与系统日期的基线一致；系统会忽略内嵌图片的 Text 基线修饰，不用加高图片画布去移动图标，以免把整行数字带偏。账号名和重置时间不在视觉版式里挤占空间，保留在辅助朗读中；
完整信息通过现有深链打开 App 查看。按系统实际尺寸复核留白和可读性，不以放大的局部截图替代整屏检查。
Credits / 余额用斜纹柱而非百分比液面；过期读数减淡液面并用时钟标记，保留更新时间供辅助朗读。
每日用量一格上下排列：上方近 7 条日数据的趋势柱，下方 tokens 数字与单位；当天数据省略「今天」，只有跨日数据才在底部标小字日期，过期快照在读数旁保留时钟，避免横排挤压读数；两格保留左侧趋势柱、右侧日期与 tokens。最后一柱强调，按窗口峰值归一化，不表示额度百分比；日期旁单行用同一份日数据绘制迷你趋势图并附最近一日的数字摘要。日期和读数配对后按日期排序；只画实际收到的数据，不补造缺失日期，零用量保持零高度。
每日用量显示最后一个有数据日期的 tokens；跨日快照标实际日期，不能继续写「今天」。
锁屏使用系统单色样式，个人读数标记 `privacySensitive()`，由系统锁屏隐私设置决定遮盖。
这三种 family 的注册及 Swift 版式属于原生扩展，必须随新 iOS 包发布，不能仅 OTA。

### Android 桌面小组件

同一对组件（订阅余量、每日用量）在 Android 上由本地模块 `cindy-usage-widgets` 的 `android/` 提供：两个
`AppWidgetProvider`（`QuotaWidgetProvider`、`UsageWidgetProvider`）、数据来源选择页 `ComputerConfigActivity`
都由模块自己的 `AndroidManifest.xml` 合并进应用，不经 config plugin。数据通道、快照格式与「自动 / 固定电脑」规则与 iOS
相同（`UsageWidgetBridge` 两端共用，`readSnapshot` / `writeSnapshot` / `readPinnedDeviceIds` / `clearSnapshot` 同名）：
快照存在应用私有的 `noBackupFilesDir/usage-widget-snapshot.json`（不进自动备份），组件选中的电脑与记录的固定电脑在
SharedPreferences `cindy-usage-widgets`。「订阅余量」的设置页另有「排在前面的账号」（最多 7 个，可上移、下移、移除）与
「隐藏的账号」，与 iOS 编辑页、Mac 菜单栏设置同一规则：排在前面的先显示，其余账号（含以后新加的）按电脑顺序跟在后面，隐藏的不显示，
全部隐藏时照常显示全部；按组件存在同一 SharedPreferences（`pinned.<id>` / `hidden.<id>`，与 iOS 相同的 `AccountKey` 字符串，
按 id 找不到时按同一图标与名字匹配）。换电脑不清空这两项。液面顶角与 iOS 一样是 4dp 圆角。

组件内容由 `WidgetRenderer` 按启动器格子的实际尺寸直接画成位图（版式与 iOS 的小 / 中 / 大一致，格子比 iOS 尺寸小时整体
等比缩小，大时靠弹性空白撑开），浅 / 深两套都画好，由 `layout` 与 `layout-night` 选择可见的一张，所以系统切换深浅色不需要
重绘。一行高、宽度 ≥ 250dp 的格子（高度 < 120dp 且宽 ≥ 1.4 倍高）用 Android 独有的单行版式，更窄的一行沿用等比缩小的小号版式（4 个来源仍可见）（液柱在左、数字名称重置时间叠在右；每日用量是今日数字加迷你柱图），
启动器里一行的实际高度因启动器而异（40–110dp），最小可缩到 40dp 高。每 30 分钟（`updatePeriodMillis`）、App 写入新数据、调整大小时重绘。Barlow Condensed 数字字体由 Gradle 任务从
`apps/desktop/native/menubar` 复制进 assets，不再提交第三份；文案表 `assets/usage-widgets/text.json` 由
`plugins/usage-widgets/UsageWidgetModel.swift` 的 `WidgetText` 转出并追加数据来源页文案，两处同步修改；选择器里的名称与说明
在 `res/values*/cindy_usage_widgets_strings.xml`（同源生成）。

调试：debug 包响应 `adb shell am broadcast -a app.cindy.usagewidgets.RENDER_PREVIEWS --es variant multi|single|stale|offline|empty
-n <applicationId>/app.cindy.usagewidgets.QuotaWidgetProvider`，把示例数据下的全部版式与深浅色写到 `cache/widget-previews`；
选择器预览图 `res/drawable*/cindy_*_widget_preview.png` 由它生成。Kotlin 与资源改动进入 Android runtime fingerprint，需要新原生包。

#### Android 锁屏

两个组件的 `widgetCategory` 为 `home_screen|keyguard`。Android 没有 iOS 那种锁屏专用的圆形、矩形、单行组件：Android 16 QPR2
（API 36.1）起的原生锁屏组件页直接放这两个组件，系统按锁屏格子的尺寸通知重绘，沿用桌面的版式、账号排序与数据来源设置页，不另做版式；
从锁屏点组件打开 App 时由系统先要求解锁，组件不声明 `showWhenLocked`。读数照常显示：Android 锁屏没有对应 iOS
`privacySensitive()` 的系统遮盖，这是有意的两端差异。三星 One UI 8.5 的原生锁屏组件列表只放行三星自家组件，
实测声明 `keyguard` 或三星私有类别（2048、4096、8192）的第三方组件都不出现；三星用户需经 Good Lock 的 LockStar 放到锁屏。

模拟器验证：36.1 的 Google Play 镜像不能 root，且系统默认关闭锁屏组件（`config_glanceableHubEnabled=false`），需用
`system-images;android-36.1;google_apis` 镜像：`adb root` 后以 `cmd overlay fabricate` 把 `android:bool/config_glanceableHubEnabled`、
`android:bool/config_glanceableHubEnabledByDefault` 与 `com.android.systemui:bool/config_communalServiceEnabled` 置真并
`cmd overlay enable`，再 `settings put secure glanceable_hub_enabled 1`、设置锁屏 PIN、重启 SystemUI。解锁后
`am start -n com.android.systemui/.communal.widgets.EditWidgetsActivity` 打开锁屏组件编辑页，从「Browse」添加。
锁定状态的组件页要模拟充电直立：`dumpsys battery set ac 1`、`cmd statusbar device-postured true`，停在锁屏上时把
`when_to_start_glanceable_hub` 先设 0 再设 2；SystemUI 的 `keyguardState` 变为 `GLANCEABLE_HUB` 即已进入，不要再按电源键。
点组件后进入 `PRIMARY_BOUNCER`（解锁界面截图为黑屏），输入 PIN 后 App 到前台。模拟器重启后运行时覆盖会失效，需重新启用。

Mobile 用 `runtimeVersion.policy: "fingerprint"`:OTA 热更只在**指纹一致**的装机上生效,
指纹一旦变化就必须**冷更出包**(新商店包 / 自建重装),存量装机拿不到该次热更。

### 硬性规则:除非必要,不得提交会改变指纹的改动

触发冷更的代价由全体存量用户承担——他们拿不到本次及后续热更,直到装上新包。性质上这与
技术框架变动同级,因此:

- 只为实现 JS / UI 需求时,不得顺手改动指纹输入。同样效果能用不动指纹的写法达成时,必须
  选不动指纹的写法。已知踩点与既有规避写法:调试信息走 `EXPO_PUBLIC_*` 进 JS bundle,不写进
  `app.config.js` 的 `extra`;新增开发脚本放仓库根 `package.json`,不放
  `apps/mobile/package.json`(后者的 `scripts` 是指纹输入,见
  [`simulator-debugging.md`](../../apps/mobile/docs/simulator-debugging.md))。
- 确实必须冷更时(升原生依赖、改 config plugin / 原生模块、动 production 段 `app.json` /
  `eas.json`),PR Description 必须写明三件事:为什么冷更不可避免、存量装机影响范围、发版
  节奏建议。
- **审查标准:会触发冷更的 PR 按普通流程审查与合并,不需要指定把关人另外确认。** 审查时
  逐条核对:是否确实必须冷更(同样效果能用不动指纹的写法达成时,要求改写),PR Description
  是否写全上面三件事。冷更 PR 可以保持 Ready 并正常进入自动审查,不因冷更要求新建讨论
  issue 或转为 draft。若同时命中其他独立的讨论、草稿或确认门禁,仍按对应规则处理。
- 提交前自查:在改动前后各跑一次
  `node apps/mobile/scripts/ci-fingerprint.mjs compute --output <file>` 并比对 hash。PR 上
  出现 fingerprint guard 的 sticky comment 时,以它给出的 base(main) vs 合并结果对比为准。

### 判断哪些改动会动指纹

- 远控凭证共享目录默认参与指纹，但 `fingerprint.config.cjs` 明确列出的六个
  `#if os(macOS)` 文件及三个桌面入口目录不参与。共享 Swift、手机密码表单、资源、
  podspec 和未列出的新文件仍参与；不要按 `Mac*` 文件名通配排除。
  `fingerprintConfig.test.ts` 校验排除文件的完整 macOS 编译保护，并使用 Expo 哈希器
  验证两端的排除项与保留项。移除平台保护或让手机依赖这些文件前，必须同步移除排除项。
  **首次采用此边界仍改变旧指纹**，须随计划内原生发版迁移；它只避免迁移后桌面专用
  修改反复触发手机冷更，不为旧安装包伪造兼容 runtime，也不豁免上面的冷更说明要求。
- 改 `app.json` / `app.config.js` 前先判断是否会动指纹。被哈希的是**解析后的
  ExpoConfig**(app.config.js 的输出),不是源文件本身:凡进入 resolved config 的字段,
  改了值就会变指纹;只有被 app.config.js **覆写 / 剥离、传不到 resolved config** 的值才指纹
  中性(如自建线的 `updates.url` 被占位覆盖)。改动前后可用仓内 `@expo/fingerprint` 比对
  (见 `scripts/ci-fingerprint.mjs`)。
- 除 config 外,这些也是指纹输入:`apps/mobile/package.json` 的依赖与 `scripts`、
  `eas.json` 的 production 段(`beta-*` profile 由 `fingerprint.config.cjs` 剔除)、
  `plugins/`、`modules/` 下的原生模块、`fingerprint.config.cjs` 自身,以及原生依赖版本变化
  (含仅体现在 lockfile 上的传递依赖)。
- **EAS 账号绑定与凭据不入仓**:`owner` / `extra.eas.projectId` / `updates.url` 及 provider
  凭证由**构建期环境变量**注入(`EAS_OWNER` / `EAS_PROJECT_ID`,provider secrets 走 EAS
  environment / 自建区域配置),仓库留空,外部使用者用自己的 Expo 项目(`eas init`)填 env。
  因为哈希的是 resolved config,发布环境注回**相同值**时逐字节不变 → 指纹不变、不冷更;缺省
  (dev / fork)则不带账号绑定、不配 OTA。变量清单见 `apps/mobile/.env.example`。

## 边界

本文只覆盖本地开发、调试和验证。商业发布、版本分发、签名与渠道运维属于维护者内部
流程，不在公开仓库文档或 Agent 手册中维护。

## Android 自建安装包的应用内更新

启动检查、设置页与强制更新屏共用 `src/update/useBundleUpdatePrompt.ts` 的安装出口。
Android 8 及以上的新原生包优先应用内下载 HTTPS APK；Android 7、旧包缺少
`CindyAppInstaller`，或安装地址是网页时，继续使用浏览器。权限由自建构建的
`app.config.js` 声明；Global 在同一次 Expo prebuild 后配置 `website` / `play` 变体：
官网 APK 保留 `REQUEST_INSTALL_PACKAGES`，Play AAB 通过 Manifest overlay 移除该权限。
变体只修改生成的 Android 工程，不修改 Expo 配置或 fingerprint 输入；EAS 商店构建不声明
该权限。

`scripts/build-android.mjs --region global --execute` 在输出产物前自动读取官网 APK 的
权限和 Play AAB 内嵌的最终 Manifest，分别要求有／无安装权限，并回读两份产物的
runtimeVersion 要求一致；读取失败或不满足条件即停止构建交付。此校验随每次实际构建执行，
覆盖最终 Manifest 合并结果。`androidLocal.test.ts` 只验证变体 patch 和权限断言，不能替代
Expo prebuild + Gradle 的实包验证；验证构建链时需保留上述实际产物校验结果。

Global 自建 APK 与 Google Play AAB 共用自建 OTA 配置和原生构建流程，不能仅凭
`IS_OTA_SELFHOST` 判断整包更新渠道。Android 原生安装桥读取系统记录的 installer：
Google Play 安装跳过官网 `/latest` APK 整包提示，由 Google Play 管理原生包更新；
JS OTA 仍按现有通道检查，设置页手动检查只报告内容更新。遗留强更目标的安装按钮也
只能打开该应用在 Google Play 的页面。官网 APK 安装继续使用下述应用内更新流程。
这项原生查询改变 Android runtime fingerprint，旧 Play 包必须经一次 Play 冷更后才具备
可靠的安装来源识别能力；不能把 JS OTA 当作旧包已经修复。

- 全程只用一张内容高度的 Material 底部更新卡（`SheetModal.nativePresentation`）：
  应用图标、版本变化与更新内容固定在上方，授权说明、下载进度、安装与失败在同一张卡内
  切换，不再叠系统对话框。启动／回前台自动发现普通更新时，先在 Wi-Fi 下静默下载，
  下载完成且回到前台后才显示「安装更新」卡；自动下载不预先申请安装权限，不自动拉起安装器。
  Wi-Fi 断开时暂停并保留字节，恢复 Wi-Fi 后续传；自动失败静默留待后续检查重试。
  选择「稍后」后，本进程不再重复提示同一目标；手动检查仍可打开更新卡，明确确认后可在移动网络下载。
  权限说明或拒绝权限卡上的「稍后」也沿用同一规则。根部自动检查 hook 持有共享安装器的通道生命周期，
  通道变化或卸载时取消已启动的下载与安装卡，回前台启动的下载同样受此约束；取消不视为用户选择「稍后」。
  下载与打开安装器期间按钮显示「取消」，仅终止当前操作，后续自动检查仍可在 Wi-Fi 下续传；
  通道变化和目标替换也只取消旧操作，不记作「稍后」。按钮文案与抑制提示的行为共用同一阶段判据。
  强更屏的「去更新」本身就是确认，不再出现确认步骤。
  旧原生包、网页地址与 Play 安装仍走原系统对话框和既有出口。
- 点击安装时已授权则直接使用已下载的包；未授权时卡内先说明权限，用户点「允许并更新」才打开系统设置，
  返回后读取实际权限，授权成功即继续安装（尚未下载的手动更新先下载）。拒绝不会循环申请，卡上保留「改用浏览器下载」。
- 手动下载显示进度条并支持取消，服务器未给大小时显示不定进度（系统减弱动态效果时静止）；
  网络停滞会结束并提供重试。中断、取消或进程重启后，按下载地址与目标版本复用私有缓存中
  已落盘的 APK 字节，重试时续传；不同目标版本不共用文件。服务器忽略 Range 时安全从头
  写入，返回 416 时仅回退重下一次；HTTP 错误响应不写入已有文件。关闭后立即重开会等待
  原生写入停止再续传。下载在后台完成时，等回到前台再打开安装器。关闭更新卡不会
  解除原有强制更新闸门。
- APK 只写入 app 私有 `cache/cindy-updates/`。原生桥只接受该目录内的 APK，校验包名、
  目标版本与递增的 versionCode；最终签名校验、安装确认和覆盖安装由 Android 负责。
- 安装器已打开不代表安装完成。取消系统安装或关闭更新卡后保留当前目标的完整包，
  再次安装或进程重启后直接复用，不重复下载或改写。发现新目标时（包括等待 Wi-Fi 期间），
  立即清理本功能其他目标的完整包和断点包；只清理已知命名的文件。
  系统安装器使用独立、不可改写的时间戳命名副本，沿用既有 24 小时清理宽限（包括旧客户端的同类副本），
  避免 `startActivity` 返回后才读取 APK 时被新目标清理；打开安装器失败则立即回收该副本。

实现：`modules/cindy-app-installer/`、`src/update/androidInstallController.ts`、
`src/update/androidInstaller.ts`、`src/update/AndroidUpdateSheet.tsx`。
定向测试为对应的 `androidInstallController.test.ts` 与 `androidInstaller.test.ts`，构建配置
边界由 `src/__tests__/nativeAppConfig.test.ts` 验证。原生验证还应检查授权/拒绝返回、系统
安装取消、签名不匹配拒绝与同签名覆盖安装；不能把 JS 单测当作这些原生路径的实测。

### 群消息通知与 Android 后台连接

`CINDY_ANDROID_GOOGLE_SERVICES_FILE` 可指向仓库外的 `google-services.json`；未配置仍可构建，
通知设置会说明 Google 推送不可用。服务端 Chat Server 和 device-link 分别配置同一 Firebase 项目的
`FCM_PROJECT_ID` 与 ADC（例如仓库外 `GOOGLE_APPLICATION_CREDENTIALS`）。不要把密钥提交到仓库。

`cindy-chat-notifications` 是 Android Expo 本地模块，复用 Expo 的 token、通知点击和冷启动响应；
FCM data 消息与后台连接都通过同一通知入口，按账号／消息去重。普通任务以服务器生成的 notificationId 去重，聊天仍按消息 ID 去重。预览关闭时本机再次去除内容与
发送者头像。群通知使用 MessagingStyle；伙伴回复有发送者时也使用 Person。普通任务仍沿用原通知。

Android 后台连接默认「自动」：中国大陆账号、设备地区 CN、上海／重庆时区，或 FCM 获取／注册尚未成功时启用。
地区和时区仅作为启用补充通道的信号，不用于修改账号区域或端点。FCM token 获取最多等 8 秒；缓存 token 不证明大陆网络可达，
因此大陆信号仍保留直连。自动模式只有在任务与聊天两路云推送注册都成功时才允许停掉共用后台服务；
旧聊天注册接口 404／405 仅兼容为任务注册成功，不代表聊天推送可用。
用户可选始终开启／关闭，原有显式 1／0 偏好保持，通知栏停止也持续生效；总通知开关与系统通知权限始终优先。

普通任务通过当前账号区域的 device-link `/api/device-link/push-stream` HTTPS SSE 接收，聊天继续走 Chat Server。
两者连接独立，不占用手机远控 socket；聊天服务不可用不阻断普通任务。SSE 仅携带当前设备绑定的短期 token。
聊天身份按账号及区域绑定；同账号短暂查询失败保留已有身份与本轮已知聊天配置，切换账号或退出时清除，防止跨账号接收。
断线按 1–60 秒加抖动重连，服务端 5 分钟内主动换连以重新验证认证；本机仅保存账号范围内的游标与去重 ID。
预览关闭时服务端及本机均删除正文／发送者信息。自建中转不把自建任务凭证转发到官方 SSE；当前自建中转的已有推送路径不变。

后台连接声明 `specialUse` 前台服务，持续显示运行通知和停止按钮；没有开机启动、隐藏重启或凭证落盘。
发行到 Play 前须完成对应前台服务用途申报。Doze、厂商电池策略和强行停止可能中断连接；FCM 也需要 Google
服务及有效项目配置，不能承诺所有设备强杀后送达。

本次 Swift 扩展、Android 原生模块和头像资源都需要新原生包，不能只发 OTA；PR 须按冷更边界写明原因、
存量装机影响与发版节奏。上线顺序为服务端兼容接口／通道配置、各端原生包，
再验证 token 注册、前后台、拒绝权限、预览关闭、停止后台连接、断网重连、通知点击定位及人／伙伴头像。旧服务端没有 chat push API 时手机保留已有任务通知。

普通任务直连新增 Android 原生接收器，必须随新 APK 冷更；旧包通过可选 native 方法检测继续使用原聊天接口，不能靠 OTA 获得任务直连。
配套服务端先部署 SSE 和通知 ID，再发布 Android 新包。旧服务端 404 时后台退避一分钟并保留 FCM，不能把该状态记成直连可用。

### 手动 APNs 诊断（iOS）

「设置 → 开发者 → 推送诊断」仅在用户点击「读取推送状态」后读取系统通知权限、签名中的 APNs 环境和当前设备令牌。它不请求或变更通知权限，不写入诊断日志或持久存储，也不自行发送服务端请求；原生读取可能触发已有 token 事件，该事件继续遵守推送注册的账号围栏和去重。页面离开、应用进入后台或读取超时后丢弃结果，迟到的原生回调不能重新展示令牌。复制是独立的显式操作，剪贴板内容不会随页面退出自动清除。

排查个人签名包时，应先核对该页的应用 ID、构建号和环境，再使用同一 Apple 开发者团队的 Push Notifications Console 给该设备令牌发送匹配环境的通知。不要把 ActivityKit token 当作 APNs device token，不把令牌粘贴到任务日志或提交到仓库；不要以「注册成功」或「服务端已发送」代替真机收到通知的验收。此入口只依赖现有 Expo 模块，不改变原生指纹、登录存储或应用身份。
