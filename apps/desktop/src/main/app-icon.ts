import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isAppContentWindow } from './windowFocusClassifier.js';

type IconWindow = Pick<BrowserWindow, 'isDestroyed' | 'setIcon'>;

/** Native images are a rebuildable projection of the existing appearance settings. */
export function createRuntimeAppIconController(deps: {
  platform: NodeJS.Platform;
  original: NativeImage;
  decode(bytes: Buffer): NativeImage;
  dock?: { setIcon(image: NativeImage): void };
  windows(): IconWindow[];
}) {
  let current: NativeImage | null = null;
  let currentHash: string | null | undefined;
  return {
    set(bytes: Buffer | null): void {
      const hash = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
      if (hash === currentHash) return;
      const image = bytes ? deps.decode(bytes) : deps.original;
      if (image.isEmpty()) throw new Error('INVALID_ICON');
      if (image === current) return;
      if (deps.platform === 'darwin') {
        if (!deps.dock) throw new Error('APP_ICON_UNAVAILABLE');
        deps.dock.setIcon(image);
      } else {
        for (const win of deps.windows()) if (!win.isDestroyed()) win.setIcon(image);
      }
      current = image;
      currentHash = hash;
    },
    applyToWindow(win: IconWindow): void {
      if (deps.platform !== 'darwin' && current && !win.isDestroyed()) win.setIcon(current);
    },
  };
}

let controller: ReturnType<typeof createRuntimeAppIconController> | undefined;

export async function initializeRuntimeAppIcon(): Promise<void> {
  if (controller) return;
  // Read the packaged bundle's actual icon; dev uses Cindy's rounded Dock asset.
  const original = process.platform === 'darwin' && app.isPackaged
    ? await app.getFileIcon(path.resolve(process.resourcesPath, '..', '..'))
    : nativeImage.createFromPath(app.isPackaged ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../resources', process.platform === 'darwin' ? 'icon-dock.png' : 'icon.png'));
  const next = createRuntimeAppIconController({ platform: process.platform, original,
    decode: bytes => nativeImage.createFromBuffer(bytes), dock: app.dock,
    windows: () => BrowserWindow.getAllWindows().filter(isAppContentWindow),
  });
  next.set(null);
  controller = next;
  if (process.platform !== 'darwin') app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', () => {
      if (isAppContentWindow(win)) controller?.applyToWindow(win);
    });
  });
}

export function applyRuntimeAppIcon(bytes: Buffer | null): void {
  if (!controller) throw new Error('APP_ICON_UNAVAILABLE');
  controller.set(bytes);
}

export function resetRuntimeAppIcon(): void {
  controller?.set(null);
}
