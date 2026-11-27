import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/** HEVC still-image brands in the ISO BMFF file-type box, independent of the transfer name. */
export function isHeicPhoto(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = header.readUInt32BE(0);
  if (size < 16 || size > bytes.length || size > 4096 || size % 4 || header.toString('latin1', 4, 8) !== 'ftyp') return false;
  for (let offset = 8; offset < size; offset += 4) {
    if (offset !== 12 && ['heic', 'heix', 'heim', 'heis'].includes(header.toString('latin1', offset, offset + 4))) return true;
  }
  return false;
}

/** Decode from a private file with a known extension, even when the bridge mislabeled the photo. */
export async function localHeicPreview(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (process.platform !== 'darwin') return null;
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'cindy-imessage-'));
  try {
    const source = path.join(dir, 'original.heic');
    const preview = path.join(dir, 'preview.jpg');
    await fs.writeFile(source, bytes, { mode: 0o600 });
    try {
      await promisify(execFile)('/usr/bin/sips', ['-Z', '1600', '-s', 'format', 'jpeg', source, '--out', preview],
        { timeout: 15_000, maxBuffer: 64 * 1024 });
    } catch { return null; }
    // Some sips versions exit successfully without writing an image on a decode error.
    return await fs.readFile(preview).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
