# 组织登录区域路由

Cindy 的中国大陆版与国际版仍是两个独立的安装包和更新通道。组织 SSO 登录可以在
用户提交企业标识后自动发现组织所在的 auth 区域，并让本次登录会话使用该区域的完整
服务端点。

## 两类区域状态

- `buildRegion`：由安装包决定，控制 App ID、URL scheme、品牌、法律链接、网站、
  CDN 与更新通道；运行期不可切换。
- `sessionRealm`：`cn | global`，控制 auth、device-link、oauth-broker、OSS、
  heartbeat、model-access、voice、GitHub、SkillHub、plugin 与 hook 等所有使用
  登录令牌的服务；组织登录成功后一直保留到登出。

两者可以不同。例如，中国大陆安装包可以登录位于 `global` 的组织；它的更新仍来自
中国大陆安装包通道，但组织数据与带 Bearer token 的业务请求全部走 `global`。

## 端点清单契约

区域身份不由远端清单自报，而由构建时注入的受信任地址表决定：

- `*.cindy.com.cn` 对应中国大陆区域；
- `*.cindy.app` 对应国际区域。

构建脚本分别读取 `config/endpoint.json` 与 `config/endpoint.global.json` 的
`cdnBaseUrl`，把当前区域和对端区域的两个清单基址烘焙进客户端。远端
`endpoint.json` 继续使用原有 `schemaVersion: 1` 与业务端点字段，不要求
`region`、`crossRealmOrgLoginEnabled` 或 `realmManifestBaseUrls`。

客户端从某个受信任地址加载到清单后，就把它归入该地址对应的区域，并使用其中的
`authApiBaseUrl` 调用该区 auth-server。discovery 响应仍必须包含 `region`，且必须与
请求的区域一致；这可以防止 CDN 或 auth-server 配错后把组织路由到错误数据面。

## 发现与失败规则

用户提交企业 ID、组织 slug 或已验证域名后，客户端直接并行加载两区清单，分别取出
各自的 `authApiBaseUrl`，再并行调用两区 `POST /api/auth/sso/discovery`。服务端响应
包含自报的 `region`。

- 一区成功、另一区明确返回 `ORG_SSO_NOT_FOUND`：选择成功区域。
- 两区都成功：`ORG_REALM_AMBIGUOUS`，不自动猜测。
- 两区都明确未找到：保留 `ORG_SSO_NOT_FOUND`。
- 任一区超时、不可达、响应非法或区域不匹配：`ORG_REALM_UNAVAILABLE`；即使另一区
  成功也 fail closed。

发现结果与 `buildRegion` 相同时直接进入连接选择，不显示额外确认。发现结果与
`buildRegion` 不同时，客户端显示目标区域，并说明继续后 Cindy 将连接该区域；用户
确认后才进入连接选择并继续 SSO，取消或 reset 会丢弃临时区域。安装包及更新通道仍由
`buildRegion` 固定，无需在确认文案中重复说明。选中的临时区域用于本次 SSO
authorize、callback、授权码兑换、联系方式验证与身份选择。

## 会话持久化与恢复

Desktop safeStorage 和 Mobile SecureStore 都只保存一个加密的原子记录：

```json
{ "version": 1, "realm": "global", "refreshToken": "…" }
```

旧版裸 refresh token 只在一次性迁移时按 `buildRegion` 解释。冷启动先加载并核验记录中
区域的端点清单，再向该区域 refresh；对端清单暂不可用时保留记录供重试，禁止退回
`buildRegion` 发送 token。登出会清除记录和 `sessionRealm`，业务端点恢复安装包区域。

Mobile 的 Pending OAuth 同时保存 `realm`，但 redirect scheme 始终使用当前安装包的
scheme。个人验证码和社交登录不做跨区域发现，也不合并两区 passport。

## Mobile 推送撤销

Mobile 按 `sessionRealm` 分别保存推送注册与待注销状态。登出、换账号或换区域时，
客户端会在替换 Access Token 和业务端点之前，用旧 Token 向旧区域现有的鉴权接口
`DELETE /api/device-link/push-token` 发起 best-effort 撤销；请求同时携带本机 APNs token，
便于同一区域内清理同一安装留下的旧账号记录。

撤销失败不能阻断退出或登录。待注销标记仍绑定原区域，并且只会在客户端以后重新持有
该区域登录态时重试；CN Token 不会发送到 Global 端点，Global Token 也不会发送到 CN
端点。两区 device-link-server 不互相信任、不互查数据，也不需要新增跨区鉴权端点、
数据库字段、密钥或环境变量。

## 上线与回滚

按以下顺序发布：

1. 先升级中国大陆和国际 `auth-server`，确保 discovery 响应都包含正确的 `region`。
2. 确认两区 `endpoint.json` 均可公网访问，且各自 `authApiBaseUrl` 指向同区域的
   auth-server。
3. 发布包含双区域可信清单地址的 Desktop 与 Mobile 客户端；device-link-server 无需
   为区域路由增加部署步骤。
4. 用同区组织和跨区组织各验证一次发现、确认、登录、冷启动恢复与登出；Mobile 还需
   验证换账号或区域时，旧区域在新会话提交前收到推送撤销请求。

需要紧急回滚新的组织发现能力时，应通过客户端版本回滚或客户端级开关处理，不能删除
任一区域清单；已建立的跨区会话仍需要按保存的 `sessionRealm` 加载原区域端点并刷新
token。
