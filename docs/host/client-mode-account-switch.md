# 客户端模式下的账号切换与添加账号：定稿方案

状态：方案已定稿（审核方 2026-11-17），**尚未实现**。分类为乙（迁移前必须完成）。实现排在 C（账号会话续期）落地、
自动续跑偶发失败第二条修完之后。放行表里的对应记录：

- 第二节“已知限制（仅限测试期）”：这一行写的是测试期的后果和临时做法；
- 第四节“用户已定的产品形态”：用户的原话和安全审查结论；
- 第五节“第 25 行 25b 的修订”和“乙：客户端模式下窗口切换、添加账号”：设计决定。

本文把这几处，以及当时分散在几轮讨论里的决定，合成一份可以单独读懂的方案。行号按集成分支 `8df7f93695`
核对；实现时以当时的代码为准。

## 一、背景：窗口是第二个写方

客户端模式下，窗口进程只当界面，任务、凭据和 owner 都由 Host 管。现有设计也是这样：

- 窗口不提交 owner：`requestStableOwnerPostCommit`，`apps/desktop/src/main/authManager.ts:318`，Host 是唯一写 owner 的一方；
- 续期交给 Host：`authManager.setAuthRefreshOverride`，`apps/desktop/src/main/bootstrap-electron.ts:1431`；
- 会话失效时不删凭据：`invalidateSession`，`authManager.ts:3908`。

但窗口里的切换账号、添加账号，以及登录本身，今天仍在窗口本地执行：

- 五个账号通道在 `bootstrap-electron.ts` 里不分模式注册：
  - `auth:accounts:list`，:6894；
  - `auth:accounts:sync`，:6899；
  - `auth:accounts:switch`，:6908；
  - `auth:accounts:begin-add`，:6917；
  - `auth:accounts:cancel-add`，:6926。
- 登录动作也一样：`auth:get-login-state` :6874、`auth:dispatch-login-action` :6876、`auth:get-captcha-challenge-url` :6885。
- Host 合同里只有三项：`auth:logout`、`auth:refresh`、`auth:get-state`，见 `packages/maker-shared/src/hostChannelContract.ts:409` 起。

窗口在本地切换到 B，走的是完整的 `completeLogin`（`authManager.ts:5298`），在 Host 读的同一份 profile 里：

- 写当前会话：`writePersistedAuthSessionOrThrow`，:5356；
- 写账号保管库；
- 经 `withCloudOwnerCommit`（:2354）把技能投影的 owner 提交成 B。

这样窗口就成了第二个写凭据、写 owner 的一方。Host 不会跟着换，结果如下（第十节有完整写法）：

- 界面先显示 B，下一次拿到 Host 的状态时又弹回 A；
- Host 的续期读到 B 的会话会失败；
- 重启 Host 因会话与库的账号不一致而起不来。

凭据层面，三个写入点都在同一把跨进程锁里先重读再写，由 C 兜住。见放行表第五节“④ 窗口的三个写入点”。语义层面的问题，即界面是 B、后台还在跑 A，由本方案解决。

## 二、方向：交给 Host 做，窗口只当界面

切换账号、添加账号和登录都由 Host 执行，窗口只渲染界面、转交用户的操作。不采用“窗口做完再通知 Host”，原因有两个：

- 那样窗口会长期是第二个写方，与客户端模式的设计、也与 C 的单写方前提相反。
- Host 已经有全部零件：
  - 读写同一份账号保管库，用同一把锁 `AUTH_ACCOUNT_VAULT_LOCK_FILE`；
  - 运行时拆装：`disposeOwnerRuntime` `apps/host/src/main.ts:1911`，`ensureRuntime` :672；
  - 登录提交：`commitLoginSessionAndOwner`，`apps/host/src/agent/skill-projection-owner.ts:112`；
  - 账号边界停止：`runOwnerBoundary`，见第七节。

接口：新增 `/api/auth/accounts/*` 一组。

| 窗口通道 | Host 路径 | 说明 |
|---|---|---|
| `auth:accounts:list` | `/api/auth/accounts/list` | 只读保管库，返回与 `DesktopAccountSwitcherSnapshot` 同形的 `{ accounts, mutationAllowed }`。当前项按 Host 的账号标，不按窗口本地；闸门关着或切换进行中时 `mutationAllowed` 为 false |
| `auth:accounts:sync` | `/api/auth/accounts/sync` | 在保管库锁内做 passport 续期与成员同步。这会写凭据，只能由单写方做；主体搬自桌面 `syncSavedAccounts`（`authManager.ts:4074`），成为共用核心 |
| `auth:accounts:switch` | `/api/auth/accounts/switch` | body `{ accountKey }`。确认在窗口那一侧做（第六节），Host 收到请求就执行第八节的顺序 |
| `auth:accounts:begin-add` | `/api/auth/accounts/add/begin` | Host 开始一个添加账号的登录事务，返回登录状态（与 `DesktopLoginActionResult` 同形，不含令牌） |
| `auth:dispatch-login-action`（客户端模式下的添加账号） | `/api/auth/accounts/add/action` | body 形如桌面的 `DesktopLoginAction`，由 Host 解释 |
| `auth:accounts:cancel-add` | `/api/auth/accounts/add/cancel` | 取消 Host 的登录事务；已开始提交的不取消，同桌面 |

- 合同项写进 `HOST_CONTRACT_CHANNELS` 的 Auth 段，形状同现有三项，标 `trustedRenderer: true`。
- 路由写进 `apps/host/src/service.mjs`，与 `/api/auth/state`、`/api/auth/refresh` 同处（:97、:100）。
- `/api/auth/*` 本来就不算 owner 请求（`apps/host/src/server.mjs:166`），切换进行中仍能调用。
- 推送沿用现有的 `auth_changed` 事件，例如退出登录收尾时发的那条（`main.ts:1546`）。窗口经 `receiveHostAuthState`（`authManager.ts:485`）换显示。
- 不走 device-link：这几个通道不在 device-link 白名单里，远程控制端本来就不能换账号。

## 三、设计点（审核方已定）

### 3.1 只给切换用的 owner 提交入口（定 (ii)）

serve 进程在加载前注入“拒绝提交 owner”：`main.ts:292` 调 `refuseSkillProjectionOwnerCommit`，定义在 `skill-projection-owner.ts:30`。只有 `cindy-host login` 放开（`allowSkillProjectionOwnerCommit`，:35）。切换要在 serve 里提交 owner，不用全局放开，而是新增一个只给切换用的提交入口：

- 放开的范围在词法上限定在切换函数内部（try/finally）；
- 绑在这一次切换上，不是全局开关：切换进行中，别的调用方去提交仍然被拒；
- 切换失败后恢复为拒绝；
- 切换之外 serve 照旧拒绝，现有根守护的语义不改。

必做的三条测试：

1. 切换之外 serve 照旧拒绝（现有根守护不改语义）；
2. 切换进行中，另一个提交尝试被拒；
3. 切换失败后，恢复为拒绝。

### 3.2 客户端模式下由 Host 提交 owner（25b 的修订）

- **原决定**（25b 方案 A）：窗口提交 owner，Host 只加入窗口已提交的同一 owner，serve 注入拒绝。
- **为什么改**：窗口在本地切换、添加账号会提交新 owner，而 Host 不跟。用户已定登录结果交给 Host（第四节），切换由 Host 执行，提交也就归 Host。
- **改后的分工**：只限客户端模式。
  - Host 在切换账号时经 3.1 的入口提交 owner；
  - 窗口在客户端模式下不再提交 owner，这是桌面改动，归第一阶段之后的桌面 PR；
  - 独立安装的 Host 不变，仍由 `cindy-host login` 提交（`apps/host/src/login-cli.mjs:144`）。

### 3.3 `discoverHostOwner` 的缺口一并处理

`discoverHostOwner`（`apps/host/src/profile-path.mjs:45`）只看 profile 里 `cindy-*.db` 的个数：

- 一个库：认它的账号；
- 两个库：不设 `CINDY_HOST_OWNER` 就拒绝启动。用在启动时 `main.ts:2072`，状态命令 `main.ts:201`。

运行中切换过一次，profile 里就有两个库，下次重启必然撞上。改成以已提交的会话或技能投影边界上的 owner 为准，与切换同一单元做。

### 3.4 `cindy-host login` 写出与桌面登录相同的存储状态

现在 `cindy-host login` 只写 v1 会话记录：账号库里不写这个账号，不写 passport，不写旧版令牌（放行表第五节并存行“后续九”）。要求改成写出与桌面 `completeLogin` 相同的状态，即账号库里的账号与 passport。添加账号由 Host 登录以后，Host 本来就要会写这些，两条路共用同一段写法。

做完后，C 的差别 a（v1 仍持有令牌时，账号库没有当前账号也写 v1）应当可以去掉。

## 四、用户的决定与安全审查结论

- **用户的决定**（2026-11-17，审核方转问）：问题是“窗口连着 Host 时，添加账号 / 登录怎么做”，用户选“**窗口照常登录，结果交给 Host（推荐）**”。审核方在选项里向用户承诺：多出的那一次登录凭证在本机内部的传递，单独做安全审查，审查通过前不实现。
- **安全审查结论**（2026-11-17，审核方）：
  - 字面做法（窗口登录后把结果交给 Host）会跨进程传长期凭据，而且令牌绑的是窗口的设备，Host 接过去连自己的远程连接身份都起不来。不采用。
  - 改为 Host 发出全部会签发令牌的认证调用，界面和操作不变；窗口只转交用户输入的一次性验证码、联系方式和账号选择。
  - 用户选的时候看重的是“窗口里的登录体验和现在完全一样、所有登录方式都能用”，这一做法满足。这属于“实现方式因审查而调整、用户看到的不变”。
  - 审核方已如实告知用户，用户可以否决，不为此再占用户一次选择。
  - 备选做法（浏览器一路窗口只交 code 和 state，其余几路不可用）不采用。

## 五、安全小节：添加账号时登录结果在本机内部的传递

### S1. 传的是什么

**现状**：桌面每条登录路径的终点都是 `LoginOutcome` 的 `ok`，即一对令牌，落在窗口主进程。

- 类型定义：`packages/auth-client/src/types.ts:174–195`，包括 `accessToken`、`refreshToken`、`membership`，以及可选的 `accountToken`、`accountRefreshToken`。
- 各路径在桌面上的调用点（`authManager.ts`）：
  - 浏览器、SSO：`exchangeAuthorizationCode`，:5796，PKCE 的 verifier 在本进程里；
  - 邮箱或手机验证码：`requestCode` :5723，`verifyCode` :5742；
  - 选账号：`exchangeAccountMembership` :5814，`selectAccount` :5829；
  - SSO 二次校验：`requestSsoVerificationCode` :5843，`verifySsoVerification` :5864；
  - 绑定手机或邮箱：`requestBindingCode` :5874，`verifyBinding` :5890。
- 落地：`finishFreshLogin`（:5491）→ `completeLogin`（:5298），把 refreshToken 写成当前会话，passport 的刷新令牌进保管库。这些都是**长期凭据**。
- 设备绑定：桌面签发时用窗口的设备 id（`resolveRuntimeDeviceId`，`authManager.ts:362`）；Host 登录时用自己的设备 id（`getOrCreateHostDeviceId`，`login-cli.mjs:110`），并写进会话记录（`apps/host/src/auth/device-identity.mjs:19`）。
  - 用窗口设备 id 签发的会话交给 Host，Host 只能沿用那个 id（`resolveSessionDevice`，:23）；
  - `canRegisterHostDevice`（:30）会判为不可注册，Host 的 device-link 身份就起不来。

**结论**：照字面“把结果交给 Host”，传的是长期凭据，还带着错的设备身份，不采用。

**做法**：界面不变，Host 发出所有会签发令牌的认证调用。

- 登录事务（相当于桌面 `runLoginAction` 的状态机）在 Host 里跑，用 Host 的设备 id。窗口照旧渲染登录状态（`DesktopLoginActionResult`，不含令牌），把用户的动作转给 Host。
- 浏览器、SSO 一路：
  - Host 生成 PKCE 的 verifier、challenge 和 state，或托管回调用的 pollSecret；
  - Host 自己开系统浏览器、听本机回调，或轮询托管回调，与 `runHostLogin`（`apps/host/src/auth/login.mjs:103`）同一做法；
  - 窗口只显示“请在浏览器中完成”和取消按钮，跨进程的只有“开始”“取消”两个动作。
- 验证码、SSO 二次校验、绑定：窗口交的是用户输入的联系方式和一次性验证码，以及“发码”这个动作。ticket（`loginTicket`、`verificationTicket`、`bindTicket`）只在 Host 内存里。
- 选账号：窗口只交 `accountId`，`accountToken` 或 `loginTicket` 留在 Host。
- 跨进程的物品因此只有用户输入的一次性验证码（短期、服务端一次性）、联系方式和账号 id，**都不是长期凭据**。渲染层本来就看得到这些，它们是用户自己输入的。

### S2. 经哪个本机接口

- 渲染层 → preload → 窗口主进程：
  - `apps/desktop/src/preload/preload.ts:2515–2526` 的 `auth*` 方法；
  - 主进程按可信渲染层准入（`assertTrustedAppRendererEvent`）。
- 窗口主进程 → Host：走客户端模式现有的合同代理。
  - 新通道加进 `HOST_CONTRACT_CHANNELS` 的 Auth 段，标 `trustedRenderer: true`。
  - `registerHostDelegatedIpc`（`apps/desktop/src/main/host-delegation.ts:197`）把它们装成代理；`claimProxiedChannels`（`bootstrap-electron.ts:1397`）去掉本地处理器。
  - 请求发到 Host 的本机地址 `/api/...`，带 Bearer 密钥和 `x-cindy-host-instance`。Host 地址只能是本机回环（`resolveHostDelegation`，`host-delegation.ts:38` 起）。
- Host 侧：`server.mjs` 收 `/api/*` 的 POST，交给 `service.mjs`；`/api/auth/*` 不受 owner 请求闸门挡（`server.mjs:166`）。
- 路由：`/api/auth/accounts/add/begin`、`/api/auth/accounts/add/action`、`/api/auth/accounts/add/cancel`，与 list、sync、switch 同组（第二节）。
- 不走 device-link。

### S3. 怎么鉴权

- 密钥：`apps/host/src/api-token.mjs`。
  - `crypto.randomBytes(32)`（:22），写成 profile 目录里的 `host-api-token`，文件 0600（:25）；
  - **每个 profile 一把，在 Host 的各次运行之间复用**；
  - 比对用 `timingSafeEqual`（`isAuthorized`，:31 起），没有这个头就一律不通过。
- 交给窗口：窗口启动时从同一个 profile 目录读这个文件（`host-delegation.ts:54` 起），不经命令行、不经环境变量。
- 实例头：带 `x-cindy-host-instance` 的请求，实例 id 必须等于正在运行的 Host（`server.mjs:143` 起），防止旧窗口打到换过的 Host 上。
- 够不够：按 S1 的做法，跨进程的东西里没有长期凭据，拿到密钥的同用户进程也拿不到令牌。它最多能发起一次登录事务，但没有用户的验证码或浏览器授权就走不完。按现有模型，够用。
- 另加两条限制：
  1. 这组接口只接受“Bearer + 实例头”的调用方，拒绝网页端 cookie 会话（`isWebAuthorized` 那一类）。账号增减只给桌面窗口，等同于 `trustedRenderer`。
  2. 同一时刻只允许一个添加账号事务（S4）。
- **威胁模型边界**（审核方补，如实写明）：同一 OS 用户下的其它进程能读到这把密钥，因此能调用这组接口，例如发起切换账号。这在现有威胁模型之内，同用户进程本来就能读 profile，不另加防护。

### S4. 有效期和一次性

- Host 的登录事务照桌面的 `loginFlowEpoch` 和 `assertLoginFlowCurrent`（`authManager.ts:3678`）：
  - 每次 begin 开一个新事务，作废上一个；
  - action 不属于当前事务，以 `AUTH_FLOW_SUPERSEDED` 拒绝；
  - 事务开始提交（存会话、换 owner）后，cancel 不再生效，同桌面 `isLoginFlowCommitSealed`（:3702）；
  - 事务结束或超时（与浏览器授权同一上限），清掉 verifier、state、pollSecret 和各种 ticket。
- 服务端一次性：
  - 授权码换一次就失效；
  - 托管回调的取回结果只能取一次；
  - 验证码与 ticket 由认证服务器保证一次性、短期。
- 重放：
  - 同一条 action 再发一次：事务已推进或已结束，Host 拒绝；Host 漏判时，服务端也会拒绝。
  - 旧窗口的请求：实例头不匹配，被拒。

### S5. 日志里不落

| 点 | 现状 | 要求 |
|---|---|---|
| 渲染层到 preload | `ipcRenderer.invoke` 不记参数 | 不变 |
| 窗口主进程的代理（`registerHostDelegatedIpc`） | 不记参数、不记响应 | 不变 |
| 窗口的 Host 客户端失败时 `throw new Error(text …)`（`host-delegation.ts:87`），`text` 是 Host 的响应正文 | Host 回什么，窗口就把什么当错误消息 | 由下一行保证 |
| Host 的错误回包（`server.mjs:408–409`，`clientErrorMessage` 见 `apps/host/src/client-error.mjs:12`） | 异常消息原样回给客户端 | 这组路由自己捕获异常，只回固定错误码 `{ error: CODE }`，不带原始消息；认证客户端抛出的异常也不原样转发 |
| Host 的 stdout、stderr | 现有续期失败会记 `error.message` | 新代码只记错误码和事务阶段，不记 body，不记认证服务器的响应 |
| 桌面日志上传 | 按白名单（deny-by-default） | 不变 |

**必做项：哨兵测试**。在 Host 测试里：

- 向这组接口发带特征串的验证码、联系方式和 ticket；
- 让认证服务器的桩返回带特征串的令牌；
- 断言这些特征串不出现在任何响应正文、错误消息和 Host 写的日志里。

### S6. 失败时窗口不留副本

- 按 S1 的做法，窗口内存里从来没有令牌。用户输入的验证码只在渲染层表单状态和一次 IPC 参数里，表单关闭或重置时随状态丢弃，同桌面的 `resetLoginFlowState`（`authManager.ts:3662`）。
- 窗口主进程在客户端模式下不能再走本地登录状态机。现在 `auth:dispatch-login-action`、`auth:accounts:begin-add` 在本地注册，本地会持有 `pendingAccountToken` 等变量（`authManager.ts:376`），`completeLogin` 会落盘。桌面 PR 要做到两点：
  1. 这些通道进合同后由代理接管，本地处理器被去掉；
  2. **必做项：第二道保险**。客户端模式下 Host 续期接管时，也就是续期 override 已设置时，本地 `completeLogin`、写会话、写保管库一律拒绝，写法同 `requestStableOwnerPostCommit`（:318）。这是桌面 PR，逐行送审。
- Host 交付失败：窗口显示错误，让用户重试；**不在本地完成登录、不落盘、不做兜底**。
- Host 侧失败：Host 撤销刚签发的会话，同 `runHostLogin` 的 `endRefusedSession`（`login.mjs:122` 起）；并回滚会话记录，同 `commitLoginSessionAndOwner`。

## 六、默认行为（审核方定：与桌面今天一致；失败时不让用户落到更糟的状态）

- **③ A 队列里没发的输入**：留在 A 的库里，回到 A 再发，与桌面换账号相同。
- **④ 切换失败**：先验 B、不动 A；B 不行就留在 A，并说明原因。
- **⑥ 闸门关着时**（同一 profile 上有会开库的桌面在运行，`inputQueue.isHeldForDesktop()`，`apps/host/src/agent/input-queue.mjs:629`）：拒绝切换，提示先关那个桌面。
- **①② 照桌面**：只在有任务在跑时，弹桌面现有的确认框，文案不变。
  - 确认后停掉在跑的任务，并保留中断痕迹：之后有中断横幅，不自动续跑。
  - 没有确认宿主时不切；切换失败留在原账号。
  - 不在 Host 侧另加一次确认，因为桌面没有。

确认框（`apps/desktop/src/renderer/i18n/locales/*/common.json`）：

| key | 中文（zh-CN） | 英文（en） |
|---|---|---|
| `sidebar.accountSwitcher.runningTaskTitle` | 中断任务并切换账号？（:10713） | Stop running tasks and switch accounts?（:10756） |
| `sidebar.accountSwitcher.runningTaskDescription` | 当前有任务正在运行。切换账号会先中断这些任务，未完成的执行不会继续。（:10714） | Tasks are currently running. Switching accounts will stop them first, and unfinished work will not continue.（:10757） |
| `sidebar.accountSwitcher.runningTaskConfirm` | 中断任务并切换（:10715） | Stop Tasks and Switch（:10758） |
| `logic.confirm.cancel` | 取消 | Cancel |

确认按钮为 `confirmVariant: 'destructive'`。切换中的提示是 `sidebar.accountSwitcher.switching`（“正在切换账号…” / “Switching accounts…”）；失败提示是 `sidebar.accountSwitcher.switchFailed`（“切换失败，请重新登录该账号” / “Could not switch accounts. Sign in to that account again”）。

入口（都走同一条主进程路径，确认都在渲染层用 `makerChatStore.getRunningSnapshot()` 判断）：

1. 侧边栏账号菜单 `apps/desktop/src/renderer/components/sidebar/UserInfoSection.tsx`：
   - 切换：`switchSavedAccount`，:215；
   - 添加：`openAddAccount`，:156。
2. 账号切换对话框 `components/sidebar/AccountSwitcherDialog.tsx`：
   - 切换：`handleSwitch`，:115；
   - 添加：`handleAddAccount`，:133；
   - 挂在 `features/plugin/MyPluginsPage.tsx:1179`。
   - 没有确认宿主时不切，见 :104 的注释。
3. 按当前代码补充：设置页的账号卡片 `components/settings/UserProfileCard.tsx` 也有“添加账号”，即 `openAddAccount`，:146。它用的是同一个确认框（:131 起）。

添加账号的登录页 `components/login/AddAccountLoginPage.tsx:47` 调 `beginAddAccount`。切换的路径是 `AuthContext.switchAccount`（`contexts/AuthContext.tsx:605`）→ preload → `auth:accounts:switch`。

桌面今天的两点行为照旧，登记在此：

1. 添加账号的确认发生在点“添加”的那一刻，账号边界要等登录完成才发生。这中间新开始的任务，会被直接停掉，不再确认。
2. 判断只看在跑的任务，不看排队的输入；排队的留在 A，即 ③。

## 七、复用账号边界：`runOwnerBoundary`

切换就是一次账号边界，经 `apps/host/src/agent/owner-boundary.ts` 的 `runOwnerBoundary(ownerBoundary, …)` 走。`ownerBoundary` 在 `main.ts:1240` 建立。`begin()` 一开始就做三件事：

- 输入运行时进入停止态（`beginStop`，`input-queue.mjs:579`）：不再接新输入，此后结束的回合记作中断；
- 持有共用的回合结束写入压制，直到拆完；
- 结束打开着的 `/chat` 流。

被切换停掉的任务因此保留中断痕迹，不自动续跑，与桌面账号边界（`bootstrap-electron.ts:2496`）效果相同。

- **`begin()` 不可撤销**：停止态只有输入运行时的 dispose 才换成新的。所以“先验 B、不动 A”（④）必须放在 begin 之前；begin 之后不存在“取消切换、原样留在 A”的路径。
- **切换是 begin 调用点的第五处**。`owner-boundary.ts` 头注列有前四处：退出登录、会话失效、有序关闭、HTTP 退出登录。切换要加进这张清单，并照那条不变式检查：begin 之后必须到达 dispose；到不了的路径必须重建输入运行时；压制的释放写在 finally 里。

## 八、Host 侧的切换顺序

`switchAccount(accountKey)`：

1. **准入**：
   - 闸门关着时拒绝（⑥）；
   - 已在切换、登录事务提交或退出登录中时拒绝；
   - B 与当前账号相同，直接返回。
2. **先验 B，不动 A**（在 begin 之前）：
   - 在保管库锁里取 B 的资源会话：先续期，不行再用 passport 兑换（主体搬自桌面 `switchSavedAccount`，`authManager.ts:4105` 起）；
   - 区域照 Host 现有的会话区域判定；
   - 这一步只得到 B 的令牌对，不写当前会话。B 不可用就留在 A，并说明原因（④）。
3. **`runOwnerBoundary(ownerBoundary, { beforeDispose, dispose, afterDispose })`**：
   - beforeDispose：照退出登录与会话失效的前段。关网页会话与平台客户端，`server.pauseOwnerRequests()`，`beginAppSessionBoundary()`，关确认窗与插件。
   - dispose：`disposeOwnerRuntime()`，停掉 A 在跑的回合并拆运行时。
   - afterDispose：
     1. 在 3.1 的入口里调 `commitLoginSessionAndOwner`：锁内写 B 的当前会话记录，再提交 owner；过渡里撤销 A 的技能投影。
     2. 有阻碍就中止，会话记录回滚到 A。
     3. 然后 `ensureRuntime(B)`。`main.ts:675` 的“运行中不许换 owner”前提是 activeOwner 已被 dispose 清空，所以拆干净后可以调；它会取租约、重做并存扫描、开 B 的库（没有就新建）。
     4. 之后 `startDeviceLink()`，并重新排续期。
4. **收尾**（finally）：
   - `commitVolatileAppSession('cloud', B)`；
   - 释放边界；
   - `eventHub.clear()`；
   - 发 `auth_changed`。窗口经 `receiveHostAuthState` 换到 B，平台客户端重连成 B。
5. **begin 之后的失败**：例如技能投影阻碍，或开 B 的库失败。dispose 照常到达，会话记录已回滚到 A，用 A 重开运行时并说明原因，不落到“未登录”（④）。这一支要有测试。

和已有机制的配合：

- 闸门：切换只在闸门打开时做；`disposeOwnerRuntime` 会停并存监视，`ensureRuntime` 重新扫描。客户端窗口的登记 `runtime: 'client'` 被放行（`apps/host/src/agent/profile-coexistence.ts:137–142`）。
- 凭据（C）：保管库与当前会话都在同一把锁里读写，切换后的续期由 Host 单写。窗口改走 Host 接口以后，C 不用再防窗口这个写方。

## 九、分工、排期与改动清单

分类为乙。桌面部分进第一阶段之后的桌面 PR，Host 部分进下一个 Host PR。实现排在 C 落地、自动续跑偶发失败第二条修完之后。

**Host 侧改动**

1. `/api/auth/accounts/*` 一组路由（list、sync、switch、add/begin、add/action、add/cancel），以及 Host 的登录事务（S1、S4）。只接受“Bearer + 实例头”，拒绝网页端 cookie 会话；同一时刻只有一个添加账号事务；只回固定错误码（S5）。
2. `switchAccount`，按第八节的顺序：先验 B，再经 `runOwnerBoundary` 拆 A、开 B；加进 `owner-boundary.ts` 头注的 begin 调用点清单，作为第五处。
3. 只给切换用的 owner 提交入口（3.1）。
4. `discoverHostOwner` 以已提交的 owner 为准（3.3）。
5. `cindy-host login` 写出与桌面登录相同的存储状态（3.4）；之后去掉 C 的差别 a。
6. 账号同步 `sync` 的主体搬成共用核心，桌面与 Host 共用。

**桌面侧改动**

1. 五个账号通道和三个登录动作通道进 `HOST_CONTRACT_CHANNELS`，客户端模式下由代理接管、去掉本地处理器（S2、S6 第 1 点）。
2. 第二道保险：续期 override 已设置时，本地 `completeLogin`、写会话、写保管库一律拒绝（S6 第 2 点，逐行送审）。
3. 客户端模式下窗口不再提交 owner（3.2）。
4. 界面不变：确认框、文案、入口、切换中和失败的提示都照旧（第六节）。

**必做测试**

- 3.1 的三条：切换之外 serve 照旧拒绝；切换进行中另一个提交被拒；切换失败后恢复为拒绝。
- S5 的哨兵测试：特征串不出现在任何响应、错误消息与 Host 日志里。
- S6 第二道保险的桌面测试：续期 override 已设置时，本地登录写入被拒。
- 切换的 Host 测试：
  - 先验 B 失败时，A 不受影响（没有 begin、运行时与会话不变）；
  - 切换成功后，被停掉的回合保留中断痕迹、不自动续跑；
  - begin 之后失败时，回滚到 A 并重开；
  - 闸门关着时拒绝；
  - 3.3 两个库时重启认对 owner。
- 鉴权两条限制：网页端 cookie 会话被拒；同一时刻只有一个添加账号事务（新的 begin 作废上一个，属于旧事务的 action 以 `AUTH_FLOW_SUPERSEDED` 被拒，S4）。

## 十、测试期的已知限制与解除条件

做完之前，客户端模式下在窗口里切换或添加账号的后果，见放行表第二节“已知限制（仅限测试期）”那一行。概括如下：

- 窗口在本地完成登录、写会话和保管库，并提交 owner；Host 仍在原账号下运行，新建的任务落在原账号的库里。
- 界面先显示新账号，下一次拿到 Host 状态时又回到原账号。
- Host 的续期读到新账号的会话会失败；原账号的访问令牌过期后，模型调用失败。
- 重启 Host 会因会话与库的账号不一致，或 profile 里有两个账号库，而起不来。

测试期的做法：

- 请勿在客户端模式下切换或添加账号；
- 要换账号，先在窗口退出登录（Host 一并退出），再用 `cindy-host login` 登录新账号，并重启 Host；
- 对用户的提醒由审核方说。

**解除条件**：第九节的 Host 侧与桌面侧改动都落地、必做测试都通过之后，从放行表第二节删去这一行，并在第五节“乙：客户端模式下窗口切换、添加账号”那一行记为已关闭。桌面侧必须包含：

- 合同代理接管；
- 第二道保险；
- 窗口不再提交 owner。

只落 Host 侧不解除：窗口仍会在本地写。
