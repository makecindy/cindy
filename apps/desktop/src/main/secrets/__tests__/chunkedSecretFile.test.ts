import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { COMPANION_SECRET_CHUNK_CHARS, readChunkedSecret, writeChunkedSecret } from '../chunkedSecretFile.js';
let root: string;
const key = randomBytes(32);
const cipher = {
  encrypt: (text: string) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
  decrypt: (bytes: Buffer) => { const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); d.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString('utf8'); },
};
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-chunked-secret-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('yields between bounded crypto calls, preserves unicode and stores no plaintext', async () => {
  const file = path.join(root, 'private.enc');
  const value = 'fixture-only-secret 文🦊'.repeat(100000);
  const encrypt = vi.fn(cipher.encrypt);
  let ticked = false;
  setImmediate(() => { ticked = true; });
  await writeChunkedSecret(file, 'owner-bot', value, { ...cipher, encrypt }, () => {});
  expect(ticked).toBe(true); expect(encrypt.mock.calls.length).toBeGreaterThan(10);
  expect(Math.max(...encrypt.mock.calls.map(([text]) => text.length))).toBeLessThan(COMPANION_SECRET_CHUNK_CHARS + 256);
  expect(await fs.readFile(file, 'utf8')).not.toContain('fixture-only-secret');
  expect(await readChunkedSecret(file, 'owner-bot', cipher, () => {})).toBe(value);
  expect(await fs.readdir(root)).toEqual(['private.enc']);
});
it('reads old single-value ciphertext and upgrades on the next write', async () => {
  const file = path.join(root, 'legacy.enc');
  await fs.writeFile(file, cipher.encrypt('old fixture').toString('base64'));
  expect(await readChunkedSecret(file, 'owner-bot', cipher, () => {})).toBe('old fixture');
  await writeChunkedSecret(file, 'owner-bot', 'new fixture', cipher, () => {});
  expect(await readChunkedSecret(file, 'owner-bot', cipher, () => {})).toBe('new fixture');
  expect(await readChunkedSecret(path.join(root, 'absent.enc'), 'owner-bot', cipher, () => {})).toBeNull();
});
it.each(['truncate', 'reorder', 'context', 'mix'] as const)('rejects %s without returning partial plaintext', async (kind) => {
  const file = path.join(root, 'private.enc');
  const second = path.join(root, 'second.enc');
  const value = 'fixture-'.repeat(20000);
  await writeChunkedSecret(file, 'owner-bot', value, cipher, () => {});
  const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
  if (kind === 'truncate') lines.pop();
  if (kind === 'reorder') [lines[1], lines[2]] = [lines[2]!, lines[1]!];
  if (kind === 'mix') {
    await writeChunkedSecret(second, 'owner-bot', value, cipher, () => {});
    lines[2] = (await fs.readFile(second, 'utf8')).split('\n')[2]!;
  }
  await fs.writeFile(file, lines.join('\n') + '\n');
  await expect(readChunkedSecret(file, kind === 'context' ? 'another-owner' : 'owner-bot', cipher, () => {})).rejects.toThrow();
});
it('retains the last committed value and removes temporary ciphertext on owner loss', async () => {
  const file = path.join(root, 'private.enc');
  await writeChunkedSecret(file, 'owner-bot', 'previous fixture', cipher, () => {});
  let calls = 0;
  await expect(writeChunkedSecret(file, 'owner-bot', 'x'.repeat(300000), cipher, () => { if (++calls === 5) throw new Error('owner changed'); })).rejects.toThrow('owner changed');
  expect(await readChunkedSecret(file, 'owner-bot', cipher, () => {})).toBe('previous fixture');
  expect(await fs.readdir(root)).toEqual(['private.enc']);
});
