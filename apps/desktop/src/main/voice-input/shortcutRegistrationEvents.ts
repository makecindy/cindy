import type { VoiceInputShortcut } from '../../shared/voiceInputData';
import { createLogger } from '../logger';

const log = createLogger('voice-input:shortcut-registration');
const listeners = new Set<() => void>();
let pendingCandidate: VoiceInputShortcut | null | undefined;

/** undefined 表示没有候选；null 表示用户正在清除语音绑定。 */
export function getPendingVoiceShortcutCandidate(): VoiceInputShortcut | null | undefined {
  return pendingCandidate;
}

/** 只在已有语音变更串行队列内使用；注册前让位，持久化或失败回滚后恢复正常仲裁。 */
export async function withPendingVoiceShortcutCandidate<T>(
  shortcut: VoiceInputShortcut | null,
  apply: (replaceCandidate: (value: VoiceInputShortcut | null) => void) => Promise<T>,
): Promise<T> {
  const previous = pendingCandidate;
  pendingCandidate = shortcut;
  notifyVoiceShortcutRegistrationChanged();
  try {
    return await apply((value) => {
      pendingCandidate = value;
      notifyVoiceShortcutRegistrationChanged();
    });
  } finally {
    pendingCandidate = previous;
    notifyVoiceShortcutRegistrationChanged();
  }
}

/** 候选、持久化设置与原生注册是不同阶段；其他全局键按当前阶段的组合仲裁。 */
export function onVoiceShortcutRegistrationChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyVoiceShortcutRegistrationChanged(): void {
  for (const listener of listeners) {
    try { listener(); }
    catch (error) { log.warn('shortcut registration listener failed', error); }
  }
}
