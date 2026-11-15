# X 视频分块转传

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

内联附件受 48 MiB 单帧限制，用不上 X 自身的上限。x-hook-server 的 welcome 增量声明 `x-media-relay-v1`，
客户端在接活时取快照：声明了就用 `x.media.init / append / finalize / abort` 逐段发送，每段等
`x.media.result` 确认，server 立刻转给 X、不落库；成功后把 media id 放进 `turn.end.xMediaIds`。未声明时
继续内联 10 MiB 以内的视频，超限提示未发出。旧 server 不会收到新帧，旧客户端忽略该能力，部署先后不影响。
两仓的共享解析入口核对分段 Base64 字符、补位及解码后大小，4 MiB 可用、多一字节即拒收；不靠总帧上限替代分段限制。
明确停止同时取消该 request 的上传；断线只结束该连接上已开始的上传，不取消 Agent 仍在生成、重连后才开始的上传；
换账号及关闭 dispatcher 才结束全部当前上传，
不重建其他连接、不自动重传。图片和 GIF 仍内联，Telegram 与 Slack 不变，不新增 IPC 或持久化。持久出箱里的 `xMediaIds` 是普通字段，
服务端重放时直接引用，media id 有效期 24 小时。回归见 `hook-control/__tests__/xMediaRelay.test.ts`、
`outbound.test.ts`、`dispatcher.test.ts` 与协议包的 `protocol-x-media.test.ts`。
