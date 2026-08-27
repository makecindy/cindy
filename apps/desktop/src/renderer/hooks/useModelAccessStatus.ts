import { useEffect, useState } from 'react';

import type { ModelAccessStatus } from '../../shared/modelAccess';

const IDLE: ModelAccessStatus = {
  state: 'idle',
  source: null,
  endpoint: null,
  accountTier: null,
};

/**
 * useModelAccessStatus —— 网关凭据自动下发的同步状态(main 侧权威,推送驱动)。
 *
 * mount 时拉一次快照(避免错过挂载前的推送),此后订阅
 * MODEL_ACCESS_STATUS_CHANNEL 增量更新。状态语义见 shared/modelAccess.ts。
 */
export function useModelAccessStatus(): ModelAccessStatus {
  const [status, setStatus] = useState<ModelAccessStatus>(IDLE);

  useEffect(() => {
    const api = window.electronAPI?.modelAccess;
    // 辅助窗口与单测可只暴露所需的最小 preload 能力；缺少该 bridge 时保持未知态，
    // 不能让一枚展示标签扩大所有 Renderer surface 的能力依赖。
    if (!api?.getStatus || !api.onStatusChange) return;

    let cancelled = false;
    void api
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => undefined);
    const unsubscribe = api.onStatusChange((s) => setStatus(s));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return status;
}
