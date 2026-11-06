import { contextBridge, ipcRenderer } from 'electron';
import type {
  PluginPageModelPickerOptions,
  PluginModelPickerResult,
} from '../shared/pluginModelPicker';

// Installed only by Main on approved plugin page guests. No general IPC or host data access.
export function exposePluginPageModelPicker(): void {
  if (!process.isMainFrame) return;
  contextBridge.exposeInMainWorld('cindyUI', {
    pickModel: async (options: PluginPageModelPickerOptions): Promise<PluginModelPickerResult> => {
      const cancel = () => ipcRenderer.send('ghost-page:cancel-model-picker');
      const hidden = () => {
        if (document.hidden) cancel();
      };
      window.addEventListener('resize', cancel);
      window.addEventListener('scroll', cancel, true);
      // Guest pointer events do not bubble into the host document. A click back in the
      // plugin is an outside click, while clicks in the Host selector never enter this guest.
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('visibilitychange', hidden);
      try {
        return await ipcRenderer.invoke('ghost-page:pick-model', options);
      } finally {
        window.removeEventListener('resize', cancel);
        window.removeEventListener('scroll', cancel, true);
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('visibilitychange', hidden);
      }
    },
  });
}
