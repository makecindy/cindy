import { globalShortcut } from 'electron';
import { comboToElectronAccelerator, voiceInputShortcutToAppShortcutCombo } from '../../shared/appShortcuts';
import {
  getAppShortcutStore,
  isAppShortcutRecordingActive,
  setGlobalShortcutRegistrationFailures,
  subscribeAppShortcutRecording,
} from '../app-shortcuts';
import { createLogger } from '../logger';
import { voiceInputDataStore } from '../voice-input/VoiceInputDataStore';

const log = createLogger('remote-desktop:away-shortcut');
const ID = 'away-guard';

/** 只由支持离开遮罩的本机主实例安装；录制时让出按键，改绑立即生效。 */
export function installAwayGuardShortcut(activate: () => Promise<void>): () => void {
  const store = getAppShortcutStore();
  let registered: string | null = null;
  let starting = false;
  let generation = 0;
  const report = (failed: boolean) =>
    setGlobalShortcutRegistrationFailures(failed ? [ID] : [], ID);
  const sync = (deferRegistration = false) => {
    const current = ++generation;
    const voiceShortcut = voiceInputDataStore.getSettings().shortcut;
    const voiceCombo = voiceShortcut ? voiceInputShortcutToAppShortcutCombo(voiceShortcut) : null;
    const combo = store.getEffectiveMap(voiceCombo ? [voiceCombo] : []).get(ID)?.[0];
    const recording = isAppShortcutRecordingActive();
    const desired = !recording && combo ? comboToElectronAccelerator(combo, process.platform) : null;
    if (desired !== null && desired === registered) return;
    if (registered) globalShortcut.unregister(registered);
    registered = null;
    if (recording) return;
    if (!desired) return report(false);
    const register = () => {
      if (current !== generation) return;
      try {
        if (globalShortcut.register(desired, () => {
          if (starting) return;
          starting = true;
          void activate()
            .catch((error) => log.warn('manual away cover failed', error))
            .finally(() => { starting = false; });
        })) registered = desired;
      } catch (error) {
        log.warn('away shortcut registration failed', error);
      }
      report(registered === null);
    };
    // 先同步释放旧键，再等同一轮其他订阅者（截图等）释放后申请新键。
    // 不轮询重试；代次同时丢弃快速改绑、开始录制和退出前排队的旧申请。
    if (deferRegistration) queueMicrotask(register);
    else register();
  };
  const changed = () => sync(true);
  const unsubscribe = store.subscribe(changed);
  const unsubscribeRecording = subscribeAppShortcutRecording(changed);
  const unsubscribeVoice = voiceInputDataStore.subscribeShortcut(changed);
  sync();
  return () => {
    generation++;
    unsubscribeVoice();
    unsubscribe();
    unsubscribeRecording();
    if (registered) globalShortcut.unregister(registered);
    registered = null;
    report(false);
  };
}
