# 管理输入队列与运行控制

声明 `"agent": { "hostTools": ["history", "control"] }`，通过 `cindy.host.call` 使用
Agent 同用的工具和 Cindy 唯一输入队列。插件使用宿主核验的真实身份，没有来源任务；
安装批准有效、已启用且声明对应组即可调用，不新增分项批准或逐次确认。

## 查看和修改待发消息

先用 `list_sessions` 选择本机任务，再读 `list_session_queue({session_id})`。
`queue[]` 提供 `queued_message_id`、`position`、`source`、`source_label`、
`content_summary`、`truncated` 和 `consuming`；正文摘要最多 500 字符，不把摘要当作完整正文。
插件来源为 `source:'plugin'`，`source_label` 为宿主核验的实例 id。

```js
const queue = await cindy.host.call('cindy_helper', 'list_session_queue', {
  session_id: selectedSessionId
});
// 检查 queue.isError，解析文本 JSON 后由插件选择一条未在投递的消息。
const edited = await cindy.host.call('cindy_helper', 'update_session_queued_message', {
  session_id: selectedSessionId, queued_message_id: selectedMessageId,
  message: replacementFullText
});
```

插件可查看、撤回、排序或转插话**所有来源**的待发消息。编辑与任务界面的编辑能力范围一致：
Orca 协同、其他任务或伙伴投递、自动化、Hook、插件消息和界面禁止编辑的其他条目返回 `UNSUPPORTED_CAPABILITY`。
普通 Agent 的原有消息所有权规则保持不变。参数不接受调用方任务或插件 id，不能自报身份。

| 工具 | 参数（除 `session_id`、`queued_message_id`） | 结果 |
| --- | --- | --- |
| `update_session_queued_message` | `message`：新的完整正文 | `updated:true` |
| `cancel_session_queued_message` | 无 | `cancelled:true` |
| `move_session_queued_message` | `position`：从 0 开始，越界放队尾 | 实际 `position` |
| `steer_session_queued_message` | 无 | `delivery:'steered'` 或 `'queued'`，未插成另有 `reason` |

编辑保留原编号、附件和生命周期信息，正文及其展示同步更新；实际发送来源标为编辑插件，
不会沿用原正文携带的主人授权。撤回与排序不改正文或发送来源，仍由原队列收敛回执和清理。
`MESSAGE_CONSUMING` 表示正在投递，不可修改或撤回；`QUEUED_MESSAGE_NOT_FOUND` 可能表示
已经消费或已被取消，不能据此声称成功撤回。插话沿原引擎能力处理，不支持或边界忙时消息仍在队列；
`STEER_UNCERTAIN` 表示送达未知，队列已暂停，不要改用普通发送再投一份。

## 暂停、恢复、重试与压缩

`control_session` 为 Agent 与插件提供相同生产入口，目标始终显式指定本机任务：

```js
const result = await cindy.host.call('cindy_helper', 'control_session', {
  session_id: selectedSessionId, action: 'pause'
});
// 同一入口 action 可用 resume / retry / compact。
// 返回原始 MCP 结果；成功文本 JSON 含 session_id、action 和 result。
```

- `pause`：使用原执行暂停锁，阻止后续输入和待答交互继续执行；不终止已经在跑的模型或工具。
  与只暂停自动化、请求优雅停止不同。任务空队列时也生效，后来入队的消息仍保留。
  暂停不冻结 IM 渠道已发出提问的原有超时，到期按原逻辑取消。
- `resume`：解除该执行暂停，发布暂停期间暂存的交互回答并恢复原队列；不是新发一条“继续”消息。
- `retry`：复用任务界面的错误恢复事务。有可恢复的错误才重试，无错误时只返回当前暂停状态。此动作沿用已有执行暂停锁。
  Pi 正处于自动重试时，由原生运行处理。自动重试开关和取消等待使用 Pi 原生的 `set_auto_retry`
  和 `abort_retry`，这两个命令未通过 `control_session` 开放。
- `compact`：Claude Code 复用原 `/compact` 队列。Codex 使用原生手动压缩，Pi 使用原生 `compact`。
  仅 Pi 支持非空 `instructions`。忙碌、原生历史不可用或能力不支持时沿用既有失败语义。

暂停和恢复结果含 `executionPaused`、`queuePaused`。压缩结果含 `status:'requested'`，
Codex/Pi 另保留原生提供的 `tokensBefore`、`estimatedTokensAfter`、`noop`；不返回队列正文或附件信息。
Claude 可能仍在排队。Pi 的 `noop:true` 表示内容不足，未执行压缩。Pi 完成压缩时可返回原生估算值，
也支持不提供计数的原生扩展。
送达未知时队列保持暂停，不会自动重放。显式调用 `resume` / `retry` 与原任务中点击继续／重试共用事务；调用前应先核实实际投递状态。
压缩未被原事务受理时返回 `COMPACT_FAILED`。Pi 的原生压缩失败也返回该错误码。
Pi 在原生 RPC 排队结束后复核派发授权，授权撤销即停止发送。

只支持执行插件电脑上的本机任务，不支持 `deviceId::sessionId` 控制另一台电脑的队列。
旧 Host 未注册 `control_session` 或未提供对应服务时明确提示不支持；先查工具目录，不读写宿主数据库替代。
启停、更新、卸载和账号边界继续由原 Host 入口复核，异步读取后写入前再次检查。
