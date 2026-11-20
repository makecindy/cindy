import { useEffect, useState } from 'react';

/**
 * 本机是否允许同账号设备远程控制(「允许被远程调用」与分享的第一级)。设备互联没有单独的
 * 开关变更事件：relay 状态、持有权变化以及窗口回到前台时重读一次，保持与「远程连接」页一致。
 * 供应商页与插件引擎的「允许被远程调用」共用这一份判断。
 */
export function useRemoteControlEnabled(): boolean | null {
  // null = 还没读到：整行先不出现，避免「未开远程控制」的说明闪一下。
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const read = () => {
      const current = ++seq;
      // 读不到(设备互联未就绪等)按未开启处理：开关不可用，不影响页面其余部分。
      void Promise.resolve()
        .then(() => window.electronAPI.deviceLink.getState())
        .then((state) => {
          if (!cancelled && current === seq) setEnabled(state.remoteControlEnabled);
        })
        .catch(() => {
          if (!cancelled && current === seq) setEnabled(false);
        });
    };
    read();
    // 设备互联预加载不可用(旧窗口 / 测试)时只读一次，不订阅。
    const deviceLink = (window as Partial<Window>).electronAPI?.deviceLink;
    const offStatus = deviceLink?.onStatusChanged?.(() => read());
    const offOwnership = deviceLink?.onOwnershipChanged?.(() => read());
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', read);
    return () => {
      cancelled = true;
      offStatus?.();
      offOwnership?.();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', read);
    };
  }, []);
  return enabled;
}
