// @vitest-environment jsdom
/**
 * 远程连接 V2 拓扑的纯状态推导(jsdom 只为最后一组 localStorage 用例)。
 * 规则依据:docs/product-rules/agent-net.md「界面」+ 本页裁决(克制模式);
 * 设备状态五档与分组 / 分边 / 折叠规则是用户在设计稿上确认的,改坏了拓扑就画错。
 * 覆盖缺口:新模块,此前无覆盖。最小失败输入:见各用例。
 * tier:unit。实测耗时:纯函数,<1s。
 */

import { describe, expect, it } from 'vitest';

import { OFFLINE_FOLD_ID, assignSides, buildTopology, rttTone } from '../topologyModel';
import { groupLines, layoutTopology } from '../topologyGeometry';
import { appendPresenceEvent } from '../useRecentPresence';
import {
  _resetRemoteConnectionV2ForTests,
  getRemoteConnectionV2Enabled,
  setRemoteConnectionV2Enabled,
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

const base = {
  relayRttMs: 20,
  relayName: 'Cindy',
  selfHosted: false,
  controlledBy: [] as string[],
  unresponsive: [] as string[],
  showOffline: false,
};

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
        { deviceId: 'a', path: 'direct', rttMs: 3, open: true },
        { deviceId: 'b', path: 'relay', rttMs: 40, open: true },
        // 还没就绪的链路不算建链
        { deviceId: 'c', path: 'direct', rttMs: 5, open: false },
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

  it('组内按往返升序,没测到的靠后再按名字', () => {
    const model = buildTopology({
      ...base,
      devices: [device({ deviceId: 'z', name: 'Zed' }), device({ deviceId: 'y', name: 'Amy' }), device({ deviceId: 'x', name: 'Bob' })],
      links: [
        { deviceId: 'z', path: 'direct', rttMs: 9, open: true },
        { deviceId: 'x', path: 'direct', rttMs: 2, open: true },
        { deviceId: 'y', path: 'direct', rttMs: null, open: true },
      ],
    });
    expect(model.groups[0]?.rows).toEqual(['x', 'z', 'y']);
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
    const direct = buildTopology({ ...base, devices: many, links: many.map((d) => ({ deviceId: d.deviceId, path: 'direct' as const, rttMs: 1, open: true })) });
    expect(direct.groups.map((g) => [g.id, g.rows.length])).toEqual([
      ['direct', 4],
      ['direct#2', 4],
    ]);
    const relay = buildTopology({ ...base, devices: many, links: many.map((d) => ({ deviceId: d.deviceId, path: 'relay' as const, rttMs: 1, open: true })) });
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
      links: [
        { deviceId: 'a', path: 'direct', rttMs: 1, open: true },
        { deviceId: 'b', path: 'relay', rttMs: 1, open: true },
        { deviceId: 'c', path: 'relay', rttMs: 2, open: true },
      ],
    });
    const layout = layoutTopology(model.groups, 920, false);
    expect(layout.rows.size).toBe(3);
    expect(layout.hub).toEqual({ x: 460, y: layout.h / 2 });
    const relayGroup = model.groups.find((g) => g.key === 'relay')!;
    const relayLayout = layout.groups.find((g) => g.id === 'relay')!;
    expect(relayLayout.relay).not.toBeNull();
    const lines = groupLines(layout, relayGroup);
    expect(lines.toRelay?.d.startsWith(`M ${460 + relayGroup.side * 30} `)).toBe(true);
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

describe('rttTone', () => {
  it('≤15 快、≥80 慢、中间与未知不上色', () => {
    expect([rttTone(0), rttTone(15), rttTone(16), rttTone(79), rttTone(80), rttTone(null)]).toEqual([
      'fast',
      'fast',
      'plain',
      'plain',
      'slow',
      'plain',
    ]);
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
