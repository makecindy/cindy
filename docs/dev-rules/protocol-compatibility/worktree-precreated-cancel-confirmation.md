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
