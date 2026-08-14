/**
 * presenceRefreshRelevance —— presence 触发目录重拉的相关性判据(issue #1726)。
 *
 * 背景:relay 把 presence-changed 广播给同账号所有连接**含本机**(刻意保留的僵尸订阅回收
 * 信号),而本机每开始 / 跑完一轮任务都翻转 busy。修复前 `onPresenceChanged(() => refresh())`
 * 不做任何过滤,自己的 busy 绕一圈回来就触发一次全量 listDevices。
 *
 * 这里只测纯判据函数;订阅接线本身由 useDeviceLinkReconnectEpoch.test.ts 那类用例覆盖。
 */
import { describe, it, expect } from 'vitest';

import { shouldRefreshForPresence } from '../useDeviceLinkDeviceList';

function view(over: Partial<DeviceLinkDeviceView> = {}): DeviceLinkDeviceView {
  return {
    deviceId: 'peer-1',
    name: 'Peer Mac',
    platform: 'darwin',
    appVersion: '0.1.27',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...over,
  };
}

function presence(over: Partial<DeviceLinkPresenceSnapshot> = {}): DeviceLinkPresenceSnapshot {
  return {
    deviceId: 'peer-1',
    online: true,
    deviceName: 'Peer Mac',
    platform: 'darwin',
    appVersion: '0.1.27',
    lastSeenAt: 1_000,
    remoteControlEnabled: true,
    busy: false,
    ...over,
  };
}

describe('shouldRefreshForPresence · 必须重拉', () => {
  it('尚无首份目录(devices === null)', () => {
    expect(shouldRefreshForPresence(null, presence(), 'ready')).toBe(true);
  });

  it('presence 指向目录里没有的设备(新机器上线)', () => {
    expect(shouldRefreshForPresence([view()], presence({ deviceId: 'peer-新' }), 'ready')).toBe(true);
  });

  it('对端 online 翻转', () => {
    expect(shouldRefreshForPresence([view({ online: true })], presence({ online: false }), 'ready')).toBe(true);
  });

  it('对端 remoteControlEnabled 翻转(「允许被控」开关)', () => {
    expect(
      shouldRefreshForPresence(
        [view({ remoteControlEnabled: true })],
        presence({ remoteControlEnabled: false }),
        'ready',
      ),
    ).toBe(true);
  });

  it('对端 platform 由 null 变成具体值 —— 决定移动端过滤,漏了会让手机留在切换栏', () => {
    expect(shouldRefreshForPresence([view({ platform: null })], presence({ platform: 'ios' }), 'ready')).toBe(
      true,
    );
  });

  it('对端改名', () => {
    expect(
      shouldRefreshForPresence([view({ name: '旧名' })], presence({ deviceName: '新名' }), 'ready'),
    ).toBe(true);
  });
});

describe('shouldRefreshForPresence · 必须跳过', () => {
  it('本机自 presence:busy 翻转不重拉(issue #1726 的主要浪费来源)', () => {
    const self = [view({ deviceId: 'self-1', isSelf: true })];
    expect(shouldRefreshForPresence(self, presence({ deviceId: 'self-1', busy: true }), 'ready')).toBe(false);
    expect(shouldRefreshForPresence(self, presence({ deviceId: 'self-1', busy: false }), 'ready')).toBe(false);
  });

  it('本机自 presence:即便 online / remoteControlEnabled 也变了仍跳过 —— 本机不进切换栏', () => {
    const self = [view({ deviceId: 'self-1', isSelf: true, online: true, remoteControlEnabled: true })];
    expect(
      shouldRefreshForPresence(
        self,
        presence({ deviceId: 'self-1', online: false, remoteControlEnabled: false }),
        'ready',
      ),
    ).toBe(false);
  });

  it('对端只有 busy / lastSeenAt / appVersion / deviceInfo 变化(心跳噪音)', () => {
    expect(
      shouldRefreshForPresence(
        [view()],
        presence({
          busy: true,
          lastSeenAt: 999_999,
          appVersion: '0.1.28',
          deviceInfo: { note: 'whatever' } as never,
        }),
        'ready',
      ),
    ).toBe(false);
  });

  it('完全无变化的 presence', () => {
    expect(shouldRefreshForPresence([view()], presence(), 'ready')).toBe(false);
  });

  it('名字仅首尾空白差异按未变(与 applyDeviceRename 的 trim 口径一致)', () => {
    expect(
      shouldRefreshForPresence(
        [view({ name: 'Peer Mac' })],
        presence({ deviceName: '  Peer Mac  ' }),
        'ready',
      ),
    ).toBe(false);
  });

  it('platform 的 null 与空串等价,不算变化', () => {
    expect(shouldRefreshForPresence([view({ platform: null })], presence({ platform: '' }), 'ready')).toBe(
      false,
    );
  });
});

describe('shouldRefreshForPresence · 多设备目录只看命中的那一行', () => {
  it('对端 A 的心跳不因对端 B 的状态差异而误判为需要重拉', () => {
    const list = [
      view({ deviceId: 'peer-a', name: 'A', online: true }),
      view({ deviceId: 'peer-b', name: 'B', online: false }),
    ];
    expect(shouldRefreshForPresence(list, presence({ deviceId: 'peer-a', deviceName: 'A', busy: true }), 'ready')).toBe(
      false,
    );
    // B 自己上线 → 命中 B 那一行,online 有差异,重拉。
    expect(
      shouldRefreshForPresence(
        list,
        presence({ deviceId: 'peer-b', deviceName: 'B', online: true }),
        'ready',
      ),
    ).toBe(true);
  });
});

/**
 * 上一次 listDevices 失败(此前已有快照 → devices 非空、requestState 停在 'error')。
 * push 驱动 + 无轮询兜底,若此时仍按「字段没变」滤掉 presence,侧栏会被钉在错误/陈旧目录上
 * 直到 status / control-target 事件或手动重试(review: codex P1 on PR #1799)。
 */
describe('shouldRefreshForPresence · 上一次请求失败时一律放行', () => {
  it("requestStatus='error':本机 busy 自回声也当作重试机会", () => {
    const self = [view({ deviceId: 'self-1', isSelf: true })];
    expect(shouldRefreshForPresence(self, presence({ deviceId: 'self-1', busy: true }), 'error')).toBe(
      true,
    );
  });

  it("requestStatus='error':对端纯心跳(无相关字段变化)也放行", () => {
    expect(shouldRefreshForPresence([view()], presence({ lastSeenAt: 999_999 }), 'error')).toBe(true);
  });

  it("requestStatus='loading':不叠加请求 —— 已有一笔在飞,失败后会落到 error 再由下条 presence 接管", () => {
    const self = [view({ deviceId: 'self-1', isSelf: true })];
    expect(
      shouldRefreshForPresence(self, presence({ deviceId: 'self-1', busy: true }), 'loading'),
    ).toBe(false);
    expect(shouldRefreshForPresence([view()], presence({ lastSeenAt: 999_999 }), 'loading')).toBe(
      false,
    );
  });
});
