import { contextBridge, ipcRenderer } from 'electron';
import { PLUGIN_VIEW_DIRECTORY_CONTEXT, type PluginViewDirectoryContext } from '../shared/pluginViewDirectoryContext';
import type {
  PluginPageModelPickerOptions,
  PluginModelPickerResult,
} from '../shared/pluginModelPicker';

// Installed only by Main on approved plugin page guests. No general IPC or host data access.
export function exposePluginPageModelPicker(): void {
  if (!process.isMainFrame) return;
  let directoryContext: PluginViewDirectoryContext | null = null;
  const directoryListeners = new Set<(context: PluginViewDirectoryContext | null) => void>();
  ipcRenderer.on(PLUGIN_VIEW_DIRECTORY_CONTEXT, (_event, context: PluginViewDirectoryContext | null) => {
    directoryContext = context;
    for (const listener of directoryListeners) listener(context);
  });
  contextBridge.exposeInMainWorld('cindyUI', {
    getDirectoryContext: () => directoryContext,
    onDirectoryContextChanged: (listener: (context: PluginViewDirectoryContext | null) => void) => {
      directoryListeners.add(listener);
      return () => { directoryListeners.delete(listener); };
    },
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
