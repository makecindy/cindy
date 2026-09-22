import { createHash } from 'node:crypto';
import { readLinuxClipboardSnapshot } from './linuxClipboardNative';

/** Linux has no portable clipboard generation counter. Fingerprint only the
 * portable formats that our existing transfer path can expose, never file URLs.
 * This is called within the controlling lease, never as an application watcher. */
export async function linuxClipboardVersion(): Promise<string> {
  const snapshot = await readLinuxClipboardSnapshot();
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
export async function linuxSelection(): Promise<string> {
  const text = (await readLinuxClipboardSnapshot(true)).content.text ?? '';
  if (text.length > 16384) throw new Error('DESKTOP_CLIPBOARD_COPY_FAILED');
  return text;
}
