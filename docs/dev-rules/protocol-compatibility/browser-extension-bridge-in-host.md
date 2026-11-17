# 浏览器扩展桥接迁入宿主

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

随包浏览器扩展的本机桥接从插件自带的 Node 接线进程迁入宿主（`main/browser-extension/bridge.ts`）。
线协议 `cindy-browser-extension/3`（协议号 3、签名线合同 0.4.13、回环端口 18810–18819、
`/health` `/poll` `/ack` `/authorize` `/result` `/learning/*` `/native/bind`）逐字不变：已装的
扩展 0.3.x / 0.4.x 不用更新即可连到宿主；`/health` 的 `plugin` 字段改为声明插件的 id（Cindy
Chrome 仍是 `my-browser`）。Native Messaging 的注册文件布局（`<App Support>/Cindy/browser-native/`
与各浏览器 profile 的 `NativeMessagingHosts/<name>.json`）与插件时期相同，已配对用户升级后无需
重新配对。

宿主只在已装、启用且 v3 清单声明 `browserExtension` 的插件存在时启动桥接；旧版插件不声明，宿主
不占端口，插件自带接线进程照旧工作，用户升级宿主不会断连。插件新版声明后由宿主接线，插件停止
自带监听，交错更新期间两边都写同一份 Native Messaging 清单。管子新增上行 `browser-extension-request`
与下行事件 `browser-extension-relay`；旧宿主对未知上行类型返回错误，插件须按运行时能力探测降级到
自带接线进程，不得把拒绝当作已连接。Browser Use 的 `BackendKind` 新增 `user-browser`：旧设置文件
的 `kind` 原样读取，未知值仍回落 `external`；回退旧版本时该值被当作默认处理，不丢其它偏好。

站点名单已取消（2026-10-30）：线上的 `policy` 字段保留，宿主在 `/ack`、`/authorize` 与 `setPolicy`
应答里恒给「全部允许」，旧扩展照常解析；旧插件推送的 `setPolicy` 应答成功但不生效；宿主缓存文件
只保存配对，旧版本存下的名单读到即忽略。事件 `browser-extension-policy-request` 沿用原名，现在只
在没有配对缓存时用来索要配对。

Native Messaging 临时注册失败由宿主按 5 秒、15 秒、30 秒、1 分钟、2 分钟、5 分钟退避，
之后保持每 5 分钟重试，不依赖打开插件面板或点击刷新。注册冲突、路径安全校验失败及
确认插件自带程序缺失时停止自动重试；通用 `ENOENT`、`EPERM` 等错误不直接判为永久失败。
停用后重新启用、更新安装或明确选择激活时重新尝试；自动恢复不会替用户接管其他注册。
自动重试与既有状态请求的恢复共用同一个在途安装和退避，状态查询不能提前重试，成功后停止计时。
重试前复核账号、插件安装版本、批准和启用状态，停用／卸载／更新／退出时取消旧实例的重试，
在途安装结束后才撤销注册。自动恢复不请求接管其他插件的注册，不改变配对、授权或线协议。
实现与回归见 `browserExtensionSlot.ts` 及其同名单测。

侧边栏模型选择器（2026-11-17，未发布）：`/learning/start` 的转交白名单新增 `models`（只读模型目录与
收藏、最近使用）和 `model-favorite`（收藏的增删改，形状同 `ModelFavoriteMutation`）；
`conversation` 在 `scenario: 'webpage-chat'` 时可带 `route`（只限本机，不含 `agentDeviceId`），
宿主按插件 learning-core 的同一判据校验后原样转交，插件与执行前的路由核验仍各自再查一次。
旧宿主对这两类请求返回 400 `INVALID_OPERATION`，并丢弃 `route` 字段：扩展侧须把前者显示为
「需要更新 Cindy」，不得当作空名单；旧宿主上网页问答回到插件默认模型，扩展线协议版本不变。
实现见 `main/browser-extension/relay-protocol.ts`，回归见 `bridge.test.ts`。

侧边栏流式回答（2026-11-17，未发布）：插件经管子 `relayProgress` 上报的进度在阶段属于白名单时
可另带 `text`（到目前为止的部分回答，≤32768 个 UTF-16 字符；超长整段丢弃、不截断，阶段照常
更新）；每次上报整体替换，`/learning/result` 未完成时返回 `progress: {stage, …, text?}`。
未知阶段仍整条忽略，结果大小上限不变。旧扩展忽略多出的字段，旧插件不发送，旧宿主丢弃该字段，
扩展只显示阶段；线协议版本不变。插件侧来源为 `tasks.getRun().preview`（见
[插件任务流式预览](plugin-task-run-preview.md)）。实现见 `bridge.ts` `relayProgress`，回归见
`bridge.test.ts`。
