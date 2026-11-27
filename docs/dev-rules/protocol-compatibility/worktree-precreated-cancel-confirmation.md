# 预创建 worktree 的终止确认

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

同账号设备互联新增 `worktree:cancel-precreated`，参数仍为 `sessionId` 加 `path` 或
`recoveryKey` 二选一，成功回执沿用严格的 `{ discarded: true, branchDeleted?: boolean }`。
主机在与创建共用的任务锁内检查任务归属，再按创建 ID 持久标记取消、回收未认领目录。
迟到的 worktree 创建和任务启动均检查该标记；有内容改动、运行时占用或真实任务时仍保留。

Mobile 对所有预创建恢复记录（含未收到创建回包的 `reserved`）只接受此终止确认，不用一次 `NOT_FOUND` 授权
旧式删除。旧主机拒绝未知 channel 时保留记录，不回退 `discard-precreated`；旧控制端
继续使用原 channel。完全恢复需要两端均更新，服务端与 Mobile 原生配置无需改动。
恢复仅作用于该任务 ID，不重启 peer 或共享 relay，也不将创建请求加入自动重放。
终止确认后先持久保存草稿的取消状态和原项目目录，再删除回收账本；再次提交使用新任务 ID。
手机发件箱保留原持久键与附件目录，只原子替换记录中的远端任务 ID，写入失败仍可恢复原草稿。

`maker:create-session` 的控制端等待预算为 2 分钟（Desktop 与 Mobile 共用协议契约表）。主机
`agent.startSession` 在高负载下实测超过 40 秒（Codex 冷启动），原先 30 秒会让控制端先放弃，
主机照常建完任务，留下一个首条消息没发出的空任务。旧控制端仍按 30 秒等待；回包 outbox
按主机自身版本的预算计算保留时长（预算 × 2，从回包入队时起算）：旧主机仍保留 60 秒，
新主机按新预算保留 240 秒。控制端升级不会改变旧主机的保留时长。
实现见 `apps/desktop/src/main/device-link/dispatch.ts` 的 `outboxEntryMaxAgeMs` /
`remoteInvokeClientBudgetMs` 与 `packages/device-link/src/allowlist.ts` 的共享预算表。

Desktop 控制端在本进程内记录「已发出创建但未得到确认」的任务 ID（只在内存，不进回收账本）。
下次恢复时若该任务已在主机出现，且仍完全没被使用（状态 active、没有消息、没有发送记录、
没在运行、未置顶），先用新增的 `local-db:sessions:discard-unused` 将其标为删除（主机删除流程一并
回收 worktree），再删除回收账本；字段缺失或已被使用时只删账本，不删任务。删除失败时同样只删账本，
不阻止新建。进程重启后不再删除，退回原行为。Mobile 失败后用同一任务 ID 重试会直接接上晚到的任务，
无需这一步。

晚到空任务的回收由独立 `sessions:discard-unused` 通道进入既有删除流程。主机在删除事务内
重新检查 active、无消息、未发送、未运行、未置顶，防止控制端探测后任务被接手；未通过
检查不取消运行时、不登记回收。旧主机拒绝新通道，控制端只销账，不退回无条件删除。
控制端快照缺少任一保护字段时也不请求清理。Worker 两条实现保持相同事务条件，不改 schema。
