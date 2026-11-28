# 登录：注册前确认与扫码登录（2026-11-26）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

- **事实来源**：客户端 `packages/auth-client`（`types.ts` 的 `signupRequiredOutcomeSchema`、QR 各响应
  schema 与 `AuthFlowState`，`qrLoginPayload.ts` 的二维码编解码，`client.ts` 的请求）；服务端仓
  `auth-server` 的 `services/{loginCapabilities,signupTicket,signup,qrLogin}.ts`、`routes/qrLogin.ts`
  与 `docs/auth-server/auth-server-api.md` A3 / I 节。两仓各自维护实现，不共享代码。
- **能力声明（opt-in）**：客户端在邮箱 / 手机 `verify-code`、`/api/auth/token`、原生三方登录的请求体
  里带 `capabilities: ["signup_confirmation_v1"]`；浏览器三方 / SSO 的 `authorize` 用逗号分隔的
  `capabilities` query，服务端冻结进事务与绑定票据，回调换码时沿用。**只有声明了的请求**，服务端在
  账号不存在时才返回 `{ status: "signup_required", signupTicket, channel, targetMasked? }`；未声明的调用方
  （旧 Desktop / Mobile、Console、cindy-host CLI）保持「验证即注册」。旧客户端的 `loginOutcomeSchema`
  是严格判别联合，收到新 status 会解析失败，所以这个 status 不能对未声明的调用方下发。
- **注册票据**：`POST /api/auth/signup { signupTicket }`，返回与其他登录相同的 `LoginOutcome`（可能继续
  `select_account` / `binding_required` 等）。票据 10 分钟、单次使用、绑定发起时的 deviceId；确认期间
  同一联系方式已被别处注册时合并进该账号，不重复建号。放弃确认不留下任何账号。
- **扫码登录只有一个方向**（`/api/auth/qr-login/handoffs`，2026-11-27 定）：已登录的电脑（「远程控制
  Cindy」弹窗）出码；未登录的手机扫码 `claim`；电脑 `state` 看到认领者后 `decision`（允许 / 拒绝）；
  手机 `poll` 领取令牌。电脑登录页不出码，手机也不能确认电脑登录。
  - 领取凭据：手机认领时自己生成 `pollSecret`，请求与服务端只出现
    `pollSecretHash = base64url(sha256(pollSecret))`；二维码里的 `scanToken` 证明扫码方确实看到了码。
    出码的电脑必须是个人（非 SSO）会话；签发给手机的令牌 `amr=["qr"]`、不带账号对。
- **跨版本**：二维码里带电脑的 `region`。与手机安装的版本不同时，手机先询问是否切换，同意后直接向
  电脑所在区域 `claim` / `poll`，登录态区域随之切换；两区之间只传随机 id、摘要与区域标识，不传
  邮箱、手机号或令牌。用户同意切换前不向另一区域发请求。
- **二维码内容**：`<官网下载页>?cindy_login=<base64url(JSON)>`（`v/k/r/i/t/n/p` 短字段，`k` 固定为
  `"h"`，见 `qrLoginPayload.ts`）。系统相机扫码直接打开下载页；Cindy App 内扫码只认带该参数的链接。
  新增字段只能追加且可选，解码端对未知字段忽略、对缺失必填字段或未知 `k` 返回 `null`。
- **发布顺序**：服务端（[xindong/cindy-server#1690](https://github.com/xindong/cindy-server/pull/1690)）
  先上线。服务端还不支持时客户端声明的 `capabilities` 被忽略，行为回到「验证即注册」，不报错；
  没有 `/api/auth/qr-login` 时「远程控制 Cindy」弹窗回落为普通下载二维码，其他登录方式不受影响。
- **轮询预算**：电脑弹窗只在打开时每 2 秒 `state` 一次，手机 `qr-waiting` 每 2 秒 `poll` 一次，均到期即停、
  不自动续期；单张码每端最多约 60 次请求。
- **本地 IPC**：Desktop 在既有 `auth:dispatch-login-action` 上新增 `confirm-signup` 动作，另增
  `auth:qr-handoff:{create,state,decide}` channel；只在本机 renderer ↔ main 之间使用，不进 device-link
  allowlist，也不经远程控制转发。
- **实现与回归**：`packages/auth-client/src/__tests__/client.test.ts`（signup / QR 请求与 payload
  编解码）、Desktop `LoginPage.pr2a.harness.test.tsx`「signup confirmation」、`authIpc.test.ts`、
  `useQrLoginHandoff.test.ts`、Mobile `browserAuthSession.test.tsx`
  「asks before creating an account…」「asks before switching editions…」；服务端
  `signupConfirmation.test.ts` 与 `qrLogin.test.ts`。
