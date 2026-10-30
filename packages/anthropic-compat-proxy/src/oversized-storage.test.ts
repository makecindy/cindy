import { statfs, access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { collectRecoverableBody } from './oversized-attachments.js';
import { createAnthropicCompatProxy } from './server.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
const disk = vi.mocked(statfs);
const reserve = 256 * 1024 * 1024;
const free = (bytes: number) => ({ bavail: reserve + bytes, bsize: 1 }) as Awaited<ReturnType<typeof statfs>>;
afterEach(() => { disk.mockReset(); });
const request = (chunks: Buffer[]) => Readable.from(chunks) as IncomingMessage;

it('does not check disk or change normal requests on a full disk', async () => {
  disk.mockResolvedValue(free(0));
  const raw = Buffer.alloc(100);
  const recover = vi.fn();
  expect(await collectRecoverableBody(request([raw]), 100, recover, new AbortController().signal)).toEqual(raw);
  expect(disk).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
});

it('stops chunked upload as available temporary storage runs out', async () => {
  disk.mockResolvedValueOnce(free(2000)).mockResolvedValue(free(0));
  const recover = vi.fn();
  await expect(collectRecoverableBody(request([Buffer.alloc(200), Buffer.alloc(200)]), 100, recover, new AbortController().signal)).rejects.toThrow('RECOVERY_STORAGE_EXHAUSTED');
  expect(recover).not.toHaveBeenCalled();
  // A failed upload releases its reservation for the next attempt.
  disk.mockResolvedValue(free(800));
  expect(await collectRecoverableBody(request([Buffer.alloc(200)]), 100, async () => Buffer.from('{}'), new AbortController().signal)).toEqual(Buffer.from('{}'));
});

it('accounts for simultaneous recovery and releases files and budget on completion', async () => {
  disk.mockResolvedValue(free(1000));
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  let spilled = '';
  const first = collectRecoverableBody(request([Buffer.alloc(200)]), 100, async body => {
    spilled = body.filePath;
    arrived();
    await hold;
    return Buffer.from('{}');
  }, new AbortController().signal);
  await started;
  try {
    await expect(collectRecoverableBody(request([Buffer.alloc(200)]), 100, async () => Buffer.from('{}'), new AbortController().signal)).rejects.toThrow('RECOVERY_STORAGE_EXHAUSTED');
  } finally { release(); await first; }
  await expect(access(spilled)).rejects.toThrow();
  expect(await collectRecoverableBody(request([Buffer.alloc(200)]), 100, async () => Buffer.from('{}'), new AbortController().signal)).toEqual(Buffer.from('{}'));
});

it('returns an actionable HTTP error without forwarding when recovery storage is unavailable', async () => {
  disk.mockResolvedValue(free(0));
  const recover = vi.fn();
  const local = vi.fn();
  const proxy = await createAnthropicCompatProxy({ upstream: 'http://127.0.0.1:1', maxRequestBodyBytes: 100,
    oversizedRequestRecovery: () => recover, routingTransform: () => ({ localHandler: local }) });
  try {
    const response = await fetch(`${proxy.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'x'.repeat(1000) }) });
    expect(response.status).toBe(507);
    expect(await response.json()).toMatchObject({ error: { reason: 'attachment_recovery_storage_exhausted' } });
    expect(local).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  } finally { await proxy.dispose(); }
});


it('reserves allocation overhead for decoded files and releases it when recovery fails', async () => {
  disk.mockResolvedValue(free(800));
  await expect(collectRecoverableBody(request([Buffer.alloc(200)]), 100, async body => {
    await body.reserveAttachment!();
    return Buffer.from('{}');
  }, new AbortController().signal)).rejects.toThrow('RECOVERY_STORAGE_EXHAUSTED');
  disk.mockResolvedValue(free(802));
  expect(await collectRecoverableBody(request([Buffer.alloc(200)]), 100, async body => {
    await body.reserveAttachment!();
    return Buffer.from('{}');
  }, new AbortController().signal)).toEqual(Buffer.from('{}'));
});
