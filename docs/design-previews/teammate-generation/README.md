# 伙伴连接与生成状态：组件证据

本次统一三件事：头像圆点只表示连接可达性；伙伴正文没有工作过程入口；列表忙时显示与输入框同源的公开生成状态，空闲时恢复消息摘要。

## 前后对照

栅格截图按设计治理规范保存在本任务交付材料中，不写入 Git 历史。当前尚无公开 PR 图片附件链接；可使用本目录脚本重现。共十六张 PNG（含追加的压缩场景）：`desktop-before/after-light/dark.png`、`mobile-before/after-light/dark.png`，对应压缩场景文件在 `.png` 前加 `-compacting`。

## 证据边界

这些是 headless Chromium 中的**真实组件 fixture**，不是正式安装版截图，也不是 iOS / Android 实机验收。修改前基线为 `73ae8eaf3772d50173cf5c0aa63666b9d0482e01`。

- Desktop 使用真实 `CindyDeviceRow`、`BotConnectionStatus`、`BotWorkingStatus`、`WorkingStatusText`、`WorkGroupBlock` 及伙伴消息投影。主题使用真实 Default Light / Dark tokens。外层窗口、输入框容器和示例消息为夹具。
- Mobile 使用真实 `TeammateList`、`RemoteCompanionAvatar`、`CompanionWorkingStatus`、`AppText` 和主题，通过 React Native Web 渲染。外层手机框、输入框容器和连接状态为夹具，不能证明原生导航、键盘或字号度量。
- 活动、登录和网络服务均为离线注入，不读取私人聊天，不调用生成模型。截图中的文案是公开阶段默认文案；宿主缓存复用和迟到结果丢弃另由测试验证。
- 已目检两端 Light / Dark 图片：桌面移除重复过程入口并保留输入框状态；列表在线运行保持绿点，移动列表显示公开阶段，已知离线为红点。
- 真实双设备连接、断连恢复、存量安装升级、iOS / Android 聊天实机仍需在发版验收时检查。本次未重启、发布或替换正式应用。

## 行为验证矩阵

| 场景 | Desktop 本地 | Desktop 远程 | Mobile |
| --- | --- | --- | --- |
| 在线且生成 | 连接绿点 + 公开状态；组件/状态机回归 | 宿主资源阶段 + 同一润色缓存；契约回归 | 列表公开状态 + 绿点；真实组件测试 |
| 在线空闲 / 模型错误 | 连接色不随运行或错误改变；最终摘要/错误保留 | API 失败不伪造断线；连接回归 | 连接与列表操作可用性分离；组件回归 |
| 真正离线 / 未知 | 本地不伪造离线 | 已知离线红、未确认中性色；连接回归 | 已知离线红、未知中性色；连接回归 |
| 运行结束 | 主机撤掉瞬时状态；终态回归 | 资源失效重读撤状态；契约回归 | 沿宿主终态，聊天标签停止；投影回归 |
| 最终答复 / 附件 / 无最终答复 | 消息投影保留结果、授权与错误；中止保留有用末段 | 复用桌面消息投影 | 实际 normalize/render 链保留结果与中止末段 |
| 未打开聊天 | 主进程活动源持续更新 | 资源列表不依赖已加载消息 | 列表读取宿主生成状态 |

普通任务视图和持久消息不受正文过滤影响。字段为可选增量；旧主机仍能聊天，但列表状态需要主机与控制端都升级。服务端、原生 fingerprint、权限边界均无变更。协议说明见 [兼容合同](../../dev-rules/protocol-compatibility.md#伙伴公开生成状态)。

## 重现材料

[Desktop 夹具](fixtures/desktop-teammate-fixture.tsx)、[Mobile 夹具](fixtures/mobile-teammate-fixture.tsx) 与截图脚本保留在本目录，均不进入应用构建。安装仓库依赖和 Playwright Chromium 后，在仓库根执行：

```sh
node docs/design-previews/teammate-generation/fixtures/capture-teammate-components.cjs
node docs/design-previews/teammate-generation/fixtures/capture-mobile-components.cjs
```

中间 bundle 写入忽略的 `tmp/teammate-generation-components`，PNG 写入 `tmp/teammate-generation-evidence/`。脚本将修改前模块固定为上述基线，不会因后续提交而悄悄更换对照。


## 对话整理（上下文压缩）补充

三种运行时均已有真实事件：Claude/Codex 发 `status: Compacting...`，Pi 发 `status: Compacting context…`；成功后发 `compact_boundary`。本次在宿主公共阶段中识别它们，优先于前一个工具结果和旧消息，发布 `compacting`。边界回到思考，后续文本回到回复；停止/错误撤下生成状态，新一轮重新开始。后台手动压缩不伪造前台生成轮。

五语言的列表和输入框使用同一固定本地化文案（简中“正在整理对话…”），不为压缩调用润色模型。既有 1 秒文字切换节奏和 alpha 动画保持；晚到的旧润色结果因阶段变化丢弃。状态机、远程列表、Desktop 真实组件和 Mobile hook 测试覆盖开始、结束、恢复、停止、失败和缓存残留。新增图片仍为离线真实组件 fixture，不是新正式版或手机实机截图。

## 手机主时间线对齐补充

以 `235c3953e3afb60447a29a692d5a3b23e28bcd53` 为对照基线，修复手机正文开关依赖异步资源详情的问题：
已确认 `source=bot` 的任务在详情暂缺、普通任务路由进入及刷新时继续使用伙伴正文投影；未知任务不提前过滤。
手机资源读取传入查看端 locale，同一 revision 切语言后仍应用新投影。
私聊记录与打开路径保留，入口改为与 Desktop 一致的发送方向，不在主时间线打印私聊摘要。
完成结果回执视为交付，避免恢复它前面的无终态旁白。

新增重现入口：

```sh
node docs/design-previews/teammate-generation/fixtures/capture-mobile-conversation.cjs
node docs/design-previews/teammate-generation/fixtures/capture-desktop-conversation.cjs
```

PNG 位于忽略的 `tmp/teammate-generation-evidence/`：`mobile-chat-before/after-light/dark.png` 与
`desktop-chat-reference-light/dark.png`。手机图使用真实私聊组件、主题和消息 normalize/render/projection，
外层导航、正文文本容器、输入框和修改前的工作行是 fixture；前图模拟“已知伙伴但资源详情未到”的真实入口条件。
桌面参考使用当前真实 `BotDirectMessageCard` 与主题，Desktop 本次没有视觉修改。全部内容为合成数据。
这些图片已按 Light/Dark 目检；不代表 iPhone、Android 或双设备实机验收，也不证明任一安装包已收到修复。

通用消息封口由宿主为 Claude Code、Codex 和 Pi 写入，手机不按引擎另造过滤规则；回归覆盖完成标记、无价格用量封口、
实时/历史、附件、问题、错误和结果回执。桌面对应投影、私聊路由、结果卡与润色状态测试作为语义参照。
原有一秒文案节奏与 alpha 实现未修改；公开阶段沿既有 `workingPhase`/压缩状态传递，旧端保持本地化阶段兜底。

## 手机状态节奏、位置与对话卡片补齐

以 `f5d296df49015be48e117ed689e5b2c3095cbf58` 为基线核对时，手机生成状态仍直接替换文字、放在消息列表尾部，
并在普通任务入口缺少伙伴 ID 时只能显示默认阶段词；上文“保留一秒 / alpha”只描述了 Desktop。本次补齐：

- 手机新增与 Desktop `WorkingStatusText` 同节奏的文字组件：至少停留 1 秒，按 `motionDuration.fast` 淡出再淡入，
  期间多次变化只呈现最新文案；系统“减弱动态效果”开启或尚未读到偏好时直接切换。输入框上方状态与列表行共用它。
- 状态移到输入框上方的固定状态位（Desktop `BotWorkingStatus` 位置），阅读历史时仍可见；带伙伴头像、转圈与文案。
  交互面板出现时让位给面板，终态立即撤下。
- 路由没有伙伴资源（普通任务链接、通知等入口）时，从账号隔离的名册缓存按对话链接找回伙伴 ID，只用于读取
  `working:<botId>/<phase>` 公开文案，不作为权限或可用性依据。连接恢复后对尚未拿到润色的同一轮次、同一阶段
  有界重读一次；已拿到的文案不重复请求。
- 对话呈现对齐 Desktop：伙伴回复带头像、五分钟时间分组（纯函数移至 `@cindy/maker-shared/botTimeline`，
  Desktop 原路径继续再导出）、持久“已自动继续”分隔卡在伙伴视图隐藏（运行中的重连卡保留）、消息菜单去掉分叉与用量、
  权限卡以“{名字} 想请你确认一下”和伙伴头像呈现；后台任务卡的状态文案、状态色点、首次读取前的“正在开始”、
  标题兜底、补充消息与过期提示图标与 Desktop 一致；执行结果展开后用对话的 Markdown 渲染，文件与图片按子任务
  目录解析；伙伴私聊只读页改为左右气泡、头像与时间，含空态和上限提示；入口私聊痕迹显示对方头像与当前名字。
- 伙伴列表：离线时继续显示已缓存的最近回复，预览为空时依次回落到简介和“开始对话”，需要处理时显示警示图标。

证据边界：均为离线真实组件与生产函数测试（jsdom / React Native 平台壳注入），未启动 iOS / Android 实机、未做
Light / Dark 实机目检；视觉颜色全部使用既有语义 token。发布到手机仍取决于对应 runtime 的 OTA 或整包。
