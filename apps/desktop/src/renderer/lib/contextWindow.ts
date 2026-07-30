export const DEFAULT_CONTEXT_WINDOW = 200_000;

interface ResolveDisplayContextWindowOptions {
  sdkContextWindow: number;
  modelContextWindow?: number;
  /**
   * `modelContextWindow` 是否为**显式声明**的真实上限(见 ModelDescriptor
   * .contextWindowVerified)。缺省按未核实处理:目录值仍可用于展示与兜底,
   * 但不拿它去压 SDK 实测值。
   */
  modelContextWindowVerified?: boolean;
}

/**
 * Resolve the context window shown in the renderer.
 *
 * 两个来源都不能单独当权威:
 *
 * - **SDK/modelUsage 值**是运行期实测,但上游 app-server 常报**基础模型**的窗口,
 *   忽略网关对该路由的实际限制(例:目录 372K 的 GPT-5.6-Sol 被报成 1M)。200K 还同时是
 *   Claude Code 的 unknown-model 默认值,换模型后可能滞留在 session state 里。
 * - **maker capabilities**(模型目录)对 provider-routed 模型比 SDK 准,但目录里的窗口
 *   有一半是派生时补的兜底常量(codex `model/list` 一律 272K、自定义 provider 未填时的
 *   200K、Anthropic 未知模型启发式),数值上与真实上限无从区分。
 *
 * 所以判定分两层,顺序有意义:
 *
 * 1. SDK 报的恰好是那个 unknown-model 默认(≤200K)时,目录值**哪怕只是兜底**也比它更
 *    贴近该模型 → 用目录值。
 * 2. 目录值只有在 `modelContextWindowVerified` 时才够格当**上限**(此时取小值)。未核实
 *    就采信 SDK 实测 —— 拿 272K/200K 这类兜底常量去压真实的 400K/1M 会让圆环显示的余量
 *    凭空缩水,比原本的虚高更糟。
 *
 * maker-core 侧的同源逻辑见 packages/maker-core/src/agents/codex/index.ts 的
 * capContextWindow。
 */
export function resolveDisplayContextWindow({
  sdkContextWindow,
  modelContextWindow,
  modelContextWindowVerified,
}: ResolveDisplayContextWindowOptions): number {
  const configured =
    Number.isFinite(modelContextWindow) && (modelContextWindow ?? 0) > 0
      ? Math.floor(modelContextWindow!)
      : undefined;
  const sdk =
    Number.isFinite(sdkContextWindow) && sdkContextWindow > 0
      ? Math.floor(sdkContextWindow)
      : undefined;

  if (!configured) return sdk ?? DEFAULT_CONTEXT_WINDOW;
  if (!sdk) return configured;

  // SDK 的 unknown-model 默认值最不可信,目录值(含兜底)也比它更能反映该模型。
  if (sdk <= DEFAULT_CONTEXT_WINDOW && configured > sdk) return configured;
  // 只有显式声明过的目录窗口才够格当上限;兜底值不压实测值。
  if (modelContextWindowVerified !== true) return sdk;

  return Math.min(configured, sdk);
}
