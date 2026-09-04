import { useEffect, useRef } from 'react';

import {
  deferUpdateBannerBecauseBusy,
  getUpdateBannerDismissState,
  isUpdateBannerPinnedFor,
  markUpdateBannerAutoShown,
  useUpdateBannerDismiss,
} from '@/hooks/useUpdateBannerDismiss';

/**
 * 更新就绪后完整 banner 要不要占侧栏,先问「有没有任务在跑」。
 *
 * 判定复用「立即重启」二次确认的同一条 IPC(anyActivityBlockingRelaunch),renderer
 * 不枚举活动来源。有任务(或探针失败,fail closed)→ 只留头像行火焰入口;全部停下
 * 后再弹出。系统自己弹出的,后来又 busy 同样收回去;用户点 X 关掉的不自动恢复;
 * 用户点火焰唤回的钉住当前这一版,busy 不再藏。待装版本变了,钉住作废并重新探针。
 *
 * 这条 IPC 是为点击「立即重启」设计的一次性探针(含 PI 目录同步扫描),不是廉价订阅。
 * 要知道「任务何时停 / 后来又没停」必须再问同一条定义,但不能把它当成 2s 热循环,
 * 也不另做活动缓存或事件总线。首次立刻问一次以免闪横幅;之后按
 * UPDATE_BANNER_BUSY_POLL_MS 续询(busy 等停下,已弹出等又 busy)。用户关掉或钉住后
 * 停询。轮询带 silent,避免把延后展示打成「manual relaunch」INFO。
 *
 * 返回值:当前这个版本还没做出弹出/让路决定时为 true,调用方据此先不渲染 banner,
 * 避免「闪一下完整横幅再收成火焰」。
 */
export const UPDATE_BANNER_BUSY_POLL_MS = 15_000;

function isActiveUpdateStatus(status: string): boolean {
  return status === 'ready' || status === 'superseding';
}

async function probeBusy(): Promise<boolean> {
  try {
    return await window.electronAPI.anyActivityBlockingRelaunch({ silent: true });
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
        read().restore({ pin: false });
        read().clearAutoDecision();
      }
    }

    const snap = getUpdateBannerDismissState();
    if (snap.reason === 'user' || isUpdateBannerPinnedFor(versionOrNull)) return;

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
      if (latest.reason === 'user' || isUpdateBannerPinnedFor(versionOrNull)) return;

      if (busy) {
        deferUpdateBannerBecauseBusy(status, versionOrNull);
        schedulePoll();
        return;
      }

      markUpdateBannerAutoShown(versionOrNull);
      schedulePoll();
    };

    void run();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [status, versionOrNull, dismissApi.dismissed, dismissApi.reason, dismissApi.pinnedByUser]);

  return hideUntilDecided;
}
