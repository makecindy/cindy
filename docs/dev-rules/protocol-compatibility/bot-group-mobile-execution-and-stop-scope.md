# 手机群内执行与停止范围（2026-11-06，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

2026-11-16：以下新规则取代本文历史上的 requester-only / admin-all 停止语义。个人伙伴仅主人可停止，
公共 Cindy 仅本轮 requester 可停止，群主／管理员不扩大权限。`canStopAll` 保留字段但新端固定为 false；
`supportsScopedStop` 保留兼容，新端不再据此提供 all。新宿主／手机直连投影声明 `supportsOwnedStop: true`，
表示自己的执行入口已按归属筛选，并拒绝收到的旧 `{scope:"all"}`；新手机不向缺少此能力的旧宿主提供服务器群执行停止入口。
`round.canStop` 按新规则投影，speaker 的 `isSelfRequested` 仍只表示发起人，不复用于个人伙伴归属。
安排与步骤追加可选 `canStop`；整张安排仅创建者且所有未完成步骤均可控时可停，单步跳过另查该步归属。
旧手机忽略新增字段，旧 all 被新宿主明确拒绝；新版只读旧宿主的队列状态，不显示不明归属的跳过／结束控件。
`isOwned`、`assistant` 和 `requester_id` 均来自既有已鉴权成员／执行数据，不根据消息内容或群角色猜测。
手机远程成员解析须保留布尔 `assistant: true`，否则公共 Cindy 会误判为外属个人伙伴；字符串或缺失值不提升权限。
`activity: planning` 且没有 `executionId` 的本人安排决策按 `isSelfRequested` 保留取消入口，仍要求宿主声明 `supportsOwnedStop`。

客户端到 Chat Server 沿用现有 executions control、plans stop／skip 路径及版本号，无新增必填字段或数据库迁移，
双仓 PR 可独立合并，无强制先后。**完整权限保护仍需服务端升级**，客户端完成不表示服务端或生产已上线。
推荐先部署服务端，让旧端立即受到归属校验保护；这不是协议上的合并前置，也不要求客户端同步发布。

| 版本组合 | 正常使用与停止行为 |
| --- | --- |
| 旧客户端 + 新服务端 | 消息、读取、执行协议不变；原有操作中符合新归属规则的停止继续成功。旧按钮仍可能显示全部停止或他人的停止入口，越权项返回既有 403 错误体，不改变他人的执行。旧端未提供的新主人入口需更新客户端后使用。 |
| 新客户端 + 旧服务端 | 消息、读取、执行协议不变；客户端先筛选本人可控项。旧服务端可能拒绝主人停止他人发起的个人伙伴执行，客户端保留拒绝，不提权重试；其他旧客户端仍能使用旧服务端的管理员停止权限。 |
| 新客户端 + 新服务端 | UI 与服务端均执行新的归属规则。 |
| 新手机 + 旧电脑宿主 | 保留群读取与其它既有操作；缺少 `supportsOwnedStop` 时隐藏服务器群停止／跳过／结束入口，须更新该电脑或在已支持的入口停止，不能让旧宿主误停他人的执行。 |

混合版本不承诺新增权限和按钮完全一致；安全修复覆盖所有请求须等目标环境全部服务端副本升级完成。
回滚客户端会恢复旧按钮，不能回滚服务端的归属校验。原生 fingerprint、数据库、凭证、channel、allowlist、relay 帧均不变；
官方和自建中转仍透明传输原有加密 invoke/result，没有需要同步的中转实现。

以下为此前兼容记录，停止权限以 2026-11-16 的规则为准。

2026-11-09：经电脑读取的未结束 `work` 安排追加可选 `canSetAutoContinue: true`，仅该电脑发起、可管理且群未归档／解散时声明。
既有 `bot-groups` collection 增加 `plan-auto-continue` action，input 为 `{planId, autoContinue: boolean, expectedPlanRevision?}`。
Host 每次重读安排，验证类型、未结束状态、发起电脑归属、管理权限及提供时的安排版本，再转发给 PC 同一 `updateGroup` 入口。
偏好仍只保存在所选电脑，影响它在该群发起的分工；不向服务器增加设置或扩大执行权限。旧 Host 缺能力时手机只读原状态，
不发新 action；旧手机忽略可选字段。直连服务器不声明该能力。沿用已有加密 invoke/result，官方／自建中转均无需新增帧、
channel、allowlist 或部署；原生 fingerprint、数据库无变化。

既有 `bot-group-chat` 业务 payload 追加可选 `supportsScopedStop: true`，只在可转发范围的服务器群宿主／直连客户端声明；
缺失或非 `true` 值按不支持处理。手机保留既有 `canStopAll` 与 `round.othersActive`，三者同时为真才提供全部停止。
既有 `stop` action 的 input 可选 `{scope: "all"}`；省略沿用本人范围，宿主重新核对群类型和权限后转给既有
`stopRound(groupId, scope)`，服务器仍做最终鉴权。旧手机省略 scope，新手机不向旧宿主发送 all，避免旧宿主静默忽略。
直连客户端复用现有 plans／executions control API 与已鉴权 actor，不增加服务端权限。停止遭 403／404／409 时复读
同一对象；只有明确收尾状态才视为竞争完成，列表中缺失不算成功，仍拒绝时原样反馈（409 对应版本冲突）。

只增加远程资源业务字段，不新增 channel、allowlist、握手、帧或协议版本；官方／自建中转均透传原有加密
invoke／result，无需调整中转内核或部署。原生 fingerprint、数据库和服务端不变。回滚后旧手机与旧宿主继续默认停止路径。
回归入口：`botGroupRemoteResourceProvider.test.ts`、Mobile `chatServerClient.test.ts`、`BotGroupChatScreen.test.tsx`。

2026-11-13：speaker 复用现有 `timelineAt`（入队时间，仅用于时序，不能作为工作用时），追加可选
`sourceMessageId` 与 `isSelfRequested`（由已鉴权 host 根据 requester 投影）。两端将进行态插入消息时序，
已呈现最终 process 的 execution 不再重复显示进行态。新端对缺失 requester 字段的服务端执行只读，
旧 host 缺少时序字段时回退 source／startedAt／历史前方。旧端忽略新字段。默认停止收窄为本人请求，
不再以 bot 归属代替 requester；管理员仍需显式 all。没有新增 channel、relay 帧或服务端字段，
官方与自建中转透传已有资源；不涉及原生指纹、数据库或凭证。

群 Cindy 的 speaker 同时可选提供 `requesterName`，从既有 execution 的 requester 与成员名称投影，
进行态用「Cindy · 替 某人」标注请求归属，群成员的 Cindy 身份不变。旧端忽略字段，旧 Host 缺失时保留原名称；
不以伙伴主人、当前阅读者或最近一条消息猜测请求者。不新增服务端字段或网络读取。
