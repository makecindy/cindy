import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import type {
  ModelCatalogImageInputTarget,
  ModelCatalogImageInputView,
} from '../../shared/modelCatalogImageInput';

const log = createLogger('UseModelCatalogImageInput');
const EMPTY: ModelCatalogImageInputView = { value: null, isCustomized: false };

/**
 * 单模型图片输入能力的本地目录 override。
 *
 * 与 `useModelContextLimit` 同一套纪律：请求不跨 target 存活(generation 守卫)，
 * 失败时回读真值而不是把乐观值留在界面上。写入成功后 main 会广播 PROVIDER_CHANGED，
 * 这里同时订阅该事件，让「跟随供应商」的括注随目录变化刷新。
 */
export function useModelCatalogImageInput(target: ModelCatalogImageInputTarget | null) {
  const key = JSON.stringify(target);
  const stableTarget = useMemo<ModelCatalogImageInputTarget | null>(() => JSON.parse(key), [key]);
  const [state, setState] = useState({ ...EMPTY, key, loading: true, saving: false, error: false });
  const generation = useRef(0);

  const run = useCallback(
    async (write?: { value: boolean | null }): Promise<boolean> => {
      const request = ++generation.current;
      if (!stableTarget) {
        setState({ ...EMPTY, key, loading: false, saving: false, error: false });
        return false;
      }
      const current = () => request === generation.current;
      // 乐观更新：写入时立即反映新值，标签点击即变；失败时由下方的回读把真值盖回来，
      // 不会把乐观值留在界面上冒充已保存。刷新(GET)保留原值，不产生明暗/文案跳变。
      setState((prev) => ({
        ...(write ? { value: write.value, isCustomized: write.value !== null } : prev),
        key,
        loading: !write,
        saving: write !== undefined,
        error: false,
      }));
      try {
        const view = write
          ? await window.electronAPI.maker.setModelCatalogImageInput(stableTarget, write.value)
          : await window.electronAPI.maker.getModelCatalogImageInput(stableTarget);
        if (current()) setState({ ...view, key, loading: false, saving: false, error: false });
        return true;
      } catch (error) {
        log.warn('model catalog image input request failed', error);
        // 失败时回读已提交的值；回读也失败就退回「跟随供应商」并标记 error，
        // 绝不让乐观值留在界面上冒充已保存。
        if (write && current()) {
          try {
            const view = await window.electronAPI.maker.getModelCatalogImageInput(stableTarget);
            if (current()) setState({ ...view, key, loading: false, saving: false, error: true });
            return false;
          } catch (readError) {
            log.warn('model catalog image input recovery read failed', readError);
          }
        }
        if (current()) {
          setState({ ...EMPTY, key, loading: false, saving: false, error: true });
        }
        return false;
      }
    },
    [stableTarget, key],
  );

  useEffect(() => {
    setState({ ...EMPTY, key, loading: stableTarget !== null, saving: false, error: false });
    const unsubscribe = window.electronAPI?.maker?.onProvidersChanged?.(() => {
      void run();
    });
    void run();
    return () => {
      unsubscribe?.();
      generation.current += 1;
    };
  }, [run, stableTarget, key]);

  /** 返回值 = 是否真正落盘。调用方据此提示失败，不要读渲染期的 error（stale closure）。 */
  const setValue = useCallback((value: boolean | null) => run({ value }), [run]);
  return {
    ...(state.key === key ? state : { ...EMPTY, loading: true, saving: false, error: false }),
    setValue,
  };
}
