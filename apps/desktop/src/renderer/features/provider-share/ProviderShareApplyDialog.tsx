/**
 * 受邀者申请弹窗(设计稿场景 4；产品规则 §4.1)。由分享链接唤起(深链、粘贴或系统通知)：
 *
 *   读取链接 → 确认申请(说明分享者是谁、运行方式、隐私与身份) → 等待同意(显示配对码)
 *   → 已同意 / 被拒绝 / 已过期；链接失效、自己的供应商、已在使用、跨区域等给出说明。
 *
 * 只有点「发送申请」才真正提交；取消或关闭都不产生申请。等待期间关掉弹窗不影响申请，
 * 有结果时由全局宿主用 toast 告知(见 isProviderShareRequestTrackedByDialog)。
 */
import { Check, CircleSlash, Eye, Folder, Info, Link2Off, Monitor, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderShareLinkPreview, ProviderShareRequestState } from '@cindy/device-link';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';

import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
  ProviderSharePairingCode,
} from './ProviderShareDialog';
import { providerShareJoinErrorKind } from './providerShareFormat';
import { ShareAvatar } from './ShareAvatar';

type Preview = ProviderShareLinkPreview;

export type ProviderShareApplyView =
  | { kind: 'loading' }
  | { kind: 'ask'; preview: Preview }
  | { kind: 'wait'; preview: Preview | null; request: ProviderShareRequestState }
  | { kind: 'done' | 'rejected' | 'expired'; preview: Preview | null }
  | { kind: 'used' | 'self' | 'member' | 'region' | 'invalid'; preview: Preview | null }
  | { kind: 'error'; preview: Preview | null; message: string; retry: 'preview' | 'send' };

// 正在由某个打开的申请弹窗跟踪的申请：结果直接显示在弹窗里，全局宿主不再弹 toast。
const trackedRequests = new Set<string>();

export function isProviderShareRequestTrackedByDialog(requestId: string): boolean {
  return trackedRequests.has(requestId);
}

/** 申请当前状态 → 弹窗状态(发送后立即有结果，或推送到达时)。 */
function viewForRequest(state: ProviderShareRequestState, preview: Preview | null): ProviderShareApplyView | null {
  switch (state.status) {
    case 'pending':
      return { kind: 'wait', preview, request: state };
    case 'approved':
      return { kind: 'done', preview };
    case 'rejected':
      return { kind: 'rejected', preview };
    case 'expired':
      return { kind: 'expired', preview };
    case 'withdrawn':
      return null;
  }
}

export function ProviderShareApplyDialog({
  link,
  onClose,
  onNewTask,
}: {
  link: string;
  onClose: () => void;
  /** 「新建任务」：去新任务页(模型列表在那里)。 */
  onNewTask: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<ProviderShareApplyView>({ kind: 'loading' });
  const [busy, setBusy] = useState<'send' | 'withdraw' | null>(null);
  const mounted = useRef(true);
  const waitingRequestId = view.kind === 'wait' ? view.request.requestId : null;
  // 读链接只跟链接走：切换界面语言不能重新读取(更不能重置已发出的申请)。
  const tRef = useRef(t);
  tRef.current = t;

  const failure = useCallback(
    (error: unknown, preview: Preview | null, retry: 'preview' | 'send'): ProviderShareApplyView => {
      const kind = providerShareJoinErrorKind(extractIpcError(error)?.code);
      if (kind === 'error') return { kind, preview, retry, message: tRef.current(mapIpcErrorToI18nKey(error)) };
      return { kind, preview };
    },
    [],
  );

  const loadPreview = useCallback(async () => {
    setView({ kind: 'loading' });
    try {
      const preview = await window.electronAPI.providerShare.command({ action: 'preview', link });
      if (!mounted.current) return;
      setView(preview.state === 'unused' ? { kind: 'ask', preview } : { kind: 'used', preview });
    } catch (error) {
      if (!mounted.current) return;
      setView(failure(error, null, 'preview'));
    }
  }, [failure, link]);

  useEffect(() => {
    mounted.current = true;
    void loadPreview();
    return () => {
      mounted.current = false;
    };
  }, [loadPreview]);

  // 等待中的申请登记给全局宿主；离开等待态或关闭弹窗即注销。
  useEffect(() => {
    if (!waitingRequestId) return;
    trackedRequests.add(waitingRequestId);
    return () => {
      trackedRequests.delete(waitingRequestId);
    };
  }, [waitingRequestId]);

  useEffect(() => {
    if (!waitingRequestId) return;
    return window.electronAPI.providerShare.onSettled((event) => {
      if (event.state.requestId !== waitingRequestId) return;
      setView((current) => {
        if (current.kind !== 'wait' || current.request.requestId !== event.state.requestId) return current;
        return viewForRequest(event.state, current.preview ?? event.preview) ?? current;
      });
    });
  }, [waitingRequestId]);

  const preview = view.kind === 'loading' ? null : view.preview;

  const send = useCallback(async () => {
    if (busy) return;
    const current = preview;
    setBusy('send');
    try {
      const state = await window.electronAPI.providerShare.command({ action: 'send-request', link });
      if (!mounted.current) return;
      const next = viewForRequest(state, current);
      if (next) setView(next);
      else onClose();
    } catch (error) {
      if (!mounted.current) return;
      setView(failure(error, current, 'send'));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [busy, failure, link, onClose, preview]);

  const withdraw = useCallback(async () => {
    if (busy || view.kind !== 'wait') return;
    setBusy('withdraw');
    try {
      await window.electronAPI.providerShare.command({ action: 'withdraw', requestId: view.request.requestId });
      toast.success(t('providerShare.apply.withdrawn'));
      onClose();
    } catch (error) {
      toast.error(t(mapIpcErrorToI18nKey(error)));
      if (mounted.current) setBusy(null);
    }
  }, [busy, onClose, t, view]);

  const name = preview?.owner.displayName ?? null;
  const provider = preview?.providerLabel ?? '';
  const closeButton = (
    <Button variant="secondary" palette="confirmation" size="lg" onClick={onClose}>
      {t('providerShare.apply.close')}
    </Button>
  );

  let body: ReactNode;
  switch (view.kind) {
    case 'loading':
      body = (
        <StateCenter icon={<Spinner size={16} />} title={t('providerShare.apply.loading')} />
      );
      break;
    case 'ask': {
      const owner = view.preview.owner.displayName;
      body = (
        <>
          <ProviderShareDialogTitle>{t('providerShare.apply.askTitle', { name: owner, provider })}</ProviderShareDialogTitle>
          <div className="mt-3.5 flex items-center gap-3 rounded-xl border border-[var(--border-default)] p-3">
            <ShareAvatar displayName={owner} avatarUrl={view.preview.owner.avatarUrl} size="lg" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-14 font-medium text-[var(--text-primary)]">{owner}</span>
              <span className="truncate text-12 text-[var(--text-secondary)]">
                {t('providerShare.apply.providerOnDevice', { provider, device: view.preview.deviceName })}
              </span>
            </div>
          </div>
          <ul className="mt-3.5 flex flex-col gap-2.5">
            <Fact icon={<Monitor size={16} aria-hidden />} title={t('providerShare.apply.factRuns', { name: owner, provider })}
              detail={t('providerShare.apply.factRunsDetail', { name: owner, provider })} />
            <Fact icon={<Folder size={16} aria-hidden />} title={t('providerShare.apply.factFiles')}
              detail={t('providerShare.apply.factFilesDetail')} />
            <Fact icon={<Eye size={16} aria-hidden />} title={t('providerShare.apply.factPrivacy', { name: owner })}
              detail={t('providerShare.apply.factPrivacyDetail', { name: owner })} />
            <Fact icon={<ShieldCheck size={16} aria-hidden />} title={t('providerShare.apply.factApproval', { name: owner })}
              detail={t('providerShare.apply.factApprovalDetail', { name: owner })} />
          </ul>
          <ProviderShareDialogFooter>
            <Button variant="cta" palette="confirmation" size="lg" loading={busy === 'send'} disabled={busy !== null}
              onClick={() => void send()}>
              {t('providerShare.apply.send')}
            </Button>
            <Button variant="secondary" palette="confirmation" size="lg" disabled={busy !== null} onClick={onClose}>
              {t('providerShare.apply.cancel')}
            </Button>
          </ProviderShareDialogFooter>
        </>
      );
      break;
    }
    case 'wait':
      body = (
        <>
          <StateCenter
            icon={<Spinner size={16} />}
            title={name ? t('providerShare.apply.waitTitle', { name }) : t('providerShare.apply.waitTitleGeneric')}
          >
            <div className="mt-1">
              <ProviderSharePairingCode
                code={view.request.pairingCode}
                label={t('providerShare.pairing.label')}
                ariaLabel={t('providerShare.pairing.ariaLabel', { digits: view.request.pairingCode.split('').join(' ') })}
              />
            </div>
            <p className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">
              {name ? t('providerShare.apply.waitDescription', { name }) : t('providerShare.apply.waitDescriptionGeneric')}
            </p>
          </StateCenter>
          <ProviderShareDialogFooter>
            {closeButton}
            <Button variant="secondary" tone="quiet" size="lg" loading={busy === 'withdraw'} disabled={busy !== null}
              onClick={() => void withdraw()}>
              {t('providerShare.apply.withdraw')}
            </Button>
          </ProviderShareDialogFooter>
        </>
      );
      break;
    case 'done': {
      const label = preview
        ? t('newChat.modelSelector.unified.railRemoteProvider', {
            provider,
            device: t('providerShare.picker.deviceName', { device: preview.deviceName, owner: preview.owner.displayName }),
          })
        : null;
      body = (
        <>
          <StateCenter
            icon={<Check size={18} aria-hidden />}
            title={name ? t('providerShare.apply.doneTitle', { name, provider }) : t('providerShare.apply.doneTitleGeneric')}
            description={label ? t('providerShare.apply.doneDescription', { label }) : t('providerShare.apply.doneDescriptionGeneric')}
          />
          <ProviderShareDialogFooter>
            <Button variant="cta" palette="confirmation" size="lg" onClick={() => { onClose(); onNewTask(); }}>
              {t('providerShare.apply.newTask')}
            </Button>
            <Button variant="secondary" palette="confirmation" size="lg" onClick={onClose}>
              {t('providerShare.apply.later')}
            </Button>
          </ProviderShareDialogFooter>
        </>
      );
      break;
    }
    case 'used':
      body = (
        <>
          <StateCenter
            icon={<Link2Off size={18} aria-hidden />}
            title={t('providerShare.apply.usedTitle')}
            description={name ? t('providerShare.apply.usedDescription', { name }) : t('providerShare.apply.usedDescriptionGeneric')}
          />
          <ProviderShareDialogFooter>{closeButton}</ProviderShareDialogFooter>
        </>
      );
      break;
    case 'rejected':
      body = (
        <>
          <StateCenter
            icon={<CircleSlash size={18} aria-hidden />}
            title={name ? t('providerShare.apply.rejectedTitle', { name }) : t('providerShare.apply.rejectedTitleGeneric')}
            description={t('providerShare.apply.rejectedDescription')}
          />
          <ProviderShareDialogFooter>{closeButton}</ProviderShareDialogFooter>
        </>
      );
      break;
    case 'expired':
    case 'self':
    case 'member':
    case 'region':
    case 'invalid':
      body = (
        <>
          <StateCenter
            icon={view.kind === 'expired' ? <Link2Off size={18} aria-hidden /> : <Info size={18} aria-hidden />}
            title={t(`providerShare.apply.${view.kind}Title`)}
            description={t(`providerShare.apply.${view.kind}Description`)}
          />
          <ProviderShareDialogFooter>{closeButton}</ProviderShareDialogFooter>
        </>
      );
      break;
    case 'error':
      body = (
        <>
          <StateCenter icon={<Info size={18} aria-hidden />} title={t('providerShare.apply.errorTitle')} description={view.message} />
          <ProviderShareDialogFooter>
            <Button variant="cta" palette="confirmation" size="lg" loading={busy === 'send'} disabled={busy !== null}
              onClick={() => void (view.retry === 'send' ? send() : loadPreview())}>
              {t('providerShare.apply.retry')}
            </Button>
            {closeButton}
          </ProviderShareDialogFooter>
        </>
      );
      break;
  }

  return (
    <ProviderShareDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      busy={busy !== null}
      testId="provider-share-apply-dialog"
    >
      <div data-apply-state={view.kind} className="contents">{body}</div>
    </ProviderShareDialog>
  );
}

function Fact({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <li className="flex gap-2.5 text-13 leading-[1.45] text-[var(--text-primary)]">
      <span className="mt-0.5 shrink-0 text-[var(--text-secondary)]">{icon}</span>
      <span className="flex min-w-0 flex-col">
        {title}
        <span className="text-12 text-[var(--text-secondary)]">{detail}</span>
      </span>
    </li>
  );
}

function StateCenter({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-1 pt-2 text-center">
      <span
        aria-hidden="true"
        className="mb-3 mt-1.5 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-primary)]"
      >
        {icon}
      </span>
      <ProviderShareDialogTitle>{title}</ProviderShareDialogTitle>
      {description && <p className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">{description}</p>}
      {children}
    </div>
  );
}
