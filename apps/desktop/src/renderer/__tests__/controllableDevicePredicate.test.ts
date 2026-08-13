/**
 * controllableDevicePredicate.test.ts —— 可控被控设备的准入判定。
 * 守住「添加远程项目」设备下拉 / 入口 gate 的准入:
 * 同账号、在线、对方已开被控、本机未关闭控制、非本机、非手机。
 */
import { describe, it, expect } from 'vitest';

import {
  isControllableDevice,
  toControllableDevices,
  sameControllableList,
  isSelectableDevice,
  toSelectableDevices,
  sameSelectableList,
} from '@/hooks/useControllableDevices';

function dev(over: Partial<DeviceLinkDeviceView>): DeviceLinkDeviceView {
  return {
    deviceId: 'd',
    name: 'Mac',
    platform: 'darwin',
    appVersion: '0.0.0-test',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...over,
  };
}

describe('isControllableDevice', () => {
  it('在线 + 已开被控 + 非本机 → 可控', () => {
    expect(isControllableDevice(dev({}))).toBe(true);
    // busy(对方正忙)仍可作为项目目标。
    expect(isControllableDevice(dev({ busy: true }))).toBe(true);
  });
  it('离线 / 未开被控 / 本机关闭控制 / 本机 / 手机 → 不可控', () => {
    expect(isControllableDevice(dev({ online: false }))).toBe(false);
    expect(isControllableDevice(dev({ remoteControlEnabled: false }))).toBe(false);
    expect(isControllableDevice(dev({ controlEnabled: false }))).toBe(false);
    expect(isControllableDevice(dev({ isSelf: true }))).toBe(false);
    expect(isControllableDevice(dev({ platform: 'ios' }))).toBe(false);
    expect(isControllableDevice(dev({ platform: 'android' }))).toBe(false);
  });
});

describe('toControllableDevices', () => {
  it('过滤可控目标 + 投影成 {deviceId,name,platform}(丢弃离线/未开被控/本机/手机)', () => {
    const out = toControllableDevices([
      dev({ deviceId: 'ok', name: 'OK', platform: 'darwin' }),
      dev({ deviceId: 'off', online: false }),
      dev({ deviceId: 'noctl', remoteControlEnabled: false }),
      dev({ deviceId: 'local-off', controlEnabled: false }),
      dev({ deviceId: 'self', isSelf: true }),
      dev({ deviceId: 'iphone', platform: 'ios' }),
      dev({ deviceId: 'android', platform: 'android' }),
    ]);
    expect(out).toEqual([{ deviceId: 'ok', name: 'OK', platform: 'darwin' }]);
  });
  it('空列表 → 空', () => {
    expect(toControllableDevices([])).toEqual([]);
  });
});

/**
 * #807 创建页设备切换器的准入。与上面的「可控目标」是两套语义:切换器要**列出离线设备**
 * 并置灰,不能一掉线就整行消失(唯一对端掉线时 pill 会整个不见)。
 */
describe('isSelectableDevice(设备切换器,含离线)', () => {
  it('在线 + 已开被控 → 可选', () => {
    expect(isSelectableDevice(dev({}))).toBe(true);
    expect(isSelectableDevice(dev({ busy: true }))).toBe(true);
  });

  it('离线仍可选(列出后由 UI 置灰禁用)', () => {
    expect(isSelectableDevice(dev({ online: false }))).toBe(true);
  });

  it('离线时 remoteControlEnabled=false 不作数 —— 只有 online 的 false 才权威', () => {
    // presence 掉线的行会把这一位报成 false,即使对方并没有主动关闭远程控制。
    // 照它过滤会让配对设备一掉线就从切换器消失(与 useDeviceLinkRemoteProjects 同款判定)。
    expect(isSelectableDevice(dev({ online: false, remoteControlEnabled: false }))).toBe(true);
    // 在线却报 false = 对方确实关了被控 → 不可选。
    expect(isSelectableDevice(dev({ online: true, remoteControlEnabled: false }))).toBe(false);
  });

  it('本机关闭了对它的控制 / 是本机 → 任何时候都不可选', () => {
    expect(isSelectableDevice(dev({ controlEnabled: false }))).toBe(false);
    expect(isSelectableDevice(dev({ controlEnabled: false, online: false }))).toBe(false);
    expect(isSelectableDevice(dev({ isSelf: true }))).toBe(false);
    expect(isSelectableDevice(dev({ isSelf: true, online: false }))).toBe(false);
  });

  it('手机只能作为控制端,在线或离线都不进入设备选择', () => {
    expect(isSelectableDevice(dev({ platform: 'ios' }))).toBe(false);
    expect(isSelectableDevice(dev({ platform: 'android' }))).toBe(false);
    expect(
      isSelectableDevice(
        dev({ platform: 'ios', online: false, remoteControlEnabled: false }),
      ),
    ).toBe(false);
    expect(
      isSelectableDevice(
        dev({ platform: 'android', online: false, remoteControlEnabled: false }),
      ),
    ).toBe(false);
  });
});

describe('toSelectableDevices', () => {
  it('保留离线电脑并带上 online 标记,过滤本机、已关控制与手机', () => {
    const out = toSelectableDevices([
      dev({ deviceId: 'on', name: 'On', platform: 'darwin' }),
      dev({ deviceId: 'off', name: 'Off', online: false, remoteControlEnabled: false }),
      dev({ deviceId: 'noctl', online: true, remoteControlEnabled: false }),
      dev({ deviceId: 'local-off', controlEnabled: false }),
      dev({ deviceId: 'self', isSelf: true }),
      dev({ deviceId: 'iphone', platform: 'ios' }),
      dev({ deviceId: 'android', platform: 'android', online: false }),
    ]);
    expect(out).toEqual([
      { deviceId: 'on', name: 'On', platform: 'darwin', online: true },
      { deviceId: 'off', name: 'Off', platform: 'darwin', online: false },
    ]);
  });
});

describe('sameSelectableList(掉线/上线必须触发重渲染)', () => {
  const a = { deviceId: 'd1', name: 'Mac', platform: 'darwin', online: true };
  it('全等 → true', () => {
    expect(sameSelectableList([a], [{ ...a }])).toBe(true);
    expect(sameSelectableList([], [])).toBe(true);
  });
  it('online 翻转 → false(否则状态点不更新、离线行点不动却看着可点)', () => {
    expect(sameSelectableList([a], [{ ...a, online: false }])).toBe(false);
  });
});

describe('sameControllableList(presence churn 去抖)', () => {
  const a = { deviceId: 'd1', name: 'Mac', platform: 'darwin' };
  const b = { deviceId: 'd2', name: 'PC', platform: 'win32' };
  it('内容/顺序全等 → true(跳过 setState,保留旧引用)', () => {
    expect(sameControllableList([a, b], [{ ...a }, { ...b }])).toBe(true);
    expect(sameControllableList([], [])).toBe(true);
  });
  it('长度 / 字段 / 顺序任一不同 → false', () => {
    expect(sameControllableList([a], [a, b])).toBe(false); // 长度
    expect(sameControllableList([a], [{ ...a, name: 'Mac2' }])).toBe(false); // name 变(改名)
    expect(sameControllableList([a], [{ ...a, platform: 'linux' }])).toBe(false); // platform 变
    expect(sameControllableList([a, b], [b, a])).toBe(false); // 顺序变
  });
});
