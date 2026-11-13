# 推送传输编码（`push-deflate-v1`，2026-11-11）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

控制端注入了同步 `inflateRawBase64` 解码器时，在同账号 `link-open` 的 `capabilities` 追加
`push-deflate-v1`；被控端只对最近一次入站 link-open 声明了它、且走可靠传输的同账号 peer
编码推送。共享任务、供应商分享等跨账号 peer 既不声明也不编码。编码在
`DeviceLinkClient.sendPush` 出口统一进行：业务 payload 的 UTF-8 JSON 在 256 字节到 512 KiB
之间时，做 raw DEFLATE（level 4），以 `PUSH_TRANSFER_DICTIONARY_V1`（只含字段名、枚举值与固定标记的
ASCII 骨架）作预置字典，base64 加上固定包装后小于原 payload 在可靠层转义后字节数的 0.9 倍才
采用（可靠层把 payload 当 JSON 字符串再转义一次，原文的引号各多一字节），线上形状为
`{ channel, payload: null, transfer: { deflateBase64 }, ownerStamp? }`。`channel` 与
`ownerStamp` 保留明文，可靠层的丢弃、latest-wins 合并与诊断判据不变。每条独立可解，
不跨消息共享状态，丢弃、重放、skip 占位与直连／中转切换都不影响解码。

512 KiB 上限远小于可靠层 4 MB 单消息上限：本来会超限、由 dispatch 改发精简版的超大推送
仍走原兜底，不会因压缩后放得下而把完整正文发给手机；它也限住控制端同步解压的最坏耗时
（Mobile 的 pako 边解边计数，超过 512K 字符即中止；Desktop／Node 的 zlib 限输出 1.5 MiB，解完再核
字符数）。链路被显式关闭后仍可发送的旧路径推送（远控授权、
插件同步等）不编码，对端此时可能已换版本。

控制端在 `emitFrame` 入口先同步还原，再交给直连信令、正文复用与业务；推送因此保持
可靠层的交付顺序。解不开的推送按 handler 失败处理（不 ACK、停住该流），不静默丢掉造成
增量缺口：被控端重试耗尽后走既有链路重置，控制端重新 link-open 并重读快照；本进程内对该
对端不再声明能力，被控端随即把这条及其余压缩推送换成 skip、改发明文，不会反复卡住。warn
按对端限频。能力只跟随入站 link-open：对端在新的 link-open 中
不再声明（降级重装）、出站 accept 显示对端已换 stream（重启，能力未知）、或 accept 找不到
对应的 link-open 声明时，被控端都停止编码，并把仍在 pending 的压缩推送原位换成 transport
skip 占位（链路可发时立即定向补发，否则由建链后的重放推进），旧端不会收到 `payload: null`
的推送；对端下次以控制端身份 link-open 时按声明恢复。

字典按字节参与解码，**发布后不得修改**，所以字典带版本（`PUSH_TRANSFER_DICTIONARIES`）：控制端
在 link-open 声明自己能解的全部字典能力（现在只有 `push-deflate-v1`），被控端选双方都有的最大
id，线上用 `transfer.dict` 标明（id 1 省略，v1 形状不变）；换字典只追加新 id 与新能力名，旧项
保留到不再有对端只认它。`dict` 缺省为 1，出现了却不是正整数或未知时按解不开处理。对端这次不再
声明某个字典时，用它压的积压推送换成 skip，仍声明的字典照常交付。新字典沿用 `deflateBase64`
字段而不换名：误发到旧端时，旧端会解压失败走恢复，而不会把 payload 为 null 的推送交给业务。
旧控制端从不声明，被控端照发原推送；新控制端连旧被控端时收到原推送，按原路消费。
Desktop 与 Node Host 共用 `desktopTransferCodec`（Node zlib，同步，按 5 分钟窗口另记
`push deflate summary`），Mobile 用已有依赖 pako 在 JS 线程同步解码，不改原生指纹。
官方与自建中转只转发 push 帧、不解析 payload，设备签名照常覆盖压缩后的 payload，无需
升级中转程序或修改服务端；`pnpm --filter @cindy/device-link-relay run interop` 已加一条
压缩推送经真实自建中转（含签名）送达并还原的断言。回归见
`packages/device-link/src/__tests__/client.test.ts`「推送传输编码（push-deflate-v1）」与
Mobile `utils/__tests__/gzipBase64.test.ts`「push-deflate decoding」。
