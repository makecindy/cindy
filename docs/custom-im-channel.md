# 自定义 IM 渠道（本机 HTTP）

> 读取时机：修改自定义渠道的端点、鉴权、token 存储、会话分线，或在设置页／伙伴页
> 增加新入口前。

## 它是什么

在「设置 → IM 机器人 → 自定义渠道」或「伙伴 → 消息平台 → 自定义渠道」里添加一条
连接，用户自己的系统就能用 HTTP 与 Cindy 伙伴收发消息。没有平台账号，也没有绑定流程。

## 协议

入站（外部系统 → Cindy）。不占端口，监听在 Unix domain socket 上：

    curl --unix-socket <socketPath> \
      -X POST http://localhost/im/custom/<connectionId>/inbound \
      -H "Authorization: Bearer <token>" \
      -H "Content-Type: application/json" \
      -d '{"conversationId":"order-42","text":"把这周的订单汇总成表"}'

请求体字段：conversationId（必填）、userId、userName、text（必填）、attachments
（每项 absPath 必须是本机绝对路径，可带 name / mimeType）。

Windows 上是 named pipe，路径形如 \\.\pipe\cindy-im-<hash>，发现文件里照原样给出。

出站（Cindy → 外部系统），配置了回调地址时：

    POST <callbackUrl>
    Authorization: Bearer <token>

    {
      "conversationId": "order-42",
      "text": "已生成对账单",
      "terminal": "done",
      "attachments": [{ "absPath": "/abs/path/result.xlsx", "name": "result.xlsx" }]
    }

conversationId 是会话维度键：同一个 id 复用同一间 Cindy 会话，不同 id 互不干扰。

## Socket 与 token

- 不监听 TCP 端口：macOS／Linux 用 <userData>/im-custom/cindy.sock，Windows 用
  named pipe。路径固定，重启不变，也没有端口占用问题。
- socket 文件权限 0600（显式 chmod，不受 umask 影响）；同一路径已有实例在服务时，
  启动报 CUSTOM_ENDPOINT_SOCKET_IN_USE，不会误删别人的 socket。
- 崩溃残留的 socket 文件在启动时先探活，确认没人监听才清理。
- 发现文件：<userData>/im-custom/endpoint.json（目录 0700、文件 0600），只含
  socketPath，不含 token。
- token：每条连接一把，32 字节随机 hex，存 safeStorage 的
  bot-im-<connectionId>-custom-channel-token；密钥环不可用时拒绝保存（fail closed）。
- 跨机需要自己转发 socket（例如 ssh -L 或 socat），本机不开放网络监听。

## 安全边界

- token 用常量时间比较；请求体上限 1 MiB，超限 413。
- 回调地址写日志前脱敏（去掉 userinfo 与 query）。
- 附件只接受本机绝对路径，不做 base64 搬运。
- 自定义渠道消息的会话来源是 custom，在侧边栏「对话」分组可见可停。

## 附件

入站（客户端 → Cindy）：

    {
      "conversationId": "cli-1",
      "text": "看下这个文件",
      "attachments": [
        { "absPath": "/tmp/report.xlsx", "name": "report.xlsx", "mimeType": "application/vnd..." }
      ]
    }

- absPath 必须是本机绝对路径；图片（png/jpeg/gif/webp）作为 image block 进模型，
  其它文件作为 file block。
- 终端客户端用 /file <绝对路径> [说明] 和 /image <绝对路径> [说明] 发送。

出站（Cindy → 客户端）：

- 终稿里的 xdt-file 引用会被剥离成正文附件，xdt-image / tool_result 图片走
  mediaAbsPaths；两者都会出现在回调的 attachments 里：

      { "absPath": "/tmp/out.txt", "name": "out.txt" }

- 附件按绝对路径交付，客户端与本机同侧时直接读；跨机需要自己转发文件。

## 伙伴页的连接

自定义渠道的 token 由 Cindy 生成并仅展示一次，连接从本机设置页／伙伴页创建，
不进入逐格输入凭证的 `im-<channel>` 授权卡。授权卡保留原有五个平台。
个人自定义渠道管理接口不属于远程伙伴设置目标；远程页面不读取本机个人渠道，
也不收取或传输 token。伙伴已有连接的远程列表、移除与专线操作沿用主干接口。

伙伴页里的自定义连接和其他 IM 渠道同一套落点规则：

- 配置了 ownerConversationId 时，这个 conversationId 走伙伴主任务（Bots 面板可见）；
- 其余 conversationId 各走一条隐藏专线（route key 形如
  im:custom:&lt;botContextId&gt;:dm:&lt;conversationId&gt;）；
- 不配置则全部走专线。

## 相关代码

| 关注点 | 位置 |
|---|---|
| 传输层（token 校验、出站回调） | packages/lizi-im/src/custom/CustomIM.ts |
| 回环端点与发现文件 | apps/desktop/src/main/im/custom/endpoint.ts |
| 端点/token 存储、连接注册 | apps/desktop/src/main/im/custom/runtime.ts |
| 设置页那份(无伙伴)的记录与运行时 | apps/desktop/src/main/im/custom/personalStore.ts、personalRuntime.ts |
| 编排适配（conversationId 分会话） | apps/desktop/src/main/im/custom/adapter.ts |
| 设置页 UI | apps/desktop/src/renderer/components/settings/CustomChannelSection.tsx |
| 伙伴页入口 | apps/desktop/src/renderer/features/bots/BotChannelsPage.tsx |
