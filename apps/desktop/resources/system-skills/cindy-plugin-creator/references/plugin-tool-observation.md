# 实时旁听工具执行过程

声明独立主题 `"subscribe": { "topics": ["tool-execution"] }`。
整体安装批准有效且已启用即接收，不新增分项批准或逐次确认。
它会读取工具输入、结果和错误，安装确认与能力清单单独展示；旧主题不因此得到工具内容。
这不是执行钩子，插件不能通过此通知阻断、改参或替换结果。
与现有消息、状态订阅一样，这是全局插件订阅。项目内停用只影响该项目中的插件发现与调用，
不停止此旁听；停止旁听需全局停用插件或移除相应订阅声明。

```js
cindy.onHostMessage(msg => {
  if (msg.type !== 'event' || msg.name !== 'did-tool-execution') return;
  const { sessionId, eventType, source, payload, truncated } = msg.data;
  // payload 保留源事件的有界结构。按存在的 toolUseId / toolUseIds 关联，不能猜造 id。
  // msg.seq / msg.dropped 与其它订阅共享；缺口或 truncated 均不能当作完整过程。
  recordToolEvent({ sessionId, eventType, source, payload, truncated });
});
```

`data` 为 `{sessionId,eventType,source?,payload,truncated?}`：

| eventType | 当前共享事件流的内容 |
| --- | --- |
| `tool_use` | 工具名、输入及调用 id（源事件提供时） |
| `tool_result` | 摘要结果、错误状态与对应调用 id 列表（源事件提供时） |
| `tool_result_full` | 当次工具结果正文，仍受本订阅的大小限制 |
| `agent_task_update` | 引擎已投影的子任务进度及状态；不是每个普通工具的内部进度 |
| `error` | 共享事件流里的错误；不保证只来自工具，也不保证带工具调用 id |

载荷经过宿主现有敏感文本脱敏并有界复制：单次内容预算 60,000 字节，最多 512 个节点、
8 层嵌套，单个字符串最多 10,000 个 UTF-16 代码单元，键最长 128 个代码单元。
实际复制可能因保守的 JSON 转义预算提前截短。超限、循环、二进制或无法复制的字段被省略/置空，
并标 `truncated:true`；不在 JSON 里交付原生二进制或宿主媒体字节。

Desktop 订阅覆盖执行 Host 实际接到的各类任务，包括普通任务、协同和自动化；不沿用旧 `turn` / `activity`
的主任务过滤，不主动订阅其它电脑。`source` 保留事件报告的引擎来源，未报告就省略。
各引擎的字段与事件顺序不强行统一；有的工具结果同时有摘要与正文，不把它们算成两次执行。
Node Host 的独立 turn executor 尚未接入此订阅，不能依赖它收到工具事件。

## 当前引擎边界

三种引擎均可收到已经进入 Cindy 共享流的工具开始、结果和错误。这里只旁听实际存在的
AgentEvent，不重新建立引擎循环、MCP 包装器或逐请求代理：

- Claude Code 的原生 `tool_progress` 当前降为通用运行状态，不在本主题中提供原始进度。
- Codex 本主题提供现有 translator 的调用和结果；命令输出 delta、文件 patch 等原生中间帧
  未单独向本主题承诺，不能把最终 `tool_result_full` 当作逐行 stdout 流。
- Pi 的普通 `tool_execution_update` 当前未投影进共享流；已投影的子代理更新通过
  `agent_task_update` 提供，不保证普通工具的 partialResult、durationMs 或 parentToolCallId。

## 投递、背压与恢复

旁听不等待插件作答。已运行插件也经异步边界投递，沿用现有每插件 100 条缓冲、单调 `seq`
与 `dropped`：溢出丢最旧，随后一次投递报告丢弃数，不额外轮询、不建持久事件日志。
无该主题订阅者时，不复制或序列化工具载荷、不取游标、不唤醒插件、不发送额外 IPC。
停用、卸载、更新安装或切换账号后，旧缓冲不会交给替代安装或新账号。

收到 `dropped`、重新连接或 Host 重启后，不能依赖这条流恢复完整状态。另声明 `history` 组后，
可通过 `get_chat_history` 显式选择 `tool_use` / `tool_result` / `error` 补读已保存历史；
历史不包含原始过程帧，普通工具结果正文的存储上限按字符串长度为 8192 个 UTF-16 代码单元，
不是严格字节上限，也不能用历史恢复未保存的全文。审计、展示和持久化策略由插件承担。
旧 Host 可保留该未知主题但不投递，插件应说明需要支持此主题的 Host，不能据此断言没有工具执行。
