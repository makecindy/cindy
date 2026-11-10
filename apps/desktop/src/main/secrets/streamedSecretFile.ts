import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const HEADER = 'CINDY_COMPANION_RESOURCE_V1';
export const RESOURCE_CHUNK_CHARS = 64 * 1024;
interface Cipher { encrypt(value: string): Buffer; decrypt(value: Buffer): string }

/** OS-encrypted records with a terminal digest. Only ciphertext is staged;
 * consumers must exhaust the iterator before publishing their output. */
export async function writeStreamedSecret(file: string, context: string, input: AsyncIterable<string>, cipher: Cipher, assertOwner: () => void): Promise<string> {
  assertOwner();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${HEADER}\n`);
    const batch = randomUUID(), hash = createHash('sha256');
    let index = 0;
    const write = async (text: string | null, digest?: string) => {
      assertOwner();
      const record = cipher.encrypt(JSON.stringify([batch, context, index++, text, digest ?? null]));
      await handle.writeFile(record.toString('base64') + '\n');
    };
    for await (const text of input) {
      if (text.length > RESOURCE_CHUNK_CHARS) throw new Error('Invalid companion resource record');
      hash.update(JSON.stringify(text));
      await write(text);
    }
    const digest = hash.digest('hex');
    await write(null, digest);
    await handle.sync(); await handle.close(); assertOwner();
    await fs.rename(temporary, file); assertOwner();
    return digest;
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
  }
}

/** Bound even malformed ciphertext lines; readline alone can buffer an entire
 * corrupted file before a caller gets a chance to validate its line length. */
async function* lines(file: string): AsyncGenerator<string> {
  const handle = await fs.open(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let pending = '';
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      pending += buffer.subarray(0, bytesRead).toString('ascii');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        if (end > 1024 * 1024) throw new Error('Invalid companion resource record');
        yield pending.slice(0, end); pending = pending.slice(end + 1);
      }
      if (pending.length > 1024 * 1024) throw new Error('Invalid companion resource record');
    }
    if (pending) throw new Error('Incomplete companion resource');
  } finally { await handle.close(); }
}

export async function* readStreamedSecret(file: string, context: string, expectedDigest: string, cipher: Cipher, assertOwner: () => void): AsyncGenerator<string> {
  let first = true, complete = false, index = 0, batch: string | undefined;
  const hash = createHash('sha256');
  for await (const line of lines(file)) {
    assertOwner();
    if (first) { first = false; if (line !== HEADER) throw new Error('Invalid companion resource'); continue; }
    if (complete) throw new Error('Invalid companion resource trailing data');
    let record: unknown;
    try { record = JSON.parse(cipher.decrypt(Buffer.from(line, 'base64'))); }
    catch { throw new Error('Invalid companion resource record'); }
    if (!Array.isArray(record) || record.length !== 5 || typeof record[0] !== 'string' || record[1] !== context || record[2] !== index++
      || batch !== undefined && record[0] !== batch) throw new Error('Invalid companion resource record');
    batch = record[0];
    if (record[3] === null) {
      if (record[4] !== expectedDigest || hash.digest('hex') !== expectedDigest) throw new Error('Invalid companion resource digest');
      complete = true;
    } else {
      if (typeof record[3] !== 'string' || record[3].length > RESOURCE_CHUNK_CHARS || record[4] !== null) throw new Error('Invalid companion resource record');
      hash.update(JSON.stringify(record[3]));
      yield record[3];
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assertOwner();
  if (!complete) throw new Error('Incomplete companion resource');
}
