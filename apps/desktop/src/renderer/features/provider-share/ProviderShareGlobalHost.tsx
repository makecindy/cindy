/**
 * 供应商分享的全局宿主(只在主窗口 MainLayout 挂一次)：
 *
 *  - 分享者：启动时读一次 `owned`，把本次运行还没弹过的待审批申请排队；之后靠 REQUESTED 推送。
 *    逐条弹审批弹窗，Esc / × = 稍后处理(申请留在管理页)。系统通知点击 → 打开对应管理页。
 *  - 受邀者：分享链接(深链、粘贴、系统通知)→ 申请弹窗。等待期间关掉弹窗的申请，有结果时用
 *    toast 告知。同时启动「已收到的分享」同步，模型列表随时可用。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { makeGenericNewMakerRouteState } from '@/features/cc-agent/lib/genericNewMakerRouteState';
import { toast } from '@/lib/toast';

import type { ProviderShareSettledEvent } from '../../../shared/providerShare';
import { ProviderShareApplyDialog, isProviderShareRequestTrackedByDialog } from './ProviderShareApplyDialog';
import { ProviderShareApproveDialog } from './ProviderShareApproveDialog';
import { pendingRequestsFromOwned } from './providerShareFormat';
import { providerShareManagePath } from './providerShareNavigation';
import {
  addProviderShareRequested,
  ensureProviderShareReceivedStarted,
  getProviderSharePendingRequests,
  refreshProviderShareOwnerPending,
  useProviderSharePendingRequests,
} from './providerShareStore';
import { subscribeProviderShareJoin } from './joinIntent';

const SETTLED_TOAST_MS = 6000;

export function ProviderShareGlobalHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const tRef = useRef(t);
  tRef.current = t;

  const pending = useProviderSharePendingRequests();
  // 本次运行已排过队的申请：main 重连后会重新推送全部待审批申请，不重复弹。
  const queuedRef = useRef(new Set<string>());
  const [queue, setQueue] = useState<readonly string[]>([]);
  const [join, setJoin] = useState<{ link: string; id: number } | null>(null);
  const joinSeq = useRef(0);

  const enqueue = useCallback((requestIds: readonly string[]) => {
    const fresh = requestIds.filter((id) => !queuedRef.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) queuedRef.current.add(id);
    setQueue((current) => [...current, ...fresh]);
  }, []);

  const openJoin = useCallback((link: string) => {
    const trimmed = link.trim();
    if (!trimmed) return;
    // 深链与 main 的 OPEN_JOIN 可能为同一条链接各来一次：同一链接已打开时不重复读取。
    setJoin((current) => (current?.link === trimmed ? current : { link: trimmed, id: ++joinSeq.current }));
  }, []);

  useEffect(() => {
    const api = (window as Partial<Window>).electronAPI?.providerShare;
    if (!api) return;
    let disposed = false;
    ensureProviderShareReceivedStarted();

    void refreshProviderShareOwnerPending().then((state) => {
      if (disposed || !state?.ready) return;
      enqueue(pendingRequestsFromOwned(state.shares).map((item) => item.request.requestId));
    });

    const offRequested = api.onRequested((event) => {
      addProviderShareRequested(event);
      enqueue([event.request.requestId]);
    });
    // 只在还有待审批申请时随推送重读(那时 main 本就在快速拉取)，让撤回、过期的申请消失。
    const offOwned = api.onOwnedChanged(() => {
      if (getProviderSharePendingRequests().length > 0) void refreshProviderShareOwnerPending();
    });
    const offManage = api.onOpenManage(({ providerId }) => {
      navigateRef.current(providerShareManagePath(providerId));
    });
    const offOpenJoin = api.onOpenJoin(({ link }) => openJoin(link));
    const offSettled = api.onSettled((event: ProviderShareSettledEvent) => {
      if (isProviderShareRequestTrackedByDialog(event.state.requestId)) return;
      const translate = tRef.current;
      const name = event.preview?.owner.displayName;
      const provider = event.preview?.providerLabel;
      switch (event.state.status) {
        case 'approved':
          toast.success(
            name && provider
              ? translate('providerShare.apply.toastApproved', { name, provider })
              : translate('providerShare.apply.toastApprovedGeneric'),
            { duration: SETTLED_TOAST_MS },
          );
          break;
        case 'rejected':
          toast.info(
            name
              ? translate('providerShare.apply.toastRejected', { name })
              : translate('providerShare.apply.toastRejectedGeneric'),
            { duration: SETTLED_TOAST_MS },
          );
          break;
        case 'expired':
          toast.info(translate('providerShare.apply.toastExpired'), { duration: SETTLED_TOAST_MS });
          break;
        default:
          break;
      }
    });
    const offJoinIntent = subscribeProviderShareJoin(openJoin);

    return () => {
      disposed = true;
      offRequested();
      offOwned();
      offManage();
      offOpenJoin();
      offSettled();
      offJoinIntent();
    };
  }, [enqueue, openJoin]);

  const currentId = queue[0] ?? null;
  const current = currentId ? pending.find((item) => item.request.requestId === currentId) ?? null : null;

  // 队首的申请已不在待审批里(在管理页处理了、被撤回或过期)：跳过。
  useEffect(() => {
    if (currentId && !current) setQueue((items) => items.filter((id) => id !== currentId));
  }, [current, currentId]);

  const closeApproval = useCallback(() => {
    setQueue((items) => (items.length > 0 ? items.slice(1) : items));
  }, []);

  const openNewTask = useCallback(() => {
    navigateRef.current('/cc-agent/new', { state: makeGenericNewMakerRouteState(pathnameRef.current) });
  }, []);

  return (
    <>
      {current && <ProviderShareApproveDialog key={current.request.requestId} item={current} onClose={closeApproval} />}
      {join && (
        <ProviderShareApplyDialog
          key={join.id}
          link={join.link}
          onClose={() => setJoin(null)}
          onNewTask={openNewTask}
        />
      )}
    </>
  );
}
