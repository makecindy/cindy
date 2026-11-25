/**
 * Unit: the production line reader and DSH adapter must read appended zstd frames.
 * A header-only first frame reproduced a missing session and silent history loss.
 * Synthetic temporary files also cover checksum, truncation and skippable frames.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { readZstdFrames } from '../zstdFrames';
import { readLines } from '../lineReader';
import { deepseekAdapter } from '../sources/deepseek';

it('reads every frame and rejects corrupt or truncated input', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-zstd-'));
  const file = path.join(dir, 'sample.zstd');
  const frame = (s: string) => zstdCompressSync(Buffer.from(s), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const bytes = Buffer.concat([frame('first\n'), frame('second\n')]);
  const read = async () => { const chunks: Buffer[] = []; for await (const chunk of readZstdFrames(file)) chunks.push(chunk); return Buffer.concat(chunks).toString(); };
  try {
    await writeFile(file, bytes);
    expect(await read()).toBe('first\nsecond\n');
    const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1]! ^= 1;
    await writeFile(file, corrupt);
    await expect(read()).rejects.toThrow();
    const readAllLines = async () => { for await (const line of readLines(file, { concatenatedZstd: true })) { void line; } };
    await expect(readAllLines()).rejects.toThrow();
    await writeFile(file, bytes.subarray(0, bytes.length - 1));
    await expect(read()).rejects.toThrow();
    await writeFile(file, Buffer.concat([bytes, Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]), frame('third\n')]));
    expect(await read()).toBe('first\nsecond\nthird\n');
    await writeFile(file, Buffer.concat([bytes, Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1])]));
    await expect(read()).rejects.toThrow();
    // A skippable frame claiming >1 GiB must fail without allocating its payload.
    await writeFile(file, Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x01, 0x00, 0x00, 0x40]));
    await expect(read()).rejects.toThrow('Invalid Zstandard skippable frame');
    // Reserved block type is invalid even when it is marked as the last block.
    await writeFile(file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x07, 0x00, 0x00]));
    await expect(read()).rejects.toThrow('Invalid Zstandard block');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('scans and reads messages across appended DeepSeek frames', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cindy-dsh-'));
  const dir = path.join(home, '.dsh/sessions/project/example');
  const frame = (x: object) => zstdCompressSync(Buffer.from(JSON.stringify(x) + '\n'));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
      frame({ type: 'session', id: 'test', version: 4 }),
      frame({ type: 'user/message', seq: 1, data: { content: 'question' } }),
      frame({ type: 'assistant/message', seq: 2, data: { content: 'answer' } }),
    ]));
    const listed = await deepseekAdapter.list({ homeDir: home, cindyUserDataDir: null });
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]!.title).toBe('question');
    const messages = [];
    for await (const message of deepseekAdapter.read(listed.sessions[0]!, { cindySessionId: 'test' })) messages.push(message.content);
    expect(messages).toEqual(['question', 'answer']);
  } finally { await rm(home, { recursive: true, force: true }); }
});
