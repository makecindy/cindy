import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { byShownName, cloudBaseName, cloudDisplayName } from '../instanceName';

const t = ((key: string) =>
  key === 'cloudSettings.onboarding.defaultNameSole' ? '云端 Cindy' : key) as unknown as TFunction;
const A = 'cloud-device-0123456789abcdef01234567';
const B = 'cloud-device-89abcdef0123456789abcdef';

describe('a cloud Cindy is named as the device list names it', () => {
  it('keeps the name the user gave it, and CIS\'s name before it is listed', () => {
    expect(cloudBaseName(t, A, '测试机', { name: null })).toBe('测试机');
    expect(cloudBaseName(t, A, undefined, { name: '工作' })).toBe('工作');
    expect(cloudBaseName(t, A, undefined, { name: null })).toBe('云端 Cindy');
  });

  it('never shows the runtime marker or a device id', () => {
    expect(cloudBaseName(t, A, '__cindy_cloud_device_name__:7', { name: null })).toBe('云端 Cindy');
    expect(cloudBaseName(t, A, A, undefined)).toBe('云端 Cindy');
  });

  it('tells two of the same name apart as the client does for any device, nothing invented', () => {
    const devices = [
      { deviceId: B, name: '云端 Cindy' },
      { deviceId: A, name: '云端 Cindy' },
      { deviceId: 'mac', name: 'Mac mini' },
    ];
    expect(cloudDisplayName(A, '云端 Cindy', devices)).toBe('云端 Cindy (1)');
    expect(cloudDisplayName(B, '云端 Cindy', devices)).toBe('云端 Cindy (2)');
    expect(cloudDisplayName(A, '测试机', [{ deviceId: A, name: '测试机' }])).toBe('测试机');
    expect(['云端 Cindy (2)', '云端 Cindy (1)'].sort(byShownName)).toEqual(['云端 Cindy (1)', '云端 Cindy (2)']);
  });
});
