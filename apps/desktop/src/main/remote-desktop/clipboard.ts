import { clipboard, nativeImage } from 'electron';
import { REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS, type DesktopInput, type RemoteClipboardContent, parseClipboardContent, CLIPBOARD_MAX_CHARS } from '@cindy/device-link';
import { readDesktopClipboardVersion, readDesktopSelection } from './inputHost';

/** Explicit selection/text transfer. No background sync, logging or persistence. */
export async function transferDesktopClipboard(
  action: 'copy' | 'paste',
  text: string | undefined,
  isCurrent: () => boolean,
  input: (events: DesktopInput[]) => void,
): Promise<string | void> {
  const check = () => {
    if (!isCurrent()) throw new Error('DESKTOP_LEASE_EXPIRED');
  };
  check();
  input([{ kind: 'release' }]);
  if (action === 'copy') {
    const selected = await readDesktopSelection();
    check();
    if (selected) {
      clipboard.writeText(selected);
      return selected;
    }
    // Only a confirmed empty selection opts into the computer clipboard.
    // Permission errors, unsupported selection APIs and oversized selections
    // remain errors rather than silently returning unrelated clipboard text.
    const before = await readDesktopClipboardVersion();
    check();
    const existing = clipboard.readText();
    if (!existing || existing.length > REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS)
      throw new Error('DESKTOP_CLIPBOARD_INVALID');
    const after = await readDesktopClipboardVersion();
    check();
    if (before !== after) throw new Error('DESKTOP_CLIPBOARD_CHANGED');
    return existing;
  }
  await readDesktopClipboardVersion(); // Refuse secure/locked desktop clipboard access.
  check();
  if (!text || text.length > REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS)
    throw new Error('DESKTOP_CLIPBOARD_INVALID');
  clipboard.writeText(text);
  if (clipboard.readText() !== text) throw new Error('DESKTOP_CLIPBOARD_WRITE_FAILED');
  const modifier = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft';
  input([
    { kind: 'release' },
    { kind: 'key', code: modifier, down: true },
    { kind: 'key', code: 'KeyV', down: true },
    { kind: 'key', code: 'KeyV', down: false },
    { kind: 'key', code: modifier, down: false },
  ]);
}

/** Portable formats are written together so HTML/image alternatives survive. */
export async function transferDesktopClipboardContent(
  action: 'copy' | 'paste',
  content: RemoteClipboardContent | undefined,
  isCurrent: () => boolean,
  input: (events: DesktopInput[]) => void,
): Promise<RemoteClipboardContent | void> {
  const check = () => { if (!isCurrent()) throw new Error('DESKTOP_LEASE_EXPIRED'); };
  check();
  input([{ kind: 'release' }]);
  if (action === 'copy') {
    const selected = await readDesktopSelection(true);
    check();
    if (selected) return { text: selected };
    const before = await readDesktopClipboardVersion(true);
    check();
    const formats = clipboard.availableFormats();
    // A file-backed image may also expose a portable bitmap. Never read the
    // file flavor or dereference its path; a file alone remains unsupported.
    const fileBacked = formats.some((format) => /file-url|filenames|hdrop|filecontents|filegroupdescriptor|uri-list/i.test(format));
    const image = clipboard.readImage();
    if (fileBacked && image.isEmpty())
      throw new Error('CLIPBOARD_UNSUPPORTED');
    const snapshot: RemoteClipboardContent = {};
    // File-manager text/HTML can be a local path rather than image content.
    const text = fileBacked ? '' : clipboard.readText();
    const html = fileBacked ? '' : clipboard.readHTML();
    const rtf = fileBacked ? '' : clipboard.readRTF();
    if (text) snapshot.text = text;
    if (html) snapshot.html = html;
    if (rtf) snapshot.rtf = rtf;
    if (!image.isEmpty()) {
      const size = image.getSize();
      if (size.width * size.height > 64_000_000) throw new Error('CLIPBOARD_TOO_LONG');
      snapshot.png = image.toPNG().toString('base64');
    }
    const after = await readDesktopClipboardVersion(true);
    check();
    if (before !== after) throw new Error('DESKTOP_CLIPBOARD_CHANGED');
    if (!Object.keys(snapshot).length) throw new Error(formats.length ? 'CLIPBOARD_UNSUPPORTED' : 'CLIPBOARD_EMPTY');
    const json = JSON.stringify(snapshot);
    if (json.length > CLIPBOARD_MAX_CHARS) throw new Error('CLIPBOARD_TOO_LONG');
    return parseClipboardContent(json);
  }
  if (!content) throw new Error('CLIPBOARD_EMPTY');
  const value = parseClipboardContent(JSON.stringify(content));
  let image: Electron.NativeImage | undefined;
  if (value.png) {
    const bytes = Buffer.from(value.png, 'base64');
    // Bound decompression before passing untrusted image bytes to nativeImage.
    if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 64_000_000)
      throw new Error('CLIPBOARD_TOO_LONG');
    image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('CLIPBOARD_UNSUPPORTED');
  }
  await readDesktopClipboardVersion();
  check();
  clipboard.write({
    ...(value.text || value.url ? { text: value.text || value.url } : {}),
    ...(value.html ? { html: value.html } : {}),
    ...(value.rtf ? { rtf: value.rtf } : {}),
    ...(image ? { image } : {}),
  });
  if ((image && clipboard.readImage().isEmpty()) ||
      (value.text && clipboard.readText() !== value.text))
    throw new Error('DESKTOP_CLIPBOARD_WRITE_FAILED');
  check();
  const modifier = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft';
  input([
    { kind: 'release' },
    { kind: 'key', code: modifier, down: true },
    { kind: 'key', code: 'KeyV', down: true },
    { kind: 'key', code: 'KeyV', down: false },
    { kind: 'key', code: modifier, down: false },
  ]);
}
