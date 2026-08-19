function normalizedSessionId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * 解析插件面板的当前任务，不做“最近任务”猜测：停靠态绑定承载会话的宿主窗口；
 * 独立面板窗只有在恰好一个主窗口时才允许回落。
 */
export function resolveGhostPanelTargetSessionId(input: {
  hostOwnsSession: boolean;
  hostSessionId: string | null | undefined;
  mainShellSessionIds: readonly (string | null | undefined)[];
}): string | null {
  if (input.hostOwnsSession) return normalizedSessionId(input.hostSessionId);
  if (input.mainShellSessionIds.length !== 1) return null;
  return normalizedSessionId(input.mainShellSessionIds[0]);
}

/**
 * 为已解析的目标任务选择确认框宿主。独立面板不把确认投给自己，
 * 也不按窗口顺序猜；只接受唯一承载同一任务的主壳。
 */
export function resolveGhostPanelConfirmationTargetId(input: {
  hostOwnsSession: boolean;
  hostWebContentsId: number;
  hostSessionId: string | null | undefined;
  targetSessionId: string;
  mainShells: readonly {
    webContentsId: number;
    sessionId: string | null | undefined;
  }[];
}): number | null {
  const targetSessionId = normalizedSessionId(input.targetSessionId);
  if (!targetSessionId) return null;
  if (input.hostOwnsSession) {
    return normalizedSessionId(input.hostSessionId) === targetSessionId
      ? input.hostWebContentsId
      : null;
  }
  const candidates = input.mainShells.filter(
    (shell) => normalizedSessionId(shell.sessionId) === targetSessionId,
  );
  return candidates.length === 1 ? candidates[0]!.webContentsId : null;
}
