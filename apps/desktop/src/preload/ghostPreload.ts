import { contextBridge, ipcRenderer } from 'electron';
import { createGhostPageBridge } from '../shared/ghostPageBridge';

// Injected only into the logic page. Main resolves identity from the real sender.
const bridge = createGhostPageBridge({
  ping: () => ipcRenderer.invoke('ghost-pipe:ping'),
  send: payload => ipcRenderer.invoke('ghost-pipe:send', payload),
});
ipcRenderer.on('ghost-pipe:message', (_event, payload: unknown) => bridge.deliver(payload));
// Build the Error where the plugin catches it. The bridge only carries its fields.
const targets: typeof bridge.api.targets = contextBridge.executeInMainWorld({
  func: (calls: typeof bridge.api.targets) => Object.fromEntries(Object.entries(calls).map(([kind, call]) => [kind,
    async (request?: Record<string, unknown>): Promise<unknown> => {
      try {
        return await call(request);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' &&
            'message' in error && typeof error.message === 'string') {
          throw Object.assign(new Error(error.message), { code: error.code });
        }
        throw error;
      }
    },
  ])),
  args: [bridge.api.targets],
});
contextBridge.exposeInMainWorld('cindy', { ...bridge.api, targets });
