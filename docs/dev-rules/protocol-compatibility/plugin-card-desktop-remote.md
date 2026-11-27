# 电脑端远程任务的插件卡片（`plugin-card-html`）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

电脑端打开另一台电脑上的任务时，插件卡片（含 PR 卡片与标题栏 PR 跟进卡片）与本机任务显示和操作一致。
卡片仍只存在任务所在电脑，插件也只在那里运行；控制端不需要安装同一插件。

## 读取

控制端读取既有 `plugin-results` 卡片资源时，在 `client.primitives` 里声明
`plugin-card-actions`、`plugin-card-forms` 与新的 `plugin-card-html`。只有声明了 `plugin-card-html`
的读者，宿主才在 `plugin-card-actions` 的 `data` 里附带可选 `card: { html, height, externalLinks }`：
`html` 是宿主卡片库里已净化的原样内容，`externalLinks` 是任务所在电脑上该插件的外链声明。
邮件卡依赖宿主专用标记，不附带 `card`。控制端主进程收到后用本机净化器再净化一遍，
不信任对方的净化结果；失败按无卡处理，带邮件标记的 HTML 一律不接受。PR 状态位、只在 PR 开着时显示的部分和归档按钮由
控制端按标题栏同源状态填写，与本机卡片同一套逻辑。

旧宿主忽略这个 primitive，回包里没有 `card`：控制端记下这台电脑不支持，本次运行内不再为它读卡，
任务保持原来的工具行。手机不声明它，回包不变。卡片更新沿用既有 `maker:remote-resources:changed`
（`sessions` topic 常驻订阅）；控制端只重读已显示的卡和它下方新出现的衍生卡（`<root>::sp…`）。
读取先检查 Device Link 的 `{ ok, result }` 信封；传输失败可稍后重读，不当作旧宿主。
变化通知在读取中到达时合并为一次补读，不丢最后版本。任务消息流与标题栏预览按会话登记显示生命周期，
最后一个视图关闭后不再因通知读取，重新显示时刷新已知卡片。
插件名与图标读既有 `plugin-identities` 资源。

## 邮件卡

邮件卡不传 HTML。宿主早已在 `plugin-card-actions` 里给手机附带校验过的 `mail`（`MailCardData`）与
`mailUpload`；控制端主进程用 `parseMailCard` 再校验一遍，然后用与任务所在电脑相同的
`renderMailCard` 在本机重建卡片，宿主标记只由本机产生。`legacyMail` 与校验失败按无卡处理，
任务保持工具行。编辑自动保存、发送／撤销／立即发送、删除与「继续」都走下文同一条
`plugin-results` invoke（与手机相同的 `formChange`、`formValues`、`formKey`）；放大查看的侧栏
同样从卡片库读这张远程卡，邮件链接解析出的草稿（`draftCallId`）也在远程任务里打开同一编辑器。

附件上传的本机 IPC 接收目标电脑 id，校验后用 `withAgentNetMediaTarget` 绑定既有加密媒体路由；
选择框打开期间关闭该电脑控制时仍拒绝上传。仅修改控制端本机 IPC，不改变中转 wire。

附件：宿主声明 `mailUpload` 时，控制端用本机文件选择器选文件，经现有附件中转上传（16 MiB），
只把带 size／SHA-256 的中转引用和文件名作为 `input.mailAttachment` 随 `mail:attach:<key>` 提交，
本机文件路径不出本机；本机 IPC `ghosts:card:remote-mail-attachment` 只在控制端进程内使用。
宿主未声明时不显示附件按钮。正文与附件预览里的图片（`cindy-media://blobs/…`）只在任务所在电脑，
控制端只为卡片数据里已校验的内容地址经既有 `cindy-remote-media://` 读取字节，转成 `data:` URL
交给邮件预览；字节经主进程的 `readImageBytes` 读取，不从 renderer fetch 自定义协议，
避免主窗口 `connect-src` 拦截。图片列表变化时由新 effect 读取当前集合，旧 effect 的迟到结果丢弃，
不保留会阻止补读的 requested 标记。保存的正文仍是 `cid:` 引用。插入内嵌图片按钮本就不出现在卡片上，远程不支持。

只需控制端升级：支持手机邮件卡的宿主已经提供上述数据与动作，不新增 wire 字段。

## 操作

点击沿用手机的路径：先对该插件 `open-interaction` 取交互页租约（空闲 90 秒内复用，宿主 120 秒回收），
再以既有 `plugin-results` invoke 带 `revision`、`pageId`、`prompt`、`formValues`、`formChange`
提交；表单提交另带既有 `formKey`。invoke 的 `input` 增加可选 `modelSelection`，形状同
`GhostCardModelSelection`，`agentDeviceId` 以任务所在电脑为准（省略 = 那台电脑）。宿主拒绝与
`formChange` 或邮件附件同时出现、形状不合法的选择；分发器对远程页面与本机一样，只接受声明了
`data-ghost-model-select` 的按钮和当前可用的模型。控制端在选择器里按本机视角显示，提交前换算：
本机 ↔ 控制端自己的 deviceId，任务所在电脑 ↔ 省略。点击被拒（版本过期、租约失效）时控制端重读
该卡并在下次点击时重开租约，不自动重放。

点击后 20 秒内（有待答请求时延长到其过期时间）控制端每秒 `poll` 该页面，把插件发起的确认框与
选模型请求（`confirms`、`modelPickers`）在本机显示，用既有 `answer` / `answer-model-picker` 回答；
同一张卡同时出现在任务页和标题栏时只由一处回答。模型被宿主拒绝时重新打开选择器；
领取请求的视图卸载时，以既有回答入口取消模型请求或拒绝确认，不让请求一直占着等到超时。

## 兼容与中转

不新增 channel、IPC 白名单、握手、topic、relay 字段或数据库迁移；控制端新增的本机 IPC
`ghosts:card:get-remote` 只在控制端进程内使用。旧控制端不声明 primitive、不带 `modelSelection`，
行为不变；新控制端连旧宿主时任务保持工具行。官方与自建中转都只透传既有 remote-resource 请求，
自建中转无需修改。需要任务所在电脑和控制端都升级才生效。

回归入口：`cardRemoteResource.test.ts`、`cardActionDispatch.test.ts`、`remoteCardFetch.test.ts`、
`remoteMailAttachment.test.ts`、`ghostCardRemote.test.ts`、`RemoteCardPrompt.test.tsx`、`MailPreview.test.tsx`。
