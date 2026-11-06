/**
 * usePeerLinks —— 远程连接拓扑的「本机已建链对端」快照(路径 / 往返)。
 * ---------------------------------------------------------------------------
 * 结构变化(建链 / 断链 / 直连↔中转)由主进程 push 全量快照;往返延迟没有事件钩子,
 * 页面可见时每 5 秒拉一次。页面不在时不拉、不订阅。
 */

import { useEffect, useState } from 'react';

const RTT_POLL_MS = 5_000;
const EMPTY: DeviceLinkPeerLinksSnapshot = { links: [], relayRttMs: null };

export function usePeerLinks(active: boolean): DeviceLinkPeerLinksSnapshot {
  const [snapshot, setSnapshot] = useState<DeviceLinkPeerLinksSnapshot>(EMPTY);

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
        (next) => { if (alive) setSnapshot(next); },
        () => undefined, // 瞬时失败保留上一份;结构变化会再推一次
      );
    };
    pull();
    const off = api.onPeerLinksChanged?.((next) => { if (alive) setSnapshot(next); });
    const timer = setInterval(pull, RTT_POLL_MS);
    return () => {
      alive = false;
      off?.();
      clearInterval(timer);
    };
  }, [active]);

  return snapshot;
}
