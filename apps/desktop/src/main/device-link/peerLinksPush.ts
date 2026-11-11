/**
 * peerLinksPush —— 远程连接拓扑页的「对端链路变化」推送合并器。
 * ---------------------------------------------------------------------------
 * 建链 / 断链 / 直连↔relay 切换往往连发好几个事件（detachDirectPath → emitPeerPathChanged，
 * markPeerLinkDown → onPeerTransportReset / 路由离线…）。这里只保留一个定时器：事件只负责
 * `schedule()`，到点取一次快照，**结构**没变就不广播。RTT 连续变化不算结构变化——它由渲染层
 * 在页面可见时轮询拿，推送只表达拓扑变了。纯函数 + 注入的快照 / 广播，便于单测。
 *
 * 事件订阅放在这里的 `attach(client)`，而不是写进 index.ts 里那些回调：那些回调会被测试逐段
 * 提取到沙箱里执行，引用模块级变量就会炸。入站接受（对端主动连本机）没有客户端事件，由渲染层
 * 的 5 秒轮询补上；用户主动断链同理。
 */

import type { DeviceLinkClient } from '@cindy/device-link';

import type { DeviceLinkPeerLinksSnapshot } from '../../shared/deviceLinkIpc';

/** 会改变拓扑结构的客户端事件；每个都返回退订函数。 */
export type PeerLinksEventSource = Pick<
  DeviceLinkClient,
  'onPeerStreamAccepted' | 'onPeerPathChanged' | 'onPeerTransportReset' | 'onPeerRouteStateChanged' | 'onStatusChange'
>;

export interface PeerLinksPushScheduler {
  /** 事件钩子调用：去抖后比较结构、变了才广播。 */
  schedule(): void;
  /** 订阅一段链路上会改变拓扑结构的事件；再次 attach 或 dispose 时退订。 */
  attach(client: PeerLinksEventSource): void;
  /** 链路拆除时调用：退订、清掉待发定时器并忘记上次 key，下一段链路重新比较。 */
  dispose(): void;
}

const DEFAULT_DEBOUNCE_MS = 250;

/** 不含 rttMs 的结构 key：同一组 (deviceId, path, open) 视为同一拓扑。 */
export function peerLinksStructureKey(snapshot: DeviceLinkPeerLinksSnapshot): string {
  return snapshot.links
    .map((link) => `${link.deviceId}|${link.path}|${link.open ? 1 : 0}`)
    .sort()
    .join('\n');
}

export function createPeerLinksPushScheduler(opts: {
  snapshot: () => DeviceLinkPeerLinksSnapshot;
  broadcast: (snapshot: DeviceLinkPeerLinksSnapshot) => void;
  debounceMs?: number;
}): PeerLinksPushScheduler {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey: string | null = null;
  let detach: Array<() => void> = [];

  const fire = (): void => {
    timer = null;
    const snapshot = opts.snapshot();
    const key = peerLinksStructureKey(snapshot);
    if (key === lastKey) return;
    lastKey = key;
    opts.broadcast(snapshot);
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(fire, debounceMs);
    // 主进程退出不等这个定时器。
    (timer as { unref?: () => void }).unref?.();
  };

  const unsubscribeAll = (): void => {
    for (const off of detach) off();
    detach = [];
  };

  return {
    schedule,
    attach(client) {
      unsubscribeAll();
      detach = [
        client.onPeerStreamAccepted(schedule),
        client.onPeerPathChanged(schedule),
        client.onPeerTransportReset(schedule),
        client.onPeerRouteStateChanged(schedule),
        client.onStatusChange(schedule),
      ];
    },
    dispose() {
      unsubscribeAll();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      lastKey = null;
    },
  };
}
