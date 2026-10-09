/**
 * 远程控制的被控电脑上的任务换 Agent 所在电脑的纯判定(场景:同账号 A 远控 B 的任务,C 开了
 * 「允许被远程调用」)。
 */
import { describe, expect, it } from 'vitest';

import {
  controlledComputerSupportsRemoteAgent,
  controlledTaskAgentLocationReadable,
  controlledTaskSupportsAgentLocation,
  isControllerReadableAgentDevice,
  selectControlledTaskAgentDevices,
} from '../controlledTaskAgentLocation';

describe('controlledComputerSupportsRemoteAgent', () => {
  it('被控电脑的供应商目录带「允许被远程调用」布尔标记(开或关都算)就支持远程控制下新建任务', () => {
    expect(controlledComputerSupportsRemoteAgent([{ remoteInvocationEnabled: false }])).toBe(true);
    expect(controlledComputerSupportsRemoteAgent([{}, { remoteInvocationEnabled: true }])).toBe(true);
  });

  it('旧版被控电脑不带这个标记、或目录还没读到:不支持', () => {
    expect(controlledComputerSupportsRemoteAgent([{}, {}])).toBe(false);
    expect(controlledComputerSupportsRemoteAgent([])).toBe(false);
    expect(controlledComputerSupportsRemoteAgent([{ remoteInvocationEnabled: 'yes' }])).toBe(false);
  });
});

describe('controlledTaskSupportsAgentLocation', () => {
  it('被控电脑投影了 agentDeviceId 字段(含 null)才算支持', () => {
    expect(controlledTaskSupportsAgentLocation({ id: 's1', agentDeviceId: null })).toBe(true);
    expect(controlledTaskSupportsAgentLocation({ id: 's1', agentDeviceId: 'device-c' })).toBe(true);
  });

  it('旧版被控电脑不投影这个字段:不支持', () => {
    expect(controlledTaskSupportsAgentLocation({ id: 's1' })).toBe(false);
    expect(controlledTaskSupportsAgentLocation(null)).toBe(false);
    expect(controlledTaskSupportsAgentLocation(undefined)).toBe(false);
  });
});

describe('isControllerReadableAgentDevice', () => {
  it('同账号的其他电脑本机读得到', () => {
    expect(isControllerReadableAgentDevice('device-c', 'device-a')).toBe(true);
  });

  it('被控电脑收到的分享、本机自己、空值都读不到', () => {
    expect(isControllerReadableAgentDevice('share:abc', 'device-a')).toBe(false);
    expect(isControllerReadableAgentDevice('device-a', 'device-a')).toBe(false);
    expect(isControllerReadableAgentDevice(null, 'device-a')).toBe(false);
    expect(isControllerReadableAgentDevice(undefined, 'device-a')).toBe(false);
  });
});

describe('controlledTaskAgentLocationReadable', () => {
  it('Agent 在被控电脑、或在本机读得到的电脑:可以在本机面板里换', () => {
    expect(
      controlledTaskAgentLocationReadable({
        agentDeviceId: null,
        pendingAgentDeviceId: undefined,
        selfDeviceId: 'device-a',
      }),
    ).toBe(true);
    expect(
      controlledTaskAgentLocationReadable({
        agentDeviceId: 'device-c',
        pendingAgentDeviceId: null,
        selfDeviceId: 'device-a',
      }),
    ).toBe(true);
  });

  it('现在或挂着的位置在分享 / 本机上:维持原有的被控电脑列表', () => {
    expect(
      controlledTaskAgentLocationReadable({
        agentDeviceId: 'share:abc',
        pendingAgentDeviceId: undefined,
        selfDeviceId: 'device-a',
      }),
    ).toBe(false);
    expect(
      controlledTaskAgentLocationReadable({
        agentDeviceId: null,
        pendingAgentDeviceId: 'device-a',
        selfDeviceId: 'device-a',
      }),
    ).toBe(false);
  });
});

describe('selectControlledTaskAgentDevices', () => {
  const devices = [
    { deviceId: 'device-b', name: 'Office', online: true },
    { deviceId: 'device-c', name: 'Studio', online: true },
    { deviceId: 'device-d', name: 'Laptop', online: false },
    { deviceId: 'device-e', name: 'Spare', online: false },
  ];

  it('去掉被控电脑本身,只留在线的电脑', () => {
    expect(
      selectControlledTaskAgentDevices({
        devices,
        controlledDeviceId: 'device-b',
        keepDeviceIds: [],
      }),
    ).toEqual([{ deviceId: 'device-c', name: 'Studio' }]);
  });

  it('任务当前 / 挂着的 Agent 所在电脑离线也保留', () => {
    expect(
      selectControlledTaskAgentDevices({
        devices,
        controlledDeviceId: 'device-b',
        keepDeviceIds: ['device-d', undefined, null],
      }),
    ).toEqual([
      { deviceId: 'device-c', name: 'Studio' },
      { deviceId: 'device-d', name: 'Laptop' },
    ]);
  });
});
