# 伙伴群聊成员操作与发送错误（#5604–#5606）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`bot-group-chat` 数据追加可选 `supportsMemberRemoval`；仅为 true 时手机调用
`remove-member({ actorId })`，主机复用现有 Chat Server 单成员 remove 与管理权限校验。
成员投影中的 actorId/actorKind 在手机保留，真人不作为分工负责人/步骤候选；缺字段的
旧本地伙伴保持原行为。旧手机继续用 `set-members`，新主机只校验其中新增的本机伙伴，
不丢弃既有真人/外来伙伴 ID。新版手机连旧主机时不调用新动作，伙伴管理沿用旧入口；
真人移出需升级主机，不能用整份伙伴名单差分假报成功。

群错误仍以稳定码作为 Remote Resource 错误 message，新增附件、鉴权、群服务不可达、
历史迁移、权限、归档及结果未确认等分类；新版双端本地化，旧端遇到未知码保留原通用失败提示。
不透传服务器正文或异常文本。仅群 send 的 invoke 预算增加到 180 秒，不改变其他动作、
共享连接、自动重试或授权。超时不能证明操作未执行，重试沿用 clientId；当前账号主机进程
合并相同在途请求并缓存最近成功回执，服务器 operationId 仍是最终幂等依据。
不新增 IPC channel、数据库迁移或 Mobile 原生指纹输入。

## 主人移出自己的伙伴

Desktop 与手机直连把本人拥有的个人伙伴移出映射到既有的成员 `leave`：
`POST /conversations/:id/members` 的 `actorId` 与 `X-Chat-Actor` 均为该伙伴，
`action: "leave"`。Desktop 在最新群快照检查 joined bot 的 `ownerActorId`，手机在已核实的
群快照检查 `isOwned`；服务端仍以登录账号独立校验 actor 归属与成员身份，邀请记录不授予权限。
公共 Cindy 使用既有群开关；他人成员的移出保持原管理权限与 `remove`，不扩大管理范围。

新版 Host 的现有群投影追加可选 `supportsOwnBotRemoval: true`；新版手机只有看到该标志才在
经电脑路径展示自己伙伴的设置页和移出入口，旧 Host 缺失时隐藏新增入口，原管理员移出不变。
旧手机忽略新字段。复用现有 `remove-member({ actorId })`，不增加 Device Link 消息类型；
自建中转继续透传原资源请求与 opaque 投影，无需升级。没有原生配置、指纹或数据库变更。
服务端 main/release 的现有 leave 合同支持此调用，具体部署与双端实机仍需独立核验。

移出前二次确认；当前快照有该伙伴的活跃群请求时说明停止影响并使用「停止并移出」。
成员退出由服务端结算该群该伙伴的执行。退出后的心跳会先因成员校验返回
`CONVERSATION_NOT_FOUND`，宿主在该明确拒绝下按 execution 的 `clientId` 精确停止普通任务里的群输入；
其它租约失效与销毁仍保留既有规则。复用成员变化触发的租约检查与心跳兜底，不新增轮询或请求。
不删除历史，不影响伙伴本体、
其它群、私聊与已独立开启的普通任务。失败留在原页可重试，旧响应沿账号／设置页生命周期保护。
