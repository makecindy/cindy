import { createLogger } from '../logger';

const log = createLogger('voice-input:shortcut-registration');
const listeners = new Set<() => void>();

/** 持久化设置与原生注册是不同阶段；其他全局键要等旧原生组合释放后再接手。 */
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
