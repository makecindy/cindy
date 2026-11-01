import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { gunzipBase64Worklet } from './gunzipBase64Worklet';
import { createOffThreadGunzip, gzipUncompressedSizeHint } from './gunzipOffThread';

const base64 = (text: string) => gzipSync(Buffer.from(text, 'utf8')).toString('base64');
const LARGE = base64('{"手机":"回到前台"}'.repeat(100));

describe('createOffThreadGunzip', () => {
  it('decodes small results in place without creating a runtime', async () => {
    const createSchedule = vi.fn(() => null);
    const gunzip = createOffThreadGunzip({ createSchedule, minBase64Chars: 1_000_000 });
    await expect(gunzip(LARGE, 10_000)).resolves.toContain('回到前台');
    expect(createSchedule).not.toHaveBeenCalled();
  });

  it('routes by inflated size, so a small repetitive payload still leaves the JS thread', async () => {
    const small = base64('{"row":"same"}'.repeat(40_000));
    expect(small.length).toBeLessThan(64 * 1024);
    expect(gzipUncompressedSizeHint(small)).toBe('{"row":"same"}'.length * 40_000);
    const decodeOnThread = vi.fn(() => 'wrong');
    const gunzip = createOffThreadGunzip({
      decodeOnThread,
      createSchedule: () => (input, limit, done) => done(gunzipBase64Worklet(input, limit)),
    });
    await expect(gunzip(small, 4 * 1024 * 1024)).resolves.toHaveLength('{"row":"same"}'.length * 40_000);
    expect(decodeOnThread).not.toHaveBeenCalled();
  });

  it('has no size hint for input that is not a gzip trailer', () => {
    expect(gzipUncompressedSizeHint('abc')).toBeNull();
    expect(gzipUncompressedSizeHint('@@@@@@@@@@@@')).toBeNull();
  });

  it('runs large results on the runtime and never touches the on-thread decoder', async () => {
    const decodeOnThread = vi.fn(() => 'wrong');
    const gunzip = createOffThreadGunzip({
      minBase64Chars: 1,
      decodeOnThread,
      createSchedule: () => (input, limit, done) => done(gunzipBase64Worklet(input, limit)),
    });
    await expect(gunzip(LARGE, 10_000)).resolves.toContain('回到前台');
    expect(decodeOnThread).not.toHaveBeenCalled();
  });

  it('creates one runtime across results', async () => {
    const createSchedule = vi.fn(() => (input: string, limit: number, done: (r: ReturnType<typeof gunzipBase64Worklet>) => void) =>
      done(gunzipBase64Worklet(input, limit)));
    const gunzip = createOffThreadGunzip({ minBase64Chars: 1, createSchedule });
    await gunzip(LARGE, 10_000);
    await gunzip(LARGE, 10_000);
    expect(createSchedule).toHaveBeenCalledTimes(1);
  });

  it('falls back when the runtime is unavailable', async () => {
    const gunzip = createOffThreadGunzip({ minBase64Chars: 1, createSchedule: () => null });
    await expect(gunzip(LARGE, 10_000)).resolves.toContain('回到前台');
  });

  it('falls back when scheduling throws', async () => {
    const gunzip = createOffThreadGunzip({
      minBase64Chars: 1,
      createSchedule: () => () => { throw new Error('runtime gone'); },
    });
    await expect(gunzip(LARGE, 10_000)).resolves.toContain('回到前台');
  });

  it('falls back when the worklet decoder fails unexpectedly', async () => {
    const gunzip = createOffThreadGunzip({
      minBase64Chars: 1,
      createSchedule: () => (_input, _limit, done) => done({ ok: false, limitExceeded: false, message: 'bug' }),
    });
    await expect(gunzip(LARGE, 10_000)).resolves.toContain('回到前台');
  });

  it('stops using a runtime that went silent', async () => {
    const run = vi.fn();
    const gunzip = createOffThreadGunzip({ minBase64Chars: 1, timeoutMs: 1, createSchedule: () => run });
    await expect(gunzip(LARGE, 10_000)).resolves.toContain('回到前台');
    await expect(gunzip(LARGE, 10_000)).resolves.toContain('回到前台');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps the size limit as a failure rather than retrying on the JS thread', async () => {
    const decodeOnThread = vi.fn(() => 'expanded');
    const gunzip = createOffThreadGunzip({
      minBase64Chars: 1,
      decodeOnThread,
      createSchedule: () => (input, limit, done) => done(gunzipBase64Worklet(input, limit)),
    });
    await expect(gunzip(base64('a'.repeat(100_000)), 10)).rejects.toThrow(RangeError);
    expect(decodeOnThread).not.toHaveBeenCalled();
  });
});
