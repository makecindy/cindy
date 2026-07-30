# 个人微信 IM 发布与熔断操作清单

本文供 release、安全和 on-call 使用。技术实现完成不代表已满足外部授权；法务发布门禁见
[`docs/legal/wechat-personal-im-compliance.md`](./legal/wechat-personal-im-compliance.md)。

## 1. 生产配置

生产配置位于：

`apps/desktop/src/main/im/wechat/compatibilityPolicy.ts`

只允许通过 code review 修改以下内置值：

- `manifestUrl`：固定 HTTPS JSON 地址，不允许 query、fragment、用户信息或运行时覆盖；
- `publicKeySpkiBase64`：独立 Ed25519 公钥的 DER/SPKI Base64；
- `trustedHelpUrlPrefixes`：固定 HTTPS origin 与 path 前缀。

当前三个值为空，因此兼容策略不会联网并保持 fail-open。这是有意的发布阻塞状态。
不得使用环境变量、endpoint manifest、更新器密钥或服务端动态配置替代这些内置值。

私钥必须由安全团队离线保管，不能进入：

- Git、CI 变量导出、构建产物或日志；
- Cindy 更新器签名系统；
- Desktop 用户数据目录；
- manifest 托管服务。

## 2. Manifest 契约

- 最大响应：32 KiB；
- Content-Type：`application/json`；
- 请求：`GET`、`no-store`、禁止重定向、10 秒超时；
- 时间字段：Unix epoch 毫秒；
- `sequence`：正整数，必须单调递增；
- `action`：只允许 `disable`；
- 版本范围：闭区间 SemVer；
- `reason`：最长 64 字符的稳定小写诊断码；
- `helpUrl`：只能命中内置 HTTPS origin/path 前缀；
- `signature`：标准 Base64 Ed25519 签名。

签名 payload 是移除 `signature` 后的对象，使用递归 key 字典序、无空白的 canonical JSON。
实现导出的 `canonicalizeWechatCompatibilityManifestPayload` 是唯一签名基线。发布脚本在进入
生产前必须用与该函数相同的测试向量做互操作验证。

Manifest 只能停用授权、轮询和发送。它不能：

- 修改腾讯或 Cindy endpoint；
- 修改 header、协议字段、消息或权限策略；
- 下发代码、脚本、证书或新的公钥；
- 删除凭证、会话、设置或用户文件。

## 3. 停用演练

1. 在隔离环境生成测试 Ed25519 key pair，只把公钥写入测试构建。
2. 发布不命中当前版本的 sequence N manifest，确认功能保持可用。
3. 发布命中当前版本的 sequence N+1 manifest，确认：
   - UI 进入“已被兼容策略停用”；
   - 正在进行的授权取消；
   - poll/send 停止；
   - 凭证、设置、会话和工作目录仍保留；
   - 解绑仍可执行。
4. 发布篡改签名、未知字段、恶意 help URL、超大 body 和低 sequence 样本，确认全部拒绝且
   最后一个有效策略不被覆盖。
5. 断网重启，确认未过期缓存继续生效。
6. 等缓存过期或用更高 sequence 的不命中 manifest 恢复，确认功能重新连接。
7. 核对日志只有稳定错误码和脱敏缓存路径，没有 URL、response body、token 或签名材料。

## 4. 跨平台发布矩阵

- [ ] Windows：绑定、扫码确认、重绑、解绑。
- [ ] macOS：绑定、扫码确认、重绑、解绑。
- [ ] Light 与 Dark 设置页目检。
- [ ] 文本、图片、语音、文件、视频。
- [ ] 断网、网络恢复、stale token、30 分钟 backlog。
- [ ] 应用重启后的 inbox/outbox 恢复。
- [ ] permission 确认窗口关闭/重开。
- [ ] manifest disable、缓存、过期、恢复与 sequence rollback。
- [ ] 安装包 NOTICE/SBOM。

## 5. 回滚

协议异常时只发布更高 sequence 的 `disable` manifest，不远程热修协议。代码修复仍走正常
PR、签名构建和发布流程。若 manifest 服务不可用，客户端 fail-open；严重事件必须同时通过
正常版本发布修复，不把熔断服务当作更新器。
