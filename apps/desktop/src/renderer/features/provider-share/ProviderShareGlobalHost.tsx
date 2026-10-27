/**
 * 供应商分享的窗口宿主：主窗口处理自动提醒，副窗口只展示管理页手动打开的审批。
 *
 *  - 分享者：启动时读一次 `owned`，把本次运行还没弹过的待审批申请排队；之后靠 REQUESTED 推送。
 *    逐条弹审批弹窗，Esc / × = 稍后处理(申请留在管理页)。系统通知点击 → 打开对应管理页。
 *    弹窗跟着生成链接的电脑(provider-sharing.md §4.1)：链接由同账号另一台电脑生成的申请不在这里弹；
 *    这台电脑为另一台电脑上的分享生成的链接，申请在这里弹。
 *    转分享请求(成员经自己的供应商组转给别人用)不弹窗：RESHARE_REQUESTED 时重读，入口亮提示点、管理页处理。
 *  - 受邀者：分享链接(深链、粘贴、系统通知)→ 申请弹窗。等待期间关掉弹窗的申请，有结果时用
 *    toast 告知。同时启动「已收到的分享」同步，模型列表随时可用。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

import { makeGenericNewMakerRouteState } from '@/features/cc-agent/lib/genericNewMakerRouteState';
import { toast } from '@/lib/toast';
import { useProviderShareFavoriteCleanupFailed } from '@/state/providerShareFavorites';

import type { ProviderShareSettledEvent } from '../../../shared/providerShare';
import { ProviderShareApplyDialog, isProviderShareRequestTrackedByDialog } from './ProviderShareApplyDialog';
import { ProviderShareApproveDialog } from './ProviderShareApproveDialog';
import { pendingRequestsFromOwnerState } from './providerShareFormat';
import { providerShareManagePath } from './providerShareNavigation';
import {
  addProviderShareRequested,
  refreshProviderShareFavoriteMembership,
  getProviderSharePendingRequests,
  getProviderSharePendingReshares,
  refreshProviderShareOwnerPending,
  useProviderShareApprovalSelection,
  useProviderSharePendingRequests,
} from './providerShareStore';
import { subscribeProviderShareJoin } from './joinIntent';

const SETTLED_TOAST_MS = 6000;

export function ProviderShareGlobalHost({ manualOnly = false }: { manualOnly?: boolean }) {
  const { t } = useTranslation();
  const { dataOwnerId, dataOwnerGeneration } = useAuth();
  useEffect(() => {
    if (manualOnly) return;
    refreshProviderShareFavoriteMembership();
  }, [dataOwnerId, dataOwnerGeneration, manualOnly]);
  const favoriteCleanupFailed = useProviderShareFavoriteCleanupFailed();
  useEffect(() => {
    if (!manualOnly && favoriteCleanupFailed) toast.error(t('newChat.modelSelector.unified.favoritesCleanupFailed'));
  }, [favoriteCleanupFailed, manualOnly, t]);
  const navigate = useNavigate();
  const location = useLocation();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const tRef = useRef(t);
  tRef.current = t;

  const pending = useProviderSharePendingRequests();
  const selection = useProviderShareApprovalSelection();
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
    if (manualOnly) return;
    const api = (window as Partial<Window>).electronAPI?.providerShare;
    if (!api) return;
    let disposed = false;

    void refreshProviderShareOwnerPending().then((state) => {
      if (disposed || !state?.ready) return;
      enqueue(pendingRequestsFromOwnerState(state).filter((item) => !item.quiet).map((item) => item.request.requestId));
    });

    const offRequested = api.onRequested((event) => {
      addProviderShareRequested(event);
      if (!event.quiet) enqueue([event.request.requestId]);
    });
    // 只在还有待审批申请(含转分享请求)时随推送重读(那时 main 本就在快速拉取)，让撤回、过期、已处理的消失。
    const offOwned = api.onOwnedChanged(() => {
      if (getProviderSharePendingRequests().length > 0 || getProviderSharePendingReshares().length > 0) {
        void refreshProviderShareOwnerPending();
      }
    });
    // 转分享请求不弹窗：重读一次，设置页入口亮提示点、管理页「待处理」一栏出现(provider-sharing.md §4.3)。
    const offReshare = api.onReshareRequested?.(() => void refreshProviderShareOwnerPending()) ?? (() => undefined);
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
      offReshare();
      offManage();
      offOpenJoin();
      offSettled();
      offJoinIntent();
    };
  }, [enqueue, openJoin, manualOnly]);

  const selectedId = selection?.item.request.requestId;
  useEffect(() => {
    if (!selectedId) return;
    // 手动打开也算本次运行已弹过：启动读取与重连推送不能再把它排入自动队列。
    queuedRef.current.add(selectedId);
    setQueue((items) => items.filter((id) => id !== selectedId));
  }, [selectedId]);

  const currentId = queue[0] ?? null;
  const queued = currentId ? pending.find((item) => item.request.requestId === currentId) ?? null : null;
  const current = selection?.item ?? queued;

  // 队首的申请已不在待审批里(在管理页处理了、被撤回或过期)：跳过。
  useEffect(() => {
    if (currentId && !queued) setQueue((items) => items.filter((id) => id !== currentId));
  }, [queued, currentId]);

  const closeApproval = useCallback(() => {
    if (selection) {
      selection.onClose();
      return;
    }
    setQueue((items) => (items.length > 0 ? items.slice(1) : items));
  }, [selection]);

  const openNewTask = useCallback(() => {
    navigateRef.current('/cc-agent/new', { state: makeGenericNewMakerRouteState(pathnameRef.current) });
  }, []);

  return (
    <>
      {current && <ProviderShareApproveDialog
        key={current.request.requestId}
        item={current}
        onClose={closeApproval}
        returnFocusTo={selection?.trigger}
      />}
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
