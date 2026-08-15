# 视觉桥（agent-vision-toolkit 式）集成方案书

> **状态**：已定稿（2026-08-11）。本文件是实现的唯一锚点，任何改动先改这里再改代码。
> **分支**：`feat/vision-toolkit-text-models`
> **范围**：让纯文本模型（如 deepseek / glm 等不支持视觉的模型）获得看图能力——用外部多模态
> API 把图转成文字描述，再让纯文本模型基于文字继续工作（image-to-text 层，vision token 不
> 直接交给文本模型）。

---

## 一、目标与硬约束

**目标**：给"包括但不限于 deepseek"的纯文本模型补视觉能力。

**硬约束**（必须满足，不得破坏）：
1. **默认不开启**——只有用户显式启用才生效；
2. **不影响正常模型使用**——纯文本模型正常流程零干扰，视觉模型完全不受影响；
3. **三层全做**：B（session 层贴图主动调视觉）+ A（proxy 透明替换兜底）+ C（pi 工具模式增强），
   pi-only 的 C 也做。

---

## 二、现状与关键事实（已确证，改动时不得偏离）

| 环节 | 事实 | 代码锚点 |
|---|---|---|
| 贴图归一化 | 图片统一为 `{ type:'image', path: absPath }` | `packages/maker-core/src/types/common.ts:46-53` |
| 消息入口 | `session.send()` 组装 `UserMessage` 后交给 agent（视觉桥在 `Session.send` 内、dispatch 前调用） | `packages/maker-core/src/session.ts` |
| cc 转图 | `toClaudeSdkContent` → `@"path"` mention → SDK 读文件 | `claude-code/index.ts:416` |
| codex 转图 | `toAppServerInput` → `{type:'localImage',path}` / `{type:'image',url}` | `codex/index.ts:1314,1361,1366` |
| pi 转图 | `buildPiPrompt` → base64 `PiPromptImage[]` | `pi/index.ts:301` |
| 多模态判定 | `supportsImageInput` 派生链只消费到 pi（cc/codex 不用） | `apps/desktop/.../catalog-to-descriptors.ts:89` |
| pi 前置拒绝 | `assertImageInputSupported` 抛 `PiImageInputUnsupportedError` | `pi/index.ts`（`assertImageInputSupported`） |
| cc/pi 代理装配 | `anthropic-compat-proxy`（`transformRequest` 链，视觉桥在 `stripNonAnthropicFields` 前） | `anthropic-compat-proxy-host.ts` |
| codex 代理装配 | 同包独立实例，transform 链 `createTransformRequestChain` | `codex-proxy-host.ts`（`createTransformRequestChain`） |
| 响应侧 | **只读 observer，无响应 transform**（SSE 低延迟刻意不做） | `packages/anthropic-compat-proxy/src/types.ts:6-9` |
| 上游失败三形态 | 显式 400（recovery 可捕获）/ **静默丢弃**（glm 实测，无信号，只能主动判定）/ pi 发送前拒绝 | `transform.ts`（#794 strip handler 表）、`pi/index.ts` |

**请求路径覆盖矩阵**（决定视觉桥能覆盖哪些请求）：

| 请求来源 | wire 格式 | 走哪个 proxy | 过 transform 链？ | 视觉桥能否覆盖 |
|---|---|---|---|---|
| claude-code 子进程 | Anthropic Messages（`messages[]`） | cc 实例 | ✅ | ✅ A |
| pi 网关模型 | Anthropic Messages | cc 实例（pi 复用） | ✅ | ✅ A |
| codex 子进程（网关路线） | OpenAI Responses（`input[]`） | codex 实例 | ✅ | ✅ A |
| 订阅直连模型（chatgpt/ xai/） | Responses 经 localHandler 翻译 | 命中 `localHandler` | ❌ 绕过 | 本就是视觉模型，无需桥 |
| pi BYOM 原生 provider | pi 原生 | **直连用户端点，不过 proxy** | ❌ | ✅ B（session 层） |
| **ghost 工具结果图片** | MCP tool_result 纯文本（`cindy-media://` URL） | 不过 proxy（MCP 内建） | ❌ | ✅ **D（ghost 收口描述）** |
| WS 隧道流量 | socket 转发 | — | ❌ | 纯文本模型不走 WS，无影响 |
| 远程 SSH env 模式 | 远程直连 | — | ❌ | 低优先级，标注"远程需另行配置" |
| 标题 one-shot / 非 POST 控制面 | 直连 / 无 body | — | ❌ | 无图，无影响 |

**关键结论**：
- 层 B（session 层）是唯一能覆盖 **pi BYOM 原生直连**的层（A 的盲区）；
- 层 A 是唯一能看到 **tool_result 内嵌图片**的层（B 覆盖不了）；
- 层 C（工具模式）提供 B/A 结构性给不了的**主动多轮聚焦**（locate → crop → 细看）；
- **层 D（ghost 收口描述）**：工具结果里的 `cindy-media://` 图片是纯文本 URL，层 A/B 都扫不到
  （工具结果不是 image block、不经过 session hook）——纯文本模型只能看到 URL 文本，实测会**幻觉
  编造**图片内容。host 在 `ghost_call` 收口处读 blob 调视觉桥转成描述，附加为
  `xdt_media_descriptions`（可选字段，视觉桥关闭/无图/全失败时不出现，存量兼容）。

---

## 三、总体设计：三层互补

```
用户贴图 → [B] session 层主动调视觉（第一刀，侵入最小，覆盖三 agent + pi BYOM）
工具返回图 → [A] proxy 透明替换（兜底，覆盖 tool_result 内嵌 + 网关模型）
           ↘ [D] ghost 收口描述（工具结果 cindy-media:// URL → 文字描述）
模型主动追问 → [C] pi 工具模式（多轮聚焦，pi 成本最低）
```

| 层 | 触发时机 | 模型感知"有图" | 多轮聚焦 | 零干扰 | 侵入性 |
|---|---|---|---|---|---|
| B session 层主动调 | 用户贴图瞬间 | ✅ 收到"贴了图，已描述" | 弱（描述一次，可再追问） | ✅ 未启用原样透传 | 改 session 一处 |
| A proxy 透明替换 | 图片到上游 | ❌ 被动得描述 | ❌ 一次性 | ✅ 未启用 null 透传 | 改 proxy 双实例 |
| C 工具模式 | 模型决定 | ✅ 主动 | ✅ 强 | ✅ 工具不注入即不存在 | pi bridge 一处 |
| D ghost 收口描述 | 工具结果返回瞬间 | ✅ 收到"图已转文字描述" | 弱（描述一次） | ✅ 未注入/失败静默跳过 | host 一处（ghost.ts 收口） |

四层共用同一视觉通道后端（见第五节）。

---

## 四、各层详细设计

### 4.1 层 B：session 层贴图主动调视觉

**入口**：`Session.send` 内（msg 组装后、`agentHandle.send(msg)` 前，视觉桥调用点见
`packages/maker-core/src/session.ts`）。优先 session 层（覆盖所有 agent；不采用下沉到
`BaseAgent.send` 的方案）。

**流程**：
1. 扫描 `message.content` 的 `{type:'image'}` block（畸形非数组 content 安全返回空）；
2. 判定：视觉桥已开 + 当前模型 ∈ 启用组合 → 继续；否则原样透传；
3. 调视觉通道 `describeWithFallback(path, focusHint, signal)`，focusHint = 同消息 text 内容（比 proxy 层提取更准）；
4. 把 image block **替换**为描述 text block（前置来源标注「用户贴了一张图片，已由外部多模态模型转成文字描述」）。
   采用替换而非"前置注入保留图"的理由：纯文本模型拿到描述即直接可用、不会触发上游 400；
   层 A 对纯文本请求（无图）自然 no-op，不与层 B 重复描述。视觉模型本不该被配进启用组合
   （用户显式多选的是纯文本模型），故替换不损失其看图能力；
5. 视觉 API 失败/超时 → 单图失败用独立占位文本（「图片不可用，不要推测内容」）替换该图，其余成功图照常；
   仅当**全部图片都失败**时才回退无视觉桥状态，**原样把图透传** + 发出清晰提示（非终态事件）；
   调用方取消（Stop / detach / 外部 signal abort）**不计入失败/超时**：立即中止视觉请求并静默收口，
   不写占位、不发 note（取消是用户主动中断，不是视觉桥故障）；若调用链已因取消收口，则不会越过取消
   边界 dispatch 给 agent（hook 内部保留原 message 仅是返回值，不意味着把原图发给模型）；
   视觉通道自身 timeout 仍按失败处理；
6. **有界延迟（非无延迟）**：视觉调用在 `handle.send` 前 await，但有明确预算——单图超时 30s
   （视觉推理常需 10-30s，5s 太短易超时）、多图并发 2、单图主+fallback 最坏 ~60s、N 图约
   `ceil(N/2)*60s` 后 dispatch。取消（signal）可提前中止。这是「有超时的前置阻塞」，不是
   「不阻塞」；总预算（最大图片数/总耗时上限）为后续增强。

### 4.2 层 A：proxy 透明替换

**引擎改动**：`packages/anthropic-compat-proxy/src/types.ts` 的 `RequestTransform` 类型放宽为
允许返回 `Promise`（`RoutingTransform` 已 async 是先例）；`server.ts` `runTransforms`
循环改用 `isPromiseLike`（已存在）做 `isPromiseLike(r) ? await r : r`。
**现有同步 transform 全部兼容**；必须顺序 await（禁 `Promise.all`），保持
`repairToolExchangeAdjacency` → `dedupeDuplicateToolUseIds` 的顺序依赖（`transform.ts` 头注）。

**新 transform**：`createVisionBridgeTransform()`（`packages/anthropic-compat-proxy/src/`）：
- 短路：未启用 / 目标模型集不含该 model → 返回 `null`（字节透传，视觉模型零影响）；
- 双格式解析：
  - Anthropic Messages：`body.messages[].content[]` 的 `{type:'image'}` block（含 tool_result 内嵌）；
  - OpenAI Responses：`body.input[]` 的 `{type:'input_image', image_url}`；
- 命中 → 仅对 `http(s):` / `data:` 协议的 image_url 调视觉通道转文字 → **原地保序替换**为
  `input_text`/`text` 块；私有协议（`cindy-media://` / `xdt-image://` / `file://`）或裸本地路径
  是内部引用/本地文件，**不透传给第三方视觉后端**，直接降级为「图片不可用」占位 + warn；
- focus hint：最近 user 文本 / assistant 最后一段（参考 vision_proxy.py 的 `_last_paragraph`）；
- 失败 → 替换为「Image unavailable / 图片不可用」占位（对齐 vision_proxy.py），不 502，不阻塞。

**装配**（两实例都要加，视觉桥 transform 都在 `stripNonAnthropicFields` 前）：
- cc/pi 实例：`apps/desktop/src/main/maker-host/anthropic-compat-proxy-host.ts` 的 `transformRequest` 链（`buildVisionBridgeProxyTransform(log)`）；
- codex 实例：`apps/desktop/src/main/maker-host/codex-proxy-host.ts` 的 `createTransformRequestChain`。

### 4.3 层 C：pi 工具模式增强

**入口**：`packages/maker-core/src/agents/pi/cindy-bridge-source.ts`——已有一套 `pi.registerTool`
范式（`registerTool` 内置工具注册）、权限门、spawn 凭证剥离；本分支视觉工具 `vision` /
`vision-locate` 注册在 `cindy-bridge-source.ts`（`vision`/`vision-locate` 两个 `registerTool`）。

**注意**：cindy-bridge 跑在 **pi 子进程**，不能 import cindy 模块，只依赖 pi ExtensionAPI、
`fetch`、`node:fs`。所以层 C 的 vision 工具**在 bridge 内自包含 fetch 视觉 API**（复用与主机
侧 VisionChannel 相同的端点/凭证 env，由 host 通过 env 注入），不依赖主机侧通道对象。

**工具**（第一版实现）：
- `vision <path> [-q <focus>]`：glance 式问答，支持多轮（模型拿上次描述后可再 `-q` 追问细节）；
- `vision-locate <path> <target>` → 返回坐标（ground 式）。
- `vision-crop` **未实现**（设计参考 agent-vision-toolkit，后续增强）：`<path> <x1,y1,x2,y2> -o out.png` 放大细节复用。

**凭证**：视觉 API key 经 host 注入的 env（对齐 `CINDY_PI_API_KEY` 插值模式），进 spawn 边界的
`SECRET_ENV_NAMES`（`cindy-bridge-source.ts` 的 `CINDY_PI_SECRET_ENV_NAMES` 解析）剥离，模型拿不到。

### 4.4 层 D：ghost 工具结果图片描述

**背景（实测）**：模型调 ghost 插件工具（如 xd-feishu 读飞书群消息）返回的图片以
`cindy-media://blobs/<hash>.<ext>` **URL 文本**进 agent 上下文（MCP tool_result 是纯文本 JSON，
不是 image block）。层 A/B 都扫不到这种形态——纯文本模型（deepseek 等）只能看到 URL 文本，
读不到图，实测会**幻觉编造**图片内容（codex 会话编造了不存在的 not_anchor 判定结果）。

**入口**：`apps/desktop/src/main/mcp-integrations/ghost.ts` 的 `callGhostTool` 收口处
（`drainGhostCallMedia` 之后、返回前）。

**流程**：
1. `CindyGhostsHostDeps` 注入可选 `describeToolResultImage({imageUrl, sessionId, sessionInstanceId})`，
   host 侧（`maker-host/index.ts`）实现；
2. 收口处从 `producedMedia`（主机媒体账本）+ `result.result`（递归扫描 ≤8 层）收集
   `cindy-media://` URL，Set 去重，`blobStore.parseBlobUrl` + `mimeForExt` 过滤 image/*；
3. 限量并发（2）+ 整批总预算（60s）调视觉桥描述，单张失败静默跳过；预算是
   **完成门**：单个 budget timer 到点同时 abort 所有在飞请求（signal 透传到视觉通道
   fetch）+ resolve race；每张图 per-call 与预算 race（即使注入的 describeImage 不响应
   signal 且永不 settle，预算到期后该调用返回 null、worker 退出，不悬挂闭包）；
4. 成功描述附加为顶层 `xdt_media_descriptions: [{url, description}]`，随工具结果 JSON 透传给模型。

**判定**：`describeToolResultImage` 内——`getVisionBridgeController()` 未注入 / session 缺失 /
`session.instanceId !== sessionInstanceId`（旧实例）/ `shouldBridge(model)` 不命中 / blob 解析失败
→ 返回 null，静默跳过（每步 fail closed，工具调用永不阻塞）。

**兼容**：`xdt_media_descriptions` 是新增可选顶层字段，不在 `MEDIA_HOIST_KEYS`，渲染层/IM 出站
只消费固定媒体字段（`xdt_image_urls`/`xdt_video_urls`/`xdt_audio_tracks`/`xdt_media_produced`），
不会误消费。视觉桥关闭 / 无图 / 全失败时字段不存在，零影响。

---

## 五、视觉通道（三层公共后端）

### 5.1 复用现有 provider 体系（已确认）

视觉后端**不新增独立配置**，复用设置页里已配好的 provider。落地形态是
`apps/desktop/src/main/vision-bridge/vision-channel.ts` 暴露 **provider-scoped 解析函数**
`describeImageWithProvider(providerId, modelId, input, deps)`：**路由决策复用统一路由器**
（host 注入 `provider-route.resolveVisionBackendRoute`；与 agent 路由**决策同源**，最终对上游
的 model 还原结果一致——执行面不同：视觉桥直接发上游，代理链给子进程/代理 body 改 model）：
- **xd 特例**：客户端投影给 Codex 的模型（只声明 claude-code）走 Claude Messages 面，
  原生 codex 模型走 Responses 面——对齐 `providerRoutingForModel`。投影模型先剥 `codex/`
  + `[1m]` 路由前缀到裸 id（如 `codex/gpt-5.6-luna[1m]` → `gpt-5.6-luna`），再走下方
  modelIdRewrite；
- **modelIdRewrite**：一般 provider 按 `routing.modelIdRewrite.stripPrefix` 剥模型前缀
  （如 `xai/grok-4.3` → `grok-4.3`）；XD 投影模型在剥路由前缀后再叠加本步，对齐 agent
  代理链的 model 还原；
- **gateway-key 动态端点**：upstream 用 `effectiveXdGatewayBaseUrl()` 随凭据下发的租户端点，
  key 与 endpoint 同租户，避免吃到 builtin 占位地址；
- **按 wire 协议构造请求/解析响应**：`openai-chat`（`/chat/completions` + `image_url`）、
  `openai-responses`（`/responses` + `input_image`）、`anthropic-messages`（`/v1/messages` +
  `image` block）。

未注入 `resolveBackendRoute` 时回退内置 provider-scoped 解析（含 gateway-key 动态端点覆盖）。
**不新增独立 `VisionChannel` 接口/注册表**；primary/fallback 编排由调用侧
（`vision-bridge.ts` 的 `describeWithFallback`）负责。

**后端来源**：从 active-catalog 里选一个多模态模型（设置页下拉），凭证走该 provider 已有的
key 存储（自定义 provider key / 网关 key）。`resolveVisionBackendEndpoint` 解析端点元数据
（含 wireProtocol + 已 rewrite 的 model），供 C 层 Pi 子进程 env 注入复用——Pi 子进程按
同一协议构造请求/解析响应。

### 5.2 双模型 + fallback（已确认）

**配置形态**：视觉通道支持配置**两个**后端模型：
- **主后端**（必选）：优先使用；
- **fallback 后端**（可选）：主后端失败时自动切换。

**编排逻辑**（调用侧 `describeWithFallback` 负责，主/fallback 各自 `describeImageWithProvider`）：

```
describeWithFallback(input, prompt, signal):
  try: return await describeImageWithProvider(primary.providerId, primary.modelId, ...)
  catch primaryErr:
    if signal.aborted: throw primaryErr          // 取消静默，不尝试 fallback
    记录主挂原因（warn，含 backendRole/durationMs）
    if fallback 已配置 && (providerId, modelId) 与 primary 不同:
      return await describeImageWithProvider(fallback.providerId, fallback.modelId, ...)
    throw 视觉桥不可用
```

**判定"主后端挂了"**：网络/超时/HTTP 错误（API 不可达）、凭证错误（401/403）、空描述/不可用响应。

### 5.3 失败与回退（已确认）

| 场景 | 行为 |
|---|---|
| 只配主后端，主后端挂了（单图） | 该图用独立「图片不可用」占位文本替换，其余图照常描述 |
| 只配主后端，主后端挂了（全部图都失败） | 全部图替换为「图片不可用」占位文本（`IMAGE_UNAVAILABLE_TEXT`，与层 A 一致），**清晰提示**"视觉桥当前不可用，已用文字提示代替"。占位替换的意图：保留原始 image block 会让层 A（proxy transform）对同一失败后端再次调用，加倍延迟且与文档承诺的 pass-through 不符 |
| 主后端挂，fallback 成功 | 用 fallback 描述，提示"已用 fallback 后端"（可选） |
| 两个都挂（全部图都失败） | 全部图替换为占位文本 + 明确提示"主后端和 fallback 都不可用，已用文字提示代替" |
| 未配置 fallback，主后端挂 | 等同"两个都挂"提示口径（只报主后端原因） |
| 用户取消 / Stop / detach 导致 signal abort | 立即中止视觉请求；本轮不写「图片不可用」占位、不发 note，按取消语义静默收口（不作为后端故障上报，也不越过取消边界继续 dispatch） |

**全部图失败时的占位替换语义**：不是让纯文本模型看到原始 image block（那会触发层 A 二次调用同一失败后端），而是替换为与层 A 一致的「图片不可用」显式占位文本。**被动故障**导致的回退会给出明确提示，说明视觉桥
不可用、图可能送不到模型；**用户主动取消/拆离**导致的 abort 是取消语义，静默中止视觉桥，不把它
报告成视觉桥故障。

**提示位置**：
- 层 B：session 注入点发非终态事件（对齐 `REMOTE_LOCAL_ATTACHMENT_UNSUPPORTED`，
  `claude-code/index.ts:5075` 模式）；
- 层 A：transform 失败时落「图片不可用（Image unavailable）」显式占位文本（对齐 vision_proxy.py
  的不可用降级思路），约束模型不推测图片内容、如实告知用户。

**用户可见提示（层 B + 层 D，toast，零阻断）**：
- **开始识别**（层 B）：视觉桥命中且有图时，`onStart` 经 `MAKER_PUSH.EVENT` 广播
  `reason: 'vision-bridge-recognizing'`，renderer toast「正在识别图片中…」，agent 首个
  输出事件（text/tool_use）时精确 dismiss；**兜底清理**：done / 终态 error / stop / 会话
  关闭（close/clear/purge）都会清掉该 session 的 loading toast，防止视觉桥未输出就
  终结时残留（按 sessionId 隔离，多会话不互相误关）；
- **失败回退**（层 B）：主/fallback 都挂或不可用，`onNote` 广播 `vision-bridge-unavailable`
  / `vision-bridge-fallback`，renderer toast 警告「视觉桥不可用，图片已按原样处理」；
- **工具结果图全失败**（层 D）：`onToolResultImagesFailed` 广播 `vision-bridge-unavailable`
  （attemptedCount>0 且无成功描述时，fire-and-forget）；
- 所有提示 fire-and-forget，绝不阻塞视觉桥、工具结果或消息发送。

---

## 六、配置设计

遵循 `docs/dev-rules/configuration-and-overrides.md`（可见性分层 + 默认/override 分离 + 只存 override）。

| 配置 | 层级 | 说明 |
|---|---|---|
| 视觉桥总开关 | 高级设置（设置页） | 默认关。层 A/B 关 = 立即不生效；**层 C（Pi 工具）仅新 Pi 会话/重启生效**（env 在会话启动时注入，已运行会话的工具保留到会话结束，详见"配置形态边界"） |
| 目标模型集 | 高级设置（设置页） | **勾选清单**：默认勾选已知无视觉模型（deepseek 系列等）；已知有视觉/未知默认不勾但允许勾 |
| 主视觉后端模型 | 高级设置（设置页） | 下拉选一个已配 provider 的多模态模型 |
| fallback 视觉后端模型 | 高级设置（设置页） | 第二个下拉，可空 = 无灾备 |
| 各层开关 | 内部常量 | B/A/C 是否独立开（随总开关） |

**三态判定模块**（`packages/model-providers/src/visionCapability.ts`）：`classifyVisionCapability(id)`
返回 `vision` / `no-vision` / `unknown`。归一化 `[1m]` 后缀与 `codex/` 前缀；名单同时覆盖
带命名空间（`deepseek/deepseek-v4-flash`）与裸 id（`deepseek-v4-flash`）形态。
- **no-vision**（已知纯文本）：`deepseek/deepseek-*` 系列、`z-ai/glm-5.2`（#794 实测）；
- **vision**（已知多模态）：claude / gpt / gemini / grok（含裸 id 前缀）；
- **unknown**（名单外）：保守按"可手动勾选"，默认不勾。

**识别策略**（对照设计约束 a/b，第四轮修订）：
- **c. 三态判定（第一版 = 名单判定）**：`classifyVisionCapability` 用 hard-coded 前缀名单
  （`packages/model-providers/src/visionCapability.ts`）判定 `vision` / `no-vision` / `unknown`。
  **第一版不消费 catalog 的 `supportsImageInput` / `modalities` 元数据**（既有派生链 `catalog-to-descriptors.ts`
  仅原样透传，未填充）；catalog 元数据驱动的判定为**未来增强**，第一版以名单 + 手动覆盖为准。
- **b. 用户显式覆盖**：设置页勾选 = 显式 targetModels；未自定义时 no-vision 默认走视觉桥
  （运行时合并），用户可手动勾/取消任何模型（含故意让视觉模型走视觉桥以用廉价描述省 token）；
- **a. 读图失败兜底**：显式 400 / pi 拒绝时若该模型已启用视觉桥则透明接管。

**配置形态边界（评审确认，2026-08 第三轮 + 第四轮修订）**：
- `targetModels` 的持久化形态为 **model id**（如 `deepseek/deepseek-v4-flash`）。IPC 层 trim + 非空校验，
  runtime 判定做 `normalizeVisionModelId` 归一化（覆盖 `[1m]` / `codex/` / bare 变体）。
  **不支持手改配置文件塞入变体 id**：若外部写入方塞入变体，runtime 会命中但 UI 勾选可能不显示为已勾选
  （raw-id 比较）——此为已知边界，不作为支持路径。
- `primary` / `fallback` 的持久化形态为 **provider-scoped ref**：`{ providerId, modelId }` 双键
  （如 `{ providerId: 'user-openrouter', modelId: 'qwen-vl' }`）。providerId 用于解析该 provider 的
  routing/凭证，modelId 是视觉后端模型。**不是 catalog id 单键**——代码需要 providerId 才能取上游端点与 key。
- **targetModels 自定义语义**（第四轮修订）：未自定义时，已知无视觉模型（no-vision）默认走视觉桥
  （运行时 `isKnownNoVisionModel` 合并）；用户一旦显式保存 targetModels（含清空 `[]`，空数组也保留
  override），即按**用户勾选列表**生效，no-vision 默认合并关闭。用户可在 UI 取消默认勾选的模型。
- 配置通过**设置页**修改（走 IPC write，清缓存）；**不支持手改 JSON / 跨进程直接写同一文件**。
  读取路径有 TTL 缓存（2000ms）+ 长期快照，手改文件在本进程内不会立即生效（需本进程 write/reset 或重启）。
  因此**手改/跨进程关闭视觉桥最多延迟 ~2000ms 生效**（TTL 窗口内仍可能转一次图）；设置页关闭走 IPC write 立即清缓存、即时生效。
- **层 C（Pi 工具）生效例外**（第四轮确认）：总开关对层 A/B 立即生效；层 C 的 env 在 Pi 会话启动时一次性注入
  （`packages/maker-core/src/agents/pi/index.ts` spawnEnv），bridge 加载时注册工具——**已运行的 Pi 会话不受设置变更影响**，
  关闭总开关后已注册的 `vision` / `vision-locate` 工具保留到该会话结束，但新会话不再注入 env、不注册工具。
  因此「关 = 三层全不生效」对层 C 是**新会话语义**。执行时 enabled guard（读 settings 文件禁用已运行会话工具）为**可选增强**，
  待产品决策是否实施。primary/fallback 后端变更同理：已运行 Pi 会话继续使用启动时注入的旧
  baseUrl/requestPath/model/authorization/wireProtocol，直到会话结束；新会话才用新后端。

---

## 七、失败兜底汇总

| 场景 | 行为 |
|---|---|
| 视觉 API 超时/不可用 | 主→fallback 编排；都挂 → 回退无视觉桥 + 明确提示；用户取消 abort 除外（取消静默收口）；不阻塞 |
| 视觉后端未配置/凭证缺失 | 该模型不启用视觉桥，行为与现状完全一致 |
| 批量图 | 并发限制 + 预算（参考 `responses-anthropic-bridge/src/anthropic-images.ts` Tier 分档） |
| 远程 HTTP 图（codex） | 视觉通道需支持 URL 输入 |
| 缓存 | 进程内 `sha256(image+focusHint+backendRef(providerId,modelId))` → 描述，LRU 128；同图同 hint 同后端零重复调用，切换主/fallback 后端会换 key、不复用旧后端描述 |

---

## 八、分档实施路径（按顺序执行，别跑偏）

1. **落盘本方案书**（✅ 本文档）；
2. **视觉通道基础设施**：`vision-channel.ts` provider resolver + 配置（主/fallback 双后端）
   + 三态名单判定（`visionCapability.ts`；catalog 元数据驱动的 `supportsImageInput` 判定为
   后续增强，第一版未消费）；
3. **层 B**：session 层贴图主动调视觉；
4. **层 A**：proxy 透明替换（async transform + 双实例装配）；
5. **层 C**：pi 工具模式增强；
6. **测试验证**：typecheck + 单测 + 回归。

---

## 九、风险与权衡

| 风险 | 缓解 |
|---|---|
| 缓存率（改动送模型内容） | 描述只进 user 消息段（本就属 per-call），不插稳定前缀（`maker-core-and-agent-behavior.md` §3.1） |
| 性能（额外网络往返） | 超时降级 + 缓存 + 并发限制；层 B 只在贴图瞬间触发 |
| 准确性（描述失真） | focus hint + "只描述不推断"模板 + 保留"不要臆造"引导 |
| 安全（图片与同消息文字提示外发第三方视觉 API） | 复用现有 provider 凭证；默认关降低暴露面；文档明示：启用后图片内容（或图片 URL）**以及同消息文字提示（focus hint）**会发送给所选视觉后端；**错误消息/日志脱敏**——本地图片路径与文件名不进错误 message，模型输入只落脱敏占位，原始错误只进内部诊断日志 |
| system prompt 门禁 | 三层都不触碰 system prompt（`maker-core-and-agent-behavior.md` §4） |
| 多模态误判 | 默认关 + b 用户显式确认 + c 只做"支持视觉"乐观标记 |
| `RequestTransform` async 改造 | `isPromiseLike` 兼容 + 顺序 await（禁 Promise.all）+ 单测回归 `server.test.ts` |
| fallback 编排复杂度 | 只在"主后端真的挂了"才切 fallback；被动失败即回退无视觉桥 + 清晰提示，不静默；用户取消/拆离 abort 静默，不作为后端故障提示 |

---

## 十、关键文件索引

> 第四轮修订：分「实际实现文件」与「参考锚点」两组，避免把参考模式当实现入口。

### 实际实现文件（本分支新增/修改）

| 文件 | 角色 |
|---|---|
| `packages/maker-core/src/types/vision-bridge.ts` | VisionBridgeHook 类型（层 B 钩子契约，含 signal） |
| `packages/maker-core/src/session.ts` | **层 B 调用点**：视觉桥在 reservation 后、handle.send 前调用，signal 贯穿，sendReservation guard |
| `packages/maker-core/src/maker.ts` | MakerDeps.visionBridge 全局默认 + CreateSessionOptions 透传 |
| `packages/maker-core/src/agents/pi/index.ts` | 层 C env 注入（CINDY_PI_VISION_BRIDGE + piSecretEnvNames 剥离） |
| `packages/maker-core/src/agents/base-agent.ts` | resolvePiVisionBridgeEnv deps |
| `packages/maker-core/src/agents/pi/cindy-bridge-source.ts` | **层 C**：vision / vision-locate 工具（条件注册、魔数校验、异常泛化） |
| `packages/anthropic-compat-proxy/src/types.ts` | RequestTransform 允许 Promise |
| `packages/anthropic-compat-proxy/src/server.ts` | runTransforms async + isPromiseLike（顺序 await） |
| `packages/anthropic-compat-proxy/src/vision-bridge-transform.ts` | **层 A**：双格式图片替换（同步短路 + async 命中） |
| `packages/model-providers/src/visionCapability.ts` | 三态判定（名单）+ normalizeVisionModelId |
| `apps/desktop/src/main/maker-host/provider-route.ts` | `resolveVisionBackendRoute`：视觉后端复用统一路由器（xd 特例 / modelIdRewrite / gateway-key 动态端点 / wireProtocol）+ `setVisionGatewayKeyReader` |
| `apps/desktop/src/main/vision-bridge/vision-channel.ts` | 视觉通道：endpoint/凭证/魔数/大小/裁剪/AbortSignal.any + 三协议构造/解析 |
| `apps/desktop/src/main/vision-bridge/vision-bridge.ts` | **层 B**：isTargetModel + describeWithFallback + 缓存/LRU/inFlight |
| `apps/desktop/src/main/vision-bridge/vision-bridge-settings-store.ts` | 配置 store + cachedSnapshot TTL + mergeOverrides |
| `apps/desktop/src/main/vision-bridge/pi-vision-bridge-env.ts` | 层 C env 序列化（host 侧） |
| `apps/desktop/src/main/vision-bridge/vision-bridge-controller.ts` | proxy transform 可变 controller |
| `apps/desktop/src/shared/visionBridgeSettings.ts` | 配置类型 + 默认值 |
| `apps/desktop/src/renderer/components/settings/VisionBridgeSection.tsx` | 设置页 UI（两个清单 + 三态标注） |
| `apps/desktop/src/main/maker-host/index.ts` | createVisionBridge + setVisionBridgeController + resetMaker 清理 |
| `apps/desktop/src/main/maker-host/anthropic-compat-proxy-host.ts` | 层 A 装配（cc/pi 实例） |
| `apps/desktop/src/main/maker-host/codex-proxy-host.ts` | 层 A 装配（codex 实例） |
| `apps/desktop/src/main/bootstrap-electron.ts` | IPC 三件套（GET/SET/RESET）+ parseVisionBridgeSettingsPatch |
| `apps/desktop/src/main/maker-ipc/channels.ts` | `VISION_BRIDGE_SETTINGS_GET/SET/RESET` channel 常量 |
| `apps/desktop/src/renderer/components/settings/SettingsView.tsx` | 设置页挂载 VisionBridgeSection |
| `packages/anthropic-compat-proxy/src/index.ts` | 导出 createVisionBridgeTransform |
| `packages/model-providers/src/index.ts` | 导出 classifyVisionCapability / isKnownNoVisionModel / normalizeVisionModelId |
| `packages/maker-core/src/types/index.ts` | 导出 vision-bridge 类型 |
| `apps/desktop/src/renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko}/common.json` | 设置页五语言文案 |
| `i18n/glossary.json` + `i18n/GLOSSARY.md` | vision-bridge 术语条目（proposed） |
| `apps/desktop/src/preload/preload.ts` + `src/renderer/vite-env.d.ts` | IPC 桥 + 类型 |

### 参考锚点（旧文档/模式，非实现入口）

| 文件 | 角色 |
|---|---|
| `packages/anthropic-compat-proxy/src/transform.ts` | #794 图片降级先例 `TOOL_RESULT_IMAGE_OMITTED_TEXT` / `stripGlm52`（参考） |
| `apps/desktop/.../cindy-brain/imageChannelRegistry.ts` | 旧图片执行通道注册表模式（参考，非视觉桥实现） |
| `apps/desktop/.../cindy-brain/geminiImageClient.ts` | 视觉后端候选基础（参考） |
| `packages/model-providers/src/types.ts:369` | `supportsImageInput`（识别策略参考，第一版未消费） |
| `apps/desktop/.../catalog-to-descriptors.ts:89` | supportsImageInput 派生链（参考，第一版未填充） |
