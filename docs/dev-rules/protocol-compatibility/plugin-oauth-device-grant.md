# 插件 OAuth 设备码登录（2026-11-24）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

- Ghost manifest 的 `network.secrets[].oauth` 增量增加可选 `deviceAuthorizationUrl`
  （RFC 8628 Device Authorization Grant 端点，https、默认端口、无内嵌凭证，域名必须命中
  `network.hosts`；与 `tokenBroker`、`brokerBounce` 互斥）。客户端正本
  `packages/plugin-protocol/src/manifest.ts` 与 Desktop 镜像 `apps/desktop/src/shared/ghost.ts`
  同步校验，并用同一组有效／无效 fixture 覆盖。归一化输出只在声明时带该字段，且固定插在
  `tokenUrl` 之后：市场能力上限按归一化 JSON 逐字比较，未声明的存量清单输出逐字不变，
  安装批准、权限投影与已连账号都不受影响。
- `authorizeUrl` 仍必填。旧 Host 的 oauth 构造器只保留已知字段，会静默丢掉新字段并退回授权码 +
  loopback 流程；插件作者要么同时保留可用的重定向配置作为旧端降级，要么把 `minCindyVersion`
  设到支持本字段的版本，并在设置页说明需要更新 Cindy。
- 服务端仓同名 `plugin-protocol` 尚未增加本字段前，声明了它的插件只适合本地 `.cindy` 安装；
  市场上架需先完成服务端同步，否则服务端剥掉字段后市场能力上限与真实包不一致，安装会按
  包内容不一致拒绝。
- 权限投影：声明了设备码端点时，`network:secret:<key>` 的 `labelArgs.host` 展示设备码端点域名；
  未声明时仍是 `authorizeUrl` 域名，存量指纹不变。
- 运行时：Host 向设备码端点申请 `user_code`（带 `client_id`，有 secret 时附 HTTP Basic），只接受落在
  设备码端点／授权页／token 端点域名或 `network.hosts` 内的确认页，按服务商 `interval` 轮询
  `tokenUrl`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`，表单带 client 凭证），
  处理 `authorization_pending`／`slow_down`／`access_denied`／`expired_token`。令牌包、保管、刷新与注入
  沿用授权码模式，不新增持久化状态。`device_code`、`user_code` 与令牌不进日志、卡片快照或模型。
- 本机：服务商给了带码确认页（`verification_uri_complete`）时直接打开；只给通用页时由 Host 把
  验证码放进剪贴板（与随包 CLI 设备码卡片的本机行为一致），本单结束时只撤掉仍属于本单的内容。
- 远程与手机：执行端经既有 `authorizationV1` 的 `{kind:'device', url, userCode, expiresAt}` 请求交给
  控制端展示验证码与确认页，不新增 device-link channel 或字段；控制端只回「已打开」，令牌仍由执行端
  轮询领取。旧控制端未协商 `authorizationV1` 时失败关闭，不回退到在执行设备打开浏览器。
- 实现与回归见 `ghostOauthFlow.ts`（`runGhostDeviceFlow`）、`ghostOauthAccounts.ts`、
  `cindy-brain/__tests__/ghostOauthFlow.test.ts`「设备码登录」、`ghostOauthAccounts.test.ts`、
  `shared/__tests__/ghost.oauth.test.ts` 与 `plugin-protocol` 的 `manifest.test.ts`。
