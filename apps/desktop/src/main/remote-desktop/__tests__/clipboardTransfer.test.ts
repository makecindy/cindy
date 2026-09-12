import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_CHUNK_CHARS, type RemoteClipboardContent } from '@cindy/device-link';
import { ClipboardTransfer } from '../clipboardTransfer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('clipboard transfer idle expiry', () => {
  it('returns small copies inline only when requested, and keeps large copies chunked', async () => {
    const buffer = new ClipboardTransfer();
    const current = () => true;
    const request = {
      op: 'clipboardContent' as const,
      lease: 'lease',
      action: 'copy' as const,
      sync: true,
      inline: true,
      version: '1',
    };
    const result = await buffer.handle(request, current, async () => ({ text: 'hello' }));
    expect(result).toEqual({ data: '{"text":"hello"}', length: 16 });
    expect(vi.getTimerCount()).toBe(0);
    const large = (await buffer.handle(request, current, async () => ({
      text: 'x'.repeat(CLIPBOARD_CHUNK_CHARS),
    }))) as { id: string };
    expect(large.id).toBeTruthy();
    buffer.reset();
    const legacy = (await buffer.handle({ ...request, inline: undefined }, current, async () => ({
      text: 'hello',
    }))) as { id: string };
    expect(legacy.id).toBeTruthy();
    buffer.reset();
  });
  it('passes the expected version through inline writes and rejects stale completion', async () => {
    const buffer = new ClipboardTransfer();
    let current = true;
    const check = () => current;
    const request = {
      op: 'clipboardContent' as const,
      lease: 'lease',
      action: 'paste' as const,
      sync: true,
      version: '1',
      data: '{"text":"hello"}',
    };
    const transfer = vi.fn(async () => ({ version: '2' }));
    expect(await buffer.handle(request, check, transfer)).toEqual({ version: '2' });
    expect(transfer).toHaveBeenCalledWith('paste', { text: 'hello' }, check, request);
    await expect(
      buffer.handle(request, check, async () => {
        current = false;
        return { version: '3' };
      }),
    ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  });
  it.each(['copy', 'paste'] as const)(
    'keeps %s progressing beyond one minute and settles only once',
    async (direction) => {
      const content = { text: 'x'.repeat(CLIPBOARD_CHUNK_CHARS * 2) };
      const data = JSON.stringify(content);
      const transfer = vi.fn(
        async (_action: 'copy' | 'paste', _content?: RemoteClipboardContent) => content,
      );
      const current = () => true;
      const buffer = new ClipboardTransfer();
      const common = { op: 'clipboardContent' as const, lease: 'lease' };
      const { id } = (await buffer.handle(
        direction === 'copy'
          ? { ...common, action: 'copy' }
          : { ...common, action: 'begin', length: data.length },
        current,
        transfer,
      )) as { id: string };
      let received = '';
      for (let offset = 0; offset < data.length; offset += CLIPBOARD_CHUNK_CHARS) {
        await vi.advanceTimersByTimeAsync(45_000);
        const chunk = data.slice(offset, offset + CLIPBOARD_CHUNK_CHARS);
        if (direction === 'copy') {
          const reply = (await buffer.handle(
            { ...common, action: 'read', id, offset },
            current,
            transfer,
          )) as { data: string };
          received += reply.data;
        } else {
          await buffer.handle(
            { ...common, action: 'write', id, offset, data: chunk },
            current,
            transfer,
          );
        }
      }
      if (direction === 'copy') {
        expect(received).toBe(data);
        await buffer.handle({ ...common, action: 'cancel', id }, current, transfer);
      } else {
        await buffer.handle({ ...common, action: 'commit', id }, current, transfer);
        expect(transfer).toHaveBeenCalledWith('paste', content, current);
        await expect(
          buffer.handle({ ...common, action: 'commit', id }, current, transfer),
        ).rejects.toThrow('CLIPBOARD_EXPIRED');
      }
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['copy', 'paste'] as const)(
    'expires idle %s even after invalid or unauthorized requests',
    async (direction) => {
      const buffer = new ClipboardTransfer();
      const transfer = vi.fn(async () => ({ text: 'content' }));
      const common = { op: 'clipboardContent' as const, lease: 'lease' };
      const { id } = (await buffer.handle(
        direction === 'copy'
          ? { ...common, action: 'copy' }
          : { ...common, action: 'begin', length: 100 },
        () => true,
        transfer,
      )) as { id: string };
      const chunk =
        direction === 'copy'
          ? { ...common, action: 'read' as const, id, offset: 0 }
          : { ...common, action: 'write' as const, id, offset: 0, data: 'x' };
      await vi.advanceTimersByTimeAsync(30_000);
      await buffer.handle(chunk, () => true, transfer);
      await vi.advanceTimersByTimeAsync(59_999);
      await expect(buffer.handle({ ...chunk, id: 'wrong' }, () => true, transfer)).rejects.toThrow(
        'CLIPBOARD_EXPIRED',
      );
      await expect(
        buffer.handle({ ...chunk, lease: 'other' }, () => true, transfer),
      ).rejects.toThrow('CLIPBOARD_EXPIRED');
      await expect(buffer.handle({ ...chunk, offset: 1000 }, () => true, transfer)).rejects.toThrow(
        'INVALID_REQUEST',
      );
      const wrongDirection =
        direction === 'copy'
          ? { ...common, action: 'write' as const, id, offset: 0, data: 'x' }
          : { ...common, action: 'read' as const, id, offset: 0 };
      await expect(buffer.handle(wrongDirection, () => true, transfer)).rejects.toThrow(
        'INVALID_REQUEST',
      );
      await expect(buffer.handle(chunk, () => false, transfer)).rejects.toThrow(
        'DESKTOP_LEASE_EXPIRED',
      );
      await vi.advanceTimersByTimeAsync(1);
      await expect(buffer.handle(chunk, () => true, transfer)).rejects.toThrow('CLIPBOARD_EXPIRED');
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
