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

邮箱入口在用户提交完整邮箱后，也会提取并小写化域名，复用上述双区组织发现；不会在
逐字输入时请求，也不会向对端发送完整邮箱。跨区命中时，复用现有目标区域确认文案，
确认后提供该企业的 SSO 连接，同时保留个人邮箱验证码选项。个人验证码始终走安装包
区域；确认企业区域不会把个人账号、验证码或社交登录迁往另一地区。

同区企业继续使用原有邮箱 discovery 的登录方式列表；两区都明确未找到时继续普通
邮箱登录。歧义、网络故障和非法响应仍遵守上面的失败规则，不当作未找到而自动发码。
服务端现有 `POST /api/auth/sso/discovery` 已支持已验证域名、企业名称、区域和启用的
SSO 连接，无需改接口。未验证域名、未启用 SSO 的企业不在本次发现范围内。
实现见 `packages/auth-client/src/emailLoginDiscovery.ts`，回归见同目录
`__tests__/emailLoginDiscovery.test.ts`。

## 本次个人登录后的企业提示

Google、Apple、邮箱/手机验证码、补绑和身份选择等新登录，统一在收到最终个人
membership 后检查邮箱域名（Desktop `finishFreshLogin`、Mobile `acceptOutcome`）。
只使用服务端返回的邮箱；已通过邮箱入口完成发现的同一邮箱不重复提示。已是企业身份、
没有有效邮箱、冷启动恢复、刷新 token 和切换已保存账号不触发此提示。

发现可用企业时，同区和跨区均显示区域及两个选择：使用企业 SSO，或继续刚完成的个人
登录。个人登录结果仅暂存在 main / AuthContext 内存，UI 状态只有发现信息和可继续标记。
继续个人登录直接提交原结果和原区域；选择企业 SSO 则丢弃临时个人结果，并在企业区域
重新授权。不会把个人 token、Google/Apple 凭据或两区 passport 互相转移。

此阶段的发现属于可选提示：未找到、歧义、限流或网络失败都保留原个人登录，不猜测
企业区域。取消本次登录或开始新流程后，迟到发现结果不能恢复旧登录。此规则只适用于
已经成功的个人认证；用户主动提交邮箱或企业标识时仍执行前述严格发现规则。

## 会话持久化与恢复

### 清单服务不可用时的恢复

Desktop 启动、Mobile 启动和两端跨区域恢复使用同一套发现策略：

1. 主清单在线优先，单次预算 2.5 秒。
2. 主源发生传输错误、5xx、407/408/425/429 时，可尝试一个构建期配置的本区备用入口，
   同样最多 2.5 秒。主源的 JSON/schema/非法 URL/错区域或永久 HTTP 配置错误仍阻断；
   备源失败或配置不兼容则跳过，继续使用可信本地清单。
3. 在线来源不可用时，读取本区最近成功的持久清单；读取后重新校验 schema、来源 URL
   和按区域限定的受信任端点域。Desktop 兼容读取旧单文件缓存，新写入按区域分文件；
   Mobile 按区域和清单 URL 分键保存公开配置，不存凭据。在线清单也须满足同一离线信任
   判据才写入缓存；含非 Cindy 业务端点的自定义清单仅在线使用，不缓存、不扩展信任域。
4. 没有有效缓存时，官方源使用随包的对应区域完整清单。自建、开发和显式自定义来源
   不会被官方生产地址替代。随包清单直接来自两份仓内正本，没有第二份业务地址真相源。

每次解析只选择一份完整快照，不合并新旧字段，不把回退结果重新保存为在线成功缓存。
网络或存储故障不清除登录凭据；端点解析成功之后仍走正常的认证与账号代次校验。
缓存读写的异步等待各有 500ms 上限；Desktop 沿用同步文件 IO，该上限不能中断同步调用。
迟到的网络结果不改变已激活的端点。后续启动重新尝试在线清单；本次会话不在后台偷偷
切换认证服务。

备用入口登记在 `config/endpoint-manifest-mirrors.json`，每区最多一个 HTTPS
完整清单 URL，随 JS 构建进入两端，不能从下载清单或用户缓存读入。空数组表示该区尚未
登记备用服务。默认复用官方 GitHub 仓库的两份原始清单，使用 GitHub 的文件分发路径，
不经过 hotfix 节点。主分支合入清单即更新备源，不需要维护第三份清单副本；发布时仍须
同步 hotfix，避免主备配置漂移。GitHub 在部分网络不可达，或 main 清单升级后与旧客户端
不兼容时，继续走缓存/随包兜底，不接受不兼容备源内容。
替换入口前须实际部署并确认与 hotfix 的 CDN/源站故障域独立，同步发布对应区域的
完整清单；不能拿另一地区的认证服务当备站。

旧清单的代价：故障期间无法立即收到端点迁移或审核/更新元数据调整。退役旧认证域前，
需协调仍在分发的客户端随包清单；仅修改线上清单不保证失联客户端立刻停止使用旧地址。
认证吊销仍由认证服务执行，离线清单不授予离线登录权限。更新身份仍跟随构建区域，
跨区域恢复不改更新器字段语义。

实现：`packages/maker-shared/src/clientEndpointResilience.ts` 与两端的
`endpointManifestLoader.ts`。回归覆盖共享故障矩阵、两端持久缓存恢复和手机首启无缓存。

### 认证记录

Desktop safeStorage 和 Mobile SecureStore 都只保存一个加密的原子记录：

```json
{ "version": 1, "realm": "global", "refreshToken": "…" }
```

旧版裸 refresh token 只在一次性迁移时按 `buildRegion` 解释。冷启动先加载并核验记录中
区域的端点清单，再向该区域 refresh；对端清单暂不可用时保留记录供重试，禁止退回
`buildRegion` 发送 token。Desktop 在 refresh 返回组织 membership 后才允许激活跨区业务
端点；个人 membership 只有在 `sessionRealm === buildRegion` 时才能恢复。跨区个人
session 被拒绝时，Desktop 仍把轮换后的 refresh token 写回原 realm，但保持未登录且不
删除记录，避免破坏共享 userData 中另一实例仍在使用的会话。登出会清除记录和
`sessionRealm`，业务端点恢复安装包区域。

Mobile 的 Pending OAuth 同时保存 `realm`，但 redirect scheme 始终使用当前安装包的
scheme。个人验证码和社交登录固定使用安装包区域，也不合并两区 passport；邮箱提交时
新增的域名发现只为引导企业 SSO。

## 模型访问与媒体目录边界

Desktop 的 model-access 身份由 `(userId, sessionRealm)` 共同确定。登出、换账号或
同账号切换 realm 时，客户端立即清空旧 XD 动态模型清单，作废旧身份在途的凭据与
`/models` 响应，并从当前 realm 重新同步；迟到响应不得写回凭据或覆盖新区域模型。

XD 媒体能力属于 `buildRegion` 产品能力，不随组织 `sessionRealm` 跨区扩张。
Global 构建保留目录中的完整图像与视频清单；中国大陆和 dev 构建会同时投影动态
agent 清单里的媒体能力组与静态媒体清单：不暴露图像模型，视频仅暴露
`seedance-fast` 与 `seedance-pro`。设置页、模型停用成员校验和 Cindy 媒体运行时
都消费 main 侧同一投影策略，Renderer 不另做隐藏。

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
