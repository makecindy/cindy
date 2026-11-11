## 4.6.2 控制节点:在 Cindy 的流程关键点先问你(subscribe.hooks)

控制节点是 Cindy 预先埋在流程关键点的 `will-` 拦截点。用户在某个自动化的
「前置检查」里选了你的插件,或在新任务的模型选择器里选了你发布的模型(§4.6.3),到了节点主机就停下来
问你,**不经过 Agent、不花模型回合**。插件不会自动管所有任务:只问选了它的那些任务。你可以在插件里调自己的规则、外部决策
接口(例如 OpenAI Decisions、Jev)或任何服务,再回一个裁决。节点由 Cindy 统一维护,
新写插件不需要 Cindy 发新版。

### 当前节点

| 节点 | 什么时候问 | 能回的裁决 | 时限 |
| --- | --- | --- | --- |
| `will-schedule-run` | 每次自动化(定时任务,含脚本模式)运行前;恢复中断的续跑不再问 | allow / skip / block | 30 秒 |
| `will-routine-run` | 兼容保留,不再触发:伙伴例行任务已改成项目自动化(2026-11-08),声明照常安装 | allow / skip / block | 30 秒 |
| `will-start-task` | 新任务(含 `/goal` 开的)第一条消息发出、任务建好之前;只问一次,之后的消息不再问;伙伴对话不问 | allow / route | 8 秒 |
| `will-start-turn` | App 内正常发起的新一轮开始前；只问任务设置中选中的插件 | allow / route / skip / block | 1 秒 |
| `will-model-request` | App 正常发起的本机 Pi 轮次内，每次模型请求，包含工具结果后的继续请求 | allow / route（select 阶段）/ transform（payload 阶段）/ skip / block | 每次请求的 select＋payload 合计 1 秒 |
| `will-compose-context` | App 内正常发起的新一轮装配消息时，为选了该插件的任务补参考资料 | allow / context / skip / block | 2 秒 |
| `will-search-memory` | 所选任务调用已有 `cindy_memory.memory_search` 时 | allow / memories | 1.5 秒，失败保留 Cindy 结果 |
| `system-prompt` | 装配所选任务的系统提示词；由清单 `systemPrompt` 静态提供，不发送询问 | 无运行期裁决 | 不启动插件 |

运行时用 `host-request` 查当前 Cindy 实际提供哪些节点,别靠版本号猜:

```js
const r = await cindy.request({ kind: 'control-points' });
// r.points = [{ id, actions, timeoutMs, declared, active }]
// active=false:声明了但用户还没在安装/更新确认里批准,用户还不能在任务里选你。
// 旧版 Cindy 不认识该请求会报错 —— 当作"没有控制节点",保留其它功能。
```

### 声明

```json
"slots": ["subscribe", "network"],
"subscribe": { "hooks": ["will-schedule-run"] },
"network": { "hosts": ["api.openai.com"], "secrets": [ ... ] }
```

- 控制节点**不要求** `launch: "resident"`:不在跑时主机会按需拉起,唤醒耗时计入同一时限。
- 每个节点在安装确认里是独立一行权限;只有用户确认看到过的节点,用户才能在任务的「前置检查」
  里选你。插件更新时新增节点会再次请用户确认。
- 写上当前 Cindy 还不认识的节点名可以装,但不会生效,也不会在 Cindy 升级后自动生效。

### 收到询问、回裁决

```js
cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'event' || msg.name !== 'will-schedule-run') return;
  // msg.data:见下表;msg.deadline:本次截止时间(ms),外部请求的超时要留出余量。
  let action = 'allow', reason;
  try {
    const verdict = await decide(msg.data, msg.deadline - Date.now() - 2000);
    if (verdict === 'nothing-to-do') { action = 'skip'; reason = '没有新情况'; }
  } catch {
    // 出错时什么都不回也行:主机按用户在该任务里设置的出错处理执行。
    return;
  }
  cindy.send({ type: 'event-verdict', hookId: msg.hookId, action, reason });
});
```

| 裁决 | 效果 |
| --- | --- |
| `allow` | 不反对,照常执行(之后还有脚本前置检查的,再跑脚本) |
| `skip` | 这次不执行,记为"跳过"(不计费、不通知);下次照常触发 |
| `block` | 这次不执行,记为"失败",`reason` 会显示在运行记录里 |
| `route` | 在 `will-start-task`、`will-start-turn` 或 `will-model-request` 的 select 阶段选模型，见下文 |

规则(主机强制):

- **不能替人批准**:`allow` 只表示不反对,不能替用户放行原本需要确认的事；运行前检查不改任务内容。逐请求正文处理见下文。
- **出错处理归用户**:超时、崩溃、连续 3 次失败(熔断),或插件被停用、卸载时,主机按用户在
  该任务里选的处理执行(照常运行 / 跳过本次 / 停止并记为失败,默认停止并记为失败,与脚本前置
  检查一致)。插件读不到也改不了这个设置。
- 自动化／例行任务的前置检查只选一个插件；「任务插件」可选多个：路由和请求正文处理串行保序；资料与记忆提供者并行询问，再按选择顺序归并。`reason` 最长 200 字符。
- 只投给当前登录账号自己电脑上的流程;手机或另一台电脑触发的运行,在执行的那台电脑上询问。

### 任务运行时等待预算

`will-start-turn`、`will-compose-context` 和 `will-model-request` 共用每轮 **5 秒**插件等待预算。App 普通消息在统一发送准备入口开启新预算，
工具续轮和同一轮内的多次模型请求不重置；同轮插话不另行询问资料提供者或建立新预算。每次询问还受上表单点时限约束；
`will-model-request` 的 `select` 与 `payload` 共用该次请求的 **1 秒**，下一请求重新取得
请求预算，但继续消费本轮剩余的 5 秒。实际 `deadline` 会按两项剩余预算缩短。

预算只统计插件等待，包括插件按需唤醒；并行等待重叠的墙钟时间只计一次。宿主的
`readRoute`、`applyRoute`、Agent 会话关闭／恢复、模型 HTTP 和工具执行不计入，
所以这不是整条消息或整轮完成时间的上限。预算耗尽后不再询问剩余插件，按每个插件在该任务
设置的 `onFailure`（allow / skip / block）处理，不擅自放行。
共享 `memory_search` 不参与 App 每轮 5 秒累计预算，每次检索的提供者等待独立最多 **1.5 秒**，
仅允许 allow-on-failure。一个 App 轮的插件总等待不包含记忆；每次额外检索最多再加 1.5 秒。
未选择插件时同步短路，不建立预算或新增定时器。旧的自动化和新任务节点时限保持不变。

### 为新任务选模型(`will-start-task`)

只在新任务开始时选一次:同一个任务中途换模型或框架会让提示缓存失效,所以之后的消息不会再问你;
伙伴的任务一直延续,也不会问。回 `route` 时带上完整组合:

```js
cindy.send({
  type: 'event-verdict', hookId: msg.hookId, action: 'route', reason: '写代码 92%',
  route: { agentKind: 'cc', model: 'claude-opus-5-5', providerId: 'anthropic', effort: 'high' },
});
```

- `route` 的 `agentKind` / `model` / `providerId` / `effort` 取自 `GET /agent-models`(`agent` 映射为
  `claude-code→cc`、`codex→codex`、`pi→pi`),不要按模型名猜来源。主机只认这四个字段。
- 主机按用户当前已连接、可用于新任务的模型核验:`effort` 不是该模型的档位时去掉档位再核验;
  仍不可用就沿用用户原来选的模型。用户在任务里会看到一行说明(选了哪个模型、`reason`,或为什么没换)。
- 只想调推理强度时,把 `msg.data.route` 原样带回,只改 `effort`。
- 不想改就回 `allow`;超时、出错或不回,都沿用用户原来选的模型(这个节点没有"跳过"或"停止")。
- `reason` 最长 200 字符,会显示给用户,写短句,例如"写代码 92%"。
- `msg.data.modelId` 是用户选的模型 id;模型的声明与发布见 §4.6.3。
- 目前只在本机新任务里提供;在另一台电脑、SSH 主机上开的任务和多 Agent 协同不提供。

### 询问数据

`will-schedule-run`:

| 字段 | 说明 |
| --- | --- |
| `scheduleId` / `runId` | 自动化与本次运行 |
| `name` / `prompt` | 名称与指令(脚本模式 prompt 为空串) |
| `executionMode` | `agent` 或 `script` |
| `trigger` | `manual` / `cron` / `interval` / `once` |
| `firedAt` | 触发时间(ms) |

`will-routine-run`(兼容保留,不再触发):

| 字段 | 说明 |
| --- | --- |
| `routineId` / `runId` / `botId` | 例行任务、本次运行、所属伙伴 |
| `name` / `prompt` | 名称与指令 |
| `builtin` | 内置例行任务种类(如 `follow-up`),用户自建为 `null` |
| `triggerIds` | 本批触发来源 |
| `events` | 本批事件 `{ id, type, sourceId?, occurredAt, subject?, data }`,时间触发为空数组 |

`will-start-task`:

| 字段 | 说明 |
| --- | --- |
| `text` | 第一条消息正文;`/goal` 开的任务是目标内容(最长 20000 字符) |
| `attachmentCount` | 附件个数(不含附件内容) |
| `route` | 用户在模型选择器里原本选的 `{ agentKind, model, providerId, effort? }` |

不包含工作目录等本机路径。数据只用于判断,不要原样转发给不需要它的服务。

### 任务中的模型路由与请求处理

在 v3 清单声明 `subscribe: { hooks: ["will-start-turn", "will-model-request"] }`。安装／更新
确认分别展示权限，用户仍须在任务菜单的「任务插件」中选择；安装或启用不会替所有任务选择。
没有选择时不唤醒插件、不读取消息或模型目录。新任务选模保持原来的“一次”语义。

发送接入范围仅限 **App 内正常发起的新轮次**。个人 IM、官方 hook 和同轮插话不执行这里的
轮前准备或资料收集，也不通过这些入口装配／更新静态片段、安装逐请求回调。已经由 App
开启的 Pi 轮次仍沿用该轮的请求控制；已有会话内容不会因更换消息入口被清空。
`memory_search` 是共享工具，按下文的任务选择规则调用记忆提供者，不受发送入口限定。

`will-start-turn` 数据为 `{ sessionId, route, text }`，可回 `allow` 或完整 `route`。
路由复用插件模型的 `agentKind / providerId / model / agentDeviceId? / effort?`，本节点另接受
`fastMode: boolean | "ultrafast"`，只能选当前已连接且可用的组合。Claude Code、Codex、Pi
都在统一发送入口执行，切换复用任务自身的模型控制服务。

`will-model-request` 分两个阶段，均带 `{ sessionId, route, phase }`：

- `phase: "select"`：回 `route` 选本机 Pi 物理模型、推理强度和 Fast，或 `allow` 保留任务模型。
  使用 Pi 原生虚拟模型路由，实际响应记实际模型，不永久改任务的模型选择。
- `phase: "payload"`：额外带 `request`（供应商请求 JSON 正文，无连接密钥和认证头）。可回
  `{ type: "event-verdict", hookId, action: "transform", request: { ...msg.data.request, max_tokens: 2048 } }`。
  可以处理参数和正文，包括模型字段；宿主只校验请求结构仍合法及序列化后最多 1048576 字符，不按字段设业务白名单。
  后选插件读取前一个插件处理后的正文。日志只记任务、来源插件和处理阶段，不记录正文。

| 引擎 | 每轮开始前路由 | 每次模型请求前路由／正文处理 |
| --- | --- | --- |
| Claude Code | 支持 | 不支持：无对应请求入口 |
| Codex | 支持 | 不支持：无对应请求入口 |
| 本机 Pi | 支持 | 支持：原生虚拟模型＋`before_provider_request` |
| SSH／设备托管 Pi | 支持每轮开始前路由 | 不支持逐请求处理 |

超时、未批准、被停用、非法结果或不可用路由都走该任务为该插件设置的出错策略。`skip` 跳过
本次回复，`block` 停止并报错；插件不能更改出错策略。逐请求阶段发生时，Pi 已接受本次输入，
`skip` 通过 Pi 原生取消收尾，`block` 通过错误生命周期返回，不伪装成已完成的模型回复。数据只传给选中的插件。

### 上下文与记忆提供者

在 `subscribe.hooks` 声明 `will-compose-context` 或 `will-search-memory`，安装确认分别展示权限。
用户在任务菜单的「任务插件」中分别选择，可以只用其中一种；不会为其它任务调用插件。

`will-compose-context` 数据为 `{ sessionId, text }`（当前消息）。

仅 App 内正常发起的新轮次询问该节点，只发送尚未附加引用历史、交接、应用资料或环境说明的
当前原文；IM、hook 和同轮插话不询问资料提供者。原生非模型命令沿既有判定跳过资料装配。
资料不进入自动审核的授权来源；原消息的附件边界和主人原话保持不变。

返回示例：

```js
cindy.send({ type: 'event-verdict', hookId: msg.hookId, action: 'context',
  blocks: [{ id: 'project-notes', text: 'Retrieved project reference material.' }] });
```

每个块的 `id` 唯一、最多 128 字符；最多 32 块、正文合计最多 32768 字符。宿主给每组资料
加来源插件，再受同一附带资料预算约束。资料复用消息附带 `context` 的普通消息通道；不进
system prompt，不改变显示／落库的主人原话，也不进入自动审核的用户授权来源。原生控制命令
（如 `/compact`）不追加资料。`sessionContext: true` 仍只是工具参数里的任务／目录元数据，
不是模型上下文注入通道。

`will-search-memory` 数据为 `{ sessionId, query, type?, limit }`，只发送当前查询，不发送 Cindy
已搜到的记忆。返回：

```js
cindy.send({ type: 'event-verdict', hookId: msg.hookId, action: 'memories',
  entries: [{ id: 'preference-1', title: 'Preferred format', type: 'reference',
    content: 'Complete memory content returned inline.' }] });
```

每批最多 50 项、全文合计最多 32768 字符；`id` 最多 128 字符、`title` 最多 256 字符，
`type` 可选 `user / feedback / project / reference`。来源 `sourcePlugin: { id, name }`
始终由宿主填写；插件自报的来源会被丢弃。结果全文直接在 `memory_search` 返回，不伪造本地
文件名，也不要求 Agent 再调用其它工具。多插件结果按用户选择顺序填充，所有提供者合计最多 **50 条**、`content` 正文合计最多
**32768 字符**；超出时截断，`memory_search` 返回的 `data.truncated` 为 `true`，被截短的
内联条目也带 `truncated: true`。标题、ID 和宿主来源仍受各自字段上限约束。
Cindy 原有结果与插件结果各保留自身排序，交替合并
并遵守调用者的总 `limit`；不同索引的分数不混排。

沿用现有 `cindy_memory` 的启用与账号／任务边界，不另建记忆库或额外工具。需已有记忆检索
可用；不开启记忆时保持原行为。提供者超时、停用、出错或给了非法数据时忽略其结果，Cindy
原有检索仍正常返回；这个节点只有“照常检索”的出错策略。源任务／账号失效后丢弃迟到结果。
Claude Code、Codex、Pi 都复用同一个检索入口；多插件仅调用任务实际选择的提供者。

### 静态系统提示词片段

v3 清单直接声明 `systemPrompt`，不要在 `subscribe.hooks` 写 `system-prompt`：

```json
"systemPrompt": [
  { "id": "style", "text": "Use the project's documented terminology.",
    "order": 100, "scope": "selected-task" },
  { "id": "coding", "text": "Explain the verification result after coding.",
    "order": 200, "scope": "selected-task", "agentKinds": ["cc", "codex", "pi"] }
]
```

正文是包内清单中的静态文本，不读取路径、运行脚本或展开模板。每项必须有唯一 `id`（最多
128 字符）、非空 `text`、整数 `order` 和 `scope: "selected-task"`；最多 32 项，正文合计
最多 32768 字符。`agentKinds` 可选，未写时对全部支持的引擎生效。当前唯一作用范围是用户
明确选择了本插件的任务，不能声明全局范围。

安装／更新确认以独立权限行显示完整片段、顺序、范围和引擎；更改这些内容需要重新确认该项
权限。插件详情也展示原文。用户随后在任务菜单的「任务插件」中选择系统指令提供者，从下一次
App 内正常发起的新轮次生效。片段先按 `order` 升序，再按 `插件 id:片段 id` 字典序排列；多个插件共用这个
次序，宿主还限制装配总量。只有所选且已批准、已启用的插件可以参与。停用、卸载或不支持
当前执行位置时，使用用户为该插件选择的出错策略。

片段进入真正的系统指令通道，放在原有固定前缀之后；未选择时提示词字节保持原样，不启动
插件。Claude Code／Codex 复用现有任务级系统指令尾段；Pi 使用原生 `before_agent_start`
在完整原生提示词之后追加。选择变化时宿主通过既有会话恢复流程更新下次运行，不改主人原话。

| 引擎与位置 | 静态系统片段 |
| --- | --- |
| Claude Code | 支持，现有任务级系统指令通道 |
| Codex | 支持，原生 developer instructions |
| 本机／SSH Pi | 支持，原生 `before_agent_start` |
| 设备托管 Pi | 不支持，设备传输尚无宿主静态片段入口 |

这是未发布能力。旧宿主会忽略未知 `systemPrompt`；仅使用这些新增节点的开发示例不得宣称
旧正式版已支持。发布时把 `minCindyVersion` 写成实际首个支持版本；运行期用 `control-points`
探测新能力，静态片段是否获准由返回的 `declared / active` 判断。

最小开发示例：[Runtime Context Example](examples/runtime-context/README.md)，含完整清单与可直接打包的 `main.js`。
