import { useEffect, useRef } from 'react';

import { publishSkinAppearance, publishSkinAppearanceState } from './skinAppearanceStore';

/**
 * 每个 Cindy Renderer 的皮肤状态桥。查询和推送在 App 根部常驻，确保主窗口、
 * 副窗口与独立侧栏拿到同一外观来源；背景组件只负责绘制，不再持有业务状态。
 */
export function SkinAppearanceRuntime() {
  const revision = useRef(0);

  useEffect(() => {
    const api = window.electronAPI?.ghosts;
    if (
      !api ||
      typeof api.getAppearance !== 'function' ||
      typeof api.onAppearanceChanged !== 'function'
    ) {
      publishSkinAppearanceState(null, []);
      return;
    }
    const refresh = (clearOnFailure = false) => {
      const expectedRevision = ++revision.current;
      void api
        .getAppearance()
        .then((state) => {
          if (revision.current === expectedRevision) {
            publishSkinAppearanceState(state.appearance, state.presets);
          }
        })
        .catch(() => {
          if (clearOnFailure && revision.current === expectedRevision) {
            publishSkinAppearanceState(null, []);
          }
        });
    };
    const unsubscribeAppearance = api.onAppearanceChanged((payload) => {
      revision.current += 1;
      publishSkinAppearance(payload.appearance);
      refresh(false);
    });
    const unsubscribeGhosts =
      typeof api.onChanged === 'function' ? api.onChanged(() => refresh(false)) : () => {};
    refresh(true);
    return () => {
      revision.current += 1;
      unsubscribeAppearance();
      unsubscribeGhosts();
    };
  }, []);

  return null;
}
