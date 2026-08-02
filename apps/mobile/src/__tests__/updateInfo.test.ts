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

  // 应急启动是"点检查更新报 reload 被拒"的唯一现场证据,必须能在设置页直接看到原因。
  it('appends the emergency launch reason when expo-updates fell back to the embedded bundle', () => {
    const rows = buildMobileUpdateInfoRows({
      isEmbeddedLaunch: false,
      updateId: undefined,
      channel: undefined,
      createdAt: undefined,
      runtimeVersion: '1.0.0',
      isEmergencyLaunch: true,
      emergencyLaunchReason: 'No launchable update was found.',
    });
    // 运行来源不能报「OTA 热更新」:应急启动跑的是内置 bundle,否则同一区块自相矛盾。
    expect(rows[0]).toEqual({
      id: 'source',
      label: '运行来源',
      value: '内置版本(应急启动，热更未生效)',
    });
    expect(rows.at(-1)).toEqual({
      id: 'emergencyLaunch',
      label: '应急启动',
      value: 'No launchable update was found.',
    });
  });

  it('falls back to a plain yes when the native layer gives no emergency launch reason', () => {
    const rows = buildMobileUpdateInfoRows({
      isEmbeddedLaunch: false,
      updateId: undefined,
      channel: undefined,
      createdAt: undefined,
      runtimeVersion: '1.0.0',
      isEmergencyLaunch: true,
      emergencyLaunchReason: null,
    });
    expect(rows.at(-1)?.value).toBe('是（本次运行内热更无法生效）');
  });

  it('omits the emergency launch row on a normal launch', () => {
    const rows = buildMobileUpdateInfoRows({
      isEmbeddedLaunch: true,
      updateId: 'embedded-id',
      channel: 'production',
      createdAt: undefined,
      runtimeVersion: '1.0.0',
      isEmergencyLaunch: false,
    });
    expect(rows.map((r) => r.id)).not.toContain('emergencyLaunch');
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

  // 应急启动下 updateId 空、isEmbeddedLaunch 也是 false,但跑的确定是内置 bundle:
  // 显示"未知"会被误读成读不到版本号,这里必须说清是内置 bundle 且热更没生效。
  it('names the embedded fallback instead of unknown on an emergency launch', () => {
    expect(currentMobileOtaVersion({
      isEmbeddedLaunch: false,
      updateId: undefined,
      isEmergencyLaunch: true,
    })).toBe('随整包（热更未生效）');
  });
});
