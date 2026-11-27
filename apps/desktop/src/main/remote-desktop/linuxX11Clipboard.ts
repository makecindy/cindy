import { clipboard, nativeImage } from 'electron';
import type { RemoteClipboardContent } from '@cindy/device-link';
import { getInstanceConfig } from '../instance-runtime/config.js';
import { linuxDisplaySocket, openLinuxDisplay } from './linuxDisplay';

/** The managed Xvfb desktop has no OS login/locker. Do not apply this policy to
 * an arbitrary local Linux session or to XWayland; Hyprland keeps its lock gate. */
export function managedX11Clipboard(): boolean {
  return process.platform === 'linux' && !!getInstanceConfig()
    && !process.env.HYPRLAND_INSTANCE_SIGNATURE && !!linuxDisplaySocket(process.env);
}

async function openClipboard() {
  if (!managedX11Clipboard()) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  try {
    const display = await openLinuxDisplay();
    return async () => {
      if (!managedX11Clipboard() || !(await display.current()))
        throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
    };
  } catch {
    throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  }
}

export async function supportsManagedX11Clipboard(): Promise<boolean> {
  try { await (await openClipboard())(); return true; } catch { return false; }
}

export async function readX11ClipboardSnapshot(primary = false): Promise<{
  formats: string[]; content: RemoteClipboardContent;
}> {
  const check = await openClipboard();
  const type = primary ? 'selection' : 'clipboard';
  const formats = clipboard.availableFormats(type).sort();
  if (formats.length > 64 || formats.some(f => f.length > 256))
    throw new Error('CLIPBOARD_UNSUPPORTED');
  const content: RemoteClipboardContent = {};
  // An owner can disappear while the X11 clipboard manager is saving its
  // targets. Reading a format that is not offered can block Electron's main
  // thread until that handover times out. An empty offer has no data to read.
  if (!formats.length) {
    await check();
    return { formats, content };
  }
  const fileBacked = formats.some(f => /file-url|filenames|hdrop|filecontents|filegroupdescriptor|uri-list/i.test(f));
  if (!fileBacked) {
    for (const [key, read] of [
      ['text', () => clipboard.readText(type)],
      ['html', () => clipboard.readHTML(type)],
      ['rtf', () => clipboard.readRTF(type)],
    ] as const) {
      if (primary && key !== 'text') continue;
      const value = read();
      if (value.length > 512000) throw new Error('CLIPBOARD_TOO_LONG');
      if (value) content[key] = value;
    }
  }
  if (!primary && formats.some(f => f.startsWith('image/'))) {
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const { width, height } = image.getSize(1);
      if (width <= 0 || height <= 0 || width > 4000000 / height)
        throw new Error('CLIPBOARD_TOO_LONG');
      const png = image.toPNG({ scaleFactor: 1 });
      if (png.length > 8 * 1024 * 1024) throw new Error('CLIPBOARD_TOO_LONG');
      content.png = png.toString('base64');
    }
  }
  await check();
  return { formats, content };
}

/** Electron owns the X11 selection, just as for a local Copy. No background
 * process, clipboard watcher, shell command or persisted copy is introduced. */
export async function writeX11Clipboard(content: RemoteClipboardContent, current: () => boolean): Promise<void> {
  const check = await openClipboard();
  await check();
  if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
  clipboard.write({
    ...(content.text || content.url ? { text: content.text || content.url } : {}),
    ...(content.html ? { html: content.html } : {}),
    ...(content.rtf ? { rtf: content.rtf } : {}),
    ...(content.png ? { image: nativeImage.createFromBuffer(Buffer.from(content.png, 'base64')) } : {}),
  });
  await check();
  if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
}
