# Pi 成功正文交付：#3696 取证与加固

核查日期：2026-09-09；代码基线：`56c0e5002`。

## 已有证据与未定案部分

[#3696](https://github.com/makecindy/cindy/issues/3696) 报告 Windows Global
`0.1.70-hotfix` / Pi `0.84.4` 的一轮只显示 thinking。用户直读 SQLite 确认故障轮
只有 thinking 行，Pi JSONL 则有 thinking 与完整正文、`stopReason=stop`；健康轮的
各类消息均有记录。

这是已产生正文未交付的证据，但不足以证明哪一层丢失。讨论中先后提出的错误 preload、
RPC 缺 text block、stdout 丢帧、stale 世代过滤均不能直接当成实证根因。尤其“只要
translator 发出 text 就不可能没有 DB 行”的推论不成立：流式正文有尚未落库的内存阶段。
`localDb.sessions.update is not a function` 发生在元数据调用面，不能由它推出正文写库
失败；本次不修改该接口或更新器。

已合并的 [#3742](https://github.com/makecindy/cindy/pull/3742) 只添加 RPC 帧元数据
诊断，不改变交付行为。合并提交 `ae2945c1f` 在本次基线及公开 `v0.1.72`、`v0.1.73`
tag 中，晚于报告版本。本次未获取或启动用户的 Windows 安装产物，不能据 Git tag
证明其实际安装文件组成。代码 pin 仍为 Pi `0.84.4`。

## 可确定复现的缺口

Pi `v0.84.4` 的
[JSON/RPC 转换](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/modes/json-event.ts)
只剥离 `message_update.partial`，`message_end` 完整透传。
[agent loop](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent-loop.ts)
发送消息结束后还会执行后续轮次/工具/跟进逻辑；消息完成与产品终态是不同边界。

当前 Cindy 的实际路径为：

1. `attachJsonlReader` 分帧，`PiRpcProcess.handleStdoutLine` 解析并转交事件。
2. PiAgent 的 `onEvent` 调用 `translatePiEvent`；它在 `message_end` 发出
   `text { isFinal: true, isFullText: true }`，在 `agent_settled` 发出带 result 的 done。
3. `Session` 消费异步队列并 fan-out；Desktop 的事件消费进入 `persistSessionStreamEvent`。
4. `onAssistantTextEvent` 在已有流式 block 时只校准内存全文；没有 block 时立即入队写库。
   前一种情况依赖随后 done/tool/interaction 等边界才 flush。
5. `createMessage` 经现有 FIFO 与 `message.insert` 事务写库、广播权威行；Renderer
   依 persistId 合并流式气泡与 DB 回执，历史读取恢复正文。

因此完整 message_end 已到达时，流式轮次仍可能只有 thinking 行。若在后续边界前清理
内存，正文丢失；若继续生成下一条 assistant，后者的全文校准还可能覆盖前一条。
这是本次回放锁定的代码缺口，**不等同于已经复现报告中的那一次事故**。无 text delta
的对照轮可以直接落库，也说明“thinking 与 text 同消息”本身不是充分触发条件。

## 修改与验证范围

仅在 Pi 的 `isFinal && isFullText` 到达后，通过既有 `flushAssistantBlock` 入队持久化。
不新增同步数据库访问、协议字段、消息类型或重试；不改变 thinking/text 分离。
正文落库不标记 turnCompleted，终态和 usage 仍由既有 done 消费负责。
SSH Pi 也进入同一个消费函数，设备互联继续接收原有消息行广播，无需新客户端协议。

`piReplyDelivery.test.ts` 使用自造正文和 Pi 协议形态，经过真实分帧、RPC client、
translator、Session、stream consumer、createMessage 和内存 SQLite 事务。
模拟的是字节来源、Agent handle 装配、DB transport 与非正文副作用，不启动 Pi、Electron
或 dev，不读取用户数据库。终态测试在此调用现有 flush helper；完整产品终态管线由
`sessionEventPipeline.test.ts` 独立覆盖。

回归覆盖流式/非流式最终全文、终态前落库、连续回复、重复终帧、逐字节 UTF-8 分帧，
以及 Renderer 的两种 DB 回执顺序和历史重载。撤去生产修复时，流式终态前落库与清理后
保留用例失败，非流式对照通过；恢复修复后通过。

仍未验证用户原机/安装产物、原故障轮 RPC 到达情况或真实模型调用。若该轮的 text 与
message_end 根本未进入消费函数，本次加固无法补回缺失正文；需用 #3742 的帧诊断与
对应消费/写库错误证据继续定界，不能靠自动续跑成功请求掩盖它。

## 本次本地验证

- 定向 Vitest：`piReplyDelivery.test.ts` 4 项、`sessionEventPipeline.test.ts` 45 项、
  `makerChatStoreTextDeltaBatching.test.ts` 172 项通过，均用单 worker 执行。
- `pnpm --filter desktop run --if-present typecheck`：通过。
- `pnpm test:unit:related -- --workspace-concurrency=1 --no-lock`：通过；设置
  `VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1`
  限制 Vitest 池。正常互斥入口先等待约 16 分钟后以 75 退出（未运行测试）；核实机器资源
  后使用仓库允许的有意并行入口，测试范围未缩减。调度器检查 511 项通过、1 项既有跳过，
  Desktop 相关单测段通过（约 323 秒）。SQLite 回放不属于根 unit tier，已单独执行如上。
