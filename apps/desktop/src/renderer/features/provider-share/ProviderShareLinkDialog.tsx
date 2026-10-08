/**
 * 生成分享链接(设计稿场景 3)：一次性链接、5 分钟倒计时、过期后可重新生成。
 * 打开即生成；「重新生成链接」再要一条新的，旧链接仍按自己的 5 分钟过期(不提供撤回)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
} from './ProviderShareDialog';
import { formatShareCountdown, shareLinkRemainingMs } from './providerShareFormat';

type LinkState =
  | { status: 'creating' }
  | { status: 'ready'; link: string; expiresAt: string }
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
  onClose,
}: {
  providerId: string;
  providerLabel: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<LinkState>({ status: 'creating' });
  const [copied, setCopied] = useState(false);
  const requestSeq = useRef(0);
  const copiedTimer = useRef<number | null>(null);
  // 生成链接只跟供应商走：切换界面语言不能再生成一条新链接。
  const tRef = useRef(t);
  tRef.current = t;

  const create = useCallback(
    async (announce: boolean) => {
      const seq = ++requestSeq.current;
      setState({ status: 'creating' });
      setCopied(false);
      try {
        const created = await window.electronAPI.providerShare.command({ action: 'create-link', providerId });
        if (seq !== requestSeq.current) return;
        setState({ status: 'ready', link: created.link, expiresAt: created.expiresAt });
        if (announce) toast.success(tRef.current('providerShare.link.regenerated'));
      } catch (error) {
        if (seq !== requestSeq.current) return;
        setState({ status: 'error', message: tRef.current(mapIpcErrorToI18nKey(error)) });
      }
    },
    [providerId],
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
      await navigator.clipboard.writeText(state.link);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error(t('providerShare.link.copyFailed'));
    }
  }, [expired, state, t]);

  return (
    <ProviderShareDialog open onOpenChange={(open) => { if (!open) onClose(); }} testId="provider-share-link-dialog">
      <ProviderShareDialogTitle>{t('providerShare.link.title', { provider: providerLabel })}</ProviderShareDialogTitle>
      <p className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">{t('providerShare.link.description')}</p>

      {state.status === 'error' ? (
        <p role="alert" className="mt-4 text-13 leading-[1.5] text-[var(--text-danger)]">
          {state.message}
        </p>
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
        </>
      )}

      <ProviderShareDialogFooter>
        <Button variant="secondary" palette="confirmation" size="lg" onClick={onClose}>
          {t('providerShare.link.back')}
        </Button>
        <Button
          variant="secondary"
          tone="quiet"
          size="lg"
          disabled={state.status === 'creating'}
          onClick={() => void create(true)}
        >
          {t('providerShare.link.regenerate')}
        </Button>
      </ProviderShareDialogFooter>
    </ProviderShareDialog>
  );
}
