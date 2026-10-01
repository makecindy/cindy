# 移动插件接入

手机通过设备互联使用执行电脑上的已装插件。插件业务逻辑、Library 和任务仍在电脑上；
手机提供入口、隔离页面及原生交互，不复制插件安装或另造任务类型。

## 入口与页面

- 主菜单提供插件入口和聚合未读点；目录按电脑展示，支持搜索、最近使用、未读筛选、详情和启停。
  宽屏目录与内容并列，样式使用 Light/Dark 语义 token，文案覆盖现有五种语言。
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
  workspace 打开对应普通任务；任务能力批准和写权限仍沿用 Host 校验、确认与回滚链。
- `cindy.tasks` 与统一任务接口共用创建、继续、结果查询、模型目录和改模型能力。
  任务设置复用 `pluginTaskPrefsStore` 和 `validatePluginTaskConfig`，保留旧偏好及私有工作目录。
- 目录由原生选择器确认；schedule 打开普通自动化草稿，支持每天、工作日、间隔和自定义 Cron，
  使用统一模型选择器，只有用户保存才创建。模拟器入口复用已有电脑控制能力，不授予额外输入权限。
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

## 验证边界

直接相关用例覆盖页面/控制端隔离、确认与未读、资源替换、任务归属、模型配置、卡片动作、
原生授权密码学互通和身份固定，以及移动桥接脚本、预览查询和媒体临时文件回收。
浏览器模拟宿主、JSDOM、原生边界 mock 和局部类型检查均不能替代手机实机验收。
本次未启动 Desktop DEV、Metro 或原生构建；iOS、Android、iPad 的键盘、系统浏览器返回、
断线恢复及 Light/Dark 实机视觉仍待验证。未执行整仓测试和整包构建，完整门禁交 CI。

## 兼容、冷更与回退

现有插件不需要重装、重新批准或重配凭证；mobile 为可选扩展，新增远程集合由能力协商发现。
插件批准格式、安装布局、旧任务偏好文件和 Library 数据未迁移。插件基座改动合并前需白名单明确批准。

新增纯 JavaScript `@noble/curves@1.9.7` 复用现有 Expo 随机数与 AES，未新增原生模块，
但依赖仍改变 runtime fingerprint，必须按冷更发布新安装包并由指定把关人明确批准。
iOS 指纹从 `d8cd3b87cb7dcf418004eeb36b0ff1b8f29a44c7` 变为
`25a5a753aaf7740670f9588e976b4770b0817999`；Android 从
`c2eb49bea3303f89edf8de95af3a0cf45179faca` 变为 `d1d89bd866a64c681f3ded59075536abccb84c9a`。
旧安装保持原能力，不向旧 runtime 投送本次 OTA。回退客户端代码即可撤销移动入口；不删除插件数据。
