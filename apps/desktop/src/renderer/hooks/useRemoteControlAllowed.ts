import { useEffect, useState } from 'react';

/**
 * Whether this computer lets its own other computers connect (「允许同账号设备控制本机」). Together with a
 * provider's 「允许被远程调用」 it decides whether those computers can use the provider. Read-only for the
 * provider page; re-read when the window regains focus or becomes visible. Unreadable means off.
 */
export function useRemoteControlAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const read = () => {
      const current = ++seq;
      const api = (window as Partial<Window>).electronAPI;
      if (!api?.deviceLink?.getState) return;
      void api.deviceLink.getState()
        .then((link) => {
          if (!cancelled && current === seq) setAllowed(link.remoteControlEnabled === true);
        })
        .catch(() => {
          if (!cancelled && current === seq) setAllowed(false);
        });
    };
    read();
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', read);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', read);
    };
  }, []);
  return allowed;
}
