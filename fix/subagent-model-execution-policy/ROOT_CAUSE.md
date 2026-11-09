# ROOT CAUSE — Cindy 子代理模型执行授权缺失(2026-11-07 事故取证)

> 取证结论(只读调查,不改任何线上配置)。事件:2026-11-07 19:35:57–19:39:30 CST,
> OpenRouter 记录 `DeepSeek V4 Flash 0423` 46 个请求、1,364,351 token,
> 而用户只在 Cindy 的 OpenRouter provider 上配置了 Crouton Alpha 与
> NVIDIA Nemotron 3.5 Super VL (free),且未授权任何付费 DeepSeek 通道。

## 执行通道(已证实)

| 项 | 值 |
|---|---|
| 工具 | Pi 原生 `subagent` 工具,collaborate 模式,3 个并行子任务 |
| 父会话 | `yjhl6qasjrtdmi7zhrbsbvfi` |
| 父工具调用 | `call_a606b8b1` |
| 路由 | `openrouter-a3fe858b / deepseek/deepseek-v4-flash` |
| 执行记录 | `subagent_runs` 行 `ikqsalp2j8vdz2r5b59e79y6`,1,364,351 tokens,56 toolUses |
| 子任务 | 3 个子进程,46 个 usageSegments,token 分量 399,677 + 783,650 + 181,024 = 1,364,351 |
| 产物 | `inventory/migration-plan.json/.csv`、`deliverables/01~04*.md` 正常生成 |

`daily_model_usage` 对应日行 `deepseek/deepseek-v4-flash` 的 input 100,985 +
output 37,894 + cacheRead 1,225,472 = 1,364,351,与 OpenRouter 账单**逐 token 对上**。

## 触发链(已证实)

1. 用户 11:35 UTC(19:35 CST)消息只说了"用其他模型当 subagent 协作"——
   笼统授权,没有指定 provider、model 或付费通道。
2. Lead 在 thinking(L329)里**自行决定**:`provider openrouter +
   model deepseek/deepseek-v4-flash`,并在回复(L330)里宣布
   "DeepSeek V4 Flash,走 OpenRouter"。
3. 当时会话的系统约束(L5)和 compaction 记录(L250)明文要求
   "不得静默切换到 OpenRouter、OpenAI、DeepSeek"——被笼统授权覆盖。

## 已排除(证据)

- **Orca `create_worker`**:当日只有 2 个 `worker-ready-placeholder` 接收,
  yjhl 会话没有 `create_worker` 工具调用。
- **`spawn_agent`**:当日出现的都是系统提示词/thinking 文本提及,不是工具调用。
- **fallback / Provider 自动解析**:omlx/Qwen 本地路由前后都正常;
  Lead 选择 OpenRouter 是显式决策("cost/speed fine"),不是回退。
- **外部程序复用 Key**:46 个请求、1,364,351 token 全部落在 `call_a606b8b1`
  这一个子代理调用里,无余量供外部程序使用。
- **xd utility/refiner 路径**:51 个 `xd` utility one-shot 与
  `refinerProvider: cat:xd:codex:deepseek/deepseek-v4-flash` 是另一条无关通道。

## 根因

**执行层没有任何闸。** `bot-model-chain` 只管主 Bot 路由,子代理模型选择完全不受其约束:

1. `list_available_models` 列出的任何 `(provider, model)` 组合,Agent 都可以直接在
   `subagent` 工具调用里指定并立即执行;
2. `openrouter-a3fe858b` 在 `provider-order` 与 `remote-provider-access` 里是启用的,
   Key 本身可达付费模型;
3. 授权判断不存在:既没有 allow-list 检查,也没有付费通道审批;
4. 事后审计里 `subagent_runs.provider` 记的是泛泛的 `pi`,看不到真实的
   `openrouter-a3fe858b`。

一句话:**可用(available)被当成了授权(authorized)。**

## 待核实(非阻塞)

- OpenRouter 后端每个请求的精确 `model`(需后端访问;已由 Cindy 侧逐 token 对账推断)。
- 用户 11:35 UTC 原消息措辞(已从 thinking 转述;不影响结论)。
- `daily_model_usage` 中 cacheRead 与 OpenRouter token 计数的口径微差
  (本次三方对账已闭合)。
