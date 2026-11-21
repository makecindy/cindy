# 桌面伙伴来源筛选

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

桌面在读取 `teammates` 名册后，用每个伙伴的 `conversation` 任务 ID 调用既有的
`maker:bot-delegations:list`（委派退役后新 Host 只读应答旧行，见[「伙伴后台任务（委派）退役」](teammate-background-task-delegation-retirement.md)）。只将 `requestingBotId` 匹配、`childSessionId` 非空的记录
作为创建来源；不把接手关系当创建，也不要求远端支持新增的 `created` link。
包含活跃和归档任务，实际展示仍由任务列表状态筛选决定；旧版远端也能直接使用。
已有 `following` 链接继续提供跟进标记，任务创建关系同时用于远程创建者头像。

按电脑 ID + 伙伴 ID 区分筛选，按电脑 ID + 任务 ID 匹配任务；远程头像使用原电脑媒体地址。
同一 Host 串行读取伙伴任务记录，关系缓存保留 ID、不保存任务卡正文。委派变更推送与
名册变更沿原刷新合并窗口更新；读取失败保留已有归属，成功空结果清空。
切账号、撤权、断线后的旧响应仍受原请求代次隔离。只读关系请求失败不重启 relay、
不影响其它设备、不重放任何任务操作。不增加 IPC、权限、服务端字段或数据库迁移。

Task creator filtering resolves built-in Cindy identity through the existing local `listCindyCopies` read,
which now returns even a single remaining cloud Cindy. The merge settings entry still requires two copies.
This allows old remote hosts without template metadata to participate in the unified filter without
changing their wire protocol or triggering any companion merge. Identity is cached with the owner-scoped roster.

## 伙伴独立任务的列表归属（2026-10-27）

`sessions:list/get/get-many` 可选投影 `companion: { id, role, channel? }`，从现有
`bot_session_links` 读取，不新增数据库列或改运行身份。普通列表仅纳入 `routine/channel`，
仍过滤隐藏任务与删除中的伙伴；`canonical/thread/group` 保留伙伴入口。
旧远端的普通列表未包含这些任务时，桌面经原有同账号 `history:query/list_sessions`
分页读取 `source=bot` 的归属，再用原有批量／单条读取补齐 Session。无权限或接口失败不能
清空普通任务；撤权沿原处理路径上报。设备／状态代次失效时丢弃迟到回复，保留其它设备的
镜像，不重启链路或重新授权。离线镜像仅保存归属的 id/role/channel，恢复时仍可筛选和显示头像。

Mobile follows the same read-only compatibility path for teammate task attribution and independent
routine/channel Sessions. `taskTeammate` is a client-local display projection (ID/name/avatar), not a
new wire field or permission. Its slim home cache keeps it with `companion`; optional read failure
retains that host's previous attribution and successful absence clears it. Account/query invalidation
and list mutation epochs fence all late results. Home and device list refreshes share this reader.
Cloud Cindy identities come from the existing owner-scoped `/preferences` profile snapshots, using
the same exact preset identity helper as Desktop. Only their IDs enter the cloud-home display cache;
profile bodies are not persisted. This adds no endpoint, database migration or native configuration.

## 完整主力名册的缺席与恢复（#8733）

`maker:remote-resources:list` 的 `teammates` 响应增量携带可选
`teammateRecovery: { version: 1, recoveringIds: string[] }`。它只在主力登记可用、未筛选、
无 cursor、少于请求上限，且整个异步读取期间主力登记快照未变化时提供；恢复中的 ID
只取本机为主力且副本仍被降级的伙伴，包含首次恢复尚无 Profile、恢复失败等待重试。
降级集合超过 200 项时不提供此证据，控制端同样拒绝畸形或超限记录。字段不包含资料、
路径、凭证或执行权限；它不改变列表项或已有 `NOT_FOUND` 的语义。

Desktop 只有在成功解析完整名册、少于 200 条、无 `nextCursor`、且明确收到 version 1
证据时，才把未列出且不在 recoveringIds 的云端伙伴记为展示缺席。按账号缓存，键同时
绑定云端 actor ID、主力电脑和伙伴 ID；成功列出或明确恢复中会清除。失败、分页和满页
不建立新证据；旧主力/未知版本/畸形证据返回完整名单时清除此主力旧推断，保留安全恢复
入口。云端身份晚到时沿既有名册同步重读，不逐伙伴新增查询或轮询。

伙伴恢复完成、降级解除时，通过现有 `maker:remote-resources:changed` 通知受影响伙伴，
沿既有 500ms 合并刷新；通知不再反向唤醒云端上传。该推断仅供 Desktop 名册、搜索、
角标、设置与任务创建者展示，不删除资料，不改变主力或任务历史，也不重定向旧任务地址。

新主力 → 旧控制端（含 Mobile）：忽略新可选字段，保持原展示；新 Desktop → 旧主力：
缺字段保持未知，不推断隐藏。只升级控制端不足以修复旧主力的此类缺席。relay 和自建
中转继续透明转发既有 invoke-result 的业务 JSON，不新增帧、通道、服务端 schema 或
中转版本要求。回滚后旧端忽略独立 `cindy.remoteBotOmissions.v2` 展示缓存，原 v1 名册
数组保持不变。验证入口：provider 的完整/恢复/快照变动用例、remoteBots 真实 hook+merge
回归、companionCloudUi 身份替换用例、control 的降级/恢复通知，以及 Device Link 与自建
中转互通套件；执行结果以 PR 的本轮实际记录为准。
