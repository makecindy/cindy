/**
 * usePeerLinks —— 远程连接拓扑的「本机已建链对端」快照(路径 / 往返 / 最近业务收发)。
 * ---------------------------------------------------------------------------
 * 结构变化(建链 / 断链 / 直连↔中转)由主进程 push 全量快照;往返和业务收发没有事件钩子
 * (每条消息都推会太吵),页面可见时每 2 秒拉一次:消息开始走后两秒内线上就动起来,
 * 停下后几秒内静止(窗口见 topologyModel.FLOW_WINDOW_MS)。只读本机内存,不发任何帧。
 * 页面不在时不拉、不订阅。每份快照记下取到的时刻(takenAt);takenAt > 0 表示第一份快照已到,
 * 拓扑据此判断打开页面后的首批数据是否到齐(到齐前不做位置过渡和动效)。
 */

import { useEffect, useState } from 'react';

const POLL_MS = 2_000;

export interface PeerLinksState extends DeviceLinkPeerLinksSnapshot {
  /** 取到这份快照的时刻(渲染进程时钟);空快照为 0 */
  takenAt: number;
}

const EMPTY: PeerLinksState = { links: [], relayRttMs: null, takenAt: 0 };

export function usePeerLinks(active: boolean): PeerLinksState {
  const [snapshot, setSnapshot] = useState<PeerLinksState>(EMPTY);

  useEffect(() => {
    const api = window.electronAPI?.deviceLink;
    if (!active || !api?.getPeerLinks) {
      setSnapshot(EMPTY);
      return undefined;
    }
    let alive = true;
    const pull = () => {
      if (document.visibilityState !== 'visible') return;
      api.getPeerLinks().then(
        (next) => { if (alive) setSnapshot({ ...next, takenAt: Date.now() }); },
        () => undefined, // 瞬时失败保留上一份;结构变化会再推一次
      );
    };
    pull();
    const off = api.onPeerLinksChanged?.((next) => { if (alive) setSnapshot({ ...next, takenAt: Date.now() }); });
    const timer = setInterval(pull, POLL_MS);
    return () => {
      alive = false;
      off?.();
      clearInterval(timer);
    };
  }, [active]);

  return snapshot;
}
