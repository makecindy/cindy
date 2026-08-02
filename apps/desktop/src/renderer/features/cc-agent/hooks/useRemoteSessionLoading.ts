/**
 * useRemoteSessionLoading —— 远程会话首屏「正在从被控端加载」态(控制端,慢网可见性)。
 * ---------------------------------------------------------------------------
 * device-link 远程会话的历史 / 元数据来自被控端,经隧道往返(网络),不像本机 DB 即时。
 * 慢网下 `historyLoaded=false` 期间消息区是空的,用户分不清「空会话」还是「在等被控端」。
 * 本 hook 在这段给出 loading 信号——但**仅远程会话**(本机会话零回归,守住 DESIGN/规则 7
 * 「本地无 loading」),且**延迟 delayMs 才亮**:快隧道(秒回)不闪 loader,直击历史上因
 * 首屏闪烁而移除占位的教训。
 *
 * 决策抽成纯函数 shouldShowRemoteLoading 便于 node 单测;hook 只管延迟 timer 这点副作用。
 */

import { useEffect, useState } from 'react';

/** 默认防闪延迟:< 250ms 到货不显示 loader。 */
export const REMOTE_LOADING_DELAY_MS = 250;

/**
 * 纯判定:是否显示远程首屏 loading。
 *  - isRemote=false(本机会话)→ 永不显示(零回归)。
 *  - historyLoaded=true → 已就位,不显示。
 *  - delayElapsed=false → 还在防闪窗口内,不显示(避免快隧道闪一下)。
 *  - hasMessages=true → 屏上已经有内容(冷缓存 hydrate 出的最近一页,见
 *    features/device-link/mirrorCacheClient.ts),覆盖层就没有存在意义了:
 *    它会盖在已经可读的消息上,反而比空白更糟。
 */
export function shouldShowRemoteLoading(
  isRemote: boolean,
  historyLoaded: boolean,
  delayElapsed: boolean,
  hasMessages = false,
): boolean {
  return isRemote && !historyLoaded && delayElapsed && !hasMessages;
}

/**
 * 远程会话首屏 loading 可见性。remoteDeviceId 为空(本机)恒为 false。
 * 进入「远程 + 未加载」条件后启动 delayMs 计时;到期才允许显示;条件离开(加载完成 /
 * 切到本机 / 换设备 / 缓存已把内容画出来)立即复位 + 清计时,确保不残留、不闪。
 */
export function useRemoteSessionLoading(
  remoteDeviceId: string | undefined,
  historyLoaded: boolean,
  hasMessages = false,
  delayMs: number = REMOTE_LOADING_DELAY_MS,
): boolean {
  const isRemote = !!remoteDeviceId;
  const [delayElapsed, setDelayElapsed] = useState(false);

  useEffect(() => {
    if (!isRemote || historyLoaded || hasMessages) {
      setDelayElapsed(false);
      return;
    }
    setDelayElapsed(false);
    const timer = setTimeout(() => setDelayElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [isRemote, historyLoaded, hasMessages, remoteDeviceId, delayMs]);

  return shouldShowRemoteLoading(isRemote, historyLoaded, delayElapsed, hasMessages);
}
