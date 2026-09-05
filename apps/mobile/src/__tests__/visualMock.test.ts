import { beforeEach, expect, it, vi } from 'vitest';
import type { DeviceView } from '@cindy/device-link';

vi.mock('@/config/env', () => ({ MOBILE_VISUAL_MOCK_REALDATA_URL: '' }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {} }));
beforeEach(() => vi.resetModules());

it('deletes an offline fixture without resurrecting it in later directory reads', async () => {
  const mock = await import('@/debug/visualMock');
  const path = `/api/device-link/devices/${mock.VISUAL_MOCK_OFFLINE_DEVICE_ID}`;
  expect(
    await mock.visualMockApiFetch(path, { baseUrl: '', method: 'DELETE' }),
  ).toEqual({
    deviceId: mock.VISUAL_MOCK_OFFLINE_DEVICE_ID,
    deleted: true,
  });
  const result = await mock.visualMockApiFetch<{ devices: DeviceView[] }>(
    '/api/device-link/devices',
  );
  expect(
    result.devices.some(
      (device) => device.deviceId === mock.VISUAL_MOCK_OFFLINE_DEVICE_ID,
    ),
  ).toBe(false);
  expect(mock.visualMockDevices()).toEqual(result.devices);
  await expect(
    mock.visualMockApiFetch(path, { baseUrl: '', method: 'DELETE' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('rejects online deletion and partial ID matches without losing devices', async () => {
  const mock = await import('@/debug/visualMock');
  const before = mock.visualMockDevices();
  const path = `/api/device-link/devices/${mock.VISUAL_MOCK_DEVICE_ID}`;
  await expect(
    mock.visualMockApiFetch(path, { baseUrl: '', method: 'DELETE' }),
  ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  await expect(
    mock.visualMockApiFetch(`${path}-extra`, { baseUrl: '', method: 'DELETE' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(mock.visualMockDevices()).toEqual(before);
});

it('persists a renamed fixture in later directory reads', async () => {
  const mock = await import('@/debug/visualMock');
  const path = `/api/device-link/devices/${mock.VISUAL_MOCK_DEVICE_ID}`;
  expect(
    await mock.visualMockApiFetch(path, {
      baseUrl: '',
      method: 'PATCH',
      body: { name: '  Office Mac  ' },
    }),
  ).toEqual({
    deviceId: mock.VISUAL_MOCK_DEVICE_ID,
    name: 'Office Mac',
  });
  const result = await mock.visualMockApiFetch<{ devices: DeviceView[] }>(
    '/api/device-link/devices',
  );
  expect(
    result.devices.find(
      (device) => device.deviceId === mock.VISUAL_MOCK_DEVICE_ID,
    )?.name,
  ).toBe('Office Mac');
});
