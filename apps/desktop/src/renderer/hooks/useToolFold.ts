/**
 * useToolFold — React 包装, 订阅 toolFoldStore 的变化。
 *
 * 真正 storage 在 lib/toolFoldStore.ts, 本 hook 只接入 React 状态。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  getToolFoldEnabled,
  setToolFoldEnabled,
  subscribeToolFoldEnabled,
} from '@/lib/toolFoldStore';

export function useToolFold(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(getToolFoldEnabled);

  const setEnabled = useCallback((next: boolean) => {
    setToolFoldEnabled(next);
  }, []);

  useEffect(() => subscribeToolFoldEnabled(setEnabledState), []);

  return { enabled, setEnabled };
}
