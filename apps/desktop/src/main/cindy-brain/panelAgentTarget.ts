function normalizedSessionId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * 解析插件面板的当前任务，不做“最近任务”猜测：停靠态绑定承载主窗口；
 * 独立面板窗只有在恰好一个主窗口时才允许回落。
 */
export function resolveGhostPanelTargetSessionId(input: {
  hostIsMainShell: boolean;
  hostSessionId: string | null | undefined;
  mainShellSessionIds: readonly (string | null | undefined)[];
}): string | null {
  if (input.hostIsMainShell) return normalizedSessionId(input.hostSessionId);
  if (input.mainShellSessionIds.length !== 1) return null;
  return normalizedSessionId(input.mainShellSessionIds[0]);
}
