import { useEffect, useRef } from 'react';

import {
  deferUpdateBannerBecauseBusy,
  getUpdateBannerDismissState,
  isUpdateBannerDecidedFor,
  markUpdateBannerAutoShown,
  useUpdateBannerDismiss,
} from '@/hooks/useUpdateBannerDismiss';

/**
 * 更新就绪后完整 banner 自动弹出前,先问「有没有任务在跑」。
 *
 * 判定复用「立即重启」二次确认的同一条 IPC(anyActivityBlockingRelaunch),renderer
 * 不枚举活动来源。有任务(或探针失败,fail closed)→ 只留头像行火焰入口;全部停下
 * 后再弹出。用户点 X 关掉的不在这条自动恢复里。
 *
 * 返回值:当前这个版本还没做出弹出/让路决定时为 true,调用方据此先不渲染 banner,
 * 避免「闪一下完整横幅再收成火焰」。
 */
export const UPDATE_BANNER_BUSY_POLL_MS = 2000;

function isActiveUpdateStatus(status: string): boolean {
  return status === 'ready' || status === 'superseding';
}

async function probeBusy(): Promise<boolean> {
  try {
    return await window.electronAPI.anyActivityBlockingRelaunch();
  } catch {
    // 跟重启入口同一条 fail closed:拿不到可信答案就当有任务,不要突然弹出横幅。
    return true;
  }
}

export function useDeferUpdateBannerWhileBusy(
  status: string,
  version: string | undefined,
): boolean {
  const dismissApi = useUpdateBannerDismiss();
  const apiRef = useRef(dismissApi);
  apiRef.current = dismissApi;

  const versionOrNull = version ?? null;
  const hideUntilDecided =
    isActiveUpdateStatus(status)
    && !dismissApi.dismissed
    && !dismissApi.isDecidedFor(versionOrNull);

  useEffect(() => {
    if (!isActiveUpdateStatus(status)) return;

    const read = () => apiRef.current;

    if (read().isNewUpdateAfterDismiss(status, versionOrNull)) {
      if (read().reason === 'busy') {
        read().deferBecauseBusy(status, versionOrNull);
      } else {
        read().restore();
        read().clearAutoDecision();
      }
    }

    const snap = getUpdateBannerDismissState();
    const shouldProbe =
      (!snap.dismissed && !isUpdateBannerDecidedFor(versionOrNull))
      || (snap.dismissed && snap.reason === 'busy');
    if (!shouldProbe) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = () => {
      timer = setTimeout(() => {
        void run();
      }, UPDATE_BANNER_BUSY_POLL_MS);
    };

    const run = async () => {
      const busy = await probeBusy();
      if (cancelled) return;

      // 探针落地时必须读模块现态,不能读 render 快照:restore / dismiss 可能已经
      // 发生、但这次 render 还没跟上。
      const latest = getUpdateBannerDismissState();
      if (latest.reason === 'user') return;

      if (busy) {
        // 用户已经点火焰把 banner 唤回来了:这是明确要看,不要再藏回去。
        if (!latest.dismissed && isUpdateBannerDecidedFor(versionOrNull)) return;
        deferUpdateBannerBecauseBusy(status, versionOrNull);
        schedulePoll();
        return;
      }

      markUpdateBannerAutoShown(versionOrNull);
    };

    void run();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [status, versionOrNull, dismissApi.dismissed, dismissApi.reason]);

  return hideUntilDecided;
}
