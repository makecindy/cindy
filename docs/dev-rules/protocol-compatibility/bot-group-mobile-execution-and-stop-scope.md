# 手机群内执行与停止范围（2026-11-06，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

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
