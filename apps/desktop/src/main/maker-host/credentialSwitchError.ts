export class CredentialModeSwitchBusyError extends Error {
  readonly sessionIds: string[];

  constructor(
    sessionIds: string[],
    message = `Cannot switch credential mode while local session(s) are busy: ${sessionIds.join(', ')}`,
  ) {
    super(message);
    this.name = 'CredentialModeSwitchBusyError';
    this.sessionIds = sessionIds;
  }
}

export class CodexCredentialModeSwitchBusyError extends CredentialModeSwitchBusyError {
  constructor(
    sessionIds: string[],
    modes?: { fromMode?: string; fromModeEffective?: string; toMode?: string },
  ) {
    // 方向必须进 message:排查"为什么要切"时日志里只有这一条现场证据
    // (2026-07-03 排队假死实报中因缺方向信息多绕了一轮)。fromMode 是原始登记值,
    // 隐式来源会显示成 fallback、掩盖 host 实际钥匙形态 —— 归一化形态可用且与原始
    // 值不同时以它为主、原始值括注(2026-07-04 实排:"fallback -> gateway-key"还得
    // 靠 ps 看进程参数才能确认 host 实际是 OAuth)。
    const fromRaw = modes?.fromMode ?? 'fallback';
    const fromDisplay =
      modes?.fromModeEffective && modes.fromModeEffective !== modes?.fromMode
        ? `${modes.fromModeEffective}(registered: ${fromRaw})`
        : fromRaw;
    const direction = modes?.fromMode || modes?.fromModeEffective || modes?.toMode
      ? ` (${fromDisplay} -> ${modes?.toMode ?? 'fallback'})`
      : '';
    super(
      sessionIds,
      `Cannot switch Codex credential mode${direction} while local Codex session(s) are busy: ${sessionIds.join(', ')}`,
    );
    this.name = 'CodexCredentialModeSwitchBusyError';
  }
}

export function isCredentialModeSwitchBusyError(
  err: unknown,
): err is CredentialModeSwitchBusyError {
  return err instanceof CredentialModeSwitchBusyError;
}

