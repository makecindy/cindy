import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import type {
  ModelCatalogThinkingTarget,
  ModelCatalogThinkingView,
} from '../../shared/modelCatalogThinking';

const log = createLogger('UseModelCatalogThinking');
const EMPTY: ModelCatalogThinkingView = { value: null, defaultEffort: null, isCustomized: false };

/**
 * 取给用户看的失败原因：main 的 `[CODE] message` 去掉机器码前缀。main 只在这条路径上带
 * 可执行指引（如「先修正 model-catalog-overrides.json」），把它吞掉会让用户反复保存失败
 * 却看不到唯一的修复方式。
 */
function toDisplayReason(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const message = raw.replace(/^\[[A-Z0-9_]+\]\s*/, '').trim();
  return message.length > 0 ? message : undefined;
}

/**
 * 单模型思考档位的本地目录 override。
 *
 * 与 `useModelCatalogImageInput` 同一套纪律：请求不跨 target 存活(generation 守卫)、
 * 不跨账号存活(owner 守卫)、失败时回读真值而不是把乐观值留在界面上。写入成功后 main 会
 * 广播 PROVIDER_CHANGED，这里同时订阅该事件，让「跟随供应商」的括注随目录变化刷新。
 *
 * 语义差异：档位是**数组**而非布尔，所以乐观值是整组档位 + 可选默认档；「跟随供应商」
 * 用 `null` 表达（与图片输入的 `value: null` 同义）。
 */
export function useModelCatalogThinking(target: ModelCatalogThinkingTarget | null) {
  const key = JSON.stringify(target);
  const stableTarget = useMemo<ModelCatalogThinkingTarget | null>(() => JSON.parse(key), [key]);
  const [state, setState] = useState({
    ...EMPTY,
    key,
    loading: true,
    saving: false,
    error: false,
    errorReason: undefined as string | undefined,
  });
  const generation = useRef(0);
  /** 在途写入数：广播触发的回读可能在写盘前拿到旧值，不得顶掉写入自己的回声。 */
  const writesInFlight = useRef(0);
  /** 在途写入的目标 key：只有在途写与本次读取是同一个 target 时才跳过回读（见下）。 */
  const writesInFlightKey = useRef<string | null>(null);
  /** 当前渲染周期的 target key 与 run：写入落定时用它判断「用户是否已经切回/切走」。 */
  const latestKey = useRef(key);
  latestKey.current = key;
  const latestRun = useRef<(write?: WriteShape) => Promise<boolean>>(async () => true);

  type WriteShape = { tiers: string[] | null; defaultTier: string | null };

  const run = useCallback(
    async (write?: WriteShape): Promise<boolean> => {
      // 写在途时不发 GET：广播（含本次写入自己触发的那次）可能在写盘前到达，其结果比写入的
      // 回声旧，却会顶掉 generation 使写入结果被丢弃 —— UI 会停在旧值而写其实已经成功。
      if (!write && writesInFlight.current > 0 && writesInFlightKey.current === key) return true;
      const request = ++generation.current;
      if (!stableTarget) {
        setState({ ...EMPTY, key, loading: false, saving: false, error: false, errorReason: undefined });
        return false;
      }
      const owner = getDataOwnerGeneration();
      const current = () => request === generation.current && isDataOwnerGenerationCurrent(owner);
      // 乐观更新：写入时立即反映新值；失败时由下方的回读把真值盖回来，不会把乐观值留在
      // 界面上冒充已保存。刷新(GET)保留原值，不产生文案跳变。
      setState((prev) => ({
        ...(write
          ? { value: write.tiers, isCustomized: write.tiers !== null }
          : prev),
        key,
        loading: !write,
        saving: write !== undefined,
        error: false,
        errorReason: undefined,
      }));
      if (write) {
        writesInFlight.current += 1;
        writesInFlightKey.current = key;
      }
      // 写入回声是否真的写进了状态（generation 被切走/切回就会丢）。
      let echoLanded = true;
      try {
        const view = write
          ? await (async () => {
              await window.electronAPI.maker.setModelCatalogThinking(
                stableTarget,
                write.tiers,
                write.defaultTier,
              );
              return window.electronAPI.maker.getModelCatalogThinking(stableTarget);
            })()
          : await window.electronAPI.maker.getModelCatalogThinking(stableTarget);
        echoLanded = current();
        if (echoLanded) {
          setState({ ...view, key, loading: false, saving: false, error: false, errorReason: undefined });
        }
        return true;
      } catch (error) {
        log.warn('model catalog thinking request failed', error);
        const reason = toDisplayReason(error);
        // 失败时回读已提交的值；回读也失败就退回「跟随供应商」并标记 error，
        // 绝不让乐观值留在界面上冒充已保存。
        if (write && current()) {
          try {
            const view = await window.electronAPI.maker.getModelCatalogThinking(stableTarget);
            echoLanded = current();
            if (echoLanded) {
              setState({ ...view, key, loading: false, saving: false, error: true, errorReason: reason });
            }
            return false;
          } catch (readError) {
            log.warn('model catalog thinking recovery read failed', readError);
          }
        }
        echoLanded = current();
        if (echoLanded) {
          setState({ ...EMPTY, key, loading: false, saving: false, error: true, errorReason: reason });
        }
        return false;
      } finally {
        if (write) {
          writesInFlight.current -= 1;
          if (writesInFlight.current <= 0) writesInFlightKey.current = null;
          // 写入回声丢失且用户又回到同一行（写 A → 切 B → 切回 A）：这行的首次读取当时被
          // 跳过、回声又被 generation 守卫丢弃，界面会永远停在 loading 占位。补一次读取。
          if (!echoLanded && latestKey.current === key) void latestRun.current();
        }
      }
    },
    [stableTarget, key],
  );
  latestRun.current = run;

  useEffect(() => {
    setState({
      ...EMPTY,
      key,
      loading: stableTarget !== null,
      saving: false,
      error: false,
      errorReason: undefined,
    });
    // 目录刷新(远端 sync / 账号切换)后重新读回：跟随供应商的显示值可能已经变了。
    // 可选链是必需的：设置抽屉的既有测试只桩了部分 electronAPI，硬调用会让整个抽屉崩掉
    // （与 useModelCatalogImageInput 同一处理）。
    const unsubscribe = window.electronAPI?.maker?.onProvidersChanged?.(() => {
      void run();
    });
    if (!stableTarget) return;
    void run();
    return () => {
      unsubscribe?.();
      generation.current += 1;
    };
  }, [run, stableTarget, key]);

  return {
    ...state,
    /** 声明一组档位；`tiers=null` 恢复「跟随供应商」。 */
    setTiers: (tiers: string[] | null, defaultTier: string | null = null) =>
      run({ tiers, defaultTier }),
  };
}
