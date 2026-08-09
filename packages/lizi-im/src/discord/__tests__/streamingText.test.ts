import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chunkDiscordText } from '../chunk.js';
import { markdownToDiscord } from '../markdown.js';
import {
  startStreaming,
  UPDATE_THROTTLE_MS,
  type DiscordImageUploadResult,
} from '../streamingText.js';

describe('discord streaming text', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('throttles edits and coalesces appends within the window', async () => {
    const deps = makeDeps();
    const handle = await startStreaming(deps, '...');

    handle.append('a');
    handle.append('b');
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.edit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(UPDATE_THROTTLE_MS - 600);
    expect(deps.edit).toHaveBeenCalledTimes(1);
    expect(deps.edit).toHaveBeenLastCalledWith('dm-1|m1', 'ab');

    handle.append('c');
    await vi.advanceTimersByTimeAsync(UPDATE_THROTTLE_MS);
    expect(deps.edit).toHaveBeenCalledTimes(2);
    expect(deps.edit).toHaveBeenLastCalledWith('dm-1|m1', 'abc');
  });

  it('replace overwrites the streamed buffer', async () => {
    const deps = makeDeps();
    const handle = await startStreaming(deps);

    handle.append('ignored');
    handle.replace('replacement');
    await vi.advanceTimersByTimeAsync(UPDATE_THROTTLE_MS);

    expect(deps.edit).toHaveBeenCalledWith('dm-1|m1', 'replacement');
  });

  it('stops intermediate edits after the buffer exceeds 1900 chars', async () => {
    const deps = makeDeps();
    const handle = await startStreaming(deps);

    handle.replace('x'.repeat(1901));
    await vi.advanceTimersByTimeAsync(UPDATE_THROTTLE_MS);

    expect(deps.edit).not.toHaveBeenCalled();
  });

  it('swallows intermediate edit failures and retries on the next flush', async () => {
    const deps = makeDeps();
    deps.edit
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(undefined);
    const handle = await startStreaming(deps);

    handle.append('a');
    await vi.advanceTimersByTimeAsync(UPDATE_THROTTLE_MS);

    handle.append('b');
    await vi.advanceTimersByTimeAsync(UPDATE_THROTTLE_MS);

    expect(deps.edit).toHaveBeenCalledTimes(2);
    expect(deps.edit).toHaveBeenNthCalledWith(1, 'dm-1|m1', 'a');
    expect(deps.edit).toHaveBeenNthCalledWith(2, 'dm-1|m1', 'ab');
  });

  it('finalizes long text with one edit and continuation sends', async () => {
    const deps = makeDeps();
    const handle = await startStreaming(deps);

    await handle.finalize('x'.repeat(3000));

    expect(deps.edit).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(deps.edit.mock.calls[0][1].length).toBeLessThanOrEqual(2000);
    expect(deps.send.mock.calls[1][0].length).toBeLessThanOrEqual(2000);
  });

  it('finalize is idempotent', async () => {
    const deps = makeDeps();
    const handle = await startStreaming(deps);

    await handle.finalize('done');
    await handle.finalize('ignored');

    expect(deps.edit).toHaveBeenCalledTimes(1);
    expect(deps.edit).toHaveBeenCalledWith('dm-1|m1', 'done');
  });

  it('finalizes image-only markdown with non-empty edit before uploading images', async () => {
    const deps = makeDeps();
    const handle = await startStreaming(deps);

    await handle.finalize('![local](xdt-image://abc123)');

    expect(deps.resolveImageUrl).toHaveBeenCalledWith('xdt-image://abc123');
    expect(deps.edit).toHaveBeenCalledTimes(1);
    expect(deps.edit).toHaveBeenCalledWith('dm-1|m1', '🖼️');
    expect(deps.edit).not.toHaveBeenCalledWith('dm-1|m1', '');
    expect(deps.uploadImages).toHaveBeenCalledWith('dm-1|m1', ['/tmp/abc123.png']);
  });

  it('skips empty final edit when there is no text or image to send', async () => {
    const deps = makeDeps();
    const handle = await startStreaming(deps);

    await handle.finalize('');

    expect(deps.edit).not.toHaveBeenCalled();
    expect(deps.uploadImages).not.toHaveBeenCalled();
  });

  it('records successful image batches before propagating a later batch failure', async () => {
    const first = '/tmp/first.png';
    const second = '/tmp/second.png';
    const uploadError = new Error('second batch failed');
    const deps = makeDeps();
    deps.uploadImages.mockResolvedValueOnce({
      deliveredAbsPaths: [first],
      error: uploadError,
    });
    const handle = await startStreaming(deps);
    handle.addExtraImageAbsPath?.(first);
    handle.addExtraImageAbsPath?.(second);

    await expect(handle.finalize('two batches')).rejects.toBe(uploadError);
    expect(handle.getDeliveredExtraImageAbsPaths?.()).toEqual([first]);
    const delivered = handle.getDeliveredExtraImageAbsPaths?.() as string[];
    delivered.push('/tmp/injected.png');
    expect(handle.getDeliveredExtraImageAbsPaths?.()).toEqual([first]);
  });

  it('close prevents future edits', async () => {
    const deps = makeDeps();
    const handle = await startStreaming(deps);

    handle.close();
    handle.append('ignored');
    await vi.advanceTimersByTimeAsync(UPDATE_THROTTLE_MS);

    expect(deps.edit).not.toHaveBeenCalled();
  });
});

function makeDeps() {
  let next = 1;
  return {
    send: vi.fn(async (...args: [string]) => {
      void args;
      return `dm-1|m${next++}`;
    }),
    edit: vi.fn(async (...args: [string, string]) => {
      void args;
    }),
    markdownToDiscord,
    chunk: chunkDiscordText,
    resolveImageUrl: vi.fn((url: string) => `/tmp/${url.replace('xdt-image://', '')}.png`),
    uploadImages: vi.fn(async (...args: [string, string[]]): Promise<DiscordImageUploadResult> => {
      void args;
      return { deliveredAbsPaths: args[1] };
    }),
  };
}
