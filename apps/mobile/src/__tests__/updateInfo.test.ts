import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { buildMobileUpdateInfoRows, currentMobileOtaVersion, OTA_VERIFY_MARKER } from '@/settings/updateInfo';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('buildMobileUpdateInfoRows', () => {
  it('shows OTA launch info (short id, local time, channel, runtime)', () => {
    const rows = buildMobileUpdateInfoRows({
      isEmbeddedLaunch: false,
      updateId: 'abcd1234-5678-90ab-cdef-1234567890ab',
      channel: 'production',
      createdAt: new Date(2026, 5, 26, 15, 13), // 本地时间,与 getter 同口径 → 不受时区影响
      runtimeVersion: '08fb61a6dfdfc5b9c9fa3cd3f4258e0b7796a392',
    });
    expect(rows).toEqual([
      { id: 'source', label: '运行来源', value: 'OTA 热更新' },
      { id: 'updateId', label: '更新 ID', value: 'abcd1234' },
      { id: 'updatedAt', label: '更新时间', value: '2026-06-26 15:13' },
      { id: 'channel', label: 'Channel', value: 'production' },
      { id: 'runtimeVersion', label: 'Runtime', value: '08fb61a6dfdfc5b9c9fa3cd3f4258e0b7796a392' },
      { id: 'otaMarker', label: '热更标记', value: OTA_VERIFY_MARKER },
    ]);
  });

  it('shows embedded / dev fallbacks when id, time and channel are absent', () => {
    const rows = buildMobileUpdateInfoRows({
      isEmbeddedLaunch: true,
      updateId: undefined,
      channel: undefined,
      createdAt: undefined,
      runtimeVersion: '1.0.0',
    });
    expect(rows.map((r) => r.value)).toEqual(['内置版本(随包)', '—', '—', '—', '1.0.0', OTA_VERIFY_MARKER]);
  });
});

describe('currentMobileOtaVersion', () => {
  it('uses the short update id for the OTA bundle currently running', () => {
    expect(currentMobileOtaVersion({
      isEmbeddedLaunch: false,
      updateId: 'abcd1234-5678-90ab-cdef-1234567890ab',
    })).toBe('abcd1234');
  });

  it('distinguishes the bundle embedded in the full app package', () => {
    expect(currentMobileOtaVersion({ isEmbeddedLaunch: true, updateId: 'embedded-id' })).toBe('随整包');
    expect(currentMobileOtaVersion({ isEmbeddedLaunch: false, updateId: undefined })).toBe('未知');
  });
});
