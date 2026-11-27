import { ErrorNotice } from '@/components/ui/error-notice';
/**
 * 生成分享链接(设计稿场景 3)：一次性链接、5 分钟倒计时、过期后可重新生成。
 * 打开即生成；「重新生成链接」再要一条新的，旧链接仍按自己的 5 分钟过期(不提供撤回)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
} from './ProviderShareDialog';
import { formatShareCountdown, shareLinkRemainingMs } from './providerShareFormat';
import { OwnRelayCrossAccountNotice } from '../device-link/OwnRelayCrossAccountNotice';
import { providerManagementErrorKey, providerShareManagementCommand } from '../provider-group/providerManagement';

type LinkState =
  | { status: 'creating' }
  | { status: 'ready'; link: string; expiresAt: string; owner: DataOwnerGeneration }
  | { status: 'error'; message: string };

/** 每秒刷新一次剩余时间；到期后停止计时。 */
export function useShareLinkCountdown(expiresAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (shareLinkRemainingMs(expiresAt, current) <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt ? shareLinkRemainingMs(expiresAt, now) : 0;
}

export function ProviderShareLinkDialog({
  providerId,
  providerLabel,
  deviceId,
  onClose,
}: {
  providerId: string;
  providerLabel: string;
  deviceId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<LinkState>({ status: 'creating' });
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const sendingRef = useRef(false);
  // Keep a successfully created task when message persistence fails, so retry
  // writes the same idempotent message instead of creating another empty task.
  const savedSessionId = useRef<string | null>(null);
  const requestSeq = useRef(0);
  const copiedTimer = useRef<number | null>(null);
  // 生成链接只跟供应商走：切换界面语言不能再生成一条新链接。
  const tRef = useRef(t);
  tRef.current = t;

  const create = useCallback(
    async (announce: boolean) => {
      const seq = ++requestSeq.current;
      const owner = getDataOwnerGeneration();
      setState({ status: 'creating' });
      setCopied(false);
      setSent(false);
      setSending(false);
      sendingRef.current = false;
      savedSessionId.current = null;
      try {
        const created = await providerShareManagementCommand({ action: 'create-link', providerId }, deviceId);
        if (seq !== requestSeq.current || !isDataOwnerGenerationCurrent(owner)) return;
        setState({ status: 'ready', link: created.link, expiresAt: created.expiresAt, owner });
        if (announce) toast.success(tRef.current('providerShare.link.regenerated'));
      } catch (error) {
        if (seq !== requestSeq.current || !isDataOwnerGenerationCurrent(owner)) return;
        setState({ status: 'error', message: tRef.current(providerManagementErrorKey(error, Boolean(deviceId))) });
      }
    },
    [providerId, deviceId],
  );

  useEffect(() => {
    void create(false);
    return () => {
      requestSeq.current += 1;
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, [create]);

  const remainingMs = useShareLinkCountdown(state.status === 'ready' ? state.expiresAt : null);
  const expired = state.status === 'ready' && remainingMs <= 0;

  const copy = useCallback(async () => {
    if (state.status !== 'ready' || expired) return;
    try {
      // Main verifies the write; on Linux/Wayland navigator.clipboard can
      // resolve while the system clipboard stays empty.
      await window.electronAPI.copyTextToClipboard({ text: state.link });
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error(t('providerShare.link.copyFailed'));
    }
  }, [expired, state, t]);

  const sendToSelf = async () => {
    if (state.status !== 'ready' || sent || sendingRef.current
      || shareLinkRemainingMs(state.expiresAt, Date.now()) <= 0
      || !isDataOwnerGenerationCurrent(state.owner)) return;
    const seq = requestSeq.current;
    const current = () => seq === requestSeq.current && isDataOwnerGenerationCurrent(state.owner);
    sendingRef.current = true;
    setSending(true);
    try {
      // Deliberately local even when managing another computer's provider: the
      // private task belongs to the account/computer where the link dialog is open.
      // These persistence APIs neither enqueue input nor start an Agent.
      if (!savedSessionId.current) {
        const session = await window.electronAPI.localDb.sessions.create({
          title: t('providerShare.link.taskTitle', { provider: providerLabel }).slice(0, 200),
          workspaceKind: 'dialogue',
        });
        if (!current()) return;
        savedSessionId.current = session.id;
      }
      if (shareLinkRemainingMs(state.expiresAt, Date.now()) <= 0) {
        toast.error(t('providerShare.link.expired'));
        return;
      }
      const sessionId = savedSessionId.current;
      await window.electronAPI.localDb.messages.create(sessionId, {
        clientId: 'provider-share-link',
        role: 'user',
        content: state.link,
      });
      if (!current()) return;
      setSent(true);
      onClose();
      navigate(`/cc-agent/${encodeURIComponent(sessionId)}`);
    } catch {
      if (current()) toast.error(t('providerShare.link.sendFailed'));
    } finally {
      if (current()) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  };

  return (
    <ProviderShareDialog open busy={sending} onOpenChange={(open) => { if (!open) onClose(); }} testId="provider-share-link-dialog">
      <ProviderShareDialogTitle>{t('providerShare.link.title', { provider: providerLabel })}</ProviderShareDialogTitle>
      <p className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">{t('providerShare.link.description')}</p>
      <OwnRelayCrossAccountNotice feature="providerShare" className="mt-1" />

      {state.status === 'error' ? (
        <ErrorNotice role="alert" className="mt-4" message={state.message} />
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface)] py-1 pl-3 pr-1">
            {state.status === 'creating' ? (
              <span className="flex h-7 min-w-0 flex-1 items-center gap-2 text-12 text-[var(--text-secondary)]">
                <Spinner size={14} />
                {t('providerShare.link.generating')}
              </span>
            ) : (
              <input
                type="text"
                readOnly
                value={state.link}
                aria-label={t('providerShare.link.fieldLabel')}
                onFocus={(event) => event.currentTarget.select()}
                className="h-7 min-w-0 flex-1 select-text bg-transparent font-mono text-12 text-[var(--text-secondary)] outline-none"
              />
            )}
            <Button
              variant="primary"
              size="sm"
              compact
              disabled={state.status !== 'ready' || expired}
              onClick={() => void copy()}
            >
              {copied ? t('providerShare.link.copied') : t('providerShare.link.copy')}
            </Button>
          </div>
          {/* 不挂 aria-live：每秒变化的倒计时会被读屏连续播报。 */}
          <p className="mt-2.5 flex flex-wrap gap-1.5 text-12 text-[var(--text-secondary)]">
            <span>{t('providerShare.link.oneTime')}</span>
            <span aria-hidden="true">·</span>
            <span data-testid="provider-share-link-countdown">
              {state.status !== 'ready'
                ? t('providerShare.link.expiresIn', { time: '5:00' })
                : expired
                  ? t('providerShare.link.expired')
                  : t('providerShare.link.expiresIn', { time: formatShareCountdown(remainingMs) })}
            </span>
            <span aria-hidden="true">·</span>
            <span>{t('providerShare.link.regenerateHint')}</span>
          </p>
          <p className="mt-2 text-12 leading-[1.5] text-[var(--text-secondary)]">
            {t('providerShare.link.sendHint')}
          </p>
        </>
      )}

      <ProviderShareDialogFooter>
        <Button variant="secondary" palette="confirmation" size="lg" disabled={sending} onClick={onClose}>
          {t('providerShare.link.back')}
        </Button>
        <Button
          variant="secondary"
          tone="quiet"
          size="lg"
          disabled={state.status === 'creating' || sending}
          onClick={() => void create(true)}
        >
          {t('providerShare.link.regenerate')}
        </Button>
        <Button
          variant="primary"
          size="lg"
          loading={sending}
          disabled={state.status !== 'ready' || expired || sent}
          onClick={() => void sendToSelf()}
        >
          {sent ? t('providerShare.link.sentToSelf') : t('providerShare.link.sendToSelf')}
        </Button>
      </ProviderShareDialogFooter>
    </ProviderShareDialog>
  );
}
