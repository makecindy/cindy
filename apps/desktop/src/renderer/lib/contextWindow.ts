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
 * 所以目录值在这里的语义是**上限**而不只是 fallback:两者都高于 200K 这道兜底档时取小值。
 * 200K 及以下的值两侧都视为「不可信的兜底」,不参与压制对方:
 *
 * - SDK 报 200K 可能是它的 unknown-model 默认 → 压不住目录里更大的真实窗口。
 * - 目录报 200K 可能是自定义 provider 没填元数据时派生的 DEFAULT_CUSTOM_CONTEXT_WINDOW
 *   占位(那个常量自己就声明「仅用于展示」) → 不能拿它把 SDK 实测的 1M 压成 200K,
 *   否则容量圆环只显示五分之一。已知边界:用户**显式**填了 ≤200K 的自定义模型也落进
 *   这一档、不会被当作上限,与改动前的行为一致(不构成回归);要精确区分得让目录
 *   携带「窗口是否显式声明」,那超出本函数职责。
 *
 * maker-core 侧的同源逻辑见 packages/maker-core/src/agents/codex/index.ts 的
 * capContextWindow / UNTRUSTED_CATALOG_WINDOW_CEILING。
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

  // 目录值可能是「没填元数据」的占位,不拿它压 SDK 实测值。
  if (configured <= DEFAULT_CONTEXT_WINDOW) return sdk;
  // 反向:SDK 的 unknown-model 默认值同样不可信,盖不住目录里更大的真实窗口。
  if (sdk <= DEFAULT_CONTEXT_WINDOW) return configured;

  return Math.min(configured, sdk);
}
