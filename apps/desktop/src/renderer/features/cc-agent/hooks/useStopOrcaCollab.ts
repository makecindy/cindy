/**
 * useStopOrcaCollab — 共享"关闭协同模式"流程的 hook。
 *
 * 两个入口都走完全一样的逻辑:
 *   - ChatInput 底部 toolbar 上的橙色 "协同" pill (ON 态点击 = onChange({enabled:false}))
 *   - WorkdirBrowseRoute 内嵌 OrcaSplitView 的 Worker pane ×
 *
 * 流程:二次确认弹窗 → disableOrca IPC → sessionsStore 刷新 →
 * navigate 回单 session 路由(可选, navigateOnSuccess=false 时不跳, 让调用方自己决定)。
 *
 * 失败:toast 提示, 不抛错(swallowed), busy 状态自动复位。
 */
import { useCallback, useState } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { sessionsStore } from '@/lib/sessionsStore';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { makerApiForSticky } from '@/lib/makerTransport';

const log = createLogger('useStopOrcaCollab');

export interface UseStopOrcaCollabOptions {
  /** Lead session id —— 没有(尚未创建)时 hook 返回的 requestStop 直接 no-op。 */
  leadSessionId: string | null | undefined;
  /**
   * disableOrca 成功后是否 navigate 回 /cc-agent/<leadSessionId>。
   * true:CCAgentSessionView 在 orca split-pane 视图里调,需要退出 split。
   * true:OrcaWorkflowRoute 在 Worker pane × 调,也需要退出 split。
   * false:CCAgentSessionView 已经在普通主会话视图里(orcaMode=false),不必跳转。
   */
  navigateOnSuccess?: boolean;
}

export interface StopOrcaCollabApi {
  /** 触发关闭流程。busy 期间重复调用直接 no-op。 */
  requestStop: () => Promise<boolean>;
  /** disableOrca 在飞 / 确认弹窗等待中 → true。用于 UI 禁用按钮防止双击。 */
  busy: boolean;
}

function useStopOrcaCollabCore(
  opts: UseStopOrcaCollabOptions,
  navigate: NavigateFunction | null,
): StopOrcaCollabApi {
  const { leadSessionId, navigateOnSuccess = true } = opts;
  const { t } = useTranslation();
  const { confirm: confirmDialog } = useConfirmDialog();
  const [busy, setBusy] = useState(false);

  const requestStop = useCallback(async () => {
    if (!leadSessionId || busy) return false;
    const ok = await confirmDialog({
      title: t('newChat.collaboration.stopConfirmTitle'),
      description: t('newChat.collaboration.stopConfirmDesc'),
      confirmText: t('newChat.collaboration.stopConfirmConfirm'),
      cancelText: t('newChat.collaboration.stopConfirmCancel'),
    });
    if (!ok) return false;
    setBusy(true);
    try {
      // 粘滞归属(与 requestEnableCollab 对称):relay 瞬断窗口内误判成本机会在**控制端**
      // 销毁一个不存在的 team、或撞上同 id 的本机会话,而远端的协同其实还开着。
      await makerApiForSticky(leadSessionId).disableOrca(leadSessionId);
      void sessionsStore.forceRefresh('active');
      if (navigateOnSuccess && navigate) {
        navigate(`/cc-agent/${leadSessionId}`, { replace: true });
      }
      return true;
    } catch (err) {
      log.error('disableOrca failed', err);
      toast.error(t('newChat.collaboration.stopFailed', { defaultValue: '关闭协同失败' }));
      return false;
    } finally {
      setBusy(false);
    }
  }, [leadSessionId, busy, confirmDialog, t, navigate, navigateOnSuccess]);

  return { requestStop, busy };
}

/** Router host path: stop collaboration and optionally navigate back to the lead task. */
export function useStopOrcaCollab(opts: UseStopOrcaCollabOptions): StopOrcaCollabApi {
  return useStopOrcaCollabCore(opts, useNavigate());
}

/**
 * Lightweight auxiliary-window path. It deliberately avoids React Router so the detached
 * sidebar can keep its minimal renderer entry while reusing the same stop-confirmation flow.
 */
export function useStopOrcaCollabWithoutNavigation(
  opts: Omit<UseStopOrcaCollabOptions, 'navigateOnSuccess'>,
): StopOrcaCollabApi {
  return useStopOrcaCollabCore({ ...opts, navigateOnSuccess: false }, null);
}
