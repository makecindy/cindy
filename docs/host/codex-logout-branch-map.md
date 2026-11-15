# Codex 原生登录：显式登出的分支对应表

放行表第 26 行的组成部分之一，m1-cp16 建立并实现。

- 桌面是 `apps/desktop/src/main/maker-host/auth-adapters.ts` 的 `logout`（2239）、`runLogout`（2327）、`disconnectCodexOAuth`（2416–2488）；行号按 m1-cp14。
- Host 是 `apps/host/src/agent/runtime.ts` 里 `createCodexLocalCliAuth` 的 `logout()`（`runLogout`），持久断开标记由 `codex-invalidation.ts` 的 `commitHostCodexDisconnectBoundary` 写，账号服务由 `provider-config.ts` 的 `createHostCodexAccounts` 构造。
- 对照测试：
  - 隔离对照 = 桌面 `hostCodexInvalidationParity.test.ts` 的 “an explicit disconnect”；
  - 共享对照 = 桌面 `hostCodexSystemLoginParity.test.ts` 的 “an explicit disconnect suppresses the system login until it is replaced”；
  - 两者都跑 Host 自己的登出和账号服务；
  - Host 单测 = `apps/host/src/agent/codex-auth-boundary.test.mjs`。

| # | 桌面（行） | 桌面做什么 | Host | 测试 |
|---|---|---|---|---|
| 1 | 2244–2286 | 已有登出或作废收口在进行：并进同一个操作，结束前重申持久断开标记 | 第二次登出并入第一次；结束前再写一次标记（作废若在中途改写了它，以登出为准） | 隔离对照“作废收口中登出”；Host 单测“收口中途改写标记的作废” |
| 2 | 2288–2295 | 新建登出意图，记 owner | 每一步之前查运行时的 owner | Host 单测“换 owner 后不跑收口钩子” |
| 3 | 2327–2338 | 先取消进行中的登录并等它结束；断开 openai 订阅池 | 先取消登录；之后由账号服务的 `retireCodexAccount` 等它结束、处置本机进程。订阅池不做，见放行表第二节“显式登出时的订阅池”（随 M2） | Host 单测“登出时已在进行的登录不绑定”“登出期间开始的登录等它结束” |
| 4 | 2425–2426 | 写持久断开标记（原因 `user_disconnected`），写不进就登出失败；停止对账 | 同一个共用写入函数、同一个原因，写不进就登出失败。Host 在“等登录结束”之前写：登录已同步取消，账号服务的提交是同步段，两者不会交错 | 隔离对照“先作废再登出”；共享对照逐步比较 |
| 5 | 2427–2431 | 显式登出不删 auth.json | 同；共享登录的链接留在原地，对账由标记停住 | 隔离对照“保留 auth.json、删模型缓存”；共享对照 |
| 6 | 2448–2454 | `onLogoutSuccess` | `retireCodexAccount` 先处置一次本机进程，`afterLogout` 再退役一次（幂等） | 收口单测 |
| 7 | 2469 | 删模型缓存 | 同 | 隔离对照 |
| 8 | 2473–2474 | 结束前重申持久断开标记 | 同 | Host 单测 |
| 9 | 2477–2487 | 最后撤销授权（`revoked: true`），写不进就抛错 | 同 | 隔离对照 |
| 10 | 各步之间 | 每一步之前检查 owner | 同 | 收口单测 |
| 11 | logout 外层 finally | 显式且 owner 未变时再断一次订阅池 | 不做（见第 3 行） | — |

登录与登出并行：
- 桌面上，登出期间开始的登录排在登出之后；
- 登录如果在登出开始之前已在进行，会被取消；它若已经提交，由登出收口兜住。
- Host 也一样：登出期间开始的登录等登出结束；登出期间完成的登录不绑定，返回 `login_cancelled`，它写下的文件由登出结束前那次标记盖住。

登出之后在 Cindy 里重新登录：新文件替换 profile 里的那一项（共享登录时不动链接指向的系统文件），持久断开标记留作抑制哨兵（`settleInvalidationMarkerAfterLogin`）。新文件的指纹与标记不同，所以可用。两边相同（隔离对照“then a new login in Cindy”；Host 经自己的账号服务和一个只写暂存目录的假 Codex CLI 登录）。

Host 不再经账号服务的 `logoutCodexAccount`，也不再写账号服务自己的 `disconnected` 文件。原生连接只在登录成功之后读那个文件（`codexAccountState('openai')`），而这时登录已经把它删了。
