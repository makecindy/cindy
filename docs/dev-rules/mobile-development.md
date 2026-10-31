# Mobile 开发、模拟器与验证

> **读取时机**：开发、启动、调试或验证 `apps/mobile` 及其共享能力时

本文是 Mobile 日常开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/mobile/package.json` 为代码事实源。

## 日常模拟器入口

普通开发使用根脚本维护 Metro、区域配置和 worktree 归属：

```bash
pnpm mobile:sim:start
pnpm mobile:sim:whoami
```

只看界面时加 `--mock`（`pnpm mobile:sim:start -- --mock`）：App 不登录、不连电脑，直接显示
与 Desktop 共用的模拟任务；`whoami`、`rebuild` 也要带同一个开关，见
[UI 模拟数据](ui-mock-data.md)。

iOS 模拟器不在仓库里固定：`whoami`、`rebuild`、`open` 默认先用 Cindy 模拟器（官方 Baguette
插件的独立设备目录）中已启动的设备，没有或插件关闭运行时用系统（Xcode）模拟器；个人选择用
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

Xcode 27 构建的 App 在 iOS 27 上还必须采用 UIScene 生命周期。当前 SDK 57 使用
Expo 官方回移支持（`expo >= 57.0.23`，`expo-build-properties` 的
`ios.enableSceneSupport: true`），由 prebuild 生成主 App 的 Scene manifest 和工厂入口。
不要只手改忽略目录里的 AppDelegate 或绕过原生指纹。启用该配置及升级原生依赖会改变
runtime fingerprint，必须按下文冷更边界审核；链接唤起、前后台切换与页面显示须单独验证。

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

- 仓库维护工具要求、脚本参数、缓存与身份校验、mock 场景和验收合同；个人 Skill 调用这些入口，
  不再实现第二套指纹、bundle ID 或缓存解析。
- 默认区域、设备偏好、模拟器后端、接管时机与工具管理方式属于开发者的本地 profile/工作流。
  本次明确指定的设备或区域高于个人默认；本次覆盖不自动写回 profile。
- 自定义 bundle ID、签名团队与私有端点留在本地配置；仓库提供模板和校验，凭证进入凭证存储。
- 设备在线状态、已安装包、Metro 占用、工具位置和缓存命中是现场事实，每次探测，不作为长期偏好。

不要用临时 Metro、端口探测或手工修改 `.env` 代替这些脚本。多 worktree、原生构建、
登录态和日志排查见 `apps/mobile/docs/simulator-debugging.md`。

## 分层验证

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
- 视觉改动同时遵守 [Cindy 设计规范](../design-rules/cindy-design-system.md) 与
  [Mobile 设计规范](../../apps/mobile/docs/mobile-design-guide.md)。
- 记录实际执行和结果；未执行的高相关检查必须说明原因。

## 专项入口

### Android 组字与发送快照

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
指纹与存量装机影响仍须按下文冷更门确认。Android 保持系统选图器和既有附件队列。

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

## 原生配置与 runtime fingerprint(冷更边界)

### 伙伴通信通知

`plugins/with-communication-notifications.js` 为当前 bundle identity 生成
`CindyNotificationService` 扩展，启用 Communication Notifications，并向 EAS 登记扩展签名。
扩展消费伙伴回复与群消息的可选 `sender` 数据；保留正文、深链和系统隐私设置，任何处理失败或
系统超时都回退原通知，且只交付一次。头像不发起网络请求、不读取用户账号存储。
Swift 源码和打包头像显式进入 fingerprint。首次发布需要原生新包和重新生成的签名配置；
服务端须先支持可选发送者透传和 `aps.mutable-content = 1`，未升级双方保持普通推送。
这不是 OTA 可独立交付的功能，仍受下述冷更审核门约束。

### iOS 桌面小组件

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
- **审查标准:会触发冷更的 PR 与技术框架变动同级,必须由仓库指定的把关人针对冷更明确
  确认后才能合并。** 不看改动大小,也不看谁提的——提交者是不是维护者、有没有拿到普通
  Approve、有没有被标回 Ready 都不构成例外;把关人自己提的 PR 同样要留下一条显式的冷更
  确认。冷更 PR 可以保持 Ready 并正常进入自动审查,不因冷更要求新建讨论 issue 或转为
  draft;冷更确认可直接留在 PR 中。未确认前不得合并(包括自动合并),把关人名单与确认
  判定细则属维护者内部 gate。若同时命中其他独立的讨论或草稿门禁,仍按对应规则处理。
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
  修改反复触发手机冷更，不为旧安装包伪造兼容 runtime，也不豁免上面的冷更确认门。
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
FCM data 消息与显式开启的前台服务都通过同一通知入口，按账号／消息去重。预览关闭时本机再次去除内容与
发送者头像。群通知使用 MessagingStyle；伙伴回复有发送者时也使用 Person。普通任务仍沿用原通知。

后台连接声明 `specialUse` 前台服务，持续显示运行通知和停止按钮；没有开机启动、隐藏重启或凭证落盘。
发行到 Play 前须完成对应前台服务用途申报。Doze、厂商电池策略和强行停止可能中断连接；FCM 也需要 Google
服务及有效项目配置，不能承诺所有设备强杀后送达。

本次 Swift 扩展、Android 原生模块和头像资源都需要新原生包，不能只发 OTA；按冷更门由指定把关人明确
批准。上线顺序为服务端兼容接口／通道配置、各端原生包，再验证 token 注册、前后台、拒绝权限、预览关闭、
停止后台连接、断网重连、通知点击定位及人／伙伴头像。旧服务端没有 chat push API 时手机保留已有任务通知。
