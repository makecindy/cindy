# 电脑端远程任务的插件卡片（`plugin-card-html`）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

电脑端打开另一台电脑上的任务时，插件卡片（含 PR 卡片与标题栏 PR 跟进卡片）与本机任务显示和操作一致。
卡片仍只存在任务所在电脑，插件也只在那里运行；控制端不需要安装同一插件。

## 读取

控制端读取既有 `plugin-results` 卡片资源时，在 `client.primitives` 里声明
`plugin-card-actions`、`plugin-card-forms` 与新的 `plugin-card-html`。只有声明了 `plugin-card-html`
的读者，宿主才在 `plugin-card-actions` 的 `data` 里附带可选 `card: { html, height, externalLinks }`：
`html` 是宿主卡片库里已净化的原样内容，`externalLinks` 是任务所在电脑上该插件的外链声明。
邮件卡依赖宿主专用标记，不附带 `card`，保留现有投影。控制端主进程收到后用本机净化器再净化一遍，
不信任对方的净化结果；失败或邮件卡按无卡处理。PR 状态位、只在 PR 开着时显示的部分和归档按钮由
控制端按标题栏同源状态填写，与本机卡片同一套逻辑。

旧宿主忽略这个 primitive，回包里没有 `card`：控制端记下这台电脑不支持，本次运行内不再为它读卡，
任务保持原来的工具行。手机不声明它，回包不变。卡片更新沿用既有 `maker:remote-resources:changed`
（`sessions` topic 常驻订阅）；控制端只重读已显示的卡和它下方新出现的衍生卡（`<root>::sp…`）。
读取先检查 Device Link 的 `{ ok, result }` 信封；传输失败可稍后重读，不当作旧宿主。
变化通知在读取中到达时合并为一次补读，不丢最后版本。任务消息流与标题栏预览按会话登记显示生命周期，
最后一个视图关闭后不再因通知读取，重新显示时刷新已知卡片。
插件名与图标读既有 `plugin-identities` 资源。

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
`ghostCardRemote.test.ts`、`RemoteCardPrompt.test.tsx`。
