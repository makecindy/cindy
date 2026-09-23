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
