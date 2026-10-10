// @vitest-environment jsdom
/**
 * 协同 Worker 面板的远程供应商候选：与任务输入框同一套；远程控制时 Lead 的 Agent 在控制端读不到目录的
 * 地方(控制端自己、只有被控电脑收到的分享)时维持被控电脑的目录，Worker 跟 Lead。
 */
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useWorkerAgentDevices } from '../hooks/useWorkerAgentDevices';

const mocks = vi.hoisted(() => ({
  selfDeviceId: 'self-pc' as string | null,
  devices: [] as Array<{ deviceId: string; name: string; online: boolean }>,
  received: [] as Array<{ deviceId: string; name: string }>,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ deviceId: mocks.selfDeviceId }),
}));
vi.mock('@/hooks/useControllableDevices', () => ({
  useSelectableDevices: () => ({ devices: mocks.devices }),
}));
vi.mock('@/features/provider-share/useProviderShareAgentDevices', () => ({
  useProviderShareAgentDevices: () => ({
    devices: mocks.received,
    isReceived: (id: string | null | undefined) => mocks.received.some((share) => share.deviceId === id),
  }),
}));

afterEach(() => {
  cleanup();
  mocks.devices = [];
  mocks.received = [];
});

describe('useWorkerAgentDevices', () => {
  it('lists online computers and received shares for a Lead on this computer', () => {
    mocks.devices = [
      { deviceId: 'office', name: 'Office', online: true },
      { deviceId: 'studio', name: 'Studio', online: false },
    ];
    mocks.received = [{ deviceId: 'share:s1', name: 'Anthropic · Alice' }];
    const { result } = renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: null, leadAgentDeviceId: 'studio' }),
    );
    expect(result.current).toEqual({
      leadAgentDeviceId: 'studio',
      // 当前位置掉线也保留，换得回来。
      devices: [
        { deviceId: 'office', name: 'Office' },
        { deviceId: 'studio', name: 'Studio' },
        { deviceId: 'share:s1', name: 'Anthropic · Alice' },
      ],
    });
  });

  it('offers nothing before the Lead is resolved or for an SSH Lead', () => {
    mocks.devices = [{ deviceId: 'office', name: 'Office', online: true }];
    expect(renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: undefined, leadAgentDeviceId: undefined }),
    ).result.current).toEqual({ leadAgentDeviceId: null, devices: undefined });
    expect(renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: null, leadAgentDeviceId: null, sshRemote: true }),
    ).result.current.devices).toBeUndefined();
  });

  it("keeps the controlled computer's catalog when this computer cannot read the Lead's location", () => {
    mocks.devices = [{ deviceId: 'office', name: 'Office', online: true }];
    // Lead 的 Agent 就在控制端自己：设备互联连不到自己。
    expect(renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: 'self-pc' }),
    ).result.current).toEqual({ leadAgentDeviceId: null, devices: undefined });
    // 只有被控电脑收到的分享。
    expect(renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: 'share:only-host' }),
    ).result.current).toEqual({ leadAgentDeviceId: null, devices: undefined });
  });

  it('lists other computers and the readable share for a controlled Lead', () => {
    mocks.devices = [
      { deviceId: 'host', name: 'Host', online: true },
      { deviceId: 'office', name: 'Office', online: true },
    ];
    mocks.received = [
      { deviceId: 'share:s1', name: 'Anthropic · Alice' },
      { deviceId: 'share:s2', name: 'OpenAI · Bob' },
    ];
    const { result } = renderHook(() =>
      useWorkerAgentDevices({ controlledDeviceId: 'host', leadAgentDeviceId: 'share:s1' }),
    );
    expect(result.current).toEqual({
      leadAgentDeviceId: 'share:s1',
      devices: [
        { deviceId: 'office', name: 'Office' },
        { deviceId: 'share:s1', name: 'Anthropic · Alice' },
      ],
    });
  });
});
