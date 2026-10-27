## 5.1 移动端页面与操作来源（可选扩展）

在身份卡顶层声明 `mobile: { channels: ["practice-ui"], panel: "mobile/panel.html" }`。
`mainView` 和 `settings` 同样可指定包内 HTML；省略路径时复用原入口。
这些只是已有 `panel` / `mainView` / `settingsHtml` 的移动呈现，不能授予未声明的能力。
没有 mobile、字段不合法或旧宿主不支持时，原桌面安装、批准与使用保持不变。

页面经手机隔离 WebView 展示，业务逻辑仍在所选电脑原插件中执行：

- 仅桥接声明的 BroadcastChannel（最多 16 个），每条 JSON 消息至多 48 KiB。
  请求必须包含业务 requestId；保存、创建任务等写操作沿用同一个 requestId 查询/去重，
  超时不等于未执行，Host 不替作者盲目重发。
- 电脑逻辑页收到手机业务消息时，Host 附上不透明 `mobilePageId`（覆盖页面自报的值）。
  异步链显式保留它；confirm、notify、tasks、pick、workspace、preview、schedule 请求均原样附带。
  卡片动作消息也包含该字段。不要存为全局“最近手机”，也不能在后台复用过期来源。
- 示例：`const origin = msg.mobilePageId; const answer = await cindy.confirm({ body: "应用调整？", ...(origin ? { mobilePageId: origin } : {}) });`
  只有 `answer.ok && answer.confirmed` 才能继续；页面关闭、覆盖、超时或撤权均不能当成同意。
  普通确认不授予目录、账号、任务或文件权限；任务授权仍由专用 Host 校验链决定。
- notify 只交给来源页面；后台提醒用原 `badge` 能力。badge 是 boolean + summary，
  没有计数字段。目录、详情及 mainView 不清 panel 未读。panel 用
  `window.cindyMobile.onUnread(version => { /* 读取并呈现对应内容后调用 contentRendered(version) */ })`
  接收未读版本；读取失败、只收到轮询或页面加载完成都不能确认已读。
  `window.cindyMobile.contentRendered(version)` 在下一帧回报该版本，Host 复核可见性和版本。
  异步读取必须捕获开始时的 version，不得用读取结束时的新版本代替；前台恢复后重新呈现再回报。
- 包内静态资源按打开时的文件身份读取，整页资源最多 64 MiB。大媒体用归属明确的
  `/media/` 或 `/library/`；不要把课程/用户媒体打进页面启动包。
- 普通数据端点支持 `/kv`、`/app-context`、`/agent-models`、`/media-models`、`/gallery`。
  凭证、OAuth、连接不走页面 fetch 或业务频道，必须使用 Host 原生配置流程。
- 页面需自行完成触屏布局、Light/Dark 与草稿保存，不依赖桌面 localStorage 同步、Node、
  悬停或 Electron 桥。当前页面供片要求自包含的脚本/样式资源；模块动态加载须实际验收，
  不能只添加 mobile 字段就宣称已经完成移动适配。
- 打开普通任务使用 `cindy://sessions/<sessionId>` 链接，由手机 Host 确认并导航；
  此链接不赋予插件读取或控制该任务的权限。新建/继续/查询任务遵循 tasks 原有归属、版本与回执契约。
