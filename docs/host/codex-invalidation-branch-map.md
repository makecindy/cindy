# Codex 原生登录：服务端作废的分支对应表

放行表第 26 行的组成部分之一，m1-cp15a 建立，m1-cp15b 和 m1-cp16 更新。

- 桌面是 `apps/desktop/src/main/maker-host/auth-adapters.ts` 的 `DesktopCodexAuthAdapter.invalidate`，以及它调用的 `logout`、`runLogout`、`disconnectCodexOAuth`；行号按 m1-cp14（e9dbab2e55 之后整体前移 34 行）。
- Host 是 `apps/host/src/agent/codex-invalidation.ts` 的 `invalidateHostCodexLogin`、`invalidateUnattributed`，接线在 `codex-runtime.ts` 的 `invalidateNative`。
- 对照测试：
  - 隔离对照 = 桌面 `maker-host/__tests__/hostCodexInvalidationParity.test.ts`
  - 共享对照 = 桌面 `maker-host/__tests__/hostCodexSystemLoginParity.test.ts`
  - Host 单测 = `apps/host/src/agent/codex-invalidation.test.mjs`
  - 收口单测 = `apps/host/src/agent/codex-auth-boundary.test.mjs`

生产上谁会调到：
- 引擎（maker-core `codex/index.ts`）只报“未归属”这一种，带任务的 providerId；
- 订阅桥只传 reason，不带上下文；
- 所以“带凭据代次”的那部分归属分支，两边目前都只有测试会走到。

## 一、入口

| # | 桌面（行） | 桌面做什么 | Host | 测试 | 结论 |
|---|---|---|---|---|---|
| 1 | 2662–2666 | providerId 是独立账号 → 返回 | 同（m1-cp15b）：账号服务的谓词（不含 openai），由 codex-runtime 传入 | 隔离对照：网关、自定义供应商、独立账号三种；Host 单测 | 相同 |
| 2 | 2667 | 用 `parseCodexCredentialGeneration` 解析代次 | 同一个函数（已移到 `codexCredentialRead.ts`） | 隔离对照 | 相同 |
| 3 | 2668–2710 | 开发版只读：只在内存里作废 | 不适用：源码运行不与系统登录对账，只写自己隔离的 profile | `codex-system-login.test.mjs` 三种运行方式 | 按设计不适用 |

## 二、未归属分支（引擎的上报方式）

| # | 桌面（行） | 桌面做什么 | Host | 测试 | 结论 |
|---|---|---|---|---|---|
| 4 | 2712 | 从磁盘把标记加载进内存 | 每次读标记 | — | 无状态设计 |
| 5 | 2713–2717 | 已有持久断开标记 → 返回 | 同 | Host 单测 | 相同 |
| 6 | 2718–2721 | 登录进行中（`pendingLogin \|\| loginCancellationOpen`）→ 返回 | `loginInProgress`（账号服务的 `isCodexAccountLoginActive`，读不出来按进行中） | 共享对照：登录进行中、登录中途开始 | 相同（窗口长短见第 17 行） |
| 7 | 2722–2733 | 读范围；共享登录且已绑定时记恢复 owner | 同；范围读不出时用标记里记下的上一次范围（m1-cp16，等同桌面 `lastKnownCodexCredentialScope` 在重启后从标记恢复） | 共享对照 8 种组合 | 相同 |
| 8 | 2734–2741 | 写未归属的抑制标记 | 同一个函数，同参数 | 隔离对照、共享对照 | 相同 |
| 9 | 2742–2760 | 标记写不进 → 写撤销兜底，范围改 unknown | 同 | Host 单测 | 相同 |
| 10 | 2761–2769 | 标记没写进时在内存里压住 | 不留内存状态 | — | 差 8 |
| 11 | 2770–2787 | 记日志，播报 | 同 | 隔离对照、收口单测 | 相同 |

## 三、归属分支（订阅桥；带代次的只有测试）

| # | 桌面（行） | 桌面做什么 | Host | 测试 | 结论 |
|---|---|---|---|---|---|
| 12 | 2789–2791 | 在检查之前记 “codex auth invalidated” | 在检查之后记 | — | 差 9（只差日志） |
| 13 | 2793–2808 | 已有持久断开标记，且本地没有文件或文件被压住 → 返回 | 同。m1-cp16 起 Host 自己的登出也写这个标记 | Host 单测；隔离对照“显式断开” | 相同 |
| 14 | 2811–2823 | 登录占着“当前文件不在”的空窗 → 返回 | 同（m1-cp16） | 隔离对照“auth.json 已不在、登录进行中” | 相同 |
| 15 | 2811 起 | 当前文件不在、又不属于上面的情形 → 照常往下：写标记、收口、播报 | 同（m1-cp16） | 隔离对照“auth.json 已不在时的迟到失效” | 相同 |
| 16 | — | 只接 maker-core 的上下文 | 同（m1-cp15b） | Host 单测：入口参数与 maker-core 的 `AuthAdapter.invalidate` 上下文一致 | 相同 |
| 17 | 2824–2846 | 内容变了，并且文件身份也变了或登录取消窗口开着 → 返回 | 同（m1-cp15a）。窗口对应 `loginInProgress`：Host 从登录开始到账号服务提交新凭据为止，桌面一直开到绑定、清标记之后。Host 用 rename 提交，新凭据总是新 inode，窗口长短的差别只影响就地改写 | 隔离对照：换 inode、登录进行中就地改写 | 相同 |
| 18 | 2847–2862 | 被拒指纹：内容变了或没有代次 → 不带；否则用捕获的那份 | 同（m1-cp15a） | 隔离对照、共享对照：就地改写 | 相同 |
| 19 | 2863–2868 | 有上下文、共享登录、没有被拒指纹 → unknown | 同（m1-cp14 起，m1-cp15a 按被拒指纹判断） | 共享对照：两种上报、就地改写 | 相同 |
| 20 | 2869–2873 | 恢复 owner | 同 | 共享对照“恢复只给原 owner” | 相同 |
| 21 | 2874–2878 | 设内存作废状态、抑制对账 | 不留内存状态 | — | 无状态设计；失败路径见差 8 |
| 22 | 2879–2887 | 写作废标记 | 同一个函数，同参数 | 隔离对照、共享对照 | 相同 |
| 23 | 2888–2911 | 写不进 → 写撤销兜底，范围改 unknown | 同 | Host 单测 | 相同 |
| 24 | 2912–2921 | 提前解绑 | 同 | Host 单测 | 相同 |

## 四、`logout({ preserveInvalidatedReason: true, … })` 收口（2922–2933，展开为 2239–2488）

| # | 桌面（行） | 桌面做什么 | Host | 测试 | 结论 |
|---|---|---|---|---|---|
| 25a | 2244–2286 | 已有登出在进行：并进同一个操作；用户的显式登出优先，结束前重申持久断开标记 | 作废的收口不进登出；Host 的显式登出先写持久断开标记、结束前再写一次（m1-cp16），作废随后的入口检查会停在第 13 行 | 隔离对照“作废收口中登出”（两边都不播报，最终都是持久断开标记）；收口单测 | 结果相同 |
| 25b | 2327–2338 | 先取消进行中的登录，等它结束，再收口 | 不取消原生登录：登录照常提交，读登录态为已登录、带“需要恢复”标注 | — | 差 4 |
| 25c | 2327–2488 | 每一步之前检查 owner（`isCodexDisconnectCurrent`） | 同（m1-cp15b）：删除前、删除后、退役之后、删模型缓存之后 | 隔离对照：退役时换 owner，新 owner 认领 | 相同 |
| 25d | 2428–2431 | 删 auth.json，除非它和 `~/.codex/auth.json` 是同一个目录项 | 同（m1-cp15b） | 共享对照：codex-home 链接到假系统目录；Host 单测：没有系统登录路径时 | 相同 |
| 25e | 2458–2464 | `onLogoutSuccess` | `disposeLocalHost` → `authBoundary.afterLogout` | 收口单测 | 相同 |
| 25f | 2469 | 删模型缓存 | 同 | Host 单测 | 相同 |
| 25g | 2473–2474 | 显式登出时重申持久断开标记 | 见 25a | — | — |
| 25h | 2477–2487 | 最后再解绑一次（不带撤销） | 同 | Host 单测 | 相同 |
| 25i | 2926–2933 | 收口出错只记日志，照样往下 | 每一步各自 try/catch | — | 相同 |

## 五、播报

| # | 桌面（行） | 桌面做什么 | Host | 测试 | 结论 |
|---|---|---|---|---|---|
| 26 | 2934–2939 | 收口期间作废原因或范围变了 → 不播报 | 同（m1-cp15b），无状态：标记写进了就重读，仍是这次的原因和范围才播报 | 隔离对照：被登录取代、被显式登出取代；Host 单测：标记被改成别的原因或范围 | 相同 |
| 27 | 2940–2946 | `onInvalidatedBroadcast(reason, scope)` | `authBoundary.afterInvalidation` | 收口单测 | 相同 |

## 剩下的差异

| 差 | 内容 | 何时出现 | 处理 |
|---|---|---|---|
| 4 | 作废时原生登录正在进行：桌面取消登录，Host 让它提交 | 被拒的仍是当前文件，用户正好在登录 | 记在放行表第二节，不改代码 |
| 8 | 标记和撤销兜底都写不进时，桌面在内存里压住直到重启，Host 与桌面重启之后相同 | 两次磁盘写都失败 | 记在放行表第二节，写了具体后果，不改代码 |
| 9 | “codex auth invalidated” 日志的先后 | 只影响日志 | 不改 |
