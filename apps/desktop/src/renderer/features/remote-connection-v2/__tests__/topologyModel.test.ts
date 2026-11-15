// @vitest-environment jsdom
/**
 * 远程连接 V2 拓扑的纯状态推导(jsdom 只为最后一组 localStorage 用例)。
 * 规则依据:docs/product-rules/agent-net.md「界面」+ 本页裁决;设备状态五档与分组 / 分边 / 折叠规则是用户
 * 在设计稿上确认的,改坏了拓扑就画错;组内按名字排、消息流向只认真实收发是 2026-11-06 用户反馈后的规则。
 * 覆盖缺口:新模块,此前无覆盖。最小失败输入:见各用例。
 * tier:unit。实测耗时:纯函数,<1s。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FLOW_WINDOW_MS,
  LABEL_HOLD_MS,
  OFFLINE_FOLD_ID,
  assignSides,
  buildTopology,
  flowOf,
  flowTextOf,
  mergeFlows,
} from '../topologyModel';
import { SPECK_H, SPECK_W, groupLines, layoutTopology, samplePath, speckKeyframes } from '../topologyGeometry';
import { SPACING, SPEED, streamFor } from '../TopologyFlow';
import { appendPresenceEvent } from '../useRecentPresence';
import {
  _resetRemoteConnectionV2ForTests,
  getRemoteConnectionV2Enabled,
  setRemoteConnectionV2Enabled,
  setRemoteConnectionOnlyEncrypted,
  getRemoteConnectionOnlyEncrypted,
} from '../useRemoteConnectionV2';

function device(partial: Partial<DeviceLinkDeviceView> & { deviceId: string }): DeviceLinkDeviceView {
  return {
    name: partial.deviceId,
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...partial,
  };
}

/** 一条链路;sent / received 是「多少毫秒前有业务消息」,不传就是从没收发过。 */
function link(
  deviceId: string,
  path: 'direct' | 'relay',
  rttMs: number | null,
  open = true,
  sentAgoMs: number | null = null,
  receivedAgoMs: number | null = null,
): DeviceLinkPeerLinkView {
  return { deviceId, path, rttMs, open, sentAgoMs, receivedAgoMs };
}

const base = {
  relayRttMs: 20,
  relayName: 'Cindy',
  selfHosted: false,
  controlledBy: [] as string[],
  unresponsive: [] as string[],
  showOffline: false,
};

// App routing: platform-only nodes incorrectly painted Friend as control-off.
// Unit, real topology builder: one online Mac, no remote control and no link.
it.each([undefined, 'cindy', 'cindy-friend', 'other-app'])('classifies app=%s without assigning Cindy-only attention to other Apps', app => {
  const model = buildTopology({ ...base, devices: [device({ deviceId: 'peer', app, remoteControlEnabled: false })], links: [] });
  const peer = model.nodes[0];
  expect(peer.app).toBe(app);
  expect(peer.status).toBe(app === undefined || app === 'cindy' ? 'attention' : 'unlinked');
  expect(peer.isMobile).toBe(false);
});

describe('buildTopology:状态五档', () => {
  it('直连 / 经中转 / 未建链 / 要处理 / 离线各归一档,本机不在节点里', () => {
    const model = buildTopology({
      ...base,
      devices: [
        device({ deviceId: 'self', isSelf: true, selfName: '我的 Mac' }),
        device({ deviceId: 'a' }),
        device({ deviceId: 'b' }),
        device({ deviceId: 'c' }),
        device({ deviceId: 'd', remoteControlEnabled: false }),
        device({ deviceId: 'e', online: false, lastSeenAt: '2026-11-01T00:00:00Z' }),
        device({ deviceId: 'f' }),
      ],
      links: [
        link('a', 'direct', 3),
        link('b', 'relay', 40),
        // 还没就绪的链路不算建链
        link('c', 'direct', 5, false),
      ],
      unresponsive: ['f'],
    });
    expect(model.self).toEqual({ name: '我的 Mac', platform: 'darwin' });
    expect(model.nodes.map((n) => [n.id, n.status, n.path, n.rttMs])).toEqual([
      ['a', 'direct', 'direct', 3],
      ['b', 'relay', 'relay', 40],
      ['c', 'unlinked', null, null],
      ['d', 'attention', null, null],
      ['e', 'offline', null, null],
      ['f', 'attention', null, null],
    ]);
    expect(model.byId.get('d')?.attention).toBe('peer-control-off');
    expect(model.byId.get('f')?.attention).toBe('unresponsive');
    expect(model.stats).toEqual({ total: 6, online: 5, direct: 1, relay: 1, unlinked: 1, attention: 2, offline: 1 });
  });

  it('手机是控制端,没开被控不算要处理;对方没开被控但本机熔断无响应时按无响应', () => {
    const model = buildTopology({
      ...base,
      devices: [device({ deviceId: 'phone', platform: 'ios', remoteControlEnabled: false }), device({ deviceId: 'pc', remoteControlEnabled: false })],
      links: [],
      unresponsive: ['pc'],
    });
    expect(model.byId.get('phone')?.status).toBe('unlinked');
    expect(model.byId.get('pc')?.attention).toBe('unresponsive');
  });

  // 用户反馈(2026-11-06):按延迟排,延迟一刷新图块就换位置。组内只按名字排(数字按数值)。
  it('组内只按名字排,往返变化不改顺序', () => {
    const devices = [
      device({ deviceId: 'z', name: 'Zed' }),
      device({ deviceId: 'y', name: 'Amy' }),
      device({ deviceId: 'x', name: 'Box 10' }),
      device({ deviceId: 'w', name: 'Box 9' }),
    ];
    const first = buildTopology({
      ...base,
      devices,
      links: [link('z', 'direct', 9), link('y', 'direct', null), link('x', 'direct', 2), link('w', 'direct', 300)],
    });
    expect(first.groups[0]?.rows).toEqual(['y', 'w', 'x', 'z']);
    const later = buildTopology({
      ...base,
      devices,
      links: [link('z', 'direct', 1), link('y', 'direct', 500), link('x', 'direct', null), link('w', 'direct', 4)],
    });
    expect(later.groups[0]?.rows).toEqual(first.groups[0]?.rows);
  });
});

describe('buildTopology:分组、分边、折叠、拆分', () => {
  it('离线两台起折成一行,showOffline 后逐台展开', () => {
    const devices = [device({ deviceId: 'a' }), device({ deviceId: 'o1', online: false }), device({ deviceId: 'o2', online: false })];
    const folded = buildTopology({ ...base, devices, links: [] });
    const offline = folded.groups.find((g) => g.key === 'offline');
    expect(offline?.collapsed).toBe(true);
    expect(offline?.rows).toEqual([OFFLINE_FOLD_ID]);
    expect(offline?.ids).toEqual(['o1', 'o2']);
    const shown = buildTopology({ ...base, devices, links: [], showOffline: true });
    expect(shown.groups.find((g) => g.key === 'offline')?.rows).toEqual(['o1', 'o2']);
    // 只有一台离线不折
    const one = buildTopology({ ...base, devices: devices.slice(0, 2), links: [] });
    expect(one.groups.find((g) => g.key === 'offline')?.rows).toEqual(['o1']);
  });

  it('直连超过 6 台对半分成两组;经中转的一组共用中转站不拆', () => {
    const many = Array.from({ length: 8 }, (_, i) => device({ deviceId: `d${i}` }));
    const direct = buildTopology({ ...base, devices: many, links: many.map((d) => link(d.deviceId, 'direct', 1)) });
    expect(direct.groups.map((g) => [g.id, g.rows.length])).toEqual([
      ['direct', 4],
      ['direct#2', 4],
    ]);
    const relay = buildTopology({ ...base, devices: many, links: many.map((d) => link(d.deviceId, 'relay', 1)) });
    expect(relay.groups.map((g) => [g.id, g.rows.length])).toEqual([['relay', 8]]);
    expect(direct.dense).toBe(false);
    expect(buildTopology({ ...base, devices: [...many, device({ deviceId: 'd8' })], links: [] }).dense).toBe(true);
  });

  it('贪心分边:行少的一边优先,右边先', () => {
    expect(assignSides([{ rows: ['a', 'b', 'c'] }, { rows: ['d'] }, { rows: ['e', 'f'] }, { rows: ['g'] }])).toEqual([1, -1, -1, 1]);
  });
});

describe('layoutTopology / groupLines', () => {
  it('每行一个图块位置,中转组有中转站,线从中间圆盘边缘出发到图块边上', () => {
    const model = buildTopology({
      ...base,
      devices: [device({ deviceId: 'a' }), device({ deviceId: 'b' }), device({ deviceId: 'c' })],
      links: [link('a', 'direct', 1), link('b', 'relay', 1), link('c', 'relay', 2)],
    });
    const layout = layoutTopology(model.groups, 920, false);
    expect(layout.rows.size).toBe(3);
    expect(layout.hub).toEqual({ x: 460, y: layout.h / 2 });
    const relayGroup = model.groups.find((g) => g.key === 'relay')!;
    const relayLayout = layout.groups.find((g) => g.id === 'relay')!;
    expect(relayLayout.relay).not.toBeNull();
    const lines = groupLines(layout, relayGroup);
    // 线从圆盘外的细环出发
    expect(lines.toRelay?.d.startsWith(`M ${460 + relayGroup.side * layout.m.ring} `)).toBe(true);
    expect(lines.rows.map((r) => r.id)).toEqual(['b', 'c']);
    const direct = groupLines(layout, model.groups.find((g) => g.key === 'direct')!);
    expect(direct.toRelay).toBeNull();
    expect(direct.rows[0]?.d).not.toContain('NaN');
  });

  it('窄一些时距离按比例收,最窄六成', () => {
    const wide = layoutTopology([], 920, false).m;
    const narrow = layoutTopology([], 300, false).m;
    expect(narrow.tile).toBe(Math.round(wide.tile * 0.6));
    expect(narrow.bend).toBe(Math.round(wide.bend * 0.6));
  });
});

// 用户要求(2026-11-06):正在操作某台机器时线上要有消息在走;只认真实业务收发,闲着的线静止。
describe('消息流向', () => {
  it('窗口内发出 / 收到分别是 out / in,都有是 both,窗口外或从没收发为 null', () => {
    expect(flowOf({ sentAgoMs: 0, receivedAgoMs: null })).toBe('out');
    expect(flowOf({ sentAgoMs: FLOW_WINDOW_MS + 1, receivedAgoMs: FLOW_WINDOW_MS })).toBe('in');
    expect(flowOf({ sentAgoMs: 10, receivedAgoMs: 20 })).toBe('both');
    expect(flowOf({ sentAgoMs: FLOW_WINDOW_MS + 1, receivedAgoMs: null })).toBeNull();
    expect(flowOf({ sentAgoMs: null, receivedAgoMs: null })).toBeNull();
    expect(mergeFlows(['out', null, 'in'])).toBe('both');
    expect(mergeFlows([null, 'in'])).toBe('in');
    expect(mergeFlows([])).toBeNull();
  });

  // 用户反馈(2026-11-07):一问一答时行字在「发送中 / 收发中」之间来回跳,晃眼。
  it('行字的流向:另一个方向在 LABEL_HOLD_MS 内有过就写收发中;线的流向不变', () => {
    expect(flowTextOf({ sentAgoMs: 100, receivedAgoMs: 9_000 })).toBe('both');
    expect(flowOf({ sentAgoMs: 100, receivedAgoMs: 9_000 })).toBe('out');
    expect(flowTextOf({ sentAgoMs: 9_000, receivedAgoMs: 100 })).toBe('both');
    expect(flowTextOf({ sentAgoMs: 100, receivedAgoMs: LABEL_HOLD_MS + 1 })).toBe('out');
    expect(flowTextOf({ sentAgoMs: 100, receivedAgoMs: null })).toBe('out');
    expect(flowTextOf({ sentAgoMs: FLOW_WINDOW_MS + 1, receivedAgoMs: 9_000 })).toBeNull();
    expect(flowTextOf({ sentAgoMs: 100, receivedAgoMs: 200 })).toBe('both');
  });

  it('只有直连 / 经中转的设备有流向;中转站那一段是经中转设备的合集', () => {
    const model = buildTopology({
      ...base,
      devices: [
        device({ deviceId: 'a' }),
        device({ deviceId: 'b' }),
        device({ deviceId: 'c' }),
        device({ deviceId: 'd', remoteControlEnabled: false }),
        device({ deviceId: 'e', online: false }),
      ],
      links: [
        link('a', 'direct', 1, true, 100, null),
        link('b', 'relay', 50, true, null, 100),
        link('c', 'relay', 50, true, 100, null),
        // 要处理的设备即使有收发也不画流动
        link('d', 'direct', 1, true, 100, 100),
        // 没就绪的链路不算
        link('e', 'direct', 1, false, 100, 100),
      ],
    });
    expect(model.nodes.map((n) => [n.id, n.flow])).toEqual([
      ['a', 'out'],
      ['b', 'in'],
      ['c', 'out'],
      ['d', null],
      ['e', null],
    ]);
    expect(model.relay.flow).toBe('both');
  });

});

// 用户裁决(2026-11-07):有消息时绿线变成朝消息方向流动的虚线,不用光点。
describe('消息流动:流动的虚线', () => {
  it('按弧长等距取样,首尾就是线的两端', () => {
    const model = buildTopology({ ...base, devices: [device({ deviceId: 'a' })], links: [link('a', 'direct', 1)] });
    const layout = layoutTopology(model.groups, 920, false);
    const row = groupLines(layout, model.groups[0]!).rows[0]!;
    const { points, length } = samplePath(row.shape);
    expect(points[0]).toMatchObject({ x: row.shape.a.x, y: row.shape.a.y });
    expect(points.at(-1)).toMatchObject({ x: row.shape.b!.x, y: row.shape.b!.y });
    expect(length).toBeGreaterThan(Math.abs(row.shape.b!.x - row.shape.a.x));
    const gaps = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1);
  });

  // 截图里发现:水平朝左的线角度在 ±180° 间跳,按角度插值会绕远路。
  it('角度连续:朝左的水平线相邻两点不跳 180°', () => {
    const left = samplePath({ a: { x: 300, y: 50 }, c1: { x: 250, y: 50 }, c2: { x: 250, y: 50.0000001 }, k: { x: 200, y: 50 }, b: { x: 100, y: 50 } });
    const jumps = left.points.slice(1).map((p, i) => Math.abs(p.angle - left.points[i]!.angle));
    expect(Math.max(...jumps)).toBeLessThan(5);
  });

  it('虚线的空隙匀速走完全程,两端透明、中间到 peak;顺着线摆,反向从线尾出发并调头;只动 transform / opacity', () => {
    const model = buildTopology({ ...base, devices: [device({ deviceId: 'a' })], links: [link('a', 'direct', 1)] });
    const row = groupLines(layoutTopology(model.groups, 920, false), model.groups[0]!).rows[0]!;
    const { points, length } = samplePath(row.shape);
    const out = speckKeyframes(points, length, false, 0.85);
    const last = out.length - 1;
    expect(out.map((k) => k.offset)).toEqual(out.map((_, i) => i / last));
    expect(out[0]).toMatchObject({ offset: 0, opacity: 0 });
    expect(out[last]).toMatchObject({ offset: 1, opacity: 0 });
    expect(out[Math.floor(last / 2)]).toMatchObject({ opacity: 0.85 });
    expect(out.every((k) => Object.keys(k).sort().join() === 'offset,opacity,transform')).toBe(true);
    const r = (n: number) => Math.round(n * 10) / 10;
    expect(out[1]!.transform).toContain(`rotate(${r(points[1]!.angle)}deg) translate(${-SPECK_W / 2}px, ${-SPECK_H / 2}px)`);
    const back = speckKeyframes(points, length, true);
    const end = points.at(-1)!;
    expect(back[0]!.transform).toContain(`translate(${r(end.x)}px, ${r(end.y)}px) rotate(${r(end.angle + 180)}deg)`);
  });

  it('所有线一样快,空隙按线长均匀排满', () => {
    for (const length of [60, 180, 260, 340]) {
      const { count, duration } = streamFor(length);
      expect(length / (duration / 1000)).toBeCloseTo(SPEED, 5);
      expect(count).toBeGreaterThanOrEqual(3);
      expect(length / count).toBeGreaterThan(SPACING * 0.75);
      expect(length / count).toBeLessThan(SPACING * 1.5);
    }
  });

  it('手机图块更窄:线画到它边上,延迟标签仍和电脑方块对齐成一列', () => {
    const model = buildTopology({
      ...base,
      devices: [device({ deviceId: 'mac' }), device({ deviceId: 'phone', platform: 'ios' })],
      links: [link('mac', 'direct', 1), link('phone', 'direct', 1)],
    });
    const layout = layoutTopology(model.groups, 920, false);
    const group = model.groups[0]!;
    const lines = groupLines(layout, group, (id) => (id === 'phone' ? 12 : layout.m.half)).rows;
    const mac = lines.find((r) => r.id === 'mac')!;
    const phone = lines.find((r) => r.id === 'phone')!;
    expect(Math.abs(phone.shape.b!.x - layout.cx)).toBe(Math.abs(mac.shape.b!.x - layout.cx) + (layout.m.half - 12));
    expect(phone.at.x).toBe(mac.at.x);
  });
});

describe('appendPresenceEvent', () => {
  it('最新在前,同一设备连续相同状态只记一次,最多 20 条', () => {
    let list = appendPresenceEvent([], { deviceId: 'a', name: 'A', online: true, at: 1 });
    list = appendPresenceEvent(list, { deviceId: 'a', name: 'A', online: true, at: 2 });
    expect(list).toHaveLength(1);
    list = appendPresenceEvent(list, { deviceId: 'a', name: 'A', online: false, at: 3 });
    expect(list.map((e) => e.at)).toEqual([3, 1]);
    for (let i = 0; i < 30; i++) list = appendPresenceEvent(list, { deviceId: `d${i}`, name: 'D', online: true, at: 10 + i });
    expect(list).toHaveLength(20);
  });
});

describe('useRemoteConnectionV2 持久化', () => {
  // Main now owns the setting: a rejected start must not display an enabled transport, and late replies cannot undo a newer choice.
  it('waits for the host commit, preserves the old value on failure and ignores a stale toggle reply', async () => {
    const previous = Object.getOwnPropertyDescriptor(window, 'electronAPI');
    const replies: Array<(value: unknown) => void> = [];
    const command = vi.fn(() => new Promise((resolve) => replies.push(resolve)));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { selfHostedRelay: { command } } });
    _resetRemoteConnectionV2ForTests(); localStorage.removeItem('remoteConnection.v2');
    try {
      const failed = setRemoteConnectionV2Enabled(true);
      expect(getRemoteConnectionV2Enabled()).toBe(false);
      replies.shift()!({ error: 'START_FAILED', state: { agentNetEnabled: false } });
      await expect(failed).rejects.toThrow('START_FAILED');
      expect(getRemoteConnectionV2Enabled()).toBe(false);
      const first = setRemoteConnectionV2Enabled(true), second = setRemoteConnectionV2Enabled(false);
      replies[1]({ state: { agentNetEnabled: false } }); await second;
      replies[0]({ state: { agentNetEnabled: true } }); await first;
      expect(getRemoteConnectionV2Enabled()).toBe(false); expect(localStorage.getItem('remoteConnection.v2')).toBeNull();
      const encryption = setRemoteConnectionOnlyEncrypted(true);
      expect(getRemoteConnectionOnlyEncrypted()).toBe(false);
      replies[2]({ state: { agentNetEnabled: false, agentNetOnlyEncrypted: true } }); await encryption;
      expect(getRemoteConnectionOnlyEncrypted()).toBe(true);
    } finally {
      if (previous) Object.defineProperty(window, 'electronAPI', previous); else Reflect.deleteProperty(window, 'electronAPI');
      _resetRemoteConnectionV2ForTests(); localStorage.removeItem('remoteConnection.v2');
    }
  });
  it('只存 override:开写 on,关删 key,坏值当默认关', () => {
    _resetRemoteConnectionV2ForTests();
    localStorage.removeItem('remoteConnection.v2');
    expect(getRemoteConnectionV2Enabled()).toBe(false);
    setRemoteConnectionV2Enabled(true);
    expect(localStorage.getItem('remoteConnection.v2')).toBe('on');
    expect(getRemoteConnectionV2Enabled()).toBe(true);
    setRemoteConnectionV2Enabled(false);
    expect(localStorage.getItem('remoteConnection.v2')).toBeNull();
    _resetRemoteConnectionV2ForTests();
    localStorage.setItem('remoteConnection.v2', 'yes');
    expect(getRemoteConnectionV2Enabled()).toBe(false);
    localStorage.removeItem('remoteConnection.v2');
    _resetRemoteConnectionV2ForTests();
  });
});
