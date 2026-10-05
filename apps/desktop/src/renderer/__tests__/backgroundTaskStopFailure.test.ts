import { beforeEach, describe, expect, it, vi } from 'vitest';

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { warning } }));

import { reportBackgroundTaskStopFailure } from '@/lib/backgroundTaskStopFailure';

describe('reportBackgroundTaskStopFailure', () => {
  const t = ((key: string) => key) as unknown as Parameters<
    typeof reportBackgroundTaskStopFailure
  >[1];

  beforeEach(() => warning.mockClear());

  it('远程电脑版本过旧(未收录停止 channel)时提示升级', () => {
    reportBackgroundTaskStopFailure(
      new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] maker:agent-task:stop'),
      t,
    );
    expect(warning).toHaveBeenCalledWith('chat.backgroundActivity.remoteStopUnsupported');
  });

  it('远程电脑未连接 / 超时 / 繁忙 / 归属未解析时提示稍后重试', () => {
    for (const message of [
      '[DEVICE_LINK_NOT_CONNECTED] Background task ownership is unresolved',
      '[DEVICE_LINK_TIMEOUT] invoke timed out',
      '[DEVICE_OFFLINE] target offline',
      '[DEVICE_LINK_BUSY] invoke scheduler is saturated',
    ]) {
      warning.mockClear();
      reportBackgroundTaskStopFailure(new Error(message), t);
      expect(warning).toHaveBeenCalledWith('chat.backgroundActivity.remoteStopUnreachable');
    }
  });

  it('其余失败保持静默(按钮保留可重试)', () => {
    reportBackgroundTaskStopFailure(new Error('[INTERNAL] failed to stop background task'), t);
    reportBackgroundTaskStopFailure(new Error('network down'), t);
    expect(warning).not.toHaveBeenCalled();
  });
});
