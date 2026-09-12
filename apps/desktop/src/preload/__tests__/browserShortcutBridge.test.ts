import { contextBridge, ipcRenderer } from 'electron';
import { afterAll, expect, it, vi } from 'vitest';

afterAll(() => vi.restoreAllMocks());

it('passes quick switcher commands through the real preload without exposing events or unknown commands', async () => {
  let bridge: Pick<Window['electronAPI'], 'onRsbBrowserCommand'> | undefined;
  vi.spyOn(ipcRenderer, 'sendSync').mockImplementation((channel) =>
    channel === 'get-app-display-version-info' ? { display: 'test', detail: 'test' } : undefined,
  );
  vi.spyOn(contextBridge, 'exposeInMainWorld').mockImplementation((name, api) => {
    if (name === 'electronAPI') bridge = api;
  });
  await import('../preload');
  expect(bridge).toBeDefined();
  const callback = vi.fn();
  const unsubscribe = bridge!.onRsbBrowserCommand(callback);
  const event = { sender: 'must not reach the renderer' };
  try {
    ipcRenderer.emit('rsb:browser-command', event, { command: 'open-quick-switcher' });
    expect(callback).toHaveBeenCalledExactlyOnceWith({ command: 'open-quick-switcher' });
    for (const payload of [null, {}, { command: 'unknown' }]) {
      ipcRenderer.emit('rsb:browser-command', event, payload);
    }
    expect(callback).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
  }
  ipcRenderer.emit('rsb:browser-command', event, { command: 'open-quick-switcher' });
  expect(callback).toHaveBeenCalledOnce();
});
