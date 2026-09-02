/** Main-owned custom background import and read-only protocol. */
import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  dialog,
  protocol,
  type BrowserWindow,
  type CustomScheme,
  type OpenDialogOptions,
} from 'electron';

import { sniffMediaMime } from './cindy-media/sniffMediaMime.js';
import { throwIpcError } from './utils/ipcValidate.js';

const SCHEME = 'cindy-background';
const MAX_BYTES = 25 * 1024 * 1024;
const MIME_EXT = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

export const appearanceBackgroundSchemePrivilege: CustomScheme = {
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    stream: false,
    corsEnabled: false,
  },
};

function backgroundDir(): string {
  return path.join(app.getPath('userData'), 'appearance-backgrounds');
}

export async function importAppearanceBackground(
  parentWindow: BrowserWindow | null,
): Promise<{ canceled: true } | { canceled: false; url: string }> {
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  };
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const source = result.filePaths[0];
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(source);
  } catch {
    throwIpcError('INVALID_PARAMS', 'selected background image is unavailable');
  }
  if (!stat.isFile()) throwIpcError('INVALID_PARAMS', 'background must be a file');
  if (stat.size > MAX_BYTES) throwIpcError('INVALID_PARAMS', 'background image exceeds 25 MB');
  const bytes = await fs.promises.readFile(source);
  const mime = sniffMediaMime(bytes.subarray(0, 4096));
  const ext = mime ? MIME_EXT.get(mime) : undefined;
  if (!ext) throwIpcError('INVALID_PARAMS', 'unsupported background image');
  const dir = backgroundDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, `background${ext}`);
  const temp = path.join(dir, `.background-${process.pid}-${Date.now()}${ext}`);
  await fs.promises.writeFile(temp, bytes, { flag: 'wx' });
  await fs.promises.copyFile(temp, target);
  await fs.promises.unlink(temp);
  await removeOtherBackgrounds(target);
  return { canceled: false, url: `${SCHEME}://current/background${ext}?v=${Date.now()}` };
}

export async function removeAppearanceBackgroundFiles(): Promise<void> {
  await removeOtherBackgrounds('');
}

async function removeOtherBackgrounds(keep: string): Promise<void> {
  const dir = backgroundDir();
  await Promise.all(
    [...MIME_EXT.values()].map(async (ext) => {
      const candidate = path.join(dir, `background${ext}`);
      if (candidate === keep) return;
      await fs.promises.unlink(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }),
  );
}

export function registerAppearanceBackgroundProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    const match =
      /^cindy-background:\/\/current\/(background\.(?:png|jpe?g|webp))(?:\?v=\d+)?$/.exec(
        request.url,
      );
    if (!match) return new Response(null, { status: 403 });
    try {
      const filePath = path.join(backgroundDir(), match[1]);
      const bytes = await fs.promises.readFile(filePath);
      const mime = sniffMediaMime(bytes.subarray(0, 4096));
      if (!mime || !MIME_EXT.has(mime)) return new Response(null, { status: 403 });
      return new Response(bytes, {
        headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' },
      });
    } catch (error) {
      return new Response(null, {
        status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500,
      });
    }
  });
}

export const __testing = { backgroundDir };
