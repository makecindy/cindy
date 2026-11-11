import { contextBridge, ipcRenderer } from 'electron';
import { createGhostPageBridge } from '../shared/ghostPageBridge';

// Injected only into the logic page. Main resolves identity from the real sender.
const bridge = createGhostPageBridge({
  ping: () => ipcRenderer.invoke('ghost-pipe:ping'),
  send: payload => ipcRenderer.invoke('ghost-pipe:send', payload),
});
ipcRenderer.on('ghost-pipe:message', (_event, payload: unknown) => bridge.deliver(payload));
contextBridge.exposeInMainWorld('cindy', bridge.api);
