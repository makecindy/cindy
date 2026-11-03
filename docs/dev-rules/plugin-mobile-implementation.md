# 移动插件接入

手机通过设备互联使用执行电脑上的已装插件。插件业务逻辑、Library 和任务仍在电脑上；
手机提供入口、隔离页面及原生交互，不复制插件安装或另造任务类型。

## 入口与页面

- 主菜单提供插件入口和聚合未读点；目录按电脑展示，支持搜索、最近使用、详情和启停。
  宽屏目录与内容并列，样式使用 Light/Dark 语义 token，文案覆盖现有五种语言。
- iOS 已装目录使用现有 `@expo/ui` 的 SwiftUI List、Menu 和 Picker；搜索复用现有导航栈的
  UIKit UISearchController / UISearchBar，置于标题下并常驻。电脑范围和标题行是普通列表内容，
  随页面滚出；All/Unread 筛选暂不展示，保留内容通知提示点。未读不表示可用更新。
  两页使用平面 List；详情启用 Toggle 放在插件名称右侧，iOS 可视目标 48×24pt，保留 56×44pt 操作区域。
  Use it in 标题下仅保留新建/已有任务原生 secondary 按钮，不附加说明。
  panel/mainView 合并为一个打开插件入口；Tools、Permissions 与 Details 使用真实 Host 只读数据，
  Tools 使用弱底色胶囊与工具图标，随容器宽度自然换行，默认最多两行，标题保留总数；溢出时提供 Show all / Show less，始终隐藏描述；权限复用 PC 声明摘要（排除 tool）。
  分组之间不画线，仅 Details 条目之间使用系统 Divider，避免重复 padding；身份首行顶部 inset 8pt。
  Details 按 PC 顺序展示版本、作者、来源与签名、标识、包含能力、面板和只读安装目录，
  内容与信任标签复用 PC 共享规则。旧 Host 缺字段时仅显示已有真实版本/标识；可选字段为空则隐藏，
  Tools/Permissions 无数据则整组隐藏，不展示未提供数据或缺描述的占位提示。
  不推断为无权限、不补造事实或面板停靠状态。配置和任务偏好不内联，提示到电脑插件详情设置。异常时显示必要提示和单个解决动作；
  导航容器负责容器安全区，Host 保留键盘避让。图标与专用任务设置继续复用 RN 内容。Android
  保留平台列表与搜索，控件同样随内容滚动，详情使用平台原生 Switch。
- Installed 固定按最近使用排序，不展示添加时间/最近使用的筛选交互，不重复展示 Recent 分组。
  最近使用以手机 MRU 优先、Host MRU 补充；不得用没有真实来源的安装时间替代。
  只记录实际成功打开页面/使用入口，查看详情不记。列表可选 pluginOrder 只下发
  addedAt/recentIndex：addedAt 来源于成功首装记录，不取更新/通知/首次手机发现时间；
  老 Host 或历史缺失时间保持未知，排在已知添加时间之后并稳定原序。手机 MRU 优先，
  Host MRU 补充，同排名保持稳定。不同电脑的插件用资源 key 区分，配置与凭证不参与排序。
- 启停开关等待电脑操作回执并重新读取插件状态，操作期间禁止重复点击，成功后保留详情。
  离线时不可操作；失败不自动重发，账号或详情已切换时旧响应不覆盖当前页面。
- manifest 的可选 `mobile` 包含 `channels`、`panel`、`mainView`、`settings`；路径只覆盖
  已声明的原能力。未声明移动适配的插件仍可被发现和在任务中使用，旧桌面行为保留。
- 页面租约绑定账号、控制端连接、插件安装版本和页面实例。页面关闭或来源失效后，
  旧响应不能修改状态；原生弹层覆盖页面时暂停页面业务操作。
- BroadcastChannel 仅桥接声明频道，每条 JSON 最多 48 KiB；Host 覆盖消息的 `mobilePageId`。
  作者显式传递来源，不得保存“最近手机”全局值。未知写入回执按原 requestId 查询，不自动重发。
- 内部返回、动态标题、主题、前后台及隔离草稿由页面桥接支持。静态资源按文件身份读取，
  整页最多 64 MiB；Library 分块固定版本，媒体按已有归属账本读取固定大小块。

## 原生交互与普通任务

- confirm 由手机原生确认，关闭、遮挡、过期或撤权均拒绝；notify 只发送给来源页面。
  badge 沿用 boolean + summary，未引入计数字段。只有实际展示 panel 才按观察版本清未读。
  作者用 `cindyMobile.onUnread(version => …)` 捕获版本，读取并呈现内容后调用
  `cindyMobile.contentRendered(version)`；宿主校验当前可见页面与版本，下一帧提交回执。
  页面加载和轮询本身不确认已读；读取失败不回报，前台恢复时重新呈现再回报。
- 任务卡从已保存且净化的 HTML 投影动作，手机不执行卡片脚本；提交复核卡片版本、归属和真实点击。
- 新建任务复用普通创建页面，选择已有任务复用原生选择器，仅预填使用文字，用户发送后执行。
  iOS 已有任务选择器使用系统 sheet + SwiftUI plain List，无分组卡片；搜索 TextField 固定在标题下，
  输入、清空、无匹配与键盘提交均消费真实任务数据。选择等待原生 onDismiss 后导航，取消或归属变化丢弃待选项。
  workspace 打开对应普通任务；任务能力批准和写权限仍沿用 Host 校验、确认与回滚链。
- `cindy.tasks` 与统一任务接口共用创建、继续、结果查询、模型目录和改模型能力。
  任务设置复用 `pluginTaskPrefsStore` 和 `validatePluginTaskConfig`，保留旧偏好及私有工作目录。
- 目录由原生选择器确认；schedule 打开普通自动化草稿，支持每天、工作日、间隔和自定义 Cron，
  使用统一模型选择器，只有用户保存才创建。旧内置模拟器跳转已下线；收到旧客户端的该类消息时，显示通用不支持提示。
- 图片进入原生图片查看器；视频进入已有媒体播放器并提供原生分享。外部预览沿用 Host URL 白名单。
  电脑 localhost 预览固定获批 origin，资源分块经设备互联交给现有本机预览服务器。
  当前本机预览服务器仅支持 GET/HEAD，不支持 POST/WebSocket/HMR；不能宣称任意开发服务器完全可用。

## 配置与授权

手机原生表单负责密钥、设备码和可远程完成的浏览器授权；PKCE/电脑 loopback 场景明确返回电脑操作。
加密复用 v3 Host 授权协议，使用 X25519、Ed25519、HKDF 与 Expo AES。
执行电脑身份固定在 SecureStore，换钥拒绝；来源变化或未知提交结果不静默重试。
凭证不进入插件页面或普通桥接；表单关闭清空临时输入。

## 实现位置与作者约束

- `packages/device-link/src/pluginPages.ts`：远程资源和页面类型。
- `apps/desktop/src/main/cindy-brain/mobilePageService.ts`：页面租约、原生意图、来源校验与回执。
- `apps/desktop/src/main/cindy-brain/mobilePageAssets.ts`：包内资源；`mobilePreview.ts`：电脑预览。
- `apps/desktop/src/main/cindy-brain/runtime/mobilePageRelay.ts`：原逻辑页频道桥接。
- `apps/mobile/src/plugins/`：目录、页面、配置、任务设置和原生交互。
- `apps/desktop/src/main/cindy-brain/forge.ts`：插件作者公开契约。

修改 `pluginPageBootstrap.ts` 后运行 `node scripts/generate-mobile-plugin-bootstrap.mjs`，
检查时加 `--check`。预生成脚本避免依赖 Hermes 的函数源码序列化。
作者必须提供真正可触屏使用的布局及 Light/Dark，保存业务去重记录和草稿；添加声明不代表完成适配。
模块动态加载、键盘、返回和前后台行为需要在目标平台验证。

## 详情状态与旧端兼容

plugin-capabilities.data.usage 为可选摘要，复用宿主 getGhostSetupAssessment，只传就绪状态
与缺失/过期项目名称；保留组内 any-of 选项，不传配置值、动作授权或凭证。批准记录异常、
下线、运行崩溃/熔断与停用分开呈现；运行 off 是正常按需启动，不算错误。
离线/未加载/读取失败时不提供任务使用或设置写入。旧宿主缺少 usage 时保留原任务入口，
不宣称配置已验证；新宿主判定异常显示未知并只重读，不自动重新执行写入。
详情配置恢复入口提示在电脑端完成；任务内既有 Setup 卡流程不变。
DEV visual mock 可用 cindy://plugins?preview=<fixture-id>[-settings] 定位演示状态，
只在显式 visual mock 下生效，不选择真实已装插件。

## 验证边界

直接相关用例覆盖页面/控制端隔离、确认与未读、资源替换、任务归属、模型配置、卡片动作、
原生授权密码学互通和身份固定，以及移动桥接脚本、预览查询和媒体临时文件回收。
浏览器模拟宿主、JSDOM、原生边界 mock 和局部类型检查均不能替代手机实机验收。
验收按各 PR 的当前提交记录，不能沿用历史接入时的未验证结论。
[已装插件页面验收](../design-evidence/2026-10-09/mobile-installed-plugins.md)记录了
iOS 原生构建、Metro 与真实 PocketMind 数据，以及 Android Debug 包的 Demo 验收。
最新 iOS 原生包重复目检为 Light；Dark 证据来自主干同步前。Android 真实账号联动、
iPad、旧 iOS、VoiceOver，以及真实启停期间的断线恢复尚未实测。
启停与回读竞态另有定向回归，不能替代运行验收；完整单测门禁由 PR CI 执行。

## 兼容、冷更与回退

现有插件不需要重装、重新批准或重配凭证；mobile 为可选扩展，新增远程集合由能力协商发现。
插件批准格式、安装布局、旧任务偏好文件和 Library 数据未迁移。插件基座改动合并前需白名单明确批准。

历史移动插件接入新增纯 JavaScript `@noble/curves@1.9.7`，复用现有 Expo 随机数与 AES，
未新增原生模块，但当时依赖变更改变了 runtime fingerprint，需要冷更与指定把关人明确批准。
iOS 指纹从 `d8cd3b87cb7dcf418004eeb36b0ff1b8f29a44c7` 变为
`25a5a753aaf7740670f9588e976b4770b0817999`；Android 从
`c2eb49bea3303f89edf8de95af3a0cf45179faca` 变为 `d1d89bd866a64c681f3ded59075536abccb84c9a`。
这些指纹记录属于历史接入，不能作为后续页面调整的冷更判据。已装插件页面调整 PR #5730
未修改原生配置、依赖或 runtime fingerprint 输入；本地重建用于匹配现有基线，不代表新增冷更。
发布仍按实际构建与目标 runtime 核对兼容性，不向不匹配的旧 runtime 投送 OTA。
回退客户端代码即可撤销移动入口；不删除插件数据。
