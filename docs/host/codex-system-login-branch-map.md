# Codex 原生登录：与系统登录对账的分支对应表

放行表第 26 行的组成部分之一，m1-cp13 建立，m1-cp14 补充。桌面是 `apps/desktop/src/main/maker-host/auth-adapters.ts`；行号按 m1-cp14（e9dbab2e55 之后整体前移 34 行）。Host 是 `apps/host/src/agent/` 下的文件。对照测试是桌面的 `maker-host/__tests__/hostCodexSystemLoginParity.test.ts`：每个场景两边各建一份 profile，各用一个假 HOME。

Host 不留进程内状态。每次对账都读标记（`restoreInvalidationStateOnStartup`），读到的就是桌面重启后读到的同一个结果。

| 桌面（行） | 做什么 | Host | 测试 |
|---|---|---|---|
| `reconcileWithSystemCodex` 1023–1040 | 登录进行中跳过（除非登录自己调用）；在途的对账合并；固定会话快照 | `codex-system-login.ts` `reconcile()` | 登录进行中；登录在对账中途开始 |
| 第 1 步 1150–1171 | 开发版隔离沙箱的清理 | 不实现：只属于未打包桌面加 `XDT_ISOLATED_AUTH`；Host 源码运行不对账 | — |
| 第 2 步 1172–1198 | 显式断开或作废标记仍有效 → 跳过；标记已失效 → 解除抑制、记“需要恢复” | `run()` 开头读 `restoreInvalidationStateOnStartup(...).suppressReconcile`；“需要恢复”由 `readHostCodexRecoveryRequirement` 读同一个标记 | 8 种组合；显式断开（跑 Host 自己的登出，m1-cp16）；同进程 |
| 第 3 步 1187 | 系统文件不存在 → 返回 | 同 | 无系统登录 |
| 第 4 步 1200–1203 | 已是同一条目 → 返回 | 同 | — |
| 第 5 步 1205–1232 | 健康的硬链接：标记为共享，换成符号链接；健康的符号链接：返回（开发版共享 Release 时拷快照） | 同；快照分支不实现（只属于未打包桌面） | 硬链接换符号链接 |
| 第 6 步 1234–1251 | 普通文件且有显式的隔离归属 → 保留 | 同 | 在 Cindy 里登录的保留 |
| 第 7 步 1253–1269 | 系统登录没有账号且不是硬链接 → 返回；旧版显式归属且账号不同 → 迁成实例隔离并保留 | 同 | 账号不同的旧版显式归属 |
| 第 8 步 1271–1281 | Windows 上的普通文件保留（条件后半句：不需要给开发版拷 Release 快照，`shouldSnapshotReleaseCodexAuth`，打包版恒为假） | 同；后半句不实现：只在未打包桌面为真，安装版 Host 对应打包版，源码运行的 Host 不对账 | 同账号本地文件：Windows 上两边都保留普通文件，其余平台两边都重链（CI 的 Windows 作业） |
| 第 9 步 1283–1353 | 再查一次登录进行中；`relinkSharedCodexAuth`；记结果日志 | 同；快照分支不实现 | 同账号本地文件重链；link-unsupported；swap-failed-intact |
| 第 10 步 `claimDetectedCodexOAuthBinding` 1061–1135 | 登录中、会话边界、会话换代、仍在作废、本地被抑制 → 不认领；有恢复 owner 时只恢复给他；否则认领给当前 owner；成功后 `onOAuthBindingClaimed` | `claim()`；`onBindingClaimed` 让 Pi 的 MCP 桥失效（桌面另两项是重置 openai 模型的自动刷新冷却、补拉 Codex 模型，Host 没有这两套机制，见放行表第二节） | 全新 profile 认领；换 owner 时不认领给出让方；恢复只给原 owner |
| `reconcileWithSystemCodexAfterLogin` 1142–1146 | 登录后等在途的对账结束，再对一次 | `reconcileAfterLogin()`，在 Host 的 `triggerLogin` 成功后 | Host `codex-system-login.test.mjs`（m1-cp14） |
| `clearStaleInvalidationIfSystemCodexChanged` 1576–1606 | 系统文件指纹变了 → 清作废、记需要恢复、重置抑制、再对账 | 无状态：标记失效后，读标记直接得到“未作废、需要恢复”，下一次对账照常进行 | 8 种组合里的系统重新登录 |
| `readState` 1488–1574 | 作废 → 报原因；对账；oauth-bearer 模式读本地文件，经 `getAccessToken` 再对账一次；“需要恢复”的标注与错误态 | `runtime.ts` `createCodexLocalCliAuth.getState`：同样的顺序；第二次对账对应 `getAccessToken`；oauth-bearer 的错误原因与桌面相同（本地文件的原因，否则 `no_oauth`） | 全部用例 |
| `getAuthEnv` 2490–2528 | gateway-key、provider-oauth、独立账号不对账；其余在未作废时对账 | 同 | 三种模式 |
| `getAccessToken` 2597–2609 | 读令牌前先对账 | `codex-runtime.ts` 订阅桥的 `getAccessToken`（`createBridgeTokenReader`）先对账 | Host 单测（m1-cp14） |
| `invalidate` 中与共享登录有关的部分 | 范围按检测结果；共享系统登录且已绑定时记恢复 owner；标记按系统路径记 | `codex-invalidation.ts`，详见 `codex-invalidation-branch-map.md` | 8 种组合 |
| 开发版只读（`devOAuthWritesBlocked`、`devReadOnlyDetached`、只读快照） | 未打包桌面共享 Release profile | 不实现：Host 源码运行不对账 | — |
| Windows 旧别名 `removeLegacyCodexAuthAlias` | 只在 Windows 上走 | 未验证（M1 不在 Windows 发布） | — |
| `verifyRecoveryWithAccountRpc` 1718 | 账号接口调用成功后清掉“需要恢复” | 未接：调用方是用量读取，随 2e（放行表第 13 行）。在那之前标注一直保留，在 Cindy 里重新登录也不清除（桌面登录后同样保留，由随后的账号接口调用清除） | — |
| 进程内兜底 `memoryOnlyInvalidatedSystemCredential` | 标记写不进时在进程内继续压住 | 不实现：Host 无状态，标记写不进时走撤销授权兜底，与桌面重启之后相同（放行表第二节写了具体后果） | — |
