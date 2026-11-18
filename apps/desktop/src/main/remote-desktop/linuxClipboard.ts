import { createHash } from 'node:crypto';
import { readLinuxClipboardSnapshot } from './linuxClipboardNative';

/** Linux has no portable clipboard generation counter. Fingerprint only the
 * portable formats that our existing transfer path can expose, never file URLs.
 * This is called within the controlling lease, never as an application watcher. */
export async function linuxClipboardVersion(): Promise<string> {
  const snapshot = await readLinuxClipboardSnapshot();
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  // Existing Desktop/Mobile sync accepts decimal generation strings. Preserve
  // all 256 fingerprint bits; Number would lose precision and miss changes.
  return BigInt(`0x${digest}`).toString(10);
}
export async function linuxSelection(): Promise<string> {
  const text = (await readLinuxClipboardSnapshot(true)).content.text ?? '';
  if (text.length > 16384) throw new Error('DESKTOP_CLIPBOARD_COPY_FAILED');
  return text;
}
