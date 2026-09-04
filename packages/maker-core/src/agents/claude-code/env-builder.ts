/**
 * env 三段组装 + process.env strip —— Claude Code spawn 用。
 *
 *   1. process.env 剥离敏感 OAuth token（避免 CLI 子进程读到用户系统 key）
 *   2. behaviorFlags 打底（runtimeConfig 注入，host 配置）
 *   3. endpoint → ANTHROPIC_BASE_URL（runtimeConfig 注入）
 *   4. authEnv 最后合并（确保不被 behaviorFlags 误覆盖）
 *   5. CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 锁定 provider 路由
 *      （阻止 workdir/.claude/settings.json env 字段覆盖 app 注入的 key/baseUrl）
 */

import type { AgentCredentialMode, AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { AgentRuntimeConfig } from '../../interfaces/runtime-config.js';
import { applyPlainTextTerminalEnv } from '../shared/terminal-output.js';

export const MAKER_MODEL_CONTEXT_WINDOWS_ENV = 'XDT_MAKER_MODEL_CONTEXT_WINDOWS';

interface ModelContextWindowSource {
  id: string;
  contextWindow: number;
  /**
   * 是否把无 [1m] 后缀的 id 镜像出一个同窗口的 `${id}[1m]` 键(缺省 true,
   * 兼容 provider 路由模型把 [1m] 当同窗口路由别名的历史语义)。claude-* 的
   * [1m] 是真实的 1M 通道、不是同窗口别名,按会话路由注入的条目必须传 false,
   * 否则 200K 会被镜像到 Fast 切换后的 [1m] 形态上(#3661)。
   */
  mirrorOneMillionSuffix?: boolean;
}

interface ClaudeEnvBuildOptions {
  /**
   * Host-provided model context windows for provider-routed models.
   *
   * Claude Code's internal resolver only knows Anthropic model names and a few
   * hard-coded suffixes. Maker capabilities are the source of truth for XDLLM /
   * LiteLLM-routed models such as qwen/*, deepseek/*, Kimi, GLM, Gemini, GPT.
   */
  modelContextWindows?: readonly ModelContextWindowSource[];
  /**
   * The model selected for this spawn. Claude Code's auto-compact resolver does
   * not read Maker's catalog-wide window map; it needs the selected model's
   * window in CLAUDE_CODE_MAX_CONTEXT_TOKENS.
   */
  activeModel?: string;
  /**
   * 'remote': 远端 cc-mgr daemon 跑 SDK 的 env —— 从空字典起,绝不继承 desktop
   * 进程 OS env(Windows HOME=C:\... 透到远端会让 cc CLI 落怪目录)。daemon 自身
   * process.env 的真实远端 HOME/PATH 由 SDK spawn merge 提供。
   * 'local'(默认): 继承 cleanProcessEnv() —— 本地子进程需本地 PATH/HOME 才能跑。
   */
  mode?: 'local' | 'remote';
  /** 本次子进程明确要走的凭证形态。undefined 时保持 adapter 既有 fallback。 */
  credentialMode?: AgentCredentialMode;
  /**
   * 本次 spawn 的会话来源(显式 providerId;null/undefined = 隐式默认路由)。
   * 供 runtimeConfig.subagentModelForRoute 按父会话来源判定 subagent 覆写是否可路由
   * (options.subagentModel 省略、走 runtimeConfig 回落分支时消费)。
   */
  sessionProviderId?: string | null;
  /**
   * CC CLI 内部小模型调用(bash 命令前缀判定/标题/摘要等)的模型覆写
   * (`ANTHROPIC_SMALL_FAST_MODEL`)。未设置时 CLI 用内置**裸名**默认值 ——
   * 经网关路由的会话模型 id 带命名空间前缀(如 `anthropic/claude-opus-5`),
   * 网关模型白名单按字面比对,CLI 的裸名默认值必被拒为 403
   * user_model_access_denied(#3557)。调用方只在会话 wire 模型带命名空间时
   * 传入(钉到会话自身的 wire 模型 —— 它是唯一确定已授权的 id);裸名会话
   * (订阅直连 / 自定义中继)省略,保持 CLI 默认行为零变化。
   */
  smallFastModel?: string;
  /**
   * 调用方已解析好的 `CLAUDE_CODE_SUBAGENT_MODEL` 决定(见 subagent-model-default.ts)。
   *   - 字符串 → 设该值;
   *   - `null`  → 明确**不要设**(让用户手写 agent 的 frontmatter `model:` 生效);
   *   - 省略    → 回落读 `runtimeConfig`(未接该解析的调用方保持旧行为;有
   *     subagentModelForRoute 时按 sessionProviderId/credentialMode 走路由感知入口)。
   */
  subagentModel?: string | null;
}

function serializeModelContextWindows(
  models: readonly ModelContextWindowSource[] | undefined,
): string | undefined {
  if (!models || models.length === 0) return undefined;

  const entries: Record<string, number> = {};
  for (const model of models) {
    if (!model.id || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
      continue;
    }
    const window = Math.floor(model.contextWindow);
    entries[model.id] = window;
    // 后缀判定大小写不敏感(#3661):用户配置 `...[1M]` 时不能再镜像出
    // `...[1M][1m]` 垃圾键。镜像本身仍按原样键写入,消费侧按字面匹配。
    const hasOneMillionSuffix = /\[1m\]$/i.test(model.id);
    if (model.mirrorOneMillionSuffix !== false && !hasOneMillionSuffix) {
      entries[`${model.id}[1m]`] = window;
    }
  }

  return Object.keys(entries).length > 0 ? JSON.stringify(entries) : undefined;
}

/**
 * Anthropic / Claude Code 体系所有"会让 CC CLI 子进程绕过 app 配置"的 env 字段
 * 单一来源:
 * - 鉴权字段 (API_KEY / AUTH_TOKEN / OAUTH_TOKEN / *_FILE_DESCRIPTOR)
 * - endpoint 重定向 (BASE_URL / UNIX_SOCKET)
 * - header 注入 (CUSTOM_HEADERS — 可塞 Authorization 直接覆盖 key)
 * - provider 切换 (Vertex / Bedrock / Foundry — 走另一套体系)
 * - 配置目录重定向 (CLAUDE_CONFIG_DIR — 让 CC 去读别处的 .credentials.json)
 *
 * 任何 host (desktop / 未来 server / CI) 都应该:
 * - boot 阶段调用 stripSensitiveAnthropicEnv() 清根上的 process.env (主防线)
 * - buildClaudeEnv 调用 cleanProcessEnv() 兜底自己手里的字典 (副防线)
 */
export const SENSITIVE_ANTHROPIC_ENV_KEYS = [
  // 鉴权
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  // 订阅身份元数据(与 OAUTH_TOKEN 配套,cc env-token 分支消费):不剥离的话,从
  // 带这些变量的 shell 启动 Cindy(典型:终端里的 cc 会话内跑 dev)会把**别人的
  // 档位/scopes**漏进子进程 —— 凭证库没提供时 getAuthEnv 不注入对应 key,继承残留
  // 会顶上,订阅会话以错误 scopes/tier 起跑。
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  // endpoint 重定向
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  // header 注入
  'ANTHROPIC_CUSTOM_HEADERS',
  // provider 切换
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  // 配置目录重定向
  'CLAUDE_CONFIG_DIR',
  // 子代理派发覆盖:这是 host 独占的键(值由「Subagent 模型」设置经
  // subagent-model-default.ts 解析决定),继承来的残留会以最高优先级盖掉用户手写 agent 的
  // `model:`,而且**盖得静默**。典型泄漏路径:终端里的 cc 会话跑 dev,Electron 从
  // process.env 继承外层会话的值 —— 那时 host 判定的「不要设」在 SDK 的
  // `{...process.env, ...userEnv}` 合并里根本不生效(我们只能覆盖,删不掉)。
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

/**
 * 远端路由 materialization 覆盖前,须从 remoteEnv 剥离的鉴权 / 上游 / 定制头字段。
 *
 * 清单归本文件所有:buildClaudeEnv(经 getAuthEnv / endpoint / behaviorFlags)是这些
 * 字段在 remoteEnv 里的唯一写入方,新增鉴权类写入时必须同步本清单,否则 route 覆盖后
 * 旧字段残留、破坏「route.env 是远端鉴权唯一事实源 / 单鉴权门」不变量(消费方见
 * claude-code/index.ts startSession 远端分支)。
 *
 * 刻意不复用 SENSITIVE_ANTHROPIC_ENV_KEYS:那是「继承残留清洗」超集,含 route 覆盖时
 * 必须保留的字段(如 dev 多实例的 CLAUDE_CONFIG_DIR)。
 */
export const REMOTE_ROUTE_OVERRIDE_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BASE_URL',
] as const;

/**
 * 订阅 token 的 401 续命回调有 entrypoint 白名单闸门(cc 反编译):
 *   if (CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH && Set(["claude-desktop","local-agent",
 *       "claude-vscode"]).has(CLAUDE_CODE_ENTRYPOINT)) 才注册 requestOAuthTokenRefresh。
 * agent SDK 默认填 CLAUDE_CODE_ENTRYPOINT=sdk-ts(不在白名单)——不覆盖的话
 * getOAuthToken 回调**静默失效**(不报错不打日志, 长 turn 过期照样死)。必须选
 * claude-vscode: 另两个值在 cc 的桌面宿主集合里, 会连带切换整套 desktop-host 语义
 * (settings 过滤策略 / remote managed settings 等), 影响面未审。
 * 硬覆盖而非 if-undefined: dev 下 Electron 可能由终端 cc 启动, 继承来的
 * CLAUDE_CODE_ENTRYPOINT=sdk-ts/cli 同样会关掉闸门。仅 oauth-spawn(实际注入了
 * 订阅 token)时生效, gateway-key 会话保持 SDK 默认。
 *
 * buildClaudeEnv 末段与远端路由 materialization(claude-code/index.ts,route 覆盖后
 * 才出现 CLAUDE_CODE_OAUTH_TOKEN 的场景)共用 —— 闸门规则只此一份。
 */
export function applyOAuthSpawnEntrypointGate(env: Record<string, string>): void {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) return;
  env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
  // claude-vscode 身份的防御性收口: 禁掉 IDE 扩展自动安装类副作用(headless 会话
  // 不需要; env 在 cc 内存在, 用户显式覆盖优先)。
  if (env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL === undefined) {
    env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1';
  }
}

/**
 * !! 主防线 !! 必须由 host 在 boot 最早期(任何动态 import / spawn 之前)调用一次。
 *
 * 背景: @anthropic-ai/claude-agent-sdk 在 spawn CLI 时强制做
 *   `F6 = { ...process.env, ...userEnv }`
 * 我们传给 SDK 的 env 字典只能"覆盖"process.env 里的同名字段,**无法删除**它们。
 * 用户系统(HKCU / shell rc)若设了 ANTHROPIC_AUTH_TOKEN 之类,会从 process.env
 * 直接漏到 CC CLI 子进程,子进程的 Anthropic 客户端优先用 Bearer authToken,
 * 导致 401(用了用户那把过期/无效 key)。
 *
 * 唯一的根治办法是在 boot 时就把根上的 process.env 清干净。
 * cleanProcessEnv 只能作副防线(只动我们手里的字典)。
 *
 * 返回值: 实际清掉的 key 列表(给 host 打日志用)。
 */
export function stripSensitiveAnthropicEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const stripped: string[] = [];
  for (const key of SENSITIVE_ANTHROPIC_ENV_KEYS) {
    if (env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

/**
 * 副防线: 剥离 process.env 里的敏感字段,只作用于本函数返回的字典副本。
 *
 * !! 警告: 不能单独依赖 !!
 * SDK 在 spawn 时会做 `{ ...process.env, ...userEnv }` 二次 merge — 即使我们的
 * 字典里没有这些字段,process.env 上还有就会漏给子进程。真正的根治在
 * stripSensitiveAnthropicEnv()(host boot 阶段调)。
 *
 * 这里保留是为了:
 * (a) host 没接 boot strip 时仍有局部防护;
 * (b) 配合 getAuthEnv 的"显式覆盖"语义,避免把 undefined 值误传给 spawn。
 */
export function cleanProcessEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const sensitive = new Set<string>(SENSITIVE_ANTHROPIC_ENV_KEYS);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (sensitive.has(k)) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * `CLAUDE_CODE_SUBAGENT_MODEL` 的**唯一**写入点。
 *
 * - 非空串 → 设该值;
 * - `null` / 空串 → **删掉这个键**;
 * - `undefined` → 不动(调用方没有做过决定)。
 *
 * 为什么「不设」必须是 delete 而不是「跳过赋值」:local 模式的 env 是从 `cleanProcessEnv()`
 * 起的,`behaviorFlags` 也可能带进来同名键。只跳过赋值的话,那个继承/外来的值会原封不动
 * 留在字典里,继续以最高优先级盖掉 frontmatter —— 「明确不设」于是变成一句空话。
 *
 * (根因侧的防线是把该键放进 SENSITIVE_ANTHROPIC_ENV_KEYS:boot 期从 process.env 剥掉,
 * 否则 SDK spawn 时的 `{...process.env, ...userEnv}` 合并我们只能覆盖、无法删除。
 * 这里的 delete 负责字典层,两道一起才干净。)
 *
 * `discoverSubagentDefinitions` 需要本函数产出的 env(要读 `CLAUDE_CONFIG_DIR`),所以
 * 「先建 env、再判定、最后回来落这个键」是合法用法,见 index.ts 的会话启动路径。
 */
export function applySubagentModelEnv(
  env: Record<string, string>,
  decision: string | null | undefined,
): void {
  if (decision === undefined) return;
  const value = (decision ?? '').trim();
  if (value) env.CLAUDE_CODE_SUBAGENT_MODEL = value;
  else delete env.CLAUDE_CODE_SUBAGENT_MODEL;
}

export const EXPLORE_INHERIT_CAP_DISABLE_ENV = 'CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP';

/**
 * CC 判定「主模型是否在 Explore inherit cap 之内」用的家族词(2.1.259 反编译里的 `ven`,
 * cap 值 `Cen = "opus"`,取 `ven.slice(0, indexOf(cap)+1)` = 整个数组)。CC 侧是**子串**
 * 匹配、大小写不敏感,这里照抄它的口径,不要换成前缀或精确匹配。
 */
const EXPLORE_CAP_TIER_WORDS = ['haiku', 'sonnet', 'opus'] as const;

/**
 * cap 只对 Claude 家族才算「限高」。家族里不在上面三档中的成员(Fable)被 cap 收到 Opus
 * 是上游有意的成本上限,必须保留 —— 所以这里额外识别家族标记。
 *
 * 与 `apps/desktop` 的 `ANTHROPIC_WIRE_MODEL_PREFIXES` 刻意不复用:那份在 main 进程,
 * maker-core 反向 import 会破坏依赖方向(见 docs/dev-rules/architecture-invariants.md)。
 * 两处都只是「前缀/子串兜底地板」,新增 Anthropic 家族名时同步加词即可。
 */
const CLAUDE_FAMILY_MARKERS = ['claude', 'fable'] as const;

/**
 * 内置 `Explore` 子代理的 inherit cap 是否该关掉。
 *
 * ## 上游行为(CC 2.1.198 起,CHANGELOG:「now inherits the main session's model (capped
 * at opus) instead of running on haiku」;2.1.259 反编译)
 *
 * 内置 Explore 声明的是 `model: "inherit"`,但派发前先过一层 cap:
 *
 * ```js
 * function FX(agent, mainLoopModel) {
 *   if (agent.agentType !== "Explore" || agent.source !== "built-in") return agent.model;
 *   if (env.CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP) return "inherit";
 *   return r7r(mainLoopModel) ? { inheritCap: "opus" } : "inherit";
 * }
 * function r7r(m) {
 *   if (provider() !== "firstParty") return false;
 *   return !containsAnyWord(m, ["haiku", "sonnet", "opus"]);   // 纯子串匹配
 * }
 * ```
 *
 * 而 `{ inheritCap: "opus" }` 到了 resolver 里会被拆成裸别名 `"opus"`,之后与「用户手写
 * `model: opus`」完全同路 —— **它不是天花板,是直接替换**。
 *
 * ## 为什么要关
 *
 * 「在 cap 之内」是靠**模型名里有没有那三个词**判定的。Cindy 的 fp 路由在 CC 眼里是
 * firstParty,而经它路由的非 Claude 模型(`gpt-5.6-sol[1m]` 等)名字里三个词都没有,于是
 * 被判成「超过 opus」→ 静默改判成 Opus。实测:GPT 会话里 8 次 Explore 派发,3 次没带
 * `model` 参数的全部打到 `claude-opus-5[1m]`,跨了供应商与计费(另 5 次调用时显式写了
 * 模型,per-invocation 参数优先级更高,照旧生效)。
 *
 * 上游的意图对 Claude 家族是成立的(别比 Opus 更贵),对它认不出的模型则是把「未知」
 * 当成了「更贵」。所以只在后者把开关打开,其余场景一律保持上游行为:
 *
 * | 主模型 | 结果 |
 * |---|---|
 * | Opus / Sonnet / Haiku | 不设 —— cap 本来就不触发,行为零变化 |
 * | Fable | 不设 —— 保留上游的成本上限 |
 * | 非 Claude(GPT / 网关模型…) | 设 —— Explore 跟随主模型 |
 *
 * 非 firstParty 路由本来就走不到 cap,那里设了也只是 no-op,不额外分支。
 *
 * ## 已知边界
 *
 * - **依赖一个未公开的 env**。上游哪天移除,这里静默退回现状(不会崩)。单测钉住的只是本
 *   函数的判定表,**钉不住二进制行为** —— 上面那段反编译是 2.1.259
 *   (`tools/claude/latest.json` 的 pin)的实测结论,升级 CC 后请回到二进制里重新核对
 *   `FX` / `r7r` 与 `ven`／`Cen`,再决定这张表是否还成立。
 * - 本机热切若跨过这张表,由 `applyExploreInheritCapEnv(..., 'replace')` 改字典,下一
 *   次 send 重建 Query 让子进程吃到新 env。远端 daemon 烤死 spawn env,跨表则拒绝切模。
 */
export function shouldDisableExploreInheritCap(activeModel: string | undefined): boolean {
  const model = activeModel?.trim().toLowerCase();
  // 拿不到本次 spawn 的模型时不猜,保持上游行为。
  if (!model) return false;
  if (EXPLORE_CAP_TIER_WORDS.some((word) => model.includes(word))) return false;
  if (CLAUDE_FAMILY_MARKERS.some((word) => model.includes(word))) return false;
  return true;
}

/**
 * 把 Explore inherit-cap 开关写进(或移出) env 字典。
 *
 * - `if-undefined`:spawn 用。behaviorFlags / 用户显式设的值优先,只在键缺失时注入 `'1'`。
 * - `replace`:本机热切跨策略时用。只动 Cindy 注入的 `'1'` / 缺省,不碰显式覆盖(如 `'0'`)。
 */
export function applyExploreInheritCapEnv(
  env: Record<string, string>,
  activeModel: string | undefined,
  mode: 'if-undefined' | 'replace',
): void {
  const disable = shouldDisableExploreInheritCap(activeModel);
  if (mode === 'if-undefined') {
    if (env[EXPLORE_INHERIT_CAP_DISABLE_ENV] === undefined && disable) {
      env[EXPLORE_INHERIT_CAP_DISABLE_ENV] = '1';
    }
    return;
  }
  const current = env[EXPLORE_INHERIT_CAP_DISABLE_ENV];
  if (current !== undefined && current !== '1') return;
  if (disable) env[EXPLORE_INHERIT_CAP_DISABLE_ENV] = '1';
  else delete env[EXPLORE_INHERIT_CAP_DISABLE_ENV];
}

/** Cindy 可改写的 cap 开关是否与目标模型失配。显式覆盖(非 `'1'`)视为用户钉死,不算失配。 */
export function exploreInheritCapEnvNeedsSync(
  env: Record<string, string>,
  activeModel: string | undefined,
): boolean {
  const current = env[EXPLORE_INHERIT_CAP_DISABLE_ENV];
  if (current !== undefined && current !== '1') return false;
  return shouldDisableExploreInheritCap(activeModel) !== (current === '1');
}

/**
 * 组装最终注入到 sdkQuery options.env 的字典。
 * 顺序：cleanEnv → behaviorFlags → endpoint → authEnv（鉴权最后，避免被 behaviorFlags 覆盖）
 *
 * `mode` 决定是否继承本地 process.env:
 *
 * - `'local'` (默认): 继承 cleanProcessEnv() — 本地 sdkQuery 起的子进程要本地
 *   `PATH` / `HOME` / `USER` / `APPDATA` 才能跑(找 node / git / locale 文件等)。
 *
 * - `'remote'`: 不继承 process.env, 字典只含 behaviorFlags + endpoint + authEnv +
 *   各种 if-undefined 注入的业务 flags(DISABLE_TELEMETRY / PYTHONUTF8 /
 *   API_TIMEOUT_MS / CLAUDE_ENABLE_STREAM_WATCHDOG 等)。
 *
 *   **为什么必须**: 远端 cc-mgr daemon 收到 startParams.env 后转给远端 SDK,
 *   SDK spawn cc CLI 时 `{...process.env, ...userEnv}`。如果继承了 desktop 的
 *   `HOME=C:\Users\REMOTE_USER`(Windows) 或 `HOME=/Users/local-user`(mac), 远端
 *   POSIX 的 cc CLI 就拿到了**错误的 HOME** — Windows 字面字符串带 `C:` 和反斜
 *   杠在 macOS 当相对路径,被拼到 cwd 后面,session/memory/snapshot 全落到
 *   `<cwd>/C:\Users\REMOTE_USER/.claude/...` 这种怪目录里, 用户彻底找不到。
 *   PATH/APPDATA/TMP 等也类似 — 跨平台 + 跨机器透传必出事。
 *
 *   零继承后, 远端 SDK spawn 用的就是 daemon 自己 process.env 的真实 POSIX
 *   `HOME=/Users/<remote-user>` 和正确的 `PATH`, cc CLI 落到正确位置。
 *
 * 调试开关: 设置 host process.env.XDT_CC_DEBUG_NET=1 开启 cc 子进程网络日志,
 * 输出走 stderr → maker-ipc onStderrLine → unified logger (apps/desktop/logs/...)。
 * 包含: Anthropic SDK 请求日志 (URL/状态/elapsed) + Node HTTP socket 事件
 * (DNS resolve / TCP connect / TLS handshake / 首字节)。海外用户排查代理延迟用。
 */
export async function buildClaudeEnv(
  auth: AuthAdapter,
  runtimeConfig: AgentRuntimeConfig,
  options: ClaudeEnvBuildOptions = {},
): Promise<Record<string, string>> {
  const mode = options.mode ?? 'local';
  // remote mode: 从空字典起,绝不继承 desktop 进程的 OS env(详见函数 doc)。
  // local mode: 继承 cleanProcessEnv() — 本地子进程需要本地 PATH/HOME 才能跑。
  const cleanEnv = mode === 'remote' ? {} : cleanProcessEnv();
  const env: Record<string, string> = { ...cleanEnv };

  // 函数形态按本次 spawn 的 route context 求值(如 attribution 按凭证形态、Tool Search
  // 按来源能力分叉);spawnMode 让 host 区分本机/远端(只对本机有意义的 flag 不注到远端)。
  const behaviorFlags =
    typeof runtimeConfig.behaviorFlags === 'function'
      ? runtimeConfig.behaviorFlags({
          credentialMode: options.credentialMode,
          sessionProviderId: options.sessionProviderId,
          spawnMode: mode,
        })
      : runtimeConfig.behaviorFlags;
  if (behaviorFlags) {
    Object.assign(env, behaviorFlags);
  }
  // 远端模式优先用 remoteEndpoint（真上游网关）—— 本地 endpoint 是 loopback proxy URL，
  // 远端机器够不到（见 runtime-config.ts remoteEndpoint 文档 + index.ts 的 loopback guard）。
  // remoteEndpoint 未设时回落 endpoint（host 不区分远端的旧行为）。
  const endpoint =
    mode === 'remote' && runtimeConfig.remoteEndpoint
      ? runtimeConfig.remoteEndpoint
      : runtimeConfig.endpoint;
  if (endpoint) {
    env.ANTHROPIC_BASE_URL = endpoint;
  }
  const authOptions = options.credentialMode
    ? { credentialMode: options.credentialMode }
    : undefined;
  const authEnv = { ...(await auth.getAuthEnv(authOptions)) };
  if (mode === 'remote') {
    // CLAUDE_CONFIG_DIR is a host-local path. Desktop dev sandboxes inject a
    // Windows/macOS userData path through the auth adapter; forwarding that
    // literal path to a different POSIX host makes Claude resolve it relative
    // to the remote cwd and write configuration data into the repository.
    // The remote cc-manager owns this path and replaces it with its isolated
    // ~/.xdt-server/v1/claude-home directory at the RPC boundary.
    delete authEnv.CLAUDE_CONFIG_DIR;
  }
  Object.assign(env, authEnv);

  // Claude Code's documented child-agent model override.
  //
  // `options.subagentModel` 是调用方**已解析过**的决定(见 subagent-model-default.ts):
  //   - 字符串 → 设该值;
  //   - `null`  → 明确「不要设」—— 用户手写 agent 自己声明了 model,设了会把它静默盖掉;
  //   - 省略    → 回落读 runtimeConfig(未接入该解析的调用方保持旧行为)。
  // 该 env 在平台解析顺序里是最高优先级,所以「不设」是让 frontmatter 生效的唯一办法。
  // runtimeConfig 回落分支里路由感知版优先:子代理请求跑在父会话来源上,覆写是否可注入
  // 要按该来源判(host 的停用轴按 (来源, 模型) 记账;PR #744 review 第十九轮)。
  applySubagentModelEnv(
    env,
    options.subagentModel !== undefined
      ? options.subagentModel
      : ((runtimeConfig.subagentModelForRoute
          ? runtimeConfig.subagentModelForRoute(
              options.sessionProviderId ?? null,
              options.credentialMode,
            )
          : runtimeConfig.subagentModel
        )?.trim() || undefined),
  );

  // #3557: 网关路由会话把 CLI 内部小模型调用钉到会话自身的 wire 模型。
  // if-undefined 守卫:behaviorFlags / 用户显式覆盖优先。
  if (options.smallFastModel && env.ANTHROPIC_SMALL_FAST_MODEL === undefined) {
    env.ANTHROPIC_SMALL_FAST_MODEL = options.smallFastModel;
  }

  // 非 Claude 主模型的会话关掉内置 Explore 的 inherit cap ——
  // 否则 CC 会把它静默改判成 Opus(判据与代价见 shouldDisableExploreInheritCap)。
  applyExploreInheritCapEnv(env, options.activeModel, 'if-undefined');

  // 第三道防线: 告诉 CC CLI "provider 路由由 host 接管"。
  // CC 内部 filterSettingsEnv 看到此标记后,会从所有 settings-sourced env 中剥掉
  // ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 等 provider 相关字段,
  // 防止 workdir/.claude/settings.json 或 ~/.claude/settings.json 的 env 覆盖 app 注入值。
  // (第一道: boot 期 stripSensitiveAnthropicEnv 拦用户系统 env;
  //  第二道: cleanProcessEnv 拦字典副本里的残留)
  // ⚠️ cc >= 2.1.198 语义扩大: 设了此 flag 的子进程**完全不读**本机凭证
  // (系统凭证库的 claudeAiOauth、settings 的 apiKeyHelper、/login managed key 全被禁),
  // 凭证必须由 host 经上面的 authEnv 显式递入 —— 订阅模式对应 CLAUDE_CODE_OAUTH_TOKEN
  // (desktop auth-adapters getAuthEnv 注入), API 模式对应 ANTHROPIC_API_KEY。
  // 若 host 只设 flag 不递凭证, cc 毫秒级判 "Not logged in"(2026-07-03 线上事故)。
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';

  applyOAuthSpawnEntrypointGate(env);

  // xdt-maker 自己托管会话生命周期和自动任务。Claude Code 原生 cron 会读取
  // workdir/.claude/scheduled_tasks.json，并把到期任务作为隐藏 meta prompt 注入
  // 当前 SDK 会话；这会污染正在处理的用户任务。host-managed 会话必须强制关闭。
  env.CLAUDE_CODE_DISABLE_CRON = '1';

  const modelContextWindows = serializeModelContextWindows(options.modelContextWindows);
  if (modelContextWindows) {
    env[MAKER_MODEL_CONTEXT_WINDOWS_ENV] = modelContextWindows;
  } else {
    delete env[MAKER_MODEL_CONTEXT_WINDOWS_ENV];
  }

  const activeContextWindow = options.modelContextWindows?.find(
    (model) => model.id === options.activeModel,
  )?.contextWindow
    ?? options.modelContextWindows?.find(
      (model) => model.id.replace(/\[1m\]$/i, '')
        === options.activeModel?.replace(/\[1m\]$/i, ''),
    )?.contextWindow;
  if (
    activeContextWindow !== undefined
    && Number.isFinite(activeContextWindow)
    && activeContextWindow > 0
  ) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.floor(activeContextWindow));
  } else {
    delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  }

  const configuredCompactPct = Math.round(runtimeConfig.autoCompactThresholdPct ?? Number.NaN);
  if (configuredCompactPct >= 50 && configuredCompactPct <= 95) {
    env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(configuredCompactPct);
  } else {
    delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  }

  // 关掉 CC SDK 内部的遥测 / 错误上报 / OTEL metrics export。
  // 我们走自家 compat proxy + xd.inc token, 这些字段都是直打 api.anthropic.com 的
  // 官方 endpoint, 必然 401 (token 不被认), 只产生日志噪音不影响功能。
  // 关闭后这三类后台请求都不会发起:
  //  - DISABLE_TELEMETRY=1       : metrics_enabled / claude_code/metrics 上报
  //  - DISABLE_ERROR_REPORTING=1 : Sentry 类自动错误样本
  //  - OTEL_SDK_DISABLED=true    : PeriodicExportingMetricReader 周期导出
  // 用户 env 没显式覆盖才注入 (留个手动开 telemetry 排 SDK bug 的口子)。
  if (env.DISABLE_TELEMETRY === undefined) env.DISABLE_TELEMETRY = '1';
  if (env.DISABLE_ERROR_REPORTING === undefined) env.DISABLE_ERROR_REPORTING = '1';
  if (env.OTEL_SDK_DISABLED === undefined) env.OTEL_SDK_DISABLED = 'true';

  // Windows 下 Python piped stdout 默认走 locale encoding(cp936/GBK), 不看 chcp 65001。
  // 强制 UTF-8 避免 Bash 工具执行 python 命令时中文乱码。跨平台设置无副作用。
  if (env.PYTHONUTF8 === undefined) env.PYTHONUTF8 = '1';
  if (env.PYTHONIOENCODING === undefined) env.PYTHONIOENCODING = 'utf-8';
  applyPlainTextTerminalEnv(env);

  // 上游流式中途静默断流的"透明自愈":启用 cc-code 子进程内置的原生 inactivity
  // stream watchdog。它盯每条流式 HTTP 响应的 chunk 间隔(每 chunk 重置, 不误杀
  // 健康活跃流), 静默超阈值后在子进程内部降级非流式 + withRetry, 在同一个 SDK
  // query 里恢复 —— 对 maker 完全无感, 不中断 turn / 不提示用户。这填补了官方
  // desktop 的洞: API_TIMEOUT_MS 只覆盖初始 fetch(), 不覆盖流式 body(见 cc-code
  // claude.ts:1868-1873 注释), 单靠它流到一半断会挂死。
  //  - CLAUDE_ENABLE_STREAM_WATCHDOG : 开关(默认关), isEnvTruthy 收 1/true/yes/on
  //  - CLAUDE_STREAM_IDLE_TIMEOUT_MS : idle 阈值。cc 默认 90s 在 Opus xhigh/max 长
  //    thinking 上会误伤, 用 300s(maker 已验证过、只在真断流时触发的安全值)
  //  - API_TIMEOUT_MS : 对标官方 desktop(900s), 兜底初始 fetch + 非流式 fallback 请求
  // 注意: 不要设 CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK —— 保持默认开, 透明恢复才生效。
  // 用户显式覆盖优先(if undefined 才注入)。
  if (env.CLAUDE_ENABLE_STREAM_WATCHDOG === undefined) env.CLAUDE_ENABLE_STREAM_WATCHDOG = 'true';
  if (env.CLAUDE_STREAM_IDLE_TIMEOUT_MS === undefined) env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '300000';
  if (env.API_TIMEOUT_MS === undefined) env.API_TIMEOUT_MS = '900000';

  // 网络调试: host 设 XDT_CC_DEBUG_NET=1 即开启。该 env 由「设置 → About 的 Debug 日志开关」
  // 经 ccSetDebugNet IPC 写入 (见 bootstrap-electron.ts), dev 模式硬开。开关关闭 ⇒ 该 env 被
  // delete ⇒ 本块不执行 ⇒ 不注入任何调试 env (默认关闭, 生产场景日志会爆炸)。
  // ANTHROPIC_LOG=debug: Anthropic SDK 打完整请求 (含 headers, 如 `anthropic-beta: fast-mode-*`)
  //   + 响应, 用于核验 fast / 路由头是否真的上到链路 —— info 级只有 URL+status+elapsed, 看不到
  //   header。代价是日志更大 (含请求体), 仅在开关打开时如此, 可由 host 显式 export ANTHROPIC_LOG
  //   覆盖 (?? 保留逃生口, 如设回 info 降噪)。
  // NODE_DEBUG=http,https,net,tls: Node 内置 http/socket trace, 能看到 DNS / TCP / TLS 握手时序
  //   (海外用户排查 llm-proxy 代理延迟用)。
  if (process.env.XDT_CC_DEBUG_NET === '1') {
    env.ANTHROPIC_LOG = process.env.ANTHROPIC_LOG ?? 'debug';
    env.NODE_DEBUG = process.env.NODE_DEBUG ?? 'http,https,net,tls';
  }

  return env;
}
