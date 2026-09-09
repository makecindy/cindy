# Mobile 任务消息内存治理方案

状态：已实现（2026-08-15）

## 1. 背景与目标

Mobile 的任务详情此前把完整消息长期保存在进程级 `remoteSessionStore`，并通过
AsyncStorage 缓存最新一页。浏览大量任务、持续接收流式消息或遇到超大工具输出时，
消息正文会在 JS 堆中持续累积；定时任务又会自动产生大量很少再次打开的会话，放大
驻留问题。

本方案只治理 Mobile 的完整消息正文与紧邻的运行时投影，不改变 Desktop、共享协议、
数据库 schema、原生配置或依赖。

交付目标：

- schedule 任务只在当前可见详情驻留完整消息，隐藏后最终回收到 0；
- regular 任务离开详情后压回最近一页，全局约 800 条或 64 MiB；
- 当前详情、运行中、待处理交互、排队输入、草稿和本地在途工作不被误回收；
- 失焦、切任务、切后台后，旧异步读取和旧订阅不得在重新聚焦后复活正文；
- 内存淘汰与磁盘缓存删除使用不同语义，不因 `messages=[]` 误删 regular 缓存；
- 本地系统卡、乐观用户行和未落库的 assistant 行优先保留。

## 2. 边界

本次改动限定在 `apps/mobile/**`：

- 不修改 device-link wire protocol；
- 不修改 Desktop 或服务端；
- 不修改 Mobile 原生配置、原生依赖与 runtime fingerprint；
- 不引入轮询、TTL 或后台常驻定时回收器；
- 不把消息正文迁移进新的数据库。

## 3. 分类

分类是创建来源决定的二分类：

| 分类 | 判据 | 隐藏后的目标 |
| --- | --- | --- |
| `schedule` | `session.source === 'scheduler'` | 完整消息最终为 0 |
| `regular` | 其它情况，包括 source 缺失 | 最近 80 条软窗口 |

不使用 schedule 索引或标题前缀。索引会晚到且同时包含“schedule 创建”和“绑定既有
任务”；标题可被用户修改。source 缺失时按 regular 保守处理，方向是多驻留而不是误
回收。

## 4. 生命周期与写权限

每个会话拥有单调递增的 `generation`：

1. 详情获得焦点且 App 在前台时 `enter(sessionId)`，生成新 authority；
2. 失焦、切任务或 App 进入后台时 `leave(sessionId, reason, authority)`；
3. leave 先递增 generation、撤销可见性，再考虑是否可以回收；
4. 页面 `listMessages`、around-message、自动补历史在请求开始时捕获 authority；
5. 断线重读对已进入过详情的任务同样捕获 authority；从未打开的 regular 只在响应返回时
   仍未进入详情、且仍归属原设备时更新全局镜像；
6. 携 authority 的异步响应提交时必须同时满足 sessionId、generation、visible 三项仍一致。

旧 cleanup 也必须携带自己的 authority。这样 A1 失焦、A2 重新聚焦后，A1 的 cleanup
和响应都不能影响 A2。

完整消息 push 的规则：

- schedule 非当前详情拒绝正文 push；
- regular 曾经离开详情后拒绝旧订阅 push；
- 从未打开的 regular 保留全局消息镜像，但补读期间一旦 enter、leave、forget 或设备归属
  变化，旧响应即拒绝；
- 页面离场但本地工作尚未收口时，允许必要的乐观/对账写入，排空后统一回收；
- status、live activity、通知摘要等轻量事实不依赖完整消息 authority。

## 5. 本地工作与延迟回收

页面通过常驻 controller 持有工作租约，报告以下同步事实：

- outbox 条目；
- 附件上传与粘贴占位；
- `send()` 同步在途；
- enqueue 未落定；
- 已出队但消息尚未回流；
- composer 附件托盘。

页面聚合租约只反映当前组件内的同步状态。`send()` 的异步发送作用域和每一条 outbox
dispatch 都会另外获取一份 active 租约，并只在各自的 `finally` 中释放；因此页面卸载
释放聚合租约时，不会把仍在等待上传、enqueue 或对账的异步工作误判为已结束。

Store 另外保护：

- `inputProjection.pendingQueue`；
- 运行中状态与 maker turn；
- pending interaction；
- regular 的文本草稿、富文本草稿和引用。

回收请求若遇到保护事实，只记录 pending，不在页面 effect 内轮询。页面卸载后租约仍按
cleanup 收口；最后一份租约释放或 Store 保护状态归零时，在 microtask 中重试。若期间
重新聚焦，新 generation 会取消旧 pending reclaim。

## 6. 窗口与预算

### 6.1 单会话窗口

- schedule 当前详情始终保持一个 80 条软窗口，不提供“加载更早”；
- regular 在详情内仍可加载历史，离开详情时压回 80 条；
- 以下行优先保留，必要时可使软上限略微超出：
  - `mobile-system-*` 本地系统卡；
  - 未落库的 live assistant；
  - 尚无服务端 id 的乐观 user 行。

### 6.2 regular 全局预算

regular 完整消息的软预算为：

- 约 800 条；或
- 估算 64 MiB。

任一维度超限时，按最近访问顺序淘汰非保护任务。字节估算包含 content、agentMeta、
systemCardData 与固定结构开销，只用于量级保护，不作为精确内存统计。

LRU 只删除内存消息与相应连续性结论，不删除 AsyncStorage 缓存。

LRU 是整窗淘汰：只要某个候选任务仍含本地系统卡、乐观用户行或未落库 assistant 行，
就跳过整个任务，避免把不可重取行单独留下后又被缓存 hook 误当成完整窗口落盘。

regular 离场压窗和 LRU 淘汰都会释放 live plan、task update、parked task update 与 input
projection，并抬升 input projection authority epoch，阻止离场前启动的慢查询污染下次打开。

## 7. 缓存语义

缓存与内存驻留分离：

- regular：可读取、去抖写入最新窗口；
- schedule：不读取、不写入，识别后定点删除存量缓存；
- 空内存快照不再自动等价为删除磁盘缓存；
- 远端删除、权威空窗与 schedule 回收使用显式删除；
- 同一缓存 key 的 set/remove 串行，避免较早开始的写在较晚删除后完成并复活正文；
- 登出全清期间禁止铸造新缓存写权，避免 `getAllKeys` 取完快照后的卸载 flush 创建漏删 key；
- hydrate、debounce 回调和卸载 flush 都在提交前二次检查 retention；
- 缓存归一化同样保护窗口外的 `mobile-system-*`。

## 8. 页面行为

- focus 与 AppState 分别上报，二者都满足才授予可见 authority；
- 从后台回前台时 regular 与 schedule 都重新登记当前详情并补一次同步；
- schedule 隐藏“加载更早”入口，并拒绝程序化翻历史；
- 页面不自行拼接消息清理步骤，只上报生命周期与本地工作事实。

## 9. 验证矩阵

自动化覆盖：

- blur → refocus 后旧代际拒写、新代际可写；
- 旧 cleanup 不撤销新 authority；
- 页面卸载后最后一份工作租约释放仍能回收；
- 重新聚焦取消旧 deferred reclaim；
- schedule 失焦归零且迟到 push 不复活；
- regular 离场拒绝旧订阅与旧流式 flush；
- 从未打开的 regular 重连补读可写；请求期间首次进入、已离场 regular 与从未打开的
  schedule 均拒绝旧补读；
- pending queue 排空触发补回收；
- regular 压窗保留本地系统卡；
- regular LRU 保护当前详情并压回约 800 条；
- async send 与 outbox dispatch 使用跨页面卸载的独立工作租约；
- regular 离场/LRU 释放详情投影并拒绝旧 projection 回写；
- regular LRU 跳过仍含不可重取行的整个任务；
- source 晚到改判 schedule 后压窗并清缓存；
- schedule 删除消息不持久化剩余正文；
- regular LRU 不删除磁盘缓存；
- 缓存写/删乱序最终以删除为准；
- 显式空窗、内存已淘汰后的删除 push、登出全清都不会被旧在途写复活。

已执行（2026-08-15）：

- `pnpm --filter mobile test`：301 个测试文件通过、1 个跳过；3514 个测试通过、9 个跳过；
- `pnpm --filter mobile test:scope`：通过；
- `pnpm --filter mobile test:smoke`：2 个测试文件、2 个测试通过；
- `pnpm --filter mobile run --if-present typecheck`：通过；
- `pnpm test:unit:related`：Mobile related unit 通过。

模拟器验证项目见架构文档的交付检查清单；未执行的项目必须在 PR 中如实说明。
