import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  openSocket: vi.fn(),
  current: vi.fn(),
  supportsLock: vi.fn(),
  logindUnlocked: vi.fn(),
  idleState: 'active',
  formats: ['text/plain'],
  text: '手机 ⇄ 云端 😀',
  primary: '选择文字',
  html: '',
  rtf: '',
  write: vi.fn(),
  readImage: vi.fn(),
}));
vi.mock('electron', () => ({
  clipboard: {
    availableFormats: () => h.formats,
    readText: (type: string) => (type === 'selection' ? h.primary : h.text),
    readHTML: () => h.html,
    readRTF: () => h.rtf,
    readImage: h.readImage,
    write: h.write,
  },
  nativeImage: { createFromBuffer: (bytes: Buffer) => bytes },
  powerMonitor: { getSystemIdleState: () => h.idleState },
}));
vi.mock('../linuxDesktop', () => ({ supportsLinuxLock: h.supportsLock }));
vi.mock('../linuxSessionLock', () => ({ isLogindSessionUnlocked: h.logindUnlocked }));
vi.mock('../linuxDisplay', async (original) => ({
  ...(await original<object>()),
  openLinuxX11Socket: h.openSocket,
}));
import {
  isX11Clipboard,
  supportsX11Clipboard,
  readX11ClipboardSnapshot,
  writeX11Clipboard,
} from '../linuxX11Clipboard';
import { clipboard } from 'electron';

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  vi.stubEnv('DISPLAY', ':99');
  vi.stubEnv('XDG_SESSION_TYPE', 'x11');
  vi.stubEnv('XDG_SESSION_ID', '');
  vi.stubEnv('WAYLAND_DISPLAY', '');
  vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', '');
  h.current.mockReset().mockResolvedValue(true);
  h.openSocket.mockReset().mockResolvedValue({ current: h.current });
  h.supportsLock.mockReset().mockReturnValue(true);
  h.logindUnlocked.mockReset().mockResolvedValue(true);
  h.idleState = 'active';
  h.formats = ['text/plain'];
  h.text = '手机 ⇄ 云端 😀';
  h.primary = '选择文字';
  h.html = '';
  h.rtf = '';
  h.write.mockReset();
  h.readImage.mockReset().mockReturnValue({ isEmpty: () => true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['wayland-display', 'wayland-session', 'hyprland', 'remote-display', 'mac'])(
  'does not enable the X11 clipboard policy on %s',
  async (mode) => {
    if (mode === 'wayland-display') vi.stubEnv('WAYLAND_DISPLAY', 'wayland-1');
    if (mode === 'wayland-session') vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    if (mode === 'hyprland') vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', 'local');
    if (mode === 'remote-display') vi.stubEnv('DISPLAY', 'remote:0');
    if (mode === 'mac') vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(isX11Clipboard()).toBe(false);
    expect(await supportsX11Clipboard()).toBe(false);
    await expect(readX11ClipboardSnapshot()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
    expect(h.openSocket).not.toHaveBeenCalled();
  },
);

// Regression: ordinary Ubuntu/XFCE desktops and cloud desktops without --cloud-instance
// or xdotool were blocked by managedX11Clipboard(). Verify both headless Xvfb (no
// XDG_SESSION_ID) and local desktop sessions (with XDG_SESSION_ID + logind lock gate).
it('supports headless Xvfb and ordinary local X11 desktops without --cloud-instance', async () => {
  expect(isX11Clipboard()).toBe(true);
  expect(await supportsX11Clipboard()).toBe(true);
  expect(h.logindUnlocked).not.toHaveBeenCalled();

  vi.stubEnv('XDG_SESSION_ID', '2');
  expect(await supportsX11Clipboard()).toBe(true);
  expect((await readX11ClipboardSnapshot()).content).toEqual({ text: h.text });
  expect(h.logindUnlocked).toHaveBeenCalled();
});

it('guards local X11 login sessions against locked screens and missing loginctl', async () => {
  vi.stubEnv('XDG_SESSION_ID', '2');
  h.supportsLock.mockReturnValue(false);
  expect(await supportsX11Clipboard()).toBe(false);
  await expect(readX11ClipboardSnapshot()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  await expect(writeX11Clipboard({ text: 'secret' }, () => true)).rejects.toThrow(
    'DESKTOP_CLIPBOARD_UNAVAILABLE',
  );
  expect(h.write).not.toHaveBeenCalled();

  h.supportsLock.mockReturnValue(true);
  h.logindUnlocked.mockResolvedValue(false);
  // Capability remains advertised while locked; operations refuse until unlocked.
  expect(await supportsX11Clipboard()).toBe(true);
  await expect(readX11ClipboardSnapshot()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  await expect(writeX11Clipboard({ text: 'secret' }, () => true)).rejects.toThrow(
    'DESKTOP_CLIPBOARD_UNAVAILABLE',
  );
  expect(h.write).not.toHaveBeenCalled();

  // Mid-read lock discards the snapshot.
  h.logindUnlocked.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(readX11ClipboardSnapshot()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
});

it('refuses X11 clipboard access when the idle monitor reports locked, even without XDG_SESSION_ID', async () => {
  h.idleState = 'locked';
  expect(await supportsX11Clipboard()).toBe(true);
  await expect(readX11ClipboardSnapshot()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  await expect(writeX11Clipboard({ text: 'secret' }, () => true)).rejects.toThrow(
    'DESKTOP_CLIPBOARD_UNAVAILABLE',
  );
  expect(h.write).not.toHaveBeenCalled();
});

it('reads native CLIPBOARD and PRIMARY separately, retaining portable alternatives', async () => {
  h.html = '<b>hello</b>';
  h.rtf = '{\\rtf1 hello}';
  expect(await supportsX11Clipboard()).toBe(true);
  expect((await readX11ClipboardSnapshot()).content).toEqual({
    text: h.text,
    html: h.html,
    rtf: h.rtf,
  });
  expect((await readX11ClipboardSnapshot(true)).content).toEqual({ text: h.primary });
});

it('does not copy file paths or encode oversized images (aligned with 24M pixel desktop bound)', async () => {
  h.formats = ['text/uri-list', 'text/plain'];
  h.text = '/private/file';
  expect((await readX11ClipboardSnapshot()).content).toEqual({});
  h.formats.push('image/png');
  const encode = vi.fn();
  h.readImage.mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 6001, height: 4000 }),
    toPNG: encode,
  });
  await expect(readX11ClipboardSnapshot()).rejects.toThrow('CLIPBOARD_TOO_LONG');
  expect(encode).not.toHaveBeenCalled();
});

it('bounds text before returning or fingerprinting it', async () => {
  h.text = 'x'.repeat(512001);
  await expect(readX11ClipboardSnapshot()).rejects.toThrow('CLIPBOARD_TOO_LONG');
});

it.each([false, true])(
  'does not request data from an empty X11 selection (primary=%s)',
  async (primary) => {
    h.formats = [];
    const reads = ['readText', 'readHTML', 'readRTF'].map((key) =>
      vi.spyOn(clipboard, key as 'readText').mockImplementation(() => {
        throw new Error('An unavailable target would block the native clipboard');
      }),
    );
    try {
      expect(await readX11ClipboardSnapshot(primary)).toEqual({ formats: [], content: {} });
      for (const read of reads) expect(read).not.toHaveBeenCalled();
      expect(h.readImage).not.toHaveBeenCalled();
      h.current.mockResolvedValue(false);
      await expect(readX11ClipboardSnapshot(primary)).rejects.toThrow(
        'DESKTOP_CLIPBOARD_UNAVAILABLE',
      );
    } finally {
      reads.forEach((read) => read.mockRestore());
    }
  },
);

it('rejects a replaced display, unavailable display and expired lease without writing', async () => {
  h.current.mockResolvedValue(false);
  await expect(writeX11Clipboard({ text: 'test' }, () => true)).rejects.toThrow(
    'DESKTOP_CLIPBOARD_UNAVAILABLE',
  );
  await expect(readX11ClipboardSnapshot()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  h.current.mockResolvedValue(true);
  await expect(writeX11Clipboard({ text: 'test' }, () => false)).rejects.toThrow(
    'DESKTOP_LEASE_EXPIRED',
  );
  h.openSocket.mockRejectedValue(new Error('private display details'));
  await expect(readX11ClipboardSnapshot()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  expect(h.write).not.toHaveBeenCalled();
});

it('writes alternatives together and rejects revocation at completion', async () => {
  let current = true;
  h.write.mockImplementation(() => {
    current = false;
  });
  await expect(
    writeX11Clipboard({ text: 'hello', html: '<b>hello</b>' }, () => current),
  ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  expect(h.write).toHaveBeenCalledExactlyOnceWith({ text: 'hello', html: '<b>hello</b>' });
});
