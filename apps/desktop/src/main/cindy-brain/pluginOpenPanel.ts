import { createRequire } from 'node:module';
import path from 'node:path';
import { app, dialog, type BrowserWindow, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron';

interface OpenPanel {
  promise: Promise<OpenDialogReturnValue>;
  cancel?: () => boolean;
}

type OpenOwnedPanel = (handle: Buffer, open: () => Promise<OpenDialogReturnValue>) => OpenPanel | null;

const requireNative = createRequire(__filename);
let openOwnedPanel: OpenOwnedPanel | null | undefined;

function loadNativePanel(): OpenOwnedPanel | null {
  if (openOwnedPanel === undefined) {
    try {
      const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
      openOwnedPanel = requireNative(path.join(resources, 'tools/plugin-open-panel/cindy-plugin-open-panel.node')) as OpenOwnedPanel;
    } catch {
      openOwnedPanel = null;
    }
  }
  return openOwnedPanel;
}

function waitForSheetToEnd(parent: BrowserWindow, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      parent.removeListener('sheet-end', done);
      parent.removeListener('closed', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    parent.once('sheet-end', done);
    parent.once('closed', done);
    signal.addEventListener('abort', done, { once: true });
    if (parent.isDestroyed() || signal.aborted) done();
  });
}

export async function showPluginOpenDialog(
  parent: BrowserWindow,
  options: OpenDialogOptions,
  signal?: AbortSignal,
): Promise<OpenDialogReturnValue> {
  const open = () => dialog.showOpenDialog(parent, options);
  if (signal?.aborted) return { canceled: true, filePaths: [] };

  const openNative = process.platform === 'darwin' && signal ? loadNativePanel() : null;
  if (!openNative || !signal) return open();

  while (!signal.aborted && !parent.isDestroyed()) {
    const panel = openNative(parent.getNativeWindowHandle(), open);
    if (!panel) {
      // AppKit does not expose a queued sheet's parent until it attaches. Wait
      // cancellably before opening so the new sheet can be identified exactly.
      await waitForSheetToEnd(parent, signal);
      await new Promise<void>(resolve => setImmediate(resolve));
      continue;
    }
    if (!panel.cancel) return panel.promise;
    const cancel = panel.cancel;
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      return await panel.promise;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  return { canceled: true, filePaths: [] };
}
