import { globalShortcut } from 'electron';
import { comboToElectronAccelerator } from '../../shared/appShortcuts';
import {
  getAppShortcutStore,
  isAppShortcutRecordingActive,
  setGlobalShortcutRegistrationFailures,
  subscribeAppShortcutRecording,
} from '../app-shortcuts';
import { createLogger } from '../logger';

const log = createLogger('remote-desktop:away-shortcut');
const ID = 'away-guard';

/** 只由支持离开遮罩的本机主实例安装；录制时让出按键，改绑立即生效。 */
export function installAwayGuardShortcut(activate: () => Promise<void>): () => void {
  const store = getAppShortcutStore();
  let registered: string | null = null;
  let starting = false;
  const report = (failed: boolean) =>
    setGlobalShortcutRegistrationFailures(failed ? [ID] : [], ID);
  const sync = () => {
    const combo = store.getEffectiveMap().get(ID)?.[0];
    const recording = isAppShortcutRecordingActive();
    const desired = !recording && combo ? comboToElectronAccelerator(combo, process.platform) : null;
    if (desired !== null && desired === registered) return;
    if (registered) globalShortcut.unregister(registered);
    registered = null;
    if (recording) return;
    if (!desired) return report(false);
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
  const unsubscribe = store.subscribe(sync);
  const unsubscribeRecording = subscribeAppShortcutRecording(sync);
  sync();
  return () => {
    unsubscribe();
    unsubscribeRecording();
    if (registered) globalShortcut.unregister(registered);
    registered = null;
    report(false);
  };
}
