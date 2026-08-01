import { useEffect, useRef, useState } from 'react';

/**
 * 为依赖远端一次性快照的页面提供有意义的重试代次。
 *
 * relay 恢复 online，或当前目标设备从离线恢复 online 时自增；其它设备的
 * presence 与目标设备在线期间的 busy/name 变化不会制造额外重拉。
 */
export function useDeviceLinkReconnectEpoch(deviceId: string | undefined): number {
  const [epoch, setEpoch] = useState(0);
  const targetOnlineRef = useRef<boolean | null>(null);
  const relayStatusRef = useRef<'stopped' | 'connecting' | 'online' | null>(null);

  useEffect(() => {
    targetOnlineRef.current = null;
    relayStatusRef.current = null;
    if (!deviceId) return;

    const bump = (): void => setEpoch((current) => current + 1);
    const offPresence = window.electronAPI.deviceLink.onPresenceChanged((snapshot) => {
      if (snapshot.deviceId !== deviceId) return;
      const wasOnline = targetOnlineRef.current;
      targetOnlineRef.current = snapshot.online;
      if (snapshot.online && wasOnline !== true) bump();
    });
    const offStatus = window.electronAPI.deviceLink.onStatusChanged(({ status }) => {
      const previous = relayStatusRef.current;
      relayStatusRef.current = status;
      if (status === 'online' && previous !== 'online') bump();
    });

    return () => {
      offPresence();
      offStatus();
    };
  }, [deviceId]);

  return epoch;
}
