/**
 * Unit: the production line reader and DSH adapter must read appended zstd frames.
 * A header-only first frame reproduced a missing session and silent history loss.
 * Synthetic temporary files also cover checksum, truncation and skippable frames.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
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
    // Bit 4 of the frame descriptor is Unused_bit: decoders must ignore it, so
    // history carrying it still has to import. Bit 3 is Reserved_bit.
    const unusedBit = Buffer.from(bytes); unusedBit[4]! |= 0x10;
    await writeFile(file, unusedBit);
    expect(await read()).toBe('first\nsecond\n');
    const reservedBit = Buffer.from(bytes); reservedBit[4]! |= 0x08;
    await writeFile(file, reservedBit);
    await expect(read()).rejects.toThrow('Invalid Zstandard frame descriptor');
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
    // DSH_HOME takes priority over homeDir, so an inherited value would point the
    // scan at another directory (possibly the developer's real history).
    vi.stubEnv('DSH_HOME', path.join(home, '.dsh'));
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
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

// Regression: reading a prefix must not read the whole frame, or the scan pays
// the full history size just to see a first line or a 512 KiB summary.
it('stops reading a large frame once the consumer stops', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-zstd-prefix-'));
  const file = path.join(dir, 'sample.zstd');
  const block = 64 * 1024;
  const blocks = 64; // 4 MiB of raw blocks in one frame
  try {
    // Single-segment frame declaring its 4 MiB content size in four bytes.
    const contentSize = Buffer.alloc(4);
    contentSize.writeUInt32LE(block * blocks);
    const parts: Buffer[] = [Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0]), contentSize];
    for (let i = 0; i < blocks; i += 1) {
      const header = (block << 3) | (i === blocks - 1 ? 1 : 0);
      parts.push(Buffer.from([header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff]));
      parts.push(Buffer.alloc(block, 0x61 + (i % 26)));
    }
    const bytes = Buffer.concat(parts);
    await writeFile(file, bytes);

    let read = 0;
    for await (const chunk of readZstdFrames(file, (n) => { read += n; })) {
      expect((chunk as Buffer).length).toBeGreaterThan(0);
      break;
    }
    // The whole frame is 4 MiB; a prefix read must stay near one block plus
    // decoder buffering instead of walking every block header first.
    expect(read).toBeLessThan(1024 * 1024);

    const all = [];
    for await (const chunk of readZstdFrames(file)) all.push(chunk as Buffer);
    expect(Buffer.concat(all).length).toBe(block * blocks);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);

// Regression: closing a prefix consumer must stop the frame read, not leave a
// prefetched read draining the rest of the frame in the background.
it('stops reading after a prefix consumer closes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-zstd-close-'));
  const file = path.join(dir, 'sample.zstd');
  try {
    const head = Buffer.from(JSON.stringify({ type: 'session', id: 'close-test', version: 4 }) + '\n');
    const contentSize = Buffer.alloc(4);
    contentSize.writeUInt32LE(head.length);
    const blockHeader = head.length << 3;
    const empty = Buffer.alloc(2_000_000 * 3); // ~6 MB of empty blocks after the text
    await writeFile(file, Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0]),
      contentSize,
      Buffer.from([blockHeader & 0xff, (blockHeader >>> 8) & 0xff, (blockHeader >>> 16) & 0xff]),
      head,
      empty,
      Buffer.from([1, 0, 0]),
    ]));

    let bytes = 0;
    for await (const line of readLines(file, { concatenatedZstd: true, onBytes: (n) => { bytes += n; } })) {
      expect(line).toContain('session');
      break;
    }
    const atClose = bytes;
    expect(atClose).toBeLessThan(512 * 1024);
    // real-wait: a leaked frame read only appears once the pending file read settles
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(bytes - atClose).toBeLessThanOrEqual(128 * 1024);
    expect(bytes).toBeLessThan(1024 * 1024);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);

// Regression: a small frame with many empty blocks must not stall session discovery.
it('reads a frame with many tiny blocks within the scan budget', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-zstd-blocks-'));
  const file = path.join(dir, 'sample.zstd');
  try {
    // Single-segment frame with a five-byte raw block followed by 200,000 empty blocks.
    const prefix = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 5, 0x28, 0, 0, ...Buffer.from('test\n')]);
    const empty = Buffer.alloc(200_000 * 3);
    const last = Buffer.from([1, 0, 0]);
    await writeFile(file, Buffer.concat([prefix, empty, last]));
    const lines = [];
    for await (const line of readLines(file, { concatenatedZstd: true })) lines.push(line);
    expect(lines).toEqual(['test']);
    const controller = new AbortController();
    controller.abort();
    const cancelled = [];
    for await (const line of readLines(file, { concatenatedZstd: true, signal: controller.signal })) cancelled.push(line);
    expect(cancelled).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 5000);
