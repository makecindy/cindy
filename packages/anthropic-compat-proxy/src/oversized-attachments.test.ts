import { mkdtemp, readFile, rm, writeFile, access, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectRecoverableBody, recoverInlineAttachments as recover, type RecoveredAttachment } from './oversized-attachments.js';

const recoverInlineAttachments = (body: Parameters<typeof recover>[0], limit: number, prepare: (a: RecoveredAttachment) => Promise<string>) =>
  recover(body, limit, { prepare, commit: async () => {} });

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(value: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), 'attachment-test-'));
  dirs.push(dir);
  const filePath = path.join(dir, 'body.json');
  const raw = Buffer.from(JSON.stringify(value));
  await writeFile(filePath, raw);
  return { dir, raw, body: { filePath, bytes: raw.length, signal: new AbortController().signal } };
}
const data = Buffer.alloc(90_000, 0x78);
const url = `data:image/png;base64,${data.toString('base64')}`;
const image = () => ({ type: 'input_image', image_url: url });

describe('overflow-only attachment recovery', () => {
  it('does not touch bytes or invoke recovery at or below the limit', async () => {
    const raw = Buffer.from(JSON.stringify({ input: Array.from({ length: 70 }, image) }));
    const keep = vi.fn();
    const actual = await collectRecoverableBody(Readable.from([raw]) as IncomingMessage, raw.length, keep, new AbortController().signal);
    expect(actual.equals(raw)).toBe(true);
    expect(keep).not.toHaveBeenCalled();
  });

  it('preserves the oldest attachment before replacing it and retains recent images and tool pairing', async () => {
    const value = { input: [
      { type: 'function_call', call_id: 'one', name: 'imagegen', arguments: '{}' },
      { type: 'function_call_output', call_id: 'one', output: [image(), { type: 'input_text', text: 'original /tmp/work.png' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Compare these' }, image()] },
    ] };
    const f = await fixture(value);
    // Backslashes need JSON decoding even when this test runs on a POSIX host.
    const savedPath = path.join(f.dir, 'saved\\nested', 'saved.png');
    await mkdir(path.dirname(savedPath), { recursive: true });
    const saved: Buffer[] = [];
    const result = await recoverInlineAttachments(f.body, f.raw.length - 1, async a => {
      saved.push(await readFile(a.filePath));
      await copyFile(a.filePath, savedPath);
      return savedPath;
    });
    expect(saved).toEqual([data]);
    const parsed = JSON.parse(result!.toString());
    expect(parsed.input[0]).toEqual(value.input[0]);
    expect(parsed.input[1].call_id).toBe('one');
    expect(parsed.input[1].output[0]).toMatchObject({ type: 'input_text' });
    const preservedPath = parsed.input[1].output[0].text.match(/Preserved local file: (.+)\. Read the file/);
    expect(preservedPath).not.toBeNull();
    const localPath = JSON.parse(preservedPath![1]);
    expect(localPath).toBe(savedPath);
    expect(await readFile(localPath)).toEqual(data);
    expect(parsed.input[1].output[1]).toEqual(value.input[1].output![1]);
    expect(parsed.input[2]).toEqual(value.input[2]);
    expect(await readFile(f.body.filePath)).toEqual(f.raw);
  });

  it.each([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } },
    { type: 'input_file', filename: 'report.pdf', file_data: `data:application/pdf;base64,${data.toString('base64')}` },
    { type: 'file', file: { filename: 'report.pdf', file_data: data.toString('base64') } },
    { type: 'image_url', image_url: { url } },
    { type: 'input_audio', input_audio: { data: data.toString('base64'), format: 'wav' } },
    { type: 'video_url', video_url: { url: `data:video/mp4;base64,${data.toString('base64')}` } },
  ])('handles attachment blocks in nested tool results: $type', async block => {
    const f = await fixture({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: [block] }] }] });
    const keep = vi.fn(async (a: RecoveredAttachment) => {
      expect(await readFile(a.filePath)).toEqual(data);
      return path.join(f.dir, 'retained');
    });
    const result = await recoverInlineAttachments(f.body, 1000, keep);
    const parsed = JSON.parse(result!.toString());
    expect(parsed.messages[0].content[0].tool_use_id).toBe('one');
    expect(parsed.messages[0].content[0].content[0].text).toContain('retained');
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it('restores large untouched text, JSON escapes and Unicode exactly', async () => {
    const text = `${'文\\"\n'.repeat(30_000)} tail`;
    const value = { instructions: text, input: [{ role: 'user', content: [{ type: 'input_text', text }, image()] }] };
    const f = await fixture(value);
    const result = await recoverInlineAttachments(f.body, f.raw.length - 1, async () => '/tmp/retained');
    const parsed = JSON.parse(result!.toString());
    expect(parsed.instructions).toBe(text);
    expect(parsed.input[0].content[0].text).toBe(text);
  });

  it('does not discard text or tool schemas to make an unfixable request fit', async () => {
    const f = await fixture({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(300_000) }] }] });
    const keep = vi.fn();
    expect(await recoverInlineAttachments(f.body, 1000, keep)).toBeNull();
    expect(keep).not.toHaveBeenCalled();
  });

  it('refuses malformed base64 without dropping the original', async () => {
    const f = await fixture({ input: [{ role: 'user', content: [{ ...image(), image_url: `${url}???` }] }] });
    const keep = vi.fn();
    await expect(recoverInlineAttachments(f.body, 1000, keep)).rejects.toThrow('base64');
    expect(keep).not.toHaveBeenCalled();
    expect(await readFile(f.body.filePath)).toEqual(f.raw);
  });

  it('decodes padding split across read chunks', async () => {
    // Header + base64 has its two padding bytes on either side of the 64 KiB boundary.
    const header = 'data:image/x-webp;base64,';
    const bytes = Buffer.alloc(98_284, 1);
    const padded = `${header}${bytes.toString('base64')}`;
    expect(padded.indexOf('=') % 65536).toBe(65535);
    const f = await fixture({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: padded }] }] });
    await recoverInlineAttachments(f.body, 1000, async a => {
      expect(await readFile(a.filePath)).toEqual(bytes);
      return '/tmp/retained';
    });
  });

  it('cleans spilled request files on persistence failure', async () => {
    const raw = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [image()] }] }));
    let spilled = '';
    await expect(collectRecoverableBody(Readable.from([raw.subarray(0, 10), raw.subarray(10)]) as IncomingMessage, 1000, async body => {
      spilled = body.filePath;
      return recoverInlineAttachments(body, 1000, async () => { throw new Error('disk full'); });
    }, new AbortController().signal)).rejects.toThrow('disk full');
    await expect(access(spilled)).rejects.toThrow();
  });

  it('stops on cancellation after preservation instead of dispatching partial recovery', async () => {
    const f = await fixture({ input: [{ role: 'user', content: [image()] }] });
    const abort = new AbortController();
    await expect(recoverInlineAttachments({ ...f.body, signal: abort.signal }, 1000, async () => {
      abort.abort();
      return '/tmp/retained';
    })).rejects.toThrow();
    expect(await readFile(f.body.filePath)).toEqual(f.raw);
  });
});

it('recovers many small attachments only after their aggregate request overflows', async () => {
  const small = Buffer.alloc(1024, 7);
  const block = { type: 'input_image', image_url: `data:image/png;base64,${small.toString('base64')}` };
  const f = await fixture({ input: [{ role: 'user', content: Array.from({ length: 70 }, () => block) }] });
  const prepare = vi.fn(async (a: RecoveredAttachment) => { expect(await readFile(a.filePath)).toEqual(small); return '/tmp/small.png'; });
  const commit = vi.fn(async () => {});
  const result = await recover(f.body, 30_000, { prepare, commit });
  expect(result!.length).toBeLessThanOrEqual(30_000);
  const content = JSON.parse(result!.toString()).input[0].content;
  expect(content[0].type).toBe('input_text');
  expect(content.at(-1)).toEqual(block);
  expect(commit).toHaveBeenCalledOnce();
});

it('keeps URL attachments intact while recovering inline small attachments', async () => {
  const remote = { type: 'input_image', image_url: 'https://example.test/image.png' };
  const f = await fixture({ input: [remote, image()] });
  const result = await recoverInlineAttachments(f.body, 1000, async () => '/tmp/kept');
  expect(JSON.parse(result!.toString()).input[0]).toEqual(remote);
});

it('does not commit staged files when the recovered request still cannot fit', async () => {
  const f = await fixture({ instructions: 'x'.repeat(100_000), input: [image()] });
  const commit = vi.fn();
  expect(await recover(f.body, 1000, { prepare: async () => '/tmp/kept', commit })).toBeNull();
  expect(commit).not.toHaveBeenCalled();
});
