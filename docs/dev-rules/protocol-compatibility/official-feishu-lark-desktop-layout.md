# 官方飞书 / Lark 由电脑排版（2026-11-10，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

官方飞书的进度卡与成功终稿原先由服务端排版，服务端那份是个人飞书 bot 卡片代码的移植，长回复仍在
30 KB 处截断，呈现上的任何改进都要两仓各做一遍。现在与官方 Telegram 一样把内容面上收客户端：桌面端
用个人飞书 bot 同一份排版（`@cindy/im` `feishu/streamingText.ts`）生成卡片，经 `msg.op` 交给服务端执行。

两个双向能力，只在飞书连接上声明，都要求同时协商 `msg-op-v1`，各自独立生效：

- `feishu-progress-ops-v1`：进度卡经 `purpose: 'turn-progress'` 的 `send` / `edit` 驱动。`turn.progress`
  照发，只用于续期。
- `feishu-final-ops-v1`：不带附件的成功终稿经 `purpose: 'turn-final'` 的 `send`（带 `finalPart`）发布。
  `finalPart = 0` 由服务端落在这一轮的进度卡上（没有或改不了时新发），其余依次新发。全部确认后
  `turn.end` 带 `clientFinal: { complete: true }`，服务端不再排版；否则服务端撤掉桌面端另发的后续卡片
  并照旧发布完整终稿。

线上不新增字段，只约定语义：这两个 purpose 下 `action.text` 是序列化后的飞书卡片 JSON（schema 2.0），
不带 `tier` 与 `buttons`；服务端拒收含按钮、表单等回调组件或超过 30 KB 的卡片（`UNSUPPORTED_PARAMETERS`）。
`msg.op.result` 的 `errorCode` 沿用 `MESSAGE_OP_ERROR_*`，`channelErrorCode` 透传飞书业务码。两仓现有
解析器都不需要改：服务端协议包原样放行 `purpose` / `finalPart` / `clientFinal`，能力名在服务端以同值常量
镜像（`feishu-hook-server/src/feishu/clientOps.ts`），客户端协议包新增 `HOOK_FEATURE_FEISHU_PROGRESS_OPS` /
`HOOK_FEATURE_FEISHU_FINAL_OPS` 两个常量。

幂等：建卡在拿到定案回执前沿用同一个 `opId`；服务端按 `opId` 去重，并把由它派生的 `uuid` 交给飞书
（1 小时内同一 `uuid` 至多发出一条），回执未知后重发或重连到别的实例都不会多出卡片。终稿卡片回执未知时
同 `opId` 同内容最多原样重发 2 次，仍未知就以 `complete=false` 交回；限速按 `retryAfterMs` 等待后换号重发。

兼容与部署顺序：全部是可选增量，任一侧缺席时行为与此前逐字相同——旧桌面端连新服务端不声明能力，
照旧由服务端排版；新桌面端连旧服务端收不到宣告，继续发 `turn.progress` / `turn.end`。因此两仓可以独立
上线，没有先后要求；只有两边都上线后才切到电脑排版。没有数据库迁移、环境变量、Mobile 冷更、
Device Link 或自建中转变化。仍由服务端排版的部分：确认卡、失败 / 取消的终稿、带附件的终稿（图片要用
机器人凭证上传）——后者仍受单卡 30 KB 截断。实现见 `hook-control/feishuTurnCarrier.ts`、`dispatcher.ts`
的轮次载体与服务端 `docs/feishu-hook-server.md`「出站排版」。
