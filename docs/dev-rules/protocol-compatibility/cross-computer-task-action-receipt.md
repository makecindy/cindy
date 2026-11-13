# 跨电脑任务行动回执

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:session:handoff` 增量支持 `task-action-capability` 与 `validate-task-action`。
新发送端先查询 `taskActionVersion: 1`，再发送带 Host 生成 `taskActionReceipt` 的消息；
缺能力时明确拒绝，不回退到旧发送方式。新接收端拒绝缺回执的旧请求，要求发送端更新。
完整任务互发需要两台电脑均升级；同账号鉴权、隐藏任务和共享访客限制不扩大。

回执只存在发送 Host 内存，绑定接收设备、发送任务、目标任务与正文，最长一小时；
接收端一次认领，强制经队列，在消费前回调发送 Host 复核。
确定未发送的本机失败或目标明确未接受时，发送端立即释放回执，避免离线尝试耗尽容量；
在途断连、超时、远端写后回执查询失败和无法识别的结果保留原有效期，不自动重发。
队列派发或丢弃后通过同一 `validate-task-action` 请求的可选 `release` 标志释放回执；
发送端删除回执后返回 `released: true`，重放无法通过验证，接收端才清除认领。
旧端没有该确认或未收到释放回执时保留原过期清理，不把旧端的普通验证成功当作释放成功。断线、撤销、账号切换或重启后
无法复核时不投递，不自动重放；已送达历史保留。未知投递结果仍要求先读取目标核实。
没有新 relay channel、服务端变更、数据库 migration 或 Mobile 原生指纹变化。

## 转达原话的核实标记（2026-10-23）

`maker:session:handoff` 与伙伴跨电脑私信的 `requestSource` 增加可选 `ownerVerified: true`：发送端只在宿主
核实为主人代办的轮次里转达时携带。接收端经 `readForwardedRequestSource` 只认字面量 `true`，并继续用
`matchesForwardedRequest` 校验正文；正文三行格式不变。旧接收端忽略该字段，行为与之前相同；旧发送端
不发送，新接收端按未核实处理。同账号鉴权、行动回执与共享访客限制不变。产品语义见
[伙伴代表谁](../../product-rules/teammate-authority.md)。

## 跨任务委派的原文正文（2026-11-05）

新版发送端的跨任务正文是 Agent 写的原文，回执 `requestSource` 增加可选 `plainBody: true` 与 `delegatedText`
（仅在发送端这一轮代表用户时出现，并与正文逐字相同；2026-11-08 起不再另经发送端审核）；`plainBody` 回执不再携带 `userText`，
只保留原请求出处的 `sessionId` / `clientId`；`delegatedText` 存在本身就是用户授权，不再另带 `ownerVerified`
（它只留在发给旧接收端的包装回执里）。`matchesForwardedRequest` 对 `plainBody`
只接受 `delegatedText === 正文`；三行包装与最初中文格式的校验、显示解码全部保留。

- `maker:session:handoff` 的 `task-action-capability` 回答增加 `plainRequestBody: 1`。发送端只在看到它时发原文与
  新回执；旧接收端收到的仍是改动前的三行包装与原话回执，逐字校验照旧通过。
- 伙伴跨电脑私信没有能力探测，且接收端按发送端存下的正文核对发件人，发送端暂时继续发旧格式。
  （2026-11-08 起 V2 不再适用：伙伴私信已移除，伙伴之间改用 `maker:session:handoff`。）
- 接收端 Auto 审核经 `verifiedOwnerRequestText` 读 `delegatedText`；旧发送端的回执没有 `plainBody`，
  继续以 `userText` 为意图。旧接收端的回退包装由发送端从自己当前的输入读原话生成，转过一手的委派读不到原话，
  回退为不带回执的普通正文。
- 本机持久化的队列与委派快照可选携带新字段；旧版本读到缺少 `userText` 的回执时按无效回执处理（不授权），
  不需要迁移。
  没有新 relay channel、服务端变更或数据库 migration。产品语义见
  [消息来源](../../product-rules/message-source.md#跨任务委派代办轮的转交带授权正文是原文)。

## 普通任务远程创建与项目发现（2026-11-11）

同一 `maker:session:handoff` 通道增加 `ordinaryCreateVersion: 1`、`projectCatalogVersion: 1` 能力。
新发送端先探测；旧接收端没有能力时不发送创建请求。旧的既有任务投递与 `plainRequestBody` 协商不变。

- `action: create` 携带预分配 UUID、普通创建选项 `create`、原有正文与来源回执。
  模型、项目与工作目录在接收端解析；权限档由发送宿主读取来源任务，不能由工具参数指定。
  不携带 Worker、父任务、Bot 关系或自动回传配置。
- 行动回执增加可选 `operation`，创建时为严格解析后的完整配置序列化结果。接收端在准备与首次
  持久化前核对原宿主回执，防止同一正文被换成不同目录、模型或权限档。
- 同一回执只能认领一次；UUID 已存在时不修改、不重发首条消息。已建任务后的发送失败返回
  `CREATED_NOT_DELIVERED`，无法确定持久化结果返回 `DELIVERY_UNKNOWN`，工具保留 qualified ID
  供读取记录与队列；不自动重建。创建成功后首条消息沿原有普通输入队列消费。
- `action: list-projects` 只读目标账号已有项目，使用已有分页与隐藏项目标记。只对同账号远控开放，
  不经 preload 暴露、不给共享访客开放。无新 channel、relay 载荷类型、服务端或数据库 migration；
  自建中转仍透传原有加密 invoke，对新旧两端都不增加中转要求。
