import { useEffect, useState } from 'react';

/**
 * 「远程连接」里的两项：是否允许同账号设备控制本机、是否打开了「让我的其他电脑用本机模型」。
 * 只读，供模型供应商页显示状态；开关只在「远程连接」里。回到窗口或页面重新可见时重读。读不到按关闭处理。
 */
export interface OwnComputerModelUse {
  remoteControl: boolean;
  allProviders: boolean;
}

const OFF: OwnComputerModelUse = { remoteControl: false, allProviders: false };

export function useOwnComputerModelUse(): OwnComputerModelUse {
  const [state, setState] = useState<OwnComputerModelUse>(OFF);
  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const read = () => {
      const current = ++seq;
      const api = (window as Partial<Window>).electronAPI;
      if (!api?.maker?.getOwnComputerModelUse || !api.deviceLink?.getState) return;
      void Promise.all([api.deviceLink.getState(), api.maker.getOwnComputerModelUse()])
        .then(([link, use]) => {
          if (!cancelled && current === seq) setState({ remoteControl: link.remoteControlEnabled, allProviders: use.enabled });
        })
        .catch(() => {
          if (!cancelled && current === seq) setState(OFF);
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
  return state;
}
