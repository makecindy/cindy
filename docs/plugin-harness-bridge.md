# 插件 Harness 桥接（revision 1）

插件通过 `cindy.harness(request)` 接入已绑定且获准的当前任务，经 `onHostMessage` 收事件和 Hook。执行由原生 Harness 负责。适用于本机用户主任务，不自动扩至 IM、定时任务、目标自动续跑、Orca Worker 或另一台设备。已有任务/消息提交、插件工具、面板和 `subscribe` 保持原契约，用户原生扩展保留直接使用路径。

本期只开放三种 Harness 已有且语义共有的能力。可以新增 Cindy 到插件的转发、身份关联和权限校验代码；不为统一接口新增原生能力、改写原生行为或另建压缩调度流程。协议预留名称不代表能力已开放，运行目录以实际接通情况为准。

实施分两步：先补齐通用基础能力，包括能力发现、数据读取、事件、Hook 和受控动作，完成三种 Harness 的原生接入、权限校验及可用性验证；再基于这些能力开发压缩插件。第一步验证接口的读取结果、信号交付、Hook 回执及动作转发；阈值、预压缩策略、原生压缩冲突处理及缓存策略属于第二步。

## 声明与批准

schemaVersion 3 使用独立的 `harness` 声明，每个名称分别批准。以下为能力全集示例，插件只声明实际所需部分：

```json
{
  "harness": {
    "read": ["runtime", "usage", "status", "messages", "tool-content"],
    "events": ["tool", "message", "usage", "compaction", "task", "status"],
    "hooks": ["permission.request", "tool.before", "compaction.before"],
    "actions": ["context.compact", "turn.interrupt"]
  },
  "launch": "resident"
}
```

Hook 要求 resident。未知名称/字段保留，不授予能力；旧批准不升级为新增正文或控制权限。旧插件继续使用原批准能力，不要求重装。task/session 标识来自已批准的事件或已有任务关联；不增加全局任务枚举权限。

## 查询与读取

```js
const runtime = await cindy.harness({ kind: 'read', name: 'runtime', sessionId });
if (!runtime.ok) return;
const { runtimeId, turnGeneration } = runtime;
const page = await cindy.harness({ kind: 'read', name: 'messages', sessionId, runtimeId, limit: 25 });
```

成功为 `{ok:true,revision:1,sessionId,runtimeId,turnGeneration,agent,value}`。失败为 `{ok:false,errorCode}`，包括 INVALID_PARAMS、DENIED、UNSUPPORTED、SESSION_UNAVAILABLE、STALE_RUNTIME、BUSY、TIMEOUT、UNAVAILABLE。查询不执行原生操作。

| 名称 | 返回内容 |
| --- | --- |
| runtime | 能力目录及 `capabilityStates` 的 declared/approved/connected；hookSubscriptions 的 not-declared/denied/not-ready/disabled/fused/not-running/ready。运行版本无证据为 null |
| usage | 数值用量、contextTokens/contextWindow、costUsd，以及已完成普通用户请求的缓存读写统计（原生提供才出现） |
| status | `{running:boolean}` |
| messages | 普通用户/助手消息的文本与保存历史，`{items,nextCursor,source:'saved-history'}` |
| tool-content | 工具参数/结果保存历史；与 messages 独立批准，工具关联键与事件一致 |

正文读取默认 25 条、limit 为 1–50。cursor 为不透明续读标识，绑定任务、实例、读取种类与数据库修订；并发写入、历史编辑、回退、清空或账号变化时可能返回 STALE_RUNTIME，应重新读取，不能直接拼接不同修订的页。实现复用现有消息库、稳定 createdAt/rowid 排序及持久化队列，不新增历史库。

每条保留 id、role、createdAt 和可用的 toolId；content 只投影公开文本或工具参数/结果，不导出 agentMeta、固定指令、隐藏推理、签名和凭证状态。非文本内容省略或超过 16384 字符时标记 truncated。附件和不可恢复的原始结果不补造，保存历史不等于完整 Provider 日志。正文可能包含用户文件、命令及敏感材料，批准说明必须如实展示。

## 事件与已有能力

`harness-event` 包含 topic/name/seq/ts/dropped/data。工具、用量、压缩边界、子任务和状态沿已有桥投递；新增 `message.updated` 观察助手文本，保留原生 isFullText/isFinal。用户消息使用历史读取或已有消息 Hook；任务创建/归档/切换、执行开始/结束、等待输入/审批继续使用 `subscribe` 的 session/turn/activity。

消息正文须额外批准 messages，工具正文须额外批准 tool-content；仅 events 批准只能看到元数据。投递前再次核验原批准和实例，缓冲期间撤销正文权限的事件不会泄漏。seq 与旧 did-* 共用，队列有界、可丢并报告 dropped，旁听不会等待插件处理。流式事件不能冒充无损原文日志。

向 Agent 提交任务/消息继续使用 agent-request 和现有任务 API，插件工具沿 tool-call/tool-result，面板沿原 UI 协议；这些能力不新增一套 Harness 专属接口。用户/助手消息 Hook 的现有改写、阻止或呈现语义保持不变。

## Hook 接入

```js
await cindy.harness({ kind: 'hook', name: 'permission.request', sessionId, runtimeId, enabled: false });
// enabled:true 恢复当前实例的接入；仍须已有声明、批准和真实原生入口。
cindy.onHostMessage(msg => {
  if (msg.type === 'harness-hook') {
    cindy.send({ type: 'harness-verdict', hookId: msg.hookId, action: 'continue' });
  }
});
```

声明且获准的 Hook 默认接入，以兼容已有 permission.request；enabled 覆盖当前实例的开关，实例替换后失效。permission.request 连接宿主实际审批，不覆盖免审批工具。tool.before / compaction.before 在 Claude 使用 SDK 的 PreToolUse / PreCompact，在 Pi 使用 tool_call / session_before_compact。仅映射原生 continue/block，不新增拦截语义，也不把事后通知当作前置决策。

原生适配限本机普通主任务，Review、托管和 SSH 不接入插件原生 Hook。Codex 0.159.2 使用原生 mcp_tool handler 调用既有 cindy MCP 服务的 harness_hook；不创建转发脚本或另一套 HTTP 服务，不修改原生配置、计算哈希或授予信任。适配同时校验当前根线程/回合、原生 hook/started 回执及原生 MCP 请求元数据，普通模型调用、子线程、重复或旧回执不能分派插件 Hook。PreToolUse 的阻止映射为原生 permissionDecision=deny，继续返回空对象；PreCompact 的阻止映射为 continue=false。两者不能混用返回格式。

Codex 必须在实际使用的原生配置中启用并信任对应定义；安装批准插件不代表已取得原生 Hook 信任。连接状态还检查当前线程的 MCP 工具是否可用，启动尚未完成时也可由真实原生回调确认就绪。原生关闭、未配置、未信任或回调尚不可达时不报告 connected，插件启用请求返回 UNAVAILABLE。原生配置变化在重新创建任务运行实例后重新读取；本次不增加配置/信任确认 UI。原生 mcp_tool 出错会 fail open，不可充当全部工具执行的强制安全边界。

内部 harness_hook 是 Codex 的固定 MCP 工具，工具目录会相对旧版本增加一项；它不随插件数量、订阅或每轮状态变化。普通模型调用只能得到 NATIVE_HOOK_UNAVAILABLE。不能用 disabled_tools 隐藏该工具，因为原生 Hook 也会因此失效。Claude/Pi 的工具目录不因此增加此项；是否影响缓存与成本仍需测量。

部署者可在原生配置中加入以下定义，再通过 Codex 原生 /hooks 审阅并信任；应合并现有配置，不覆盖已有 Hook，且遵守 managed-only 等原生限制。此处不是插件可写的配置接口，Cindy 不自动执行这些配置操作。原生协议见 [OpenAI Docs：Hooks](https://learn.chatgpt.com/docs/hooks#mcp-tool-hooks)。

```toml
[features]
hooks = true

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "mcp_tool"
server = "cindy"
tool = "harness_hook"
timeout = 4
input = { event = "${hook_event_name}", session = "${session_id}", turn = "${turn_id}", tool_name = "${tool_name}", tool_use_id = "${tool_use_id}", tool_input = "${tool_input}" }

[[hooks.PreCompact]]
[[hooks.PreCompact.hooks]]
type = "mcp_tool"
server = "cindy"
tool = "harness_hook"
timeout = 4
input = { event = "${hook_event_name}", session = "${session_id}", turn = "${turn_id}" }
```

回执仅 continue/block；continue 保留所有原生守卫，不增加授权。每次按固定插件顺序共用 1.5 秒预算，不等待冷启动；异常/超时回原策略，连续失败熔断。迟到、冒名、重复或旧实例回执拒绝；卸载/撤权释放等待。工具输入仅在 adapter 提供且另有工具内容批准时下发。block 使用固定宿主原因，不把插件自定义文本升格为模型指令。Hook 回调中不执行会等待自身完成的控制动作。

## 受控动作

```js
await cindy.harness({ kind: 'action', name: 'turn.interrupt', sessionId, runtimeId, turnGeneration, requestId: crypto.randomUUID() });
// name:'context.compact' 请求原生手动压缩。
```

两个动作分别批准，必须绑定最新 runtimeId 和目标 turnGeneration。重复 requestId 不重复发起；同 ID 改目标会被拒绝。先查 actions/availability：中断复用 Session.abort；context.compact 转发原生手动压缩，Claude 走现有 Query 的 /compact，Codex 0.159.2 走 thread/compact/start，Pi 走现有 compact RPC。Cindy 仅关联请求及原生终态，摘要、历史更新、后台预计算与自动压缩协调由原生负责，不另建压缩调度器。

压缩要求空闲且无未结执行或审批，忙时返回 BUSY；Session 同步保留动作边界，期间用户发送不抢跑。动作最多等待 10 秒，超时或连接错误可能返回 `outcome:'unknown'`，底层不自动重放，插件也不能换 ID 自动重试。中断返回 requested 仅是请求已返回，应继续观察原生终态；压缩返回原生结果（可能 noop）。每个执行代次最多保留 128 个操作身份，达到上限返回 BUSY。

## 后台压缩与验证边界

本次补齐公共接口、权限、读取和事件通道，以及三种原生 Hook 和手动压缩的适配代码。Codex 隔离协议核验已确认：实际 Cindy MCP server 与 adapter 能接收 PreToolUse/PreCompact；工具 deny 时普通工具执行次数为零，压缩 stop 时原生回合中断；普通模型调用不能冒充回调。核验使用临时配置和本地固定模型协议夹具，不读用户凭证、不调用真实模型；这不替代 Desktop 的实例路由、插件批准与三引擎实际任务联调。

压缩动作沿用原生手动压缩的等待语义，不能当作“不阻塞当前任务”的后台压缩接口。后台摘要 prepare/adopt 不在本期实现范围，nativeEnabled/nativeRunning=unknown 不能推断原生关闭或据此叠加自建压缩器；缓存统计也不保证下一次命中，缓存、时延和成本须单独测量。

静态类型、lint、i18n 与文档检查不能替代运行验收。事件用最小输入验证获准插件收到正确的关联字段与状态；Hook 还须验证回执被采用，动作须验证请求转发至原生入口并正确返回结果。可结合接口回归和原生联调取证，不以逐引擎重复全部业务场景作为能力开放门禁。回归用例覆盖正文权限、撤权后缓冲投递、动作去重/旧代次拒绝、Hook 取消及不透明内容过滤。未运行测试或真实模型调用时应如实说明；后台压缩插件独立验收。
