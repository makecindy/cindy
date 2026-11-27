import { clipboard, nativeImage, powerMonitor } from 'electron';
import type { RemoteClipboardContent } from '@cindy/device-link';
import { CLIPBOARD_IMAGE_BYTES, CLIPBOARD_IMAGE_PIXELS } from './clipboardLimits';
import { supportsLinuxLock } from './linuxDesktop';
import { linuxDisplaySocket, openLinuxX11Socket } from './linuxDisplay';
import { isLogindSessionUnlocked } from './linuxSessionLock';
import { isWaylandDesktop } from './waylandCapture';

interface X11LockOptions {
  checkLock?: boolean;
}

/** Local X11 desktop sessions (Ubuntu Xorg, XFCE desktop, headless Xvfb cloud
 * desktops and managed cloud containers). Never applies to Wayland/XWayland,
 * Hyprland or remote TCP DISPLAY targets. */
export function isX11Clipboard(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    process.platform === 'linux' &&
    !isWaylandDesktop(process.platform, env) &&
    !env.HYPRLAND_INSTANCE_SIGNATURE &&
    Boolean(linuxDisplaySocket(env))
  );
}

function hasLoginSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.XDG_SESSION_ID?.length);
}

function isIdleMonitorLocked(): boolean {
  try {
    return powerMonitor?.getSystemIdleState?.(1) === 'locked';
  } catch {
    return false;
  }
}

async function openClipboard(checkLock: boolean) {
  if (!isX11Clipboard()) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  const loginSession = hasLoginSession();
  // An OS login session (XDG_SESSION_ID set) must have a verifiable logind lock
  // probe before remote clipboard access is offered or executed.
  if (loginSession && !supportsLinuxLock()) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  try {
    const display = await openLinuxX11Socket();
    return async () => {
      if (!isX11Clipboard() || !(await display.current()))
        throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
      if (!checkLock) return;
      if (isIdleMonitorLocked()) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
      if (hasLoginSession() !== loginSession) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
      if (loginSession && !(await isLogindSessionUnlocked()))
        throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
    };
  } catch {
    throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  }
}

export async function supportsX11Clipboard(): Promise<boolean> {
  try {
    await (await openClipboard(false))();
    return true;
  } catch {
    return false;
  }
}

export async function readX11ClipboardSnapshot(
  primary = false,
  { checkLock = true }: X11LockOptions = {},
): Promise<{
  formats: string[];
  content: RemoteClipboardContent;
}> {
  const check = await openClipboard(checkLock);
  await check();
  const type = primary ? 'selection' : 'clipboard';
  const formats = clipboard.availableFormats(type).sort();
  if (formats.length > 64 || formats.some((f) => f.length > 256))
    throw new Error('CLIPBOARD_UNSUPPORTED');
  const content: RemoteClipboardContent = {};
  // An owner can disappear while the X11 clipboard manager is saving its
  // targets. Reading a format that is not offered can block Electron's main
  // thread until that handover times out. An empty offer has no data to read.
  if (!formats.length) {
    await check();
    return { formats, content };
  }
  const fileBacked = formats.some((f) =>
    /file-url|filenames|hdrop|filecontents|filegroupdescriptor|uri-list/i.test(f),
  );
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
  if (!primary && formats.some((f) => f.startsWith('image/'))) {
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const { width, height } = image.getSize(1);
      if (width <= 0 || height <= 0 || width > CLIPBOARD_IMAGE_PIXELS / height)
        throw new Error('CLIPBOARD_TOO_LONG');
      const png = image.toPNG({ scaleFactor: 1 });
      if (png.length > CLIPBOARD_IMAGE_BYTES) throw new Error('CLIPBOARD_TOO_LONG');
      content.png = png.toString('base64');
    }
  }
  await check();
  return { formats, content };
}

/** Electron owns the X11 selection, just as for a local Copy. No background
 * process, clipboard watcher, shell command or persisted copy is introduced. */
export async function writeX11Clipboard(
  content: RemoteClipboardContent,
  current: () => boolean,
  { checkLock = true }: X11LockOptions = {},
): Promise<void> {
  const check = await openClipboard(checkLock);
  await check();
  if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
  clipboard.write({
    ...(content.text || content.url ? { text: content.text || content.url } : {}),
    ...(content.html ? { html: content.html } : {}),
    ...(content.rtf ? { rtf: content.rtf } : {}),
    ...(content.png
      ? { image: nativeImage.createFromBuffer(Buffer.from(content.png, 'base64')) }
      : {}),
  });
  await check();
  if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
}
