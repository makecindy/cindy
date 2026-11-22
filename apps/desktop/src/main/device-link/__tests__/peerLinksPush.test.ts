/**
 * peerLinksPush —— 远程连接拓扑的推送合并器。
 * 生产入口:index.ts 调一次 `attach(client)`,建链 / 断链 / 路径切换 / 上下线事件都只触发 `schedule()`,
 * 250ms 后结构变了才广播。
 * 规则依据:engineering-conventions §2(push 合并、不按 RTT 抖动广播)。
 * 现有覆盖缺口:新模块。最小失败输入:连发 5 次 schedule 只许 1 次广播;只变 rttMs 不许广播;dispose 后不许广播;
 * attach 漏订阅任一事件(index.ts 的回调被测试逐段提取执行,订阅不能写回那里)。
 * tier:unit。实测耗时:fake timers,<1s。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPeerLinksPushScheduler, peerLinksStructureKey } from '../peerLinksPush';
import type { DeviceLinkPeerLinksSnapshot, DeviceLinkPeerLinkView } from '../../../shared/deviceLinkIpc';

type LinkInput = Omit<DeviceLinkPeerLinkView, 'sentAgoMs' | 'receivedAgoMs'>
  & Partial<Pick<DeviceLinkPeerLinkView, 'sentAgoMs' | 'receivedAgoMs'>>;

function snap(links: LinkInput[], relayRttMs: number | null = 20): DeviceLinkPeerLinksSnapshot {
  return { links: links.map((l) => ({ sentAgoMs: null, receivedAgoMs: null, ...l })), relayRttMs };
}

describe('createPeerLinksPushScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('连发多次 schedule 只在去抖后广播一次,且广播的是到点时的快照', () => {
    let current = snap([{ deviceId: 'a', path: 'relay', rttMs: null, open: false }]);
    const broadcast = vi.fn();
    const s = createPeerLinksPushScheduler({ snapshot: () => current, broadcast });
    for (let i = 0; i < 5; i += 1) s.schedule();
    current = snap([{ deviceId: 'a', path: 'direct', rttMs: 3, open: true }]);
    expect(broadcast).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(broadcast).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(current);
  });

  it('只有 rttMs 变化不广播;path / open 变化才广播', () => {
    let current = snap([{ deviceId: 'a', path: 'relay', rttMs: 10, open: true }]);
    const broadcast = vi.fn();
    const s = createPeerLinksPushScheduler({ snapshot: () => current, broadcast });
    s.schedule();
    vi.advanceTimersByTime(250);
    expect(broadcast).toHaveBeenCalledTimes(1);

    current = snap([{ deviceId: 'a', path: 'relay', rttMs: 99, open: true }], 55);
    s.schedule();
    vi.advanceTimersByTime(250);
    expect(broadcast).toHaveBeenCalledTimes(1);

    current = snap([{ deviceId: 'a', path: 'direct', rttMs: 99, open: true }]);
    s.schedule();
    vi.advanceTimersByTime(250);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  // MagicLizi was already reachable without a control link. Unit: an empty links list
  // with a changing transport route must produce the same pushes as a business link.
  it('publishes transport changes before a control link is opened', () => {
    let current = snap([]);
    const broadcast = vi.fn();
    const scheduler = createPeerLinksPushScheduler({ snapshot: () => current, broadcast });
    const publish = (agentNetRoutes: DeviceLinkPeerLinksSnapshot['agentNetRoutes']) => {
      current = { ...current, agentNetRoutes };
      scheduler.schedule();
      vi.advanceTimersByTime(250);
    };

    publish([{ deviceId: 'a', path: 'connecting', rttMs: null }]);
    publish([{ deviceId: 'a', path: 'relay', rttMs: 20 }]);
    publish([{ deviceId: 'a', path: 'relay', rttMs: 25 }]);
    publish([{ deviceId: 'a', path: 'direct', rttMs: 3 }]);
    publish([]);

    expect(broadcast.mock.calls.map(([snapshot]) => snapshot.agentNetRoutes[0]?.path ?? null))
      .toEqual(['connecting', 'relay', 'direct', null]);
  });

  it('dispose 取消待发广播并忘记上次结构,下一段链路从头比较', () => {
    const current = snap([{ deviceId: 'a', path: 'relay', rttMs: null, open: true }]);
    const broadcast = vi.fn();
    const s = createPeerLinksPushScheduler({ snapshot: () => current, broadcast });
    s.schedule();
    s.dispose();
    vi.advanceTimersByTime(250);
    expect(broadcast).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // 同一份结构在 dispose 之后再次 schedule 要重新广播(新链路的首个快照)。
    s.schedule();
    vi.advanceTimersByTime(250);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('attach 订阅五种结构事件,每种都能触发广播;dispose 退订后事件不再广播', () => {
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const hook = (name: string) => (cb: (...args: unknown[]) => void) => {
      const set = handlers.get(name) ?? new Set();
      set.add(cb);
      handlers.set(name, set);
      return () => set.delete(cb);
    };
    const client = {
      onPeerStreamAccepted: hook('accepted'),
      onPeerPathChanged: hook('path'),
      onPeerTransportReset: hook('reset'),
      onPeerRouteStateChanged: hook('route'),
      onStatusChange: hook('status'),
    };
    let current = snap([]);
    const broadcast = vi.fn();
    const s = createPeerLinksPushScheduler({ snapshot: () => current, broadcast });
    s.attach(client as unknown as Parameters<typeof s.attach>[0]);
    let n = 0;
    for (const name of ['accepted', 'path', 'reset', 'route', 'status']) {
      n += 1;
      current = snap([{ deviceId: `d${n}`, path: 'direct', rttMs: 1, open: true }]);
      for (const cb of handlers.get(name) ?? []) cb();
      vi.advanceTimersByTime(250);
      expect(broadcast, name).toHaveBeenCalledTimes(n);
    }
    s.dispose();
    for (const set of handlers.values()) expect(set.size).toBe(0);
  });

  // 2026-11-18 用户要求拓扑中间那台电脑也写出它实际用的连接方式。主连接重连换了传输时对端集合可能完全不变，
  // 原来的 key 只看对端，推送会被吞掉、要等下一次 2 秒轮询。最小失败输入：links 相同、relayProtocol 从 agent-net 变为 device-link。tier:unit。
  it('本机主连接换了传输(Agent-Net ↔ Device Link)即使对端没变也广播', () => {
    const links: LinkInput[] = [{ deviceId: 'a', path: 'relay', rttMs: 10, open: true }];
    let current: DeviceLinkPeerLinksSnapshot = { ...snap(links), relayProtocol: 'agent-net' };
    const broadcast = vi.fn();
    const s = createPeerLinksPushScheduler({ snapshot: () => current, broadcast });
    s.schedule();
    vi.advanceTimersByTime(250);
    expect(broadcast).toHaveBeenCalledTimes(1);

    current = { ...snap(links), relayProtocol: 'device-link' };
    s.schedule();
    vi.advanceTimersByTime(250);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith(current);
  });

  // 2026-11-18 用户要求中转点写出 Agent-Net 走的是 UDP 还是 WS:只换了这条路(UDP 不通退回 WebSocket)也要马上推，
  // 否则页面要等下一次轮询才改字。最小失败输入:同一 Agent-Net 主连接,relayTransport 从 udp 变成 websocket。
  it('经中转的数据在 UDP 与 WebSocket 之间切换也广播', () => {
    const links: LinkInput[] = [{ deviceId: 'a', path: 'relay', rttMs: 10, open: true }];
    let current: DeviceLinkPeerLinksSnapshot = { ...snap(links), relayProtocol: 'agent-net', relayTransport: 'udp' };
    const broadcast = vi.fn();
    const s = createPeerLinksPushScheduler({ snapshot: () => current, broadcast });
    s.schedule();
    vi.advanceTimersByTime(250);
    expect(broadcast).toHaveBeenCalledTimes(1);

    current = { ...snap(links, 42), relayProtocol: 'agent-net', relayTransport: 'websocket' };
    s.schedule();
    vi.advanceTimersByTime(250);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith(current);
  });

  it('结构 key 与顺序无关、忽略 rttMs 与业务收发时刻', () => {
    const a = snap([
      { deviceId: 'b', path: 'relay', rttMs: 1, open: true, sentAgoMs: 10 },
      { deviceId: 'a', path: 'direct', rttMs: 2, open: false },
    ]);
    const b = snap([
      { deviceId: 'a', path: 'direct', rttMs: null, open: false, receivedAgoMs: 3 },
      { deviceId: 'b', path: 'relay', rttMs: 77, open: true },
    ], null);
    expect(peerLinksStructureKey(a)).toBe(peerLinksStructureKey(b));
  });
});
