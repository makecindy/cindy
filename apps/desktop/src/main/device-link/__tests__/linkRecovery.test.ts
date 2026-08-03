import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';
import {
  invokeWithClosedLinkRecovery,
  requiresSessionLink,
} from '../linkRecovery.js';

describe('device-link closed link recovery', () => {
  it('正常成功或不可重试错误不会触发 reopen', async () => {
    const successInvoke = vi.fn().mockResolvedValue({ ok: true });
    const reopen = vi.fn();

    await expect(invokeWithClosedLinkRecovery(successInvoke, reopen)).resolves.toEqual({ ok: true });
    expect(successInvoke).toHaveBeenCalledTimes(1);
    expect(reopen).not.toHaveBeenCalled();

    for (const code of ['NOT_CONNECTED', 'INVOKE_TIMEOUT', 'BACKPRESSURE'] as const) {
      const err = new DeviceLinkError(code, code);
      const failedInvoke = vi.fn().mockRejectedValue(err);
      await expect(invokeWithClosedLinkRecovery(failedInvoke, reopen)).rejects.toBe(err);
      expect(failedInvoke).toHaveBeenCalledTimes(1);
    }
    expect(reopen).not.toHaveBeenCalled();
  });

  it('发送前 LINK_NOT_OPEN 会先 reopen，再且只再 invoke 一次', async () => {
    const closed = new DeviceLinkError('LINK_NOT_OPEN', 'control link is closed');
    const invoke = vi.fn()
      .mockRejectedValueOnce(closed)
      .mockResolvedValueOnce({ ok: true });
    const reopen = vi.fn().mockResolvedValue(undefined);

    await expect(invokeWithClosedLinkRecovery(invoke, reopen)).resolves.toEqual({ ok: true });
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(reopen.mock.invocationCallOrder[0]);
    expect(reopen.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[1]);
  });

  it('已发出的请求即使标成 LINK_NOT_OPEN 也不重试', async () => {
    const closed = new DeviceLinkError('LINK_NOT_OPEN', 'late close');
    closed.inFlight = true;
    const invoke = vi.fn().mockRejectedValue(closed);
    const reopen = vi.fn();

    await expect(invokeWithClosedLinkRecovery(invoke, reopen)).rejects.toBe(closed);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(reopen).not.toHaveBeenCalled();
  });

  it('reopen 的撤权错误原样返回，不发送第二次业务 invoke', async () => {
    const closed = new DeviceLinkError('LINK_NOT_OPEN', 'control link is closed');
    const revoked = new DeviceLinkError('ACCESS_REVOKED', 'access revoked');
    const invoke = vi.fn().mockRejectedValue(closed);
    const reopen = vi.fn().mockRejectedValue(revoked);

    await expect(invokeWithClosedLinkRecovery(invoke, reopen)).rejects.toBe(revoked);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('第二次 invoke 失败时不循环 reopen', async () => {
    const firstClosed = new DeviceLinkError('LINK_NOT_OPEN', 'first close');
    const secondClosed = new DeviceLinkError('LINK_NOT_OPEN', 'second close');
    const invoke = vi.fn()
      .mockRejectedValueOnce(firstClosed)
      .mockRejectedValueOnce(secondClosed);
    const reopen = vi.fn().mockResolvedValue(undefined);

    await expect(invokeWithClosedLinkRecovery(invoke, reopen)).rejects.toBe(secondClosed);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('reopen 后守卫失败会清理链路且不发送第二次 invoke', async () => {
    const closed = new DeviceLinkError('LINK_NOT_OPEN', 'control link is closed');
    const disabled = new Error('[DEVICE_LINK_CONTROL_DISABLED] disabled while reopening');
    const invoke = vi.fn().mockRejectedValueOnce(closed);
    const reopen = vi.fn().mockResolvedValue(undefined);
    const beforeRetry = vi.fn(() => {
      throw disabled;
    });
    const cleanup = vi.fn();

    await expect(
      invokeWithClosedLinkRecovery(invoke, reopen, beforeRetry, cleanup),
    ).rejects.toBe(disabled);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(beforeRetry).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('只把具体会话或有效文件树 topic 识别为需要 streaming link', () => {
    expect(requiresSessionLink(['sessions'])).toBe(false);
    expect(requiresSessionLink(['session:'])).toBe(false);
    expect(requiresSessionLink(['fs-watch:'])).toBe(false);
    expect(requiresSessionLink(['sessions', 'session:s1'])).toBe(true);
    expect(requiresSessionLink(['fs-watch:C:\\repo'])).toBe(true);
  });
});
