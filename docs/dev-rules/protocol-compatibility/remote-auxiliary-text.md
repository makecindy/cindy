# 同账号电脑的辅助短文本

辅助模型自定义链可以保存同账号另一台电脑的精确来源。目录、设备栏、可见性与缓存复用 `maker:provider:list` / `ModelSelector`；执行端用原有 `buildTextOneshotPinOptions(..., 'auxiliary')` 生成可执行路线身份。显示目录在隧道中已剥离路由字段，不能据它重新推导 HTTP 能力或把执行端凭据传给控制端。

`maker:utility-text:v1` 是新增的同账号 invoke 通道，版本为 1，支持 `caps`、`run`、`cancel`。不加入共享任务或供应商分享的访客白名单；供应商组和 SSH 不在本次能力范围内。继续要求远控开启、调用电脑未被撤权、模型使用未被关闭、供应商对自己的电脑开放。`caps` 返回执行端本次实例的 `hostEpoch` 和获准的精确 `(providerId, agentKind, model)`，不返回地址或凭据；`run` 带该代次、操作 ID、精确路线、文本及可序列化选项。执行端仍在实际派发前检查目录、停用、凭据与授权；展示快照不是许可。

执行只复用 `requestExplicitUtilityText`，不递归调用执行电脑的默认辅助链，不启动 Agent 或工具循环。业务输出与 `validateResponse` 由发起端接纳后交原调用方保存。systemPrompt 与参考文本保持分开，不传回调函数；v1 一次返回完整文本，不提供流式 token 事件。请求、响应和选项的类型、字节及数值限制由 `packages/device-link/src/remoteUtilityText.ts` 的 parser 定义。

取消复用现有父信号和 `requestUtilityTextWithinTimeout`，并以取消操作终止执行端 HTTP。执行端只保存短期在途取消登记，不建第二套结果缓存。传输重发、同 envelope ID 去重、结果缓存、背压与 outbox 全部沿用 Device Link；再次调用公开 invoke 会生成新 envelope ID，所以结果未知不自动重放推理。上游可能已经计费，取消不是退款保证。失效检查同时覆盖派发和 outbox 最终发回，撤权后恢复不使旧结果重新有效。

保存格式仍为 owner 范围辅助设置中的 `models: string[]`，最多三项，沿用 `cat:` 外壳；保留 provider 命名空间 `cindy-remote-aux://v1/<device>/<provider>` 携带位置。内部各段与外层 provider 分别 URI 编码；不是 URL，不用于访问任意 endpoint。新版本遇到保留命名空间的未知版本／损坏内容只保留为不可用，不能剥掉设备后访问本机同名来源。继续遵守旧 768 字符引用与 4 KiB 文件上限，恢复自动仍清空原列表。

兼容行为：

- 新发起端遇到旧执行端：`caps` 收到 `CHANNEL_NOT_ALLOWED`，不发送 prompt，保留选择并显示不支持；只继续用户明确保存的备选。
- 旧发起端连接新执行端：旧接口和对话远程模型行为不变。
- 基线 `models + cat:` 版本读取新引用：保留并显示不可用；普通 custom 短文本不会改走自动链。更早版本不在此保证范围。
- 旧版插件正式任务在辅助候选不可用后可能改用新任务默认模型，该行为不能靠新引用编码修复。新版显式保留远程辅助引用的任务位置，远程链用尽时不静默换成本机默认来源。
- BYOK 语音润色仍受原 transport 映射约束，不新增远程润色通道；普通辅助短文本的词典学习可使用新来源。

不创建 Cindy Session、消息、原生 Agent 历史、影子工作区或记忆写入。原显式执行器的凭据刷新、兼容缓存、托管本地模型启动及供应商计费保持原规则，不伪造会话 token 用量。日志不记录 prompt、回答和鉴权材料。

故障半径：一笔请求超时、取消或一台模型电脑不可用，只使本候选结束并按用户既有辅助链决定后续，不重建共享 relay、不影响其他电脑；明确撤权和退出使对应在途及迟到结果失效。协议复用原有加密 invoke 信封，不新增 relay frame 或服务端业务接口，自建中转应透明转发。验证必须包括 Device Link、relay、interop 与短文本调用定向回归，未实测双电脑的部分在 PR 中说明。

实现入口：`shared/remoteAuxiliaryModelRef.ts`、`main/utility-model/remote/`、`main/device-link/dispatch.ts`。回归入口：Device Link `remoteUtilityText.test.ts`，Desktop `remote/__tests__/host.test.ts`、`client.test.ts`、`providerShareDispatch.test.ts`、辅助模型设置与选择器回归。
