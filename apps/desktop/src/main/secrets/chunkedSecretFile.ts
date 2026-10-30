import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';

const HEADER = 'CINDY_COMPANION_SECRET_V2';
export const COMPANION_SECRET_CHUNK_CHARS = 64 * 1024;
interface Cipher { encrypt(value: string): Buffer; decrypt(value: Buffer): string }

/** Keep the OS safeStorage boundary, but limit every synchronous crypto call.
 * Each asynchronous file operation yields to Main. No plaintext touches disk.
 * Encrypted chunk metadata rejects reordering, truncation and cross-file mixing. */
export async function writeChunkedSecret(file: string, context: string, value: string, cipher: Cipher, assertOwner: () => void): Promise<void> {
  assertOwner();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  assertOwner();
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${HEADER}\n`);
    const batch = randomUUID();
    const count = Math.max(1, Math.ceil(value.length / COMPANION_SECRET_CHUNK_CHARS));
    for (let index = 0; index < count; index++) {
      assertOwner();
      const text = value.slice(index * COMPANION_SECRET_CHUNK_CHARS, (index + 1) * COMPANION_SECRET_CHUNK_CHARS);
      const encrypted = cipher.encrypt(JSON.stringify([batch, context, index, count, text]));
      await handle.writeFile(`${encrypted.toString('base64')}\n`);
    }
    await handle.sync();
    await handle.close();
    assertOwner();
    await fs.rename(temporary, file);
    assertOwner();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
  }
}

export async function readChunkedSecret(file: string, context: string, cipher: Cipher, assertOwner: () => void): Promise<string | null> {
  assertOwner();
  // The old format remains readable. Its one-time legacy decryption is still
  // synchronous; the next normal write uses bounded chunks automatically.
  let handle;
  try { handle = await fs.open(file, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const stream = handle.createReadStream({ autoClose: false });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let first = true; let batch: string | undefined; let expected = 0;
    const values: string[] = [];
    for await (const line of lines) {
      assertOwner();
      if (first) {
        first = false;
        if (line !== HEADER) {
          // Legacy files are a single base64 line. Do not lose compatibility.
          const result = cipher.decrypt(Buffer.from(line, 'base64'));
          assertOwner(); return result;
        }
        continue;
      }
      if (line.length > 1024 * 1024) throw new Error('Invalid companion credential chunk');
      let chunk: unknown;
      try { chunk = JSON.parse(cipher.decrypt(Buffer.from(line, 'base64'))); }
      catch { throw new Error('Invalid companion credential chunk'); }
      if (!Array.isArray(chunk) || chunk.length !== 5 || typeof chunk[0] !== 'string' || chunk[1] !== context
        || chunk[2] !== values.length || !Number.isSafeInteger(chunk[3]) || chunk[3] < 1 || chunk[3] > 32768
        || typeof chunk[4] !== 'string' || chunk[4].length > COMPANION_SECRET_CHUNK_CHARS
        || batch !== undefined && (chunk[0] !== batch || chunk[3] !== expected)) throw new Error('Invalid companion credential chunk');
      batch = chunk[0]; expected = chunk[3]; values.push(chunk[4]);
      // readline can buffer multiple lines; explicitly yield between decryptions.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (batch === undefined || values.length !== expected) throw new Error('Incomplete companion credential file');
    assertOwner(); return values.join('');
  } finally { lines.close(); stream.destroy(); await handle.close(); }
}
