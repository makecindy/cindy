/**
 * 「Subagent 模型」设置的**默认值**语义 + 相关诊断。
 *
 * ## 问题
 *
 * 设置页说的是「执行子任务时使用的**默认**模型」「留空表示使用 Agent 原本的默认设置」,
 * 但它落到 `CLAUDE_CODE_SUBAGENT_MODEL`,而平台的 model 解析顺序是:
 *
 *   1. `CLAUDE_CODE_SUBAGENT_MODEL`   ← 最高
 *   2. 每次调用传入的 model 参数
 *   3. agent frontmatter 的 model
 *   4. 主会话模型
 *
 * env 变量是**强制覆盖**,平台没有「最低优先级默认值」这个位置。于是用户手写 agent 里的
 * `model:` 一旦设过该设置就**静默失效** —— 说的是默认,做的是覆盖。
 *
 * ## ⚠️ 上面那张表在 cc 2.1.259 上已经不成立(2026-09-03 实测,尚未据此改行为)
 *
 * 反编译 2.1.259 的解析函数,env **从最高降到了最低**:
 *
 *   1. 每次调用传入的 model 参数
 *   2. agent frontmatter 的 model —— 且写 `"inherit"` 会直接短路回主会话模型
 *   3. `CLAUDE_CODE_SUBAGENT_MODEL` ← 只在该 agent **完全没声明** model 时才轮到它
 *   4. 主会话模型
 *
 * 另有 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` 恢复旧的「env 压过一切」。
 *
 * 两个直接后果:
 *   - 下面「有人声明 model 就整个会话不设 env」的条件化**已无必要**(env 再也盖不掉
 *     frontmatter),但也无害,所以先不动 —— 改它要连带重跑那个判别实验;
 *   - 内置 `Explore` 自己声明了 `model: "inherit"`,会在读 env 之前短路,所以这个设置
 *     **对它从来不生效**。它另有一层 cap,见 env-builder.ts 的
 *     `shouldDisableExploreInheritCap`。
 *
 * 结论保持:要动这段逻辑,先回到当前 pin 的二进制里重新核对解析顺序,别只信这段文字。
 *
 * ## 做法:条件化地设不设 env
 *
 * | 会话里的情况 | 做法 | 效果 |
 * |---|---|---|
 * | 没有任何 agent 声明 model | 设 env | 全部 subagent(含内置)跟随默认值,**行为零变化** |
 * | 有 agent 声明了 model | **不设 env** | 声明生效;未声明的(含内置)回落主会话模型 |
 *
 * 「有人声明就整个会话不设 env」是粒度最细的可行方案 —— env 是进程级的,没法只对某几个
 * agent 生效。代价是该会话里未声明 model 的 agent 拿不到默认值;换来的是用户显式写下的
 * `model:` 不再被静默吞掉。从不写 `model:` 的用户完全无感(仍走 env 分支)。
 *
 * ## 已知代价:走 env 分支时,每次调用传入的 model 也会被盖掉
 *
 * 上面那张解析顺序表里,env 不只压过 frontmatter,也压过**每次调用传入的 model 参数**
 * (Task/Agent 工具的 `model`)。所以「没人声明 model → 设 env」这一支里,编排模型在某次
 * Task 调用上显式点的模型同样不生效。
 *
 * 这不是本模块引入的:改动前 env 是**无条件**设的,上述覆盖对所有会话、所有调用都成立;
 * 现在至少「有人声明 model」的会话里,frontmatter 与每次调用的参数都恢复生效了。
 *
 * 也没有更好的落点。反编译 cc 的解析函数可见 env 检查位于函数最前、无任何条件,后面依次才是
 * per-invocation 参数、frontmatter、主会话模型;平台**不提供** settings 级(或任何更低优先级)
 * 的 subagent 默认模型槽位,host 也插不进 dispatch 层 —— 那段逻辑在 cc 二进制内部。
 * 结论:要让这个设置有任何效果,唯一可用的就是这个最高优先级的 env。宁可保留它并把代价写在
 * 这里,也不要做一个静默失效的设置。
 *
 * ## 为什么不用 `options.agents` 给未声明者补默认值(实测结论)
 *
 * 曾尝试:不设 env,同时把「没写 model 的文件 agent」经 `options.agents` 重发一份并补上
 * 默认值,想两头都要。**实测(2026-07-28,cc 2.1.219)证明行不通**:同名情况下**文件定义
 * 胜出**,programmatic 定义里的 model 不生效。
 *
 * 判别实验:同一个 `model: inherit` 的 agent 文件、同一份默认值设置,只切换代码路径 ——
 * 走重发路径时它拿到主会话模型(= 文件的 inherit 生效,我们的 model 被忽略),走 env 路径时
 * 它拿到默认值。可见 programmatic agents **不能**覆盖同名文件 agent(文档里 `--agents`
 * 优先级高于项目/用户作用域的那张表,不适用于 SDK 的 `agents` 选项)。
 *
 * 因此重发逻辑连同它的字段保真防线一起删掉了 —— 那些复杂度只为一个走不通的方案服务。
 * 改这里前请先重跑上面的判别实验,不要只依据文档表格。
 *
 * ## 稳定性
 *
 * 判定只在会话启动时做一次:env 要在 spawn 之前定好,而会话中途变动 tools/system 会破坏 prompt
 * 前缀稳定性(见 docs/dev-rules/maker-core-and-agent-behavior.md §3.1)。
 *
 * ## 诊断只落日志与 host 回调,**不进模型上下文**
 *
 * 曾经把诊断渲染成 `<system-reminder>` 前置到首条用户消息(想让 AI 转告用户)。已移除,原因:
 *   - agent 名、路径、model 串全部由**被打开的仓库**决定,塞进一段 host 署名的提醒里就成了
 *     提示注入面;而字符级消毒挡不住 `ignore-all-previous-instructions-and-...` 这类
 *     kebab-case 指令(连字符与字母是真实 model id 必需的字符,没法禁)。
 *   - 收益本来就薄:unknown-model 在 subagent 真被调用时**就会直接报错**(id 原样发给上游),
 *     用户不需要提前几分钟知道;alias-model 虽静默,但影响温和,且只命中手写 agent 的少数用户。
 *   - 每个有坏定义的会话都要为此付首轮上下文,并诱导模型提一件用户当下未必关心的事。
 *
 * 诊断照旧产出,只走两条不进 prompt 的通道:agent 层 `log.warn` 与
 * `AgentRuntimeConfig.onSubagentModelDiagnostics` 回调(拿到的是未消毒原值)。将来要给用户看,
 * 正确的落点是 Settings 里 subagent 模型那一节的 inline 警告 —— 那里有 UI 上下文,也不必把仓库
 * 字符串交给模型。
 */

import type { DiscoveredSubagent } from './subagent-definitions.js';

/**
 * 诊断种类:
 * - `unknown-model`:声明的 model 在当前可用模型里找不到(拼错 / 供应商没连 / 已下线)。
 *   该 id 会被原样发给上游,所以那个 subagent 的调用很可能直接报错;
 * - `alias-model`:声明的是 `sonnet` / `opus` 这类**裸别名**。别名照旧生效(host 不改用户
 *   文件),但二进制升级后别名指针会漂到下一代模型 —— 本仓对此有过实踩,见
 *   index.ts `toSdkModelString` 的「一律走显式版本号」说明。
 *
 * 新增种类时记得同步 host 侧的展示(目前只有日志与 onSubagentModelDiagnostics 回调)。
 */
export type SubagentModelDiagnosticKind = 'unknown-model' | 'alias-model';

/** 单条诊断 —— 供 agent 层日志与 host 回调消费(不进模型上下文,见模块头)。 */
export interface SubagentModelDiagnostic {
  /** 出问题的 subagent 名(来自 frontmatter,即**仓库可控**内容 —— host 展示前请自行消毒)。 */
  agent: string;
  /** 定义文件绝对路径,方便 host 指给用户(同样仓库可控)。 */
  filePath: string;
  /** 见 {@link SubagentModelDiagnosticKind}。 */
  kind: SubagentModelDiagnosticKind;
  /** 该 agent 自己声明的 model(仓库可控)。 */
  declaredModel: string;
  /** 建议的可用 model id(已按相近度排序并截断,见 suggestModelIds)。 */
  suggestedModelIds: string[];
  /** 可用模型总数,让 host 能诚实说明「候选只列了其中几个」。 */
  availableModelCount: number;
}

export interface ResolveSubagentModelDefaultInput {
  /** 用户在设置页选的默认模型;空 / undefined = 没设。 */
  configuredDefault: string | undefined;
  /** 扫描到的用户手写 subagent 定义。 */
  discovered: readonly DiscoveredSubagent[];
  /**
   * 本 agent 当前可用的 model id(host 从目录派生的 capabilities.availableModels)。
   * 用于校验 agent 声明的 model 是否真的存在。省略 = 不做该校验(拿不到清单时不误报)。
   */
  availableModelIds?: readonly string[];
}

export interface ResolveSubagentModelDefaultResult {
  /**
   * 该写进 `CLAUDE_CODE_SUBAGENT_MODEL` 的值;`undefined` = **不要设**这个 env
   * (让 frontmatter 生效)。
   */
  envSubagentModel?: string;
  /** 诊断,供 host 落日志或展示给用户。 */
  diagnostics: SubagentModelDiagnostic[];
}

/**
 * 平台内置的模型别名 —— 这些不是目录里的 model id,写在 frontmatter 里是合法的、也确实能用,
 * 所以**不算** unknown-model;但它们会随二进制升级漂移,单独归到 alias-model 提示。
 * `inherit` 在发现层已归一成「未声明」,不会走到这里。
 */
const MODEL_ALIASES: ReadonlySet<string> = new Set(['sonnet', 'opus', 'haiku', 'fable']);

/**
 * 去掉 1M 上下文的 wire 后缀再比对目录 id。
 *
 * maker-core 自己就把目录里的 `claude-sonnet-5` 转成 wire 串 `claude-sonnet-5[1m]`
 * (index.ts `toSdkModelString`),用户照着日志/文档把带后缀的串写进 frontmatter 是完全
 * 正常的,cc 也认。不归一化就会把一份**能正常工作**的定义报成 unknown,—— 假警报比不报更糟。
 */
function stripWireSuffix(model: string): string {
  return model.endsWith('[1m]') ? model.slice(0, -'[1m]'.length) : model;
}

/** 最多给几个候选 —— 可用清单常有几十条(含图像/向量等无关模型),全列既无用又误导。 */
const MAX_SUGGESTIONS = 8;
/** 参与打分的字符数上限(发现层已限 256,这里是独立的第二道)。 */
const MAX_SCORING_CHARS = 256;
/** 参与第二档匹配的词干个数上限 —— 真实 id 拆出来就几个词,几千个词干只可能来自恶意输入。 */
const MAX_STEM_SEGMENTS = 8;

/**
 * 给写错的 model 挑几个最可能的候选。
 *
 * 排序依据「与写错的值有多像」:同命名空间前缀(如 `xai/`)最优先,其次是共享词干的,
 * 最后才是其它。这样 `xai/grok-9.9` 会先看到 `xai/grok-4.5` —— 比无序倾倒几十个
 * (里面还混着 embedding / image 模型)有用得多。
 */
export function suggestModelIds(declared: string, available: readonly string[]): string[] {
  // 打分是**同步**的,而且发生在扫描 deadline 之外 —— 一旦入参失控就是实打实的事件循环卡顿,
  // 任何异步超时都拦不住。所以入参在这里再封一道:发现层已把 model id 限到 256 字符
  // (MAX_DECLARED_MODEL_CHARS),这里再限词干个数。上界因此是
  // MAX_STEM_SEGMENTS × available.length 次 includes,与仓库内容无关。
  const lower = declared.slice(0, MAX_SCORING_CHARS).toLowerCase();
  const ns = lower.includes('/') ? lower.slice(0, lower.indexOf('/') + 1) : '';
  // 取写错值里的字母词干(如 grok / gpt / claude),用于第二档匹配。
  const stem = (lower.match(/[a-z]+/g) ?? [])
    .filter((w) => w.length >= 3 && w !== ns.replace('/', ''))
    .slice(0, MAX_STEM_SEGMENTS);
  const score = (id: string): number => {
    const l = id.toLowerCase();
    if (ns && l.startsWith(ns)) return 0;
    if (stem.some((w) => l.includes(w))) return 1;
    return 2;
  };
  return [...available]
    .map((id, index) => ({ id, rank: score(id), index }))
    // 同档内保持目录原序(稳定、可预期),不按字母重排。
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_SUGGESTIONS)
    .map((e) => e.id);
}

/**
 * 决定设不设 env,并产出诊断。
 *
 * 没配默认值时不设 env(与本特性上线前一致);校验与默认值无关,照常执行。
 */
export function resolveSubagentModelDefault(
  input: ResolveSubagentModelDefaultInput,
): ResolveSubagentModelDefaultResult {
  // 校验独立于默认值:哪怕用户没配默认值,agent 写错 model 也该被指出来。
  const diagnostics: SubagentModelDiagnostic[] = [];
  const available = input.availableModelIds;
  if (available && available.length > 0) {
    // 目录 id 与它们的 wire 形态都算「认识」(见 stripWireSuffix)。
    const known = new Set(available.map((id) => stripWireSuffix(id)));
    for (const found of input.discovered) {
      const declared = found.declaredModel;
      if (declared === undefined) continue;
      const base = (d: SubagentModelDiagnosticKind): SubagentModelDiagnostic => ({
        agent: found.name,
        filePath: found.filePath,
        kind: d,
        declaredModel: declared,
        suggestedModelIds: suggestModelIds(declared, available),
        availableModelCount: available.length,
      });
      // 归一化要在**分类之前**做:`sonnet[1m]` 这种带 wire 后缀的别名 cc 认(历史上
      // legacyToSdkModelString 产出的就是它),不归一化会被判成 unknown —— 而它其实是一个
      // 会漂移的别名,是完全另一件事。
      const bare = stripWireSuffix(declared);
      if (MODEL_ALIASES.has(bare.toLowerCase())) {
        // 别名能跑,不拦、不改用户文件 —— 只把「会随版本漂移」这件事说出来,由用户决定。
        diagnostics.push(base('alias-model'));
        continue;
      }
      if (known.has(bare)) continue;
      diagnostics.push(base('unknown-model'));
    }
  }

  const configured = input.configuredDefault?.trim();
  if (!configured) return { diagnostics };

  // 有任何 agent 自己声明了 model → 不设 env,否则那些声明会被静默覆盖。
  const someoneDeclared = input.discovered.some((d) => d.declaredModel !== undefined);
  return someoneDeclared ? { diagnostics } : { envSubagentModel: configured, diagnostics };
}

/**
 * 把诊断交给 host 回调,并保证**任何**失败都影响不到会话启动。
 *
 * 同步 throw 好接;麻烦的是异步:回调类型是 `=> void`,而 TS 在 void 返回位置接受任意返回值,
 * 所以 host 完全可以传一个 `async` 函数。那时 reject 发生在调用点的 try 之外,变成 unhandled
 * rejection —— Node 默认直接结束进程,和「上报失败不影响会话启动」的约定正好相反。
 * 因此对返回的 thenable 显式挂 catch。
 */
export function reportSubagentModelDiagnostics(
  callback: ((diagnostics: readonly SubagentModelDiagnostic[]) => void) | undefined,
  diagnostics: readonly SubagentModelDiagnostic[],
): void {
  if (!callback || diagnostics.length === 0) return;
  try {
    const returned: unknown = callback(diagnostics);
    if (typeof (returned as { then?: unknown } | undefined)?.then === 'function') {
      void (returned as Promise<unknown>).catch(() => {
        /* 上报失败不影响会话启动 */
      });
    }
  } catch {
    /* 同上 */
  }
}
