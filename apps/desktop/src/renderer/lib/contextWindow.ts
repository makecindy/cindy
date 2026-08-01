export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** 上下文窗口文本是否可提交：空 = 清除窗口；非空须整体合法（分组分隔符 + BigInt 上界）。 */
export function isCommittableWindowText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  if (!/^[0-9]+(?:[,_ ][0-9]+)*$/.test(trimmed)) return false;
  const parsed = BigInt(trimmed.replace(/[,_ ]/g, ''));
  return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
}

/**
 * 把已通过 isCommittableWindowText 的窗口文本解析为 number（BigInt 精确转换，调用方
 * 保证不超 MAX_SAFE_INTEGER）；空文本返回 undefined。
 */
export function parseWindowText(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return Number(BigInt(trimmed.replace(/[,_ ]/g, '')));
}

interface ResolveDisplayContextWindowOptions {
  sdkContextWindow: number;
  modelContextWindow?: number;
}

/**
 * Resolve the context window shown in the renderer.
 *
 * SDK/modelUsage values are normally runtime ground truth, but 200K is also
 * Claude Code's unknown-model default and can remain in session state after a
 * model switch. Maker capabilities are more accurate for provider-routed models.
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

  if (configured && (!sdk || (sdk <= DEFAULT_CONTEXT_WINDOW && configured > sdk))) {
    return configured;
  }

  return sdk ?? configured ?? DEFAULT_CONTEXT_WINDOW;
}
