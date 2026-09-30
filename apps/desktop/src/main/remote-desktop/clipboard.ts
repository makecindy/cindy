import { clipboard, nativeImage } from 'electron';
import { createHash } from 'node:crypto';
import {
  REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS,
  type DesktopInput,
  type RemoteClipboardContent,
  parseClipboardContent,
  CLIPBOARD_MAX_CHARS,
} from '@cindy/device-link';
import { readDesktopClipboardVersion, readDesktopSelection } from './inputHost';
import {
  readLinuxClipboardSnapshot,
  writeLinuxClipboard,
  supportsLinuxClipboard,
} from './linuxClipboardNative';

const IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_PIXELS = 4_000_000;

function checkImageSize(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > IMAGE_PIXELS / height
  )
    throw new Error('CLIPBOARD_TOO_LONG');
}

/** Bound native encoding before PNG allocation, and Base64/hash copies afterwards. */
function clipboardPng(image: Electron.NativeImage): Buffer {
  if (image.isEmpty()) return Buffer.alloc(0);
  const size = image.getSize(1);
  checkImageSize(size.width, size.height);
  const png = image.toPNG({ scaleFactor: 1 });
  if (png.length > IMAGE_BYTES) throw new Error('CLIPBOARD_TOO_LONG');
  return png;
}

function incomingPng(encoded: string): Buffer {
  if (encoded.length > Math.ceil(IMAGE_BYTES / 3) * 4) throw new Error('CLIPBOARD_TOO_LONG');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > IMAGE_BYTES) throw new Error('CLIPBOARD_TOO_LONG');
  if (
    bytes.length < 33 ||
    !bytes
      .subarray(0, 16)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]))
  )
    throw new Error('CLIPBOARD_UNSUPPORTED');
  checkImageSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  return bytes;
}

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
      if (supportsLinuxClipboard()) await writeLinuxClipboard({ text: selected }, isCurrent);
      else clipboard.writeText(selected);
      return selected;
    }
    // Only a confirmed empty selection opts into the computer clipboard.
    // Permission errors, unsupported selection APIs and oversized selections
    // remain errors rather than silently returning unrelated clipboard text.
    const before = await readDesktopClipboardVersion();
    check();
    const existing = supportsLinuxClipboard()
      ? (await readLinuxClipboardSnapshot()).content.text
      : clipboard.readText();
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
  if (supportsLinuxClipboard()) await writeLinuxClipboard({ text }, isCurrent);
  else clipboard.writeText(text);
  const writtenText = supportsLinuxClipboard()
    ? (await readLinuxClipboardSnapshot()).content.text
    : clipboard.readText();
  check();
  if (writtenText !== text) throw new Error('DESKTOP_CLIPBOARD_WRITE_FAILED');
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
  options?: { sync?: boolean; version?: string },
): Promise<RemoteClipboardContent | { version: string } | void> {
  const check = () => {
    if (!isCurrent()) throw new Error('DESKTOP_LEASE_EXPIRED');
  };
  check();
  if (!options?.sync) input([{ kind: 'release' }]);
  if (action === 'copy') {
    const selected = options?.sync ? null : await readDesktopSelection(true);
    check();
    if (selected) return { text: selected };
    const before = await readDesktopClipboardVersion(true);
    check();
    if (options?.version && before !== options.version)
      throw new Error('DESKTOP_CLIPBOARD_CHANGED');
    const linux = supportsLinuxClipboard() ? await readLinuxClipboardSnapshot() : null;
    check();
    const formats = linux?.formats ?? clipboard.availableFormats();
    // A file-backed image may also expose a portable bitmap. Never read the
    // file flavor or dereference its path; a file alone remains unsupported.
    const fileBacked = formats.some((format) =>
      /file-url|filenames|hdrop|filecontents|filegroupdescriptor|uri-list/i.test(format),
    );
    const image = linux ? nativeImage.createEmpty() : clipboard.readImage();
    if (fileBacked && image.isEmpty() && !linux?.content.png)
      throw new Error('CLIPBOARD_UNSUPPORTED');
    const snapshot: RemoteClipboardContent = { ...linux?.content };
    // File-manager text/HTML can be a local path rather than image content.
    const text = fileBacked ? '' : linux ? linux.content.text : clipboard.readText();
    const html = fileBacked ? '' : linux ? linux.content.html : clipboard.readHTML();
    const rtf = fileBacked ? '' : linux ? linux.content.rtf : clipboard.readRTF();
    if (text) snapshot.text = text;
    if (html) snapshot.html = html;
    if (rtf) snapshot.rtf = rtf;
    if (!image.isEmpty()) {
      snapshot.png = clipboardPng(image).toString('base64');
    }
    const after = await readDesktopClipboardVersion(true);
    check();
    if (before !== after) throw new Error('DESKTOP_CLIPBOARD_CHANGED');
    if (!Object.keys(snapshot).length)
      throw new Error(formats.length ? 'CLIPBOARD_UNSUPPORTED' : 'CLIPBOARD_EMPTY');
    const json = JSON.stringify(snapshot);
    if (json.length > CLIPBOARD_MAX_CHARS) throw new Error('CLIPBOARD_TOO_LONG');
    return parseClipboardContent(json);
  }
  if (!content) throw new Error('CLIPBOARD_EMPTY');
  const pngBytes = content.png ? incomingPng(content.png) : undefined;
  const value = parseClipboardContent(JSON.stringify(content));
  let image: Electron.NativeImage | undefined;
  if (value.png) {
    image = nativeImage.createFromBuffer(pngBytes!);
    if (image.isEmpty()) throw new Error('CLIPBOARD_UNSUPPORTED');
  }
  const version = await readDesktopClipboardVersion();
  check();
  if (options?.version && version !== options.version) throw new Error('DESKTOP_CLIPBOARD_CHANGED');
  if (supportsLinuxClipboard()) {
    await writeLinuxClipboard(value, isCurrent);
    const actual = (await readLinuxClipboardSnapshot()).content;
    check();
    if (
      (value.text || value.url || undefined) !== actual.text ||
      value.html !== actual.html ||
      value.rtf !== actual.rtf ||
      value.png !== actual.png
    )
      throw new Error('DESKTOP_CLIPBOARD_WRITE_FAILED');
    if (options?.sync) {
      const version = await readDesktopClipboardVersion(true);
      const after = (await readLinuxClipboardSnapshot()).content;
      check();
      if (JSON.stringify(after) !== JSON.stringify(actual))
        throw new Error('DESKTOP_CLIPBOARD_CHANGED');
      return { version };
    }
  } else {
    clipboard.write({
      ...(value.text || value.url ? { text: value.text || value.url } : {}),
      ...(value.html ? { html: value.html } : {}),
      ...(value.rtf ? { rtf: value.rtf } : {}),
      ...(image ? { image } : {}),
    });
    if (
      (image && clipboard.readImage().isEmpty()) ||
      (value.text && clipboard.readText() !== value.text)
    )
      throw new Error('DESKTOP_CLIPBOARD_WRITE_FAILED');
    check();
    if (options?.sync) {
      const fingerprint = () =>
        createHash('sha256')
          .update(
            JSON.stringify([
              clipboard.availableFormats(),
              clipboard.readText(),
              clipboard.readHTML(),
              clipboard.readRTF(),
            ]),
          )
          .update(clipboardPng(clipboard.readImage()))
          .digest('hex');
      const written = fingerprint();
      const version = await readDesktopClipboardVersion(true);
      check();
      if (fingerprint() !== written) throw new Error('DESKTOP_CLIPBOARD_CHANGED');
      return { version };
    }
  }
  const modifier = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft';
  input([
    { kind: 'release' },
    { kind: 'key', code: modifier, down: true },
    { kind: 'key', code: 'KeyV', down: true },
    { kind: 'key', code: 'KeyV', down: false },
    { kind: 'key', code: modifier, down: false },
  ]);
}
