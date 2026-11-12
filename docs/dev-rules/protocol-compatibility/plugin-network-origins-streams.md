# 插件网络来源、流与 WebSocket

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- `network.hosts` 的 string 数组增量接受精确 HTTP(S)/WS(S) origin；普通域名维持 HTTPS:443。
  复用原声明、权限行和 receipt，不新增 schema 或批准存储。原客户端会在安装时拒绝新格式，
  使用此能力的包须标明实际支持版本；已装旧插件的规范值与批准范围不变。凭证范围比较按协议、
  主机与端口区分，不能把旧通配域名批准解释为 HTTP 或非默认端口授权。
  自备密钥对公网只注入 HTTPS/WSS；HTTP/WS 限字面量私网/回环 IP、localhost 及其子域。
  按当前每一跳 URL 复用现有分类器、不查 DNS，内网主机名仍须 HTTPS；Host 身份与动态连接边界不变。
  无新 device-link 帧，官方与自建中转无需升级；网络仍在执行 Host 发起。
  `fetch-request.as` 增量增加 `stream`，成功回执可带 `connectionId`；`network-request`
  提供 open/read/send/close，read 返回有界事件、nextCursor、closed 与 resetRequired。
  同一管子服务于 Desktop 与 Node Host；连接留在执行电脑，不是新 HTTP/Webhook 入口。
  Node 私有控制通道新增 `network-request {reqId,request}`，旧引导层不会提供新 API，
  请求序列化上限为 2 Mi 个 JSON 字符，容纳 256 KiB 正文的 JSON 转义与元数据；超限在 Worker 发送前以 `NETWORK_INVALID_REQUEST` 拒绝。
  插件须检测 `cindy.network`。不改 host-tool-request 或 HostToolCaller 的既有签名。
