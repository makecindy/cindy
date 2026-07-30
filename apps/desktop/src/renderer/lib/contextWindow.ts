export const DEFAULT_CONTEXT_WINDOW = 200_000;

interface ResolveDisplayContextWindowOptions {
  sdkContextWindow: number;
  modelContextWindow?: number;
}

/**
 * Resolve the context window shown in the renderer.
 *
 * 两个来源都不能单独当权威:
 *
 * - **SDK/modelUsage 值**是运行期实测,但上游 app-server 常报**基础模型**的窗口,
 *   忽略网关对该路由的实际限制(例:目录 372K 的 GPT-5.6-Sol 被报成 1M)。200K 还同时是
 *   Claude Code 的 unknown-model 默认值,换模型后可能滞留在 session state 里。
 * - **maker capabilities**(模型目录)是产品侧针对自家网关维护的真实上限,对
 *   provider-routed 模型比 SDK 准,但可能缺失(自定义 provider、目录未覆盖的新模型)。
 *
 * 所以目录值在这里的语义是**上限**而不只是 fallback:两者都有时取小值。唯一例外是
 * SDK 报的恰好是那个不可信的 200K 默认 —— 它压不住目录里更大的真实窗口。
 */
export function resolveDisplayContextWindow({
  sdkContextWindow,
  modelContextWindow,
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

  // SDK 的 unknown-model 默认值不可信,不让它盖住目录里更大的真实窗口。
  if (sdk <= DEFAULT_CONTEXT_WINDOW && configured > sdk) return configured;

  return Math.min(configured, sdk);
}
