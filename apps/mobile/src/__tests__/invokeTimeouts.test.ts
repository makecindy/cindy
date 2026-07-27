import { describe, expect, it } from 'vitest';
import { INVOKE_TIMEOUT_OVERRIDES_MS } from '@cindy/device-link';
import {
  MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS,
  MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS,
  resolveMobileInvokeTimeoutMs,
} from '@/device-link/invokeTimeouts';

describe('resolveMobileInvokeTimeoutMs', () => {
  it('mobile 精确表优先:media / 文件搜索保住收紧前的 30s 窗口', () => {
    expect(resolveMobileInvokeTimeoutMs('device-link:media:fetch')).toBe(30_000);
    expect(resolveMobileInvokeTimeoutMs('file-browser:remote-op')).toBe(30_000);
    expect(MOBILE_INVOKE_TIMEOUT_OVERRIDES_MS['device-link:media:fetch']).toBe(30_000);
  });

  it('maker:schedule:* 前缀整类放宽:桌面 handler 会等 scheduler 就绪(30s 上限)', () => {
    expect(resolveMobileInvokeTimeoutMs('maker:schedule:list')).toBe(MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS);
    expect(resolveMobileInvokeTimeoutMs('maker:schedule:list-runs')).toBe(MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS);
    expect(resolveMobileInvokeTimeoutMs('maker:schedule:mark-run-read')).toBe(MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS);
    expect(MOBILE_SCHEDULE_CHANNEL_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('其余通道回退协议契约表;无登记则 undefined(client 默认 15s)', () => {
    for (const [channel, ms] of Object.entries(INVOKE_TIMEOUT_OVERRIDES_MS)) {
      expect(resolveMobileInvokeTimeoutMs(channel)).toBe(ms);
    }
    expect(resolveMobileInvokeTimeoutMs('maker:get-capabilities')).toBe(
      INVOKE_TIMEOUT_OVERRIDES_MS['maker:get-capabilities'],
    );
  });
});
