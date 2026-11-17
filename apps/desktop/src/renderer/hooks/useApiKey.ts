import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { providerSecretStorageKey } from '../../shared/providerSecrets';

const log = createLogger('UseApiKey');

/** XD 网关 key 的本机 safeStorage 存储键名(SSoT,见 shared/providerSecrets)。 */
const XD_STORAGE_KEY = providerSecretStorageKey('xd');

/**
 * 统一 tag —— 所有 api-key 链路的日志都挂这个前缀,
 * 排查时只需 `grep [apikey-trace] main.log` 一把抓出全链路。
 *
 * 隐私设计:XD 网关 key 是 **本机 only** 落盘(Electron safeStorage,委托 OS
 * keychain/DPAPI 加密)。key 由 model-access 自动下发(main 侧写入,见
 * main/model-access/),**手填录入链路已移除(2026-07-17)**——本 hook 只负责
 * 读取展示 / 断开清理,不再承载保存与连通性测试。
 */
const TAG = '[apikey-trace]';

/**
 * 取 key 末 4 位用于排查日志 ——
 * 只用于本地排查日志里的同 key 识别。单独看任何一条都不能还原 key。
 */
function keyTail(k: string | null | undefined): string {
  if (!k) return '<empty>';
  if (k.length <= 4) return '<short>';
  return k.slice(-4);
}

/**
 * 模块级 reconcile 去重 ——
 * useApiKey 被 Settings / TodaySpendChip / ModelSelector 等多处消费,
 * 没有去重的话每个 mount 都会各自 safeStorageRead,同时 mount 时还会打多份
 * [apikey-trace] reconcile 日志,制造噪音。
 *
 * 设计:
 * - 第一个 mount 启动 reconcile (本地 safeStorage 读), promise 缓存到 module 级
 * - 后续 mount 拿同一个 promise (resolve 后立即拿到结果, 不再重复 IPC)
 * - clearKey / 自动下发成功后 invalidate, 下次 mount 重新读一次保险
 *
 * 不缓存最终值本身 —— 跨 consumer 同步走 broadcastApiKeyChange, 这里只解决重复读。
 */
type ReconcileResult = { savedKey: string | null };
let initialReconcileInFlight: Promise<ReconcileResult> | null = null;

/** 本地 only —— 只读 Electron safeStorage(main 侧 model-access 下发写入同一份 .enc)。 */
async function performReconcile(): Promise<ReconcileResult> {
  // Read-only auxiliary renderers intentionally have no credential bridge. Their selectors
  // use the Host's connected provider catalog, never a key read or a fabricated credential.
  if (typeof window.electronAPI?.safeStorageRead !== 'function') return { savedKey: null };
  let localKey: string | null = null;
  try {
    localKey = await window.electronAPI.safeStorageRead(XD_STORAGE_KEY);
  } catch (err) {
    log.error(TAG, 'reconcile.local.read.failed', 'err=' + String(err));
  }
  log.info(
    TAG,
    'reconcile.local',
    'localKey=' + (localKey ? 'present' : 'absent'),
    'tail=' + keyTail(localKey),
  );
  return { savedKey: localKey };
}

function reconcileSavedKeyOnce(): Promise<ReconcileResult> {
  if (initialReconcileInFlight) return initialReconcileInFlight;
  initialReconcileInFlight = performReconcile();
  return initialReconcileInFlight;
}

function invalidateReconcileCache(): void {
  initialReconcileInFlight = null;
}

/**
 * 跨 useApiKey() 实例的同步广播。
 *
 * 背景:useApiKey 是普通 React hook,每个 consumer 都有独立的 useState。某个实例
 * clearKey 成功(或 main 自动下发新 key)只改自己的 state,其它已挂载的实例不会
 * 感知。这里加一个 module 级 listener 集合:每个 hook 实例订阅,变更时广播新值,
 * 所有实例同步刷新本地 state。
 */
type ApiKeyChangeListener = (newKey: string | null) => void;
const apiKeyChangeListeners = new Set<ApiKeyChangeListener>();
function broadcastApiKeyChange(newKey: string | null): void {
  apiKeyChangeListeners.forEach((fn) => {
    try {
      fn(newKey);
    } catch (err) {
      log.error(TAG, 'broadcast.listener.threw', 'err=' + String(err));
    }
  });
}

/**
 * 切账号防污染 —— logout / login 不重启 renderer 进程(见 schedulesStore.ts),
 * 模块级 reconcile 缓存 + 各实例 state 会残留上一个账号的 key。main 端已在
 * login / 冷启动 reconcileOwner 对账过本机文件(换账号清、同账号留),这里只负责让
 * renderer 丢弃缓存并重读后广播,确保切到另一个账号后 UI 不显示上一个账号的残留 key。
 *
 * 模块加载时挂一次(进程级,不卸载,与 schedulesStore 范式一致)。
 */
function handleAuthStateChangeForApiKey(state: AuthStateChangePayload): void {
  invalidateReconcileCache();
  if (!state.isAuthenticated) {
    // 登出:立即把所有挂载实例重置为 needs-config,不再显示旧账号的 key。
    broadcastApiKeyChange(null);
    return;
  }
  // 登录:重新 reconcile(读 main 已对账后的本地文件)并广播给所有挂载实例。
  void reconcileSavedKeyOnce().then(({ savedKey }) => {
    broadcastApiKeyChange(savedKey);
  });
}

if (typeof window !== 'undefined' && window.electronAPI?.onAuthStateChange) {
  window.electronAPI.onAuthStateChange(handleAuthStateChangeForApiKey);
}

/**
 * 网关凭据自动下发联动 —— main 侧 model-access 同步成功后直接写 safeStorage
 * (不经 renderer 的 safe-storage IPC),模块级 reconcile 缓存与各实例 state
 * 都不会自动感知。订阅状态推送:同步/轮换成功(ok)时丢缓存重读并广播,
 * 让供应商行 / TodaySpendChip / gate 等 consumer 立即看到新 key。
 */
function handleModelAccessStatusForApiKey(status: { state: string }): void {
  if (status.state !== 'ok') return;
  invalidateReconcileCache();
  void reconcileSavedKeyOnce().then(({ savedKey }) => {
    broadcastApiKeyChange(savedKey);
  });
}

if (typeof window !== 'undefined' && window.electronAPI?.modelAccess) {
  window.electronAPI.modelAccess.onStatusChange(handleModelAccessStatusForApiKey);
}

export interface UseApiKeyReturn {
  /** 本机当前保存的 XD key(展示遮罩用);无 key 为空串。 */
  key: string;
  hasSavedKey: boolean;
  /** Whether this renderer can inspect the local key; false means unknown, not absent. */
  canReadKey: boolean;
  /**
   * mount 时 reconcile (safeStorage 读) 还没完成时为 true。
   * consumer 用它避免在 reconcile 完成前误判为"没 Key"——reconcile 完成后才能
   * 区分"本地真没 Key"和"还没读到"。
   */
  isReconciling: boolean;
  /** 断开:清除本机 key(自动下发的 key 可经重试/重登再拉)。返回是否成功。 */
  clearKey: () => Promise<boolean>;
}

export function useApiKey(): UseApiKeyReturn {
  const [key, setKeyState] = useState('');
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [isReconciling, setIsReconciling] = useState(true);
  const isClearingRef = useRef(false);

  // Initialize: 多个 useApiKey() consumer 共享同一份 reconcile 结果, 不重复
  // safeStorageRead (见模块顶部 reconcileSavedKeyOnce 注释)。
  // mount 阶段 cancelled 标志位防卸载后 setState (StrictMode 重挂 / 路由切换)。
  useEffect(() => {
    let cancelled = false;
    void reconcileSavedKeyOnce().then(({ savedKey }) => {
      if (cancelled) return;
      setKeyState(savedKey ?? '');
      setHasSavedKey(savedKey != null);
      setIsReconciling(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 订阅跨实例广播 —— 别的实例 clearKey / main 自动下发成功后通过
  // broadcastApiKeyChange 通知所有挂载中的实例,直接同步本地 state。
  useEffect(() => {
    const listener: ApiKeyChangeListener = (newKey) => {
      setKeyState(newKey ?? '');
      setHasSavedKey(newKey != null);
    };
    apiKeyChangeListeners.add(listener);
    return () => {
      apiKeyChangeListeners.delete(listener);
    };
  }, []);

  const clearKey = useCallback(async (): Promise<boolean> => {
    if (isClearingRef.current) return false;
    isClearingRef.current = true;
    try {
      const result = await window.electronAPI.safeStorageRemove(XD_STORAGE_KEY);
      if (!result.success) return false;
      // 下次 mount 重新走一遍 reconcile —— cached promise 若仍指向旧值,
      // 重挂的 consumer 会以为还有 key, 跟实际状态不符。
      invalidateReconcileCache();
      log.info(TAG, 'clearKey.local.remove.ok');
      setKeyState('');
      setHasSavedKey(false);
      // 通知所有已挂载的 useApiKey 实例同步 —— 清完后 gate / 其它 consumer
      // 立刻感知 hasSavedKey=false, 拦截后续操作。
      broadcastApiKeyChange(null);
      return true;
    } catch (err) {
      log.error('clearKey failed', err);
      return false;
    } finally {
      isClearingRef.current = false;
    }
  }, []);

  return {
    key,
    hasSavedKey,
    canReadKey: typeof window.electronAPI?.safeStorageRead === 'function',
    isReconciling,
    clearKey,
  };
}
