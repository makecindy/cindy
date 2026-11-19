# Desktop A2UI 消息卡

## 版本与入口

Desktop 在助手正文的顶层 `a2ui` fenced block 中读取 JSON、JSON 数组或 NDJSON。
消息仍通过现有正文传输、保存和重放，不新增 IPC、服务器接口、独立服务或 AG-UI。
`cindy-ui` 保持原协议和渲染路径；它与官方 A2UI 不是同一种格式。

- 上游：[a2ui-project/a2ui](https://github.com/a2ui-project/a2ui)。
- 固定依赖：`@a2ui/react`、`@a2ui/web_core` 均为 `0.15.0`，wire `version` 为 `1.0`。
- 校验依据：这个 npm release 随包的 schema、严格模式 MessageProcessor 和组件图校验。
  不混用更新的仓库 schema；例如后续文档的 `@checks` 与本 release 不一致。
- `packages/a2ui-renderer` 隔离 SDK 的 Zod 3 依赖；Cindy 其他包继续使用 Zod 4。
- `get_capabilities` / `list_tools` 的 `a2ui-messages` 按需返回生产格式说明，
  不修改常驻 system prompt。

## 支持范围

使用 basic catalog 标识，初始目录只支持 Text、Image、AudioPlayer、Button、Column、
Row、Card、Divider、Tabs、TextField、ChoicePicker。不宣称支持完整官方 basic catalog。
官方 A2uiSurface、MessageProcessor、绑定和动作解析负责协议运行；组件的视觉实现使用
Cindy 的 Button、FormField、Input、Textarea、Markdown 和媒体入口，保持主题与权限边界。
不实例化会上改页面全局主题的上游 Lit 控件。

Tabs 用于段落浏览，TextField 的 `longText` 用于中文主旨和卡点。两者都有标准 schema，
无需为这两项另建协议组件。精确选区锚点、段落引用定位和自动生成朗读音频不在初始范围。
Row / Column 的 align、justify 生效，Row 在窄容器换行；weight 与 ChoicePicker 的
displayStyle 不改变宿主布局，宿主保留阅读宽度和换行策略。

每个 block 必须自行 createSurface，完整组件图以 `root` 为根；允许同 block 后续更新。
不同消息不能修改此前消息的 surface。闭合 fence 前仅显示 Markdown，不激活控件。
每 block 限制 128 KiB、256 条 envelope、递归深度 32 和 16000 个数据节点。
未知版本、组件、非法图或不支持的表达式显示提示与原文，普通 Markdown 不受影响。

## 提交、媒体与持久化

唯一发送事件是 `Button.action.event.name = "cindy.sendMessage"`。界面显示将要发送的
完整文本：`userMessage`，以及非空 context 的格式化 JSON。用户点击后，官方动作必须与
该按钮、预览文本和这次点击一致，才交给 SessionQuickSend；内容作为普通用户消息，沿用
当前任务的排队、只读判定和权限处理。输入或切段不会发送，不从描述调用工具或执行代码。
发送失败保留草稿并可重试，同一已接受文本在本设备禁用重复提交。

不开放自定义 catalog、函数 / RPC、checks、theme 或 `sendDataModel:true`。
图片和音频复用 Markdown 的媒体来源、协议及远端设备处理，不直接使用模型给出的 src
绕过宿主。AudioPlayer 仅播放已有音频，不生成 TTS，也不据此宣称已播放。

原始正文继续存入既有消息历史。`/draft` 和 Tabs 位置通过 RichInteractionMemory 保存在
本地查看状态中，按账号、任务、消息和控件隔离；200ms 合并写入，最多 256 项 / 512 KiB。
这不是学习进度。阅读进度和过关判定继续由原导师工具处理，卡片没有学习记录写接口。

## 发布与验证边界

只需升级 Desktop 消费端，不改变服务端或 Device Link wire 字段。旧 Desktop、原生 Mobile
和外部 IM 会显示 fenced source；生产者应在 block 外保留可读 Markdown，不能把桌面支持
推断成所有接收端支持。此处未实现 Mobile 原生渲染。

定向回归入口为 `A2uiAnswer.test.tsx`、既有 `RichAnswer.test.tsx` 和
`getCapabilitiesTool.test.ts`。组件测试使用官方 SDK，发送端是测试替身；它们不证明
真实模型调用、安装版已更新或导师学习闭环。实际宿主验证及其未覆盖范围应单独写入 PR。
