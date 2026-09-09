import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_CHUNK_CHARS, type RemoteClipboardContent } from '@cindy/device-link';
import { ClipboardTransfer } from '../clipboardTransfer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('clipboard transfer idle expiry', () => {
  it.each(['copy', 'paste'] as const)('keeps %s progressing beyond one minute and settles only once', async (direction) => {
    const content = { text: 'x'.repeat(CLIPBOARD_CHUNK_CHARS * 2) };
    const data = JSON.stringify(content);
    const transfer = vi.fn(async (_action: 'copy' | 'paste', _content?: RemoteClipboardContent) => content);
    const current = () => true;
    const buffer = new ClipboardTransfer();
    const common = { op: 'clipboardContent' as const, lease: 'lease' };
    const { id } = await buffer.handle(
      direction === 'copy' ? { ...common, action: 'copy' } : { ...common, action: 'begin', length: data.length },
      current, transfer,
    ) as { id: string };
    let received = '';
    for (let offset = 0; offset < data.length; offset += CLIPBOARD_CHUNK_CHARS) {
      await vi.advanceTimersByTimeAsync(45_000);
      const chunk = data.slice(offset, offset + CLIPBOARD_CHUNK_CHARS);
      if (direction === 'copy') {
        const reply = await buffer.handle({ ...common, action: 'read', id, offset }, current, transfer) as { data: string };
        received += reply.data;
      } else {
        await buffer.handle({ ...common, action: 'write', id, offset, data: chunk }, current, transfer);
      }
    }
    if (direction === 'copy') {
      expect(received).toBe(data);
      await buffer.handle({ ...common, action: 'cancel', id }, current, transfer);
    } else {
      await buffer.handle({ ...common, action: 'commit', id }, current, transfer);
      expect(transfer).toHaveBeenCalledWith('paste', content, current);
      await expect(buffer.handle({ ...common, action: 'commit', id }, current, transfer)).rejects.toThrow('CLIPBOARD_EXPIRED');
    }
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['copy', 'paste'] as const)('expires idle %s even after invalid or unauthorized requests', async (direction) => {
    const buffer = new ClipboardTransfer();
    const transfer = vi.fn(async () => ({ text: 'content' }));
    const common = { op: 'clipboardContent' as const, lease: 'lease' };
    const { id } = await buffer.handle(
      direction === 'copy' ? { ...common, action: 'copy' } : { ...common, action: 'begin', length: 100 },
      () => true, transfer,
    ) as { id: string };
    const chunk = direction === 'copy'
      ? { ...common, action: 'read' as const, id, offset: 0 }
      : { ...common, action: 'write' as const, id, offset: 0, data: 'x' };
    await vi.advanceTimersByTimeAsync(30_000);
    await buffer.handle(chunk, () => true, transfer);
    await vi.advanceTimersByTimeAsync(59_999);
    await expect(buffer.handle({ ...chunk, id: 'wrong' }, () => true, transfer)).rejects.toThrow('CLIPBOARD_EXPIRED');
    await expect(buffer.handle({ ...chunk, lease: 'other' }, () => true, transfer)).rejects.toThrow('CLIPBOARD_EXPIRED');
    await expect(buffer.handle({ ...chunk, offset: 1000 }, () => true, transfer)).rejects.toThrow('INVALID_REQUEST');
    const wrongDirection = direction === 'copy'
      ? { ...common, action: 'write' as const, id, offset: 0, data: 'x' }
      : { ...common, action: 'read' as const, id, offset: 0 };
    await expect(buffer.handle(wrongDirection, () => true, transfer)).rejects.toThrow('INVALID_REQUEST');
    await expect(buffer.handle(chunk, () => false, transfer)).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    await vi.advanceTimersByTimeAsync(1);
    await expect(buffer.handle(chunk, () => true, transfer)).rejects.toThrow('CLIPBOARD_EXPIRED');
    expect(vi.getTimerCount()).toBe(0);
  });
});
