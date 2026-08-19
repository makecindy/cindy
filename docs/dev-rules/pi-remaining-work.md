# PI harness 剩余工作 / 续做指南

> 本文件是 `sandbox/pi-live` 分支的交接记录:已交付什么、还差什么、每一项**怎么接着做**
> (含具体 file:line 锚点与坑)。配合 `docs/dev-rules/pi-harness.md`(架构、维护不变量、
> 上线清单)一起看。最后更新:2026-08-01。

## 2026-08-01 收口状态

本文下方保留历史调研与实现过程，当前非核心缺口已收口：

- Pi pin 升至 v0.83.0；Mac Intel/Apple Silicon、Linux x64/arm64、Windows x64/arm64
  六平台资产有官方 digest pin，Forge 按目标平台 provision 完整目录并打包。
- 文件附件、Extra Dirs（结构化写工具只读保护）、minimal thinking、纯 BYOM 无 Cindy 登录已开放。
- 精确 rewind 由 Pi `fork(entryId)` 裁剪对话，文件恢复复用 Cindy Git savepoint；与原会话树共用入口。
- Pi Auto Memory 控制面已开放，自动/手动 compaction summary 写 searchable digest；reset 复用
  Maker Memory manager。
- 真二进制覆盖 v0.82.1 → v0.83.0 resume、invalid resume CAS、rewind/fork 后 resume；scheduler
  Pi 无人值守参数有契约测试。剩余的异构 OS 启动和逐真实模型额度 smoke 是 release runner/RC
  门禁，不再需要产品代码。

## 分支与运行

- 工作分支:`sandbox/pi-live`(基于 `pi-agent-research`)。
- 本机联调沙盒:独立 checkout `cindy-pi-latest-sandbox`,独立 userData
  `Cindy-dev-pi-latest`,以 `--isolated=pi-latest` 命名。
- 启动(保留其它 dev 实例,被动模式,不抢定时任务):
  ```bash
  XDT_USER_DATA_DIR='~/Library/Application Support/Cindy-dev-pi-latest' \
  XDT_ISOLATED=1 XDT_ISOLATED_NAME=pi-latest \
  pnpm restart:desktop:remote --preserve-running
  ```
  **只重启 pi 沙盒**:先 `pnpm desktop:whoami --all` 找到 pi-latest 的 PID,`kill <pid>`,
  再跑上面的命令。**绝不用会全局关实例的默认 restart**(会误杀其它 checkout 的 dev)。
- 验证口径:maker-core `pnpm --filter @cindy/maker-core test`;desktop
  `pnpm --filter desktop run typecheck`;mcps `pnpm --filter @cindy/mcps run build && ... test`;
  i18n `pnpm check:i18n` + `pnpm check:i18n-glossary`。pi 真二进制集成测试在
  `packages/maker-core/src/agents/pi/__tests__/pi-agent.integration.test.ts`(二进制缺失自动 skip)。

## 已交付(sandbox/pi-live 上,均已测试)

- redacted thinking 修复;PI 会话图标(π);Auto-review 核心 + pi adapter + auto 档;
  PI_OFFLINE / NO_PROXY;`--append-system-prompt`(保留 pi 默认 prompt);斜杠命令转义 +
  只读工具凭证路径收口;成本计量真值;权限档四语 i18n + 弹窗正文归一化 + 能力契约测试。
- **HTML 导出**(`export_html`)、**手动压缩**(`compact`)、**subagent 接 pi**(Orca worker 可选 pi)。

维护不变量见 `pi-harness.md §4`(权限档从严到宽、凭证 regex 三处同步、斜杠转义、
auto fail-closed、成本派生链、弹窗正文 harness 无关)。

---

## ✅ 代码审查轮(2026-07-31,对抗式 review 后修复)

两个对抗式 review agent(BYOM 路由 / 记忆-斜杠-凭证)发现的**真实**问题已修复(均带测试):

- **digest 按字节截断**(index.ts `truncateToByteBudget`):原按字符 `slice(0,7000)`,中文摘要
  ~2731 字即超存储 8192 **字节**硬上限 → `write` 抛 `shard-too-large` 被吞 → digest 静默丢失。
  改为码点安全的字节预算截断;title 里的 `reason` 也收敛(去换行 + 截 40)防撑爆 maxTitleLen。
- **凭证门覆盖 `/proc/<pid>/task/<tid>/environ`**(shared/auto-review.ts + cindy-bridge-source.ts
  同步):原 `[^/\s]*` 跨不过 `/`,task/tid 变体读同一份进程环境(含注入的 provider key)漏判。
  正则放宽为 `[^\s]*`。
- **凭证扫描递归 array / 嵌套 object**(cindy-bridge-source.ts `touchesCredentialPath` +
  auto-review-policy.ts `findCredentialLeaf`,深度上限 6):原只扫顶层 string 字段,
  `{paths:[...]}` / `{opts:{path}}` 形态漏判。防御性收口(当前 pi 内置工具用顶层 path,暂无
  已知利用面,但抗 pi 二进制升级后 tool schema 漂移)。
- **BYOM env 变量名去重**(pi-host.ts `buildPiNativeProvidersFromConfigs`):`my-vllm` 与
  `my_vllm` 都归一成 `CINDY_PI_KEY_MY_VLLM` → 后写覆盖 → 一个 provider 的 key 被发往另一端点
  (凭证串号)。撞名追加 `_2/_3` 保证独立 env 名。
- **getAuthEnv 占位符只给订阅 OAuth provider**(pi-host.ts `PI_OAUTH_SUBSCRIPTION_PROVIDERS`):
  原 `providerId && !== 'xd'` 把自定义 BYOM providerId 也塞占位符 → 毒化网关 `cindy` 块 →
  BYOM 会话中途切回网关模型 401。改为仅 anthropic/openai/xai 用占位符,BYOM/自定义拿真网关 key。
- **保留 `cindy` provider id**(custom-provider-store.ts RESERVED_IDS):撞 pi 网关 provider id
  会让其模型既被排除出网关块又不写原生块 → `--model` 校验失败。
- **两处源码契约测试同步 pi 改动**:`sessionHeaderMenuParity`(导出 HTML / 压缩暂隐;
  任务分支只在 Cindy 分叉家族时显示,仍是头部专属)、`automationGeneratedSessions`(
  自动组头图标改用 `agentKindToVendor`,pi 会话显示 π)。

**已评估暂不修(设计权衡 / 边缘,后续按需)**:
- **#2 已解决 — 纯 BYOM 不依赖网关 key**:`getState` 按 custom provider runtime 校验自身
  apiKey/keyless 状态；即使旧会话没有 providerId，PiAgent 也会先解析 model→native provider
  再过 auth。models.json 的 `cindy` block 在无网关 key 时只拿不可用占位值，不会发往 BYOM endpoint。
- **#4 resolvePiNativeProviders 失败降级**:抛错 → gateway-only。纯 BYOM 模型此时不在任何 block
  → pi `--model` 校验失败(fail-closed,会失败而非静默错路由),可接受;已 warn 日志。
- **#5 `managed` 鉴权自定义 provider**:当前按 keyless 写 dummy key,若指远端会 401。取决于
  是否真支持 managed 型 pi 自定义 provider,待该形态确认后再定。
- **#7 catalog id 与原生 model id 一致性**:双路由去重靠 `id` 精确相等;host 两侧 id 生成须一致
  (纯 BYOM 目录无该项,当前不触发)。可加断言。
- **B3 多行斜杠命令**:`escapeLeadingSlashCommand` 只护消息开头(pi 命令为 leading-only 解析);
  若未来确认 pi 按行识别命令,再对换行后的 `/` 转义。

> 注:`makerSendToSessionOrdering.test.ts` 的 3 条 source-contract 失败为 **upstream/main
> 自带**(needle `const live = maker.getSession(targetSessionId);` 等在 upstream/base/HEAD 均
> 不存在),非 pi 工作引入;未改动其契约。

---

## ✅ 已交付:压缩即记忆(2026-07-30,Option 1)

新增 `digest` 记忆类型:pi `compaction_end.result.summary` → `deps.makerMemory.write` 写 digest,
进 FTS 可 `memory_search`,但排除出 MEMORY.md / system prompt / LLM memory_write 工具。见
`memory/types.ts`、`memory/storage.ts rebuildIndex`、`pi/index.ts` writeCompactionDigest +
onEvent 钩子。下方原设计说明保留作背景。

### (原调研)压缩即记忆的设计取舍

**目标**:pi 压缩上下文时,把被丢弃内容的要点沉淀进 Cindy 记忆,新会话可召回。

**关键约束(调研结论)**:
- CC 的 auto-memory / auto-dream 是 **CC 二进制内部能力**,pi 触达不到,不能复用。
- `cindy_memory` 是 per-workdir 文件式(MEMORY.md + 分片),只有 4 类
  `user/feedback/project/reference`,**没有 session/auto 命名空间**。写进去的任何东西都会被
  `rebuildIndex` 列进 MEMORY.md,而 MEMORY.md 会内联进系统提示 —— **裸转存压缩摘要 = 直接
  污染 curated 记忆 + 撑大系统提示**。
- pi translator 的 `compact_boundary` 目前**只带 token 数,不带摘要正文**
  (`packages/maker-core/src/agents/pi/translator.ts` 的 `compaction_end`)。摘要文本留在 pi
  自己的 session JSONL 里,主进程看不到。
- pi bridge(`cindy-bridge-source.ts`)能经已桥接的 `mcp__cindy_memory__memory_write` 调
  cindy_memory(仅 Maker memory 模式开时),也能挂 pi 的 `session_before_compact` 钩子拿到
  `preparation.messagesToSummarize`(可 `serializeConversation` 成文本)。

**推荐设计(不污染 curated memory)—— 二选一,动手前与 Chris 确认**:
1. **新增记忆 type(如 `digest`)并改 `storage.rebuildIndex` 把它排除出 MEMORY.md**:只进
   FTS(可被 `memory_search` 检索)、不进 curated 索引/系统提示。改
   `packages/maker-core/src/types/memory.ts:15`(MEMORY_TYPES)+ `memory/storage.ts` 的
   `rebuildIndex`(~312-338)。
2. **灌进 `session_search` 底层的 `messages_fts`(原始对话历史库),而非 curated 分片** ——
   语义上压缩摘要更接近「原始历史」而非「提炼后的偏好/决策」,天然不碰 MEMORY.md。见
   `packages/lizi-mcps/src/memory/sessionSearch.ts`。

**落地路径**:在 `cindy-bridge-source.ts` 挂 `session_before_compact` → 取
`preparation.messagesToSummarize` 序列化 → 经 MCP 通道写入上面选定的目标。注意:
(a) 仅 Maker memory 模式开时通;(b) 复用 flush-controller 脚手架
(`packages/maker-core/src/memory/flush-controller.ts`,当前只在 CC/Codex 接线,pi 未接);
(c) pi 的钩子是否真给摘要正文属 pi 二进制内部,需实测。

**验收**:pi 会话跑到触发压缩,确认要点进了选定存储、`memory_search` 能查到、MEMORY.md
**没有**被污染、系统提示未膨胀。

---

## 还差 2:BYOM 本地/自定义模型(走 pi 原生 provider)

**目标**:用户配自定义/本地模型(Ollama / vLLM / 自建端点),pi 直连,**不过 anthropic-compat
代理**(设计原则:禁止「先转 Claude 再转 pi」双重转义)。

**现状(可复用的基建 —— 比预想的多)**:Cindy 已有完整自定义 provider 体系 ——
`apps/desktop/src/main/maker-host/custom-provider-store.ts`(CRUD + DB schema)、
`buildUserProvider`、`createDesktopProviderService.ts:384 setCustomProviders`、
`active-catalog.ts`(base + custom 合并进目录,下游选择器/路由统一消费)。
**关键发现**:`CustomProviderConfig.runtimes` 是 `Partial<Record<AgentKind, CustomProviderRuntimeConfig>>`
(custom-provider-store.ts:51),**数据模型天生支持 per-agent runtime,包括 `pi`**;每个
runtime 带 `baseUrl` + `models` + auth。所以「自定义 provider 能不能挂 pi tab」在数据层已
成立;缺的是 pi 侧把它写成**原生 provider 块**、以及 UI 是否允许添加 pi runtime。

**✅ 已交付:maker-core 核心(2026-07-30,commit 4c0b269b)** —— 原生 provider 块 +
provider 感知路由 + 端到端真二进制测试(BYOM 模型直连原生端点、网关零请求)。契约:
`AgentDeps.resolvePiNativeProviders` + `PiNativeProviderSpec`(base-agent.ts);
`writeModelsJson` 写多 provider;`buildModelProviderMap` + provider 感知 `setModel`/`--provider`
(pi/index.ts)。**host 侧只要实现 `resolvePiNativeProviders` 把 custom provider 喂进来即可。**

**剩余 = host 接线 + UI(按依赖顺序,均在 desktop / model-providers 侧)**:

1. **`packages/model-providers/src/custom-provider-store.ts:36`** `VALID_AGENTS` 加 `'pi'`;
   `:113-119` wireProtocol 白名单加 pi 分支(pi 允许 anthropic-messages / openai-chat /
   openai-responses)。加 pi 是**增量**——CC/Codex custom provider 只有 cc/codex runtime,
   不受影响;但要加测试确认。
2. **`packages/model-providers/src/user-provider.ts:44`** `AGENT_ORDER` 加 `'pi'`;`:36`
   `CUSTOM_EFFORTS` 加 pi 档位;`:66` `defaultWireProtocol` 加 pi 默认。这样 custom provider
   的 pi runtime 才进 `deriveAvailableModels('pi')`。
3. **`apps/desktop/src/main/maker-host/pi-host.ts`** 实现 `resolvePiNativeProviders`:从
   `getActiveCatalog()` 筛 `source==='user'` 且有 pi runtime 的 provider,映射
   wireProtocol→PiNativeApi(`openai-chat`→`openai-completions`、`openai-responses`→同名、
   `anthropic-messages`→同名),读 `readCustomProviderKey(id,'pi')` 填进 `env`(键名
   `CINDY_PI_KEY_<ID>`,与 spec.apiKeyEnvVar 对应),models 带 baseUrl/models[]。接到
   `buildPiAgent` 的 deps。**注意**:原生路径不经 provider-route / compat-proxy,loopback/剥
   凭证那套对它不生效——安全边界(禁 none+远程等)由 store 的 validate 与本 resolver 把关。
4. **UI(唯一剩余增量)**:`apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx`。
   **✅ 后端全通(commit 见 pi BYOM host 接线):store 收 pi runtime、user-provider 派生 pi 模型、
   pi-host resolvePiNativeProviders 产出原生块——只差这个对话框能让用户添加 pi runtime。**
   做法(用 typecheck 当 34 处的穷举清单):`DialogAgentKind` 加 `'pi'` → tsc 会逐个报出所有
   `Record<DialogAgentKind,...>` 缺 pi 的位置,逐个补齐:
   - `AGENTS`/`VISIBLE_AGENTS`/`TAB_META`(加 PiMark + i18n label/desc);
   - 每-runtime 表单 state(init/read/handlers 的 agent 字典);
   - `wireProtocol` 默认(pi 建议 openai-chat)+ **pi 专属 api 选择器**(3 选:anthropic-messages/
     openai-responses/openai-chat;cc 锁 anthropic、codex 锁 responses/chat,pi 三选);
   - i18n 四语(`settings.providers.custom.protocol.pi*` + api 选择器文案),过 check:i18n/glossary。
   验证:desktop typecheck + CustomProviderDialog.test.tsx。

**原设计说明(缺口 = pi 特有)**:
1. **`writeModelsJson`(`packages/maker-core/src/agents/pi/index.ts:203`)现在只写单一
   `cindy` provider,baseUrl 全指向 compat 代理。** 要让它对「自定义/本地 provider」额外写出
   **原生 pi provider 块**:`{ name, baseUrl:<用户端点>, api:'openai-completions'|'anthropic-messages'|'google-generative-ai', apiKey:<env 插值或占位>, models:[...] }`,
   baseUrl 直连用户端点。需要 host 把自定义 provider 的元数据(端点/api 类型/key 来源)透传给
   PiAgent(目前只透传 `availableModels: ModelDescriptor[]`,信息不够 —— 要扩 deps 或
   capabilityAdditions 带 provider 维度)。
2. **`setModel`(`pi/index.ts` handle.setModel)现在硬编码 `provider: PI_PROVIDER_ID`**。
   BYOM 模型属于别的 provider,要改成 provider-aware(从 model → 其所属 provider 解析)。
3. 模型选择器让自定义模型出现在 pi tab(custom provider 的 `agents` 字段需含 `pi`;确认
   `buildUserProvider` / 目录 union 是否已给 pi tab)。
4. keyless 本地服务器(Ollama)要留 dummy apiKey,否则 pi `/model` 不显示(见
   `apps/pi-bin/darwin-arm64/docs/models.md`)。

**验收**:配一个本地 Ollama,pi 会话能选到它、直连本机端点跑通(抓包确认没走 compat 代理),
成本按目录/0 计,thinking/工具调用正常。

---

## ✅ 已交付:统一会话树(fork/分支树状升级,2026-07-31)

**目标**:pi 原生是 append-only entry 树,支持分支、树导航、分支摘要。现在 Cindy 只用了最粗的
fork(散落成平级会话)。升级成「同一会话内可切换的分支树」,**不引入新概念**,按现有 fork/分支
迭代。

**pi 侧能力**:`get_tree`(rpc.md:724)返回树结构;`fork`/`clone`/`get_fork_messages`
已在 `PiAgent.forkSdkSession` 用;`get_entries` 可读分支条目;`branchSummary` 设置控制分支
摘要。

**已落地**:
- 统一成一个「会话分支」入口:外层继续展示 Cindy 原有 `parentSessionId` 会话分叉,当前 Pi
  会话节点内嵌 Pi append-only entry 树,没有再造第二套分支概念。
- maker-core 增加 harness-neutral `sessionTree` capability / snapshot / navigate 契约;Pi 通过
  `get_tree` 读取,私有 bridge command 调 `ctx.navigateTree`,可选离开分支时调用模型生成摘要。
- 切换 Pi 分支后,Cindy SQLite 在一笔事务内 soft-hide 旧可见投影并恢复活动路径;旧分支不删除。
  选中 user entry 时原 prompt 回填编辑器;上下文占用从 Pi `get_session_stats.contextUsage`
  权威估算恢复。
- IPC / preload / desktop remote transport / device-link allowlist / mobile transport contract 已全链路接通;
  老被控端仍按 `CHANNEL_NOT_ALLOWED` 能力降级。桌面 UI 用设计 token,Light/Dark 共用。
- 明确边界:Pi 分支切换只改变模型对话上下文,不回滚工作区文件;Cindy fork 仍是独立会话/
  worktree 的粗粒度分叉。

---

## 已收口:上线 QA 自动化与发布门禁

见 `pi-harness.md §6`。要点:
1. **平台二进制**:v0.83.0 六平台 digest pin + Forge stage/签名路径已完成；异构 OS 启动 smoke
   由各平台发布 runner 做，不能在 Apple Silicon Mac 上伪装成实机结果。
2. **模型兼容矩阵**:三种 wire protocol、真 Pi bridge/tool/usage/cache 自动测试已完成；逐个真实
   商业模型只剩 RC 账号额度 smoke。
3. **实机联调**:compaction、scheduler 参数、v0.82.1→v0.83.0 resume、invalid fallback、
   rewind/fork 后 resume 已自动覆盖。

## 顺手可做的小项

- **minimal effort 档（已完成）**:Pi capability 与所有 reasoning-capable Pi model descriptor
  暴露 `minimal`；具体模型是否接受该档仍由 Pi v0.83 的 provider mapping 决定。
- **settings.json 钉值**:目前没写 pi settings.json,retry/超时全 pi 默认;若发现某默认值需防
  二进制升级漂移,在 `pi/index.ts` 加 `writeSettingsJson`(与 models.json 同机制)。
