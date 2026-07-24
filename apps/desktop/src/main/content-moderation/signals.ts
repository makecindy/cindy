export interface OutputModerationSignal {
  sessionId: string;
  turnId: string;
  kind: 'blocked';
}

const listeners = new Set<(signal: OutputModerationSignal) => void>();

export function emitOutputModerationSignal(signal: OutputModerationSignal): void {
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch {
      // 临时通知失败不能阻断 turn 收尾。
    }
  }
}

export function onOutputModerationSignal(
  listener: (signal: OutputModerationSignal) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
