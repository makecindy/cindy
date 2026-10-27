## 4.2 Agent 在途网络与 workdir 操作

当 `onHostMessage` 收到 `tool-call` 时，主机下发的 `msg.callId` 是本次
Agent 调用的严格在途凭证。它已绑定真实插件和当前会话，外层
`ghost_call` 由 Cindy 现有 Agent 授权系统处理。因此本次调用里的普通
HTTPS 和 workdir 写入不需要再声明 `network` 或 `fs`。

对应 tool 的 `description` 必须写清实际会执行的命令类别、联网目标／用途和
文件副作用；这段描述就是 Agent 与用户决定是否调用该插件工具时看到的授权契约，
不能用「处理数据」之类模糊文案隐藏真实操作。

`callId` 必须在交卷前使用；不得持久化、不得交给 Panel，也不能用在订阅、
后台或 scheduler 调用。主机会反查这些条件，不信任插件自报。

普通 HTTPS 使用 `cindy.fetch({ callId: msg.callId, ... })`，workdir 写入使用
`cindy.fs({ root:'workdir', callId: msg.callId, ... })`；具体参数见 §4.7 和 §4.10。

CLI 执行机制不在本次协议中另开通道：需要随包代码或 CLI 时继续使用 §4.12
的 Node 工作进程。顶层 `node` 字段描述插件的运行形态；具体命令不需要客户端
预登记，当前工具是否运行仍由外层 `ghost_call` 的 Agent 授权决定。
