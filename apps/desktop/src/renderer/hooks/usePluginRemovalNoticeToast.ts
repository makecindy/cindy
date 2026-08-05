/**
 * 组织插件被服务端清理后的一次性汇总提示。
 *
 * 清理可能发生在主界面挂载前（冷启动对账），所以不能只依赖 push：Main 保留
 * owner 隔离的 pending 汇总，Renderer 先订阅再主动 consume；后续 push 也走同一
 * consume 入口。Main 侧 consume 是同步的原子取走（get+delete），并发信号里
 * 后到的一次只会拿到 null，不会重复弹窗。文案在展示瞬间用 i18n 直调翻译，
 * 不依赖组件重渲染，effect 因此无依赖、只随挂载建立一次订阅。
 */

import { useEffect } from 'react';

import { i18n } from '@/i18n';
import { createLogger } from '@/lib/logger';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { toast } from '@/lib/toast';

const log = createLogger('usePluginRemovalNoticeToast');

export function usePluginRemovalNoticeToast(): void {
  useEffect(() => {
    // 副窗口不消费全局一次性通知，避免抢在主窗口前取走。
    if (isSecondaryWindow()) return undefined;

    let cancelled = false;
    const showIfPending = async (): Promise<void> => {
      try {
        const notice = await window.electronAPI.pluginMarket.consumeRemovalNotice();
        if (cancelled || !notice) return;
        const message =
          notice.count === 1 && notice.name
            ? i18n.t('settings.ghosts.market.removalNotice.single', {
                name: notice.name,
              })
            : i18n.t('settings.ghosts.market.removalNotice.multiple', {
                count: notice.count,
              });
        toast.info(message, { duration: 8000 });
      } catch (error) {
        log.warn('failed to consume plugin removal notice:', error);
      }
    };

    // 先订阅再主动取，封住「初次 consume 与 listener 建立之间」的新通知窗口。
    const unsubscribe = window.electronAPI.pluginMarket.onRemovalNoticeAvailable(() => {
      void showIfPending();
    });
    void showIfPending();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
}
