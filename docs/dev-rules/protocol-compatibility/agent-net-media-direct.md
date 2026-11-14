# Agent-Net 附件存储接口与客户端直传（2026-11-14）

> 通用规则见[跨端协议兼容](../protocol-compatibility.md)；多副本背景见
> [官方中转多副本](./agent-net-relay-cluster.md)。

## 背景

附件在客户端端到端加密后，密文原本只能存在中转的本地目录 `mediaDir`，所有字节都经过中转。
官方中转多副本时这个目录必须是各副本共享的卷，副本还要承担全部附件流量。

## 做法

- **存储接口。** `startAgentNetRelay({ mediaStorage })` 接受实现了 `RelayMediaStorage` 的对象
  （`packages/agent-net-relay/src/mediaStorage.ts`，从包入口导出）：`length`、`append(id, offset, data)`、
  `read(id, start, end)`、`remove`，以及可选的 `direct`。未传时用 `createLocalMediaStorage(mediaDir)`，
  与原来的本地目录行为一致；自建中转与单实例不受影响。
  `append` 必须在 `offset` 处原子追加：位置不对抛 `RelayMediaStorageError('MEDIA_OFFSET_MISMATCH')`，
  已有数据短于确认进度抛 `MEDIA_DATA_MISSING`。`direct.append(id, offset, size, md5)` 签发的请求必须让存储拒绝其它请求体、
  长度或位置（中转按 `size` 核对附件大小与配额）；直传请求的有效期不得超过 `DIRECT_GRANT_MAX_MS`（10 分钟），
  超过时中转按存储故障返回 503。存储本身不可用时抛其它错误即可，内核统一转成可重试的
  `503 MEDIA_STORAGE_UNAVAILABLE`（同类告警每 10 秒最多一条），不返回 500。
- **直传。** 存储提供 `direct` 时，`GET /info` 的 `features` 含 `media-direct-v1`，客户端与存储直接收发密文，
  中转只负责鉴权和记录进度：
  1. `POST /media` 请求体带 `transfer: "direct-v1"`；中转同意时响应也带同一字段。
  2. 每一块先 `POST /media/{id}/upload {offset, size, md5}`（`md5` 为该块 Content-MD5，标准 base64）。
     中转核对调用方是所有者、`offset` 等于存储里已有的长度、块不超过 8 MiB，然后返回
     `{request:{method,url,headers,expiresAt}}`：一个绑定这一位置、长度和这块 MD5 的短期预签名追加请求。
     客户端原样发送这块密文，再 `POST /media/{id}/commit`，中转从存储读出实际长度，返回
     `{received, complete}`。进度只以存储中的长度为准；存储写成功但回复丢失时，commit 同样能确认。
     存储中的字节超过声明大小时，中转删除对象并返回 `409 MEDIA_SIZE_MISMATCH`。
  3. 下载时 `GET /media/{id}` 带请求头 `x-agent-net-media-transfer: direct-v1`。中转按原规则鉴权，附件完整时
     返回 JSON `{transfer, size, request}`（响应头带同名标记），客户端带 `Range` 直接读存储；
     读取地址缓存到过期前 30 秒（最多 10 分钟），缓存的地址被拒（403）时重新向中转申请；刚签发的地址被拒则报 `MEDIA_STORAGE_READ_FAILED`，不当作附件内容。
  4. 删除与过期清理仍由中转执行。删除前签发、删除后才到达的写入可能重新建出对象，所以存储支持直传时，删除后附件记录
     保留为已过期（双方都读到 404，不占配额），过期清理比到期多等 `DIRECT_GRANT_MAX_MS` 再删一次对象。
     经中转下载时先打开存储读取再回响应头，存储故障返回 503 而不是断开连接。
- **连不上存储时回退。** 网络只放行中转、不放行存储（企业防火墙等）时，新客户端不能比旧客户端差：
  存储请求没有得到任何响应时，上传经 commit 确认这块未写入后，该附件剩余部分改走 `PUT /media/{id}`；
  下载改发不带直传请求头的 `GET`。此后 10 分钟内该客户端的附件都经中转。存储给出了响应但拒绝时不回退。
- **客户端实现。** Desktop／Node 用 `AgentNetClient`（`packages/agent-net-relay/src/client.ts`），
  Mobile 用 `PortableAgentNetClient`（`packages/agent-net/src/portableClient.ts`）。Mobile 需要宿主传入
  `md5` 选项（`apps/mobile` 用 `@noble/hashes/legacy`）才会申请直传；没有该选项时照旧经中转。
- **安全。** 客户端只接受 https 存储地址（仅当中转本身走 http 时例外），存储请求不得带
  `authorization`、`cookie`、`host` 头（`directMediaRequestValid`）。密文完整性仍由 AES-GCM 与头部 sha256
  保证，存储被篡改只会导致解密失败。设备被撤销后，它已拿到的预签名读取在有效期内仍可用，
  因此存储实现应让读取地址短期有效。

## 混版本与发布

不提升 `RELAY_VERSION`，也不改 `RELAY_CLUSTER_COMPAT`；协商只靠可选字段和请求头，旧端忽略即可。

| | 本地目录（自建、旧中转） | 提供 `direct` 的存储 |
| --- | --- | --- |
| 旧客户端 | 不变 | 中转代为读写存储（`PUT/GET /media/{id}` 照旧） |
| 新客户端 | 会申请直传，中转不同意，照旧传给中转（附件存在中转所在机器上） | 直传；没有 MD5 能力或连不上存储时经中转 |

官方服务的对象存储实现（OSS、V4 预签名、迁移命令）在服务端仓同步 PR 中，本仓内核只定义接口与协议，不含任何对象存储实现。
自建中继（一键部署与本机中转）都以本地目录启动内核，附件存在中继所在机器上，不会同意直传，也不接触官方存储。
集群模式必须提供共享存储：共享 `mediaDir` 或 `mediaStorage`，都没有时拒绝启动（`CLUSTER_MEDIA_DIR_REQUIRED`）。

## 验证入口

- `packages/agent-net-relay/src/__tests__/relay.integration.test.ts`「direct media transfer」：真实中转加本地 HTTP
  对象存储替身（HMAC 绑定位置与 MD5）。覆盖直传上传／下载与 Range（字节不经中转）、旧客户端经中转读写同一对象、
  逐请求鉴权与只认存储长度、回复丢失后 commit 确认、存储故障 503（含经中转下载）、超出声明大小删除对象、
  删除后迟到的写入在授权失效后被清理、缓存读取被拒后重新申请、
  拒绝带 `authorization` 的存储请求，以及存储不可达时上传与下载回退到中转（去掉任一回退即失败）。
- `packages/agent-net/src/__tests__/portableClient.test.ts`：Mobile 客户端的直传、无 MD5 时不申请直传、
  存储不可达时回退到中转。
