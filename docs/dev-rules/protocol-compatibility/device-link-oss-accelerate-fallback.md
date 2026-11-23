# Device Link OSS 上传的海外加速兜底

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Device Link 媒体走 OSS 保底中转时，海外设备到 bucket 所在区域的线路可能连不上或超时。服务端可在
`POST /api/device-link/media/presign-put` 的返回里追加可选字段 `accelerateUrl`：用传输加速 endpoint
为**同一 bucket、同一 `key`** 签发的上传地址，签名头与 `putUrl` 相同（`Content-Type` 与
`x-oss-object-acl: private`），过期时间与 `putUrl` 一致。加速流量单独计费，所以只作失败兜底：

- **Mobile**（`apps/mobile/src/session/mobileAttachmentUpload.ts`）：附件 PUT 原本最多两次，第二次
  只在网络错误、超时、408、429、5xx 后发生。有 `accelerateUrl` 时第二次改用它，次数与判定条件不变；
  签名、权限等不可重试的拒绝仍直接失败，不碰加速线路。文件直传与内存字节两个入口都适用。
- **Desktop**（`apps/desktop/src/main/device-link/mediaTransfer.ts`）：普通地址先走原有的 undici →
  Electron net 两栈回退；两栈都只因网络层失败时，才用同一份可重放 body 对 `accelerateUrl` 再走一轮。
  HTTP 拒绝、本地读盘失败和取消都原样抛出。
- 两条线路写同一个对象，返回给对端的 `key`、`presign-get` 下载与 `DELETE /media` 回收都不变。
  客户端不改写域名，只使用服务端签好的原始地址；缺失、无法解析、非 `http(s)`、没有主机名或与 `putUrl` 相同的值一律忽略。
- 日志只记录线路种类与 host，不记录完整地址（签名可直接复用上传）。

兼容与发布：

- 只增加可选响应字段，不改请求、device-link 帧、channel 或持久化 schema。旧客户端忽略该字段；
  新客户端遇到不返回它的服务端，行为与原来逐次一致。服务端与客户端可独立发布。
- 服务端（cindy-server `device-link-server`）通过 `OSS_ACCELERATE_ENDPOINT` 配置加速 endpoint（不含
  bucket 名），未配置时不返回该字段；两区各自配置。bucket 需先开启
  传输加速（开启后约 30 分钟全网生效），未开启时不得配置，否则兜底请求只会多一次失败。
- 自建中转（`packages/device-link-relay`）的媒体地址指向中转自身，不返回 `accelerateUrl`，无需修改；
  客户端按“字段缺失”走原有路径。
- 只覆盖上传。`presign-get` 下载不提供加速地址：加速下载同时产生加速费与外网流出费。
- Mobile 旧版语音转写上传（`mobileVoiceInput.ts` 的 `presign-put`）已无生产调用方，不接入。
