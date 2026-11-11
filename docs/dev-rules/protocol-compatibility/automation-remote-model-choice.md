# 自动化的远程模型选择

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`Schedule` / 创建与更新输入增量增加可选 `modelAgentDeviceId`：缺省保持旧版绑定任务的位置继承，
空字符串表示自动化所在电脑，非空使用既有远程／分享 Agent 标识。SQLite 新增可空文本列，
SQL NULL 对应缺省；项目 `version: 1` 配置同样允许该字段，旧文件无需改写。
既有 `agentDeviceId` 仍只提供新建／重建任务的默认位置；绑定任务存在时继续跟随它的当前位置。
显式 `modelAgentDeviceId` 优先于该默认值（包括空字符串本机），仅查看或修改旧记录的非模型字段
不会将默认位置转换为显式覆盖。MCP 的旧 `agentDeviceId: "local"` 仍沿用原协议；从
`schedule_list_models` 选择本机并填写 `modelAgentDeviceId` 时使用空字符串，不使用 `"local"`。
绑定任务或持续模式的 Agent 自动化显式选本机时也须有 `modelAgentKind` 与 `model`；不完整选择在保存前拒绝，
不把“选本机”误作继承绑定任务的位置。更新可沿用已存的完整选择，恢复跟随时清除显式选择。
`maker:get-capabilities` 返回 `supportsScheduleAgentDeviceSelection: true`。
远程创建定时任务前，调用方还必须看到 `supportsRemoteScheduleDirectoryCheck: true`。旧端虽有 `maker:schedule:create`，但不会检查 `workingDir` 是否存在，因此缺此能力时必须在写入前返回 `REMOTE_UNSUPPORTED`，不能静默落库。
新调用方只有明确看到此能力才向其它电脑提交位置选择；旧端未知字段会被忽略，禁止静默降级。
跨电脑更新非空 `modelAgentKind` 时，即使省略位置以继承原位置，也必须先确认既有
`supportsScheduleModelSelection: true`；旧端不支持时在写入前拒绝。同时设置位置或清空模型
字段时，两项所需能力一起核验，复用一次能力查询及原有账号代次检查，不新增协议字段。
跨电脑 `schedule_update` 清空 `modelAgentDeviceId` / `modelAgentKind` / `model` / `providerId` /
`effort` 时，同样先核验此能力，再保留可序列化的 `null` 发送；接收端 IPC 转成带 key 的
`undefined` 后交给 Scheduler 与存储。省略字段仍是不修改，不在发送前丢掉清空意图。
旧调用方修改新自动化的非模型字段仍保留位置；修改模型路线却未携带已固定的位置时拒绝保存，
避免意外把另一台电脑的供应商当作本机来源。执行与恢复仍使用既有远程授权、目录与切换协议。
直接发送与排队派发在准备完成后，按实际运行位置、模型及供应商重新读取远程目录；来源或模型
已停用、离线或授权不可用时拒绝本次调用，排队项取消发送预留并失败收口，不回退到本机来源。
