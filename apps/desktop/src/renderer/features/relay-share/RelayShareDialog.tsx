/**
 * 分享中转(中转页那一行的分享图标):与供应商分享同一个弹窗外框和链接写法——一次性链接、倒计时、
 * 过期后重新生成;多一个二维码给手机扫,可以放大到二级弹窗里扫。打开时沿用还在有效期内的链接,「重新生成链接」才另要一条,
 * 旧链接仍按自己的有效期作废。收到的申请由全局审批弹窗处理,这里不显示。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import * as QRCode from 'qrcode';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
} from '@/features/provider-share/ProviderShareDialog';
import { useShareLinkCountdown } from '@/features/provider-share/ProviderShareLinkDialog';
import { formatShareCountdown } from '@/features/provider-share/providerShareFormat';

import type { SelfHostedRelayErrorCode } from '../../../shared/selfHostedRelay';

const K = 'settings.remoteControl.relay.share';

type LinkState =
  | { status: 'creating' }
  | { status: 'ready'; link: string; expiresAt: string; otherAccounts: boolean }
  | { status: 'error'; error: SelfHostedRelayErrorCode };

export function RelayShareDialog({ relayName, onClose }: { relayName: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LinkState>({ status: 'creating' });
  const [qr, setQr] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [enlargeOpen, setEnlargeOpen] = useState(false);
  const [enlargeButton, setEnlargeButton] = useState<HTMLButtonElement | null>(null);
  const [copied, setCopied] = useState(false);
  const requestSeq = useRef(0);
  const copiedTimer = useRef<number | null>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  // 链接只跟中转走:切换界面语言不能再要一条新链接。
  const tRef = useRef(t);
  tRef.current = t;

  const create = useCallback(async (fresh: boolean) => {
    const api = window.electronAPI?.selfHostedRelay;
    if (!api) return;
    const seq = ++requestSeq.current;
    setState({ status: 'creating' });
    setCopied(false);
    try {
      const result = await api.command({ type: 'create-join-link', fresh });
      if (seq !== requestSeq.current) return;
      const link = result.state.joinLink;
      if (result.error || !link) {
        setState({ status: 'error', error: result.error ?? 'FAILED' });
        return;
      }
      // 旧版主进程不给这个字段:照旧当作可以分享。
      setState({ status: 'ready', link: link.link, expiresAt: link.expiresAt, otherAccounts: link.otherAccounts !== false });
      if (fresh) toast.success(tRef.current(`${K}.regenerated`));
    } catch {
      if (seq === requestSeq.current) setState({ status: 'error', error: 'FAILED' });
    }
  }, []);

  useEffect(() => {
    void create(false);
    return () => {
      requestSeq.current += 1;
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, [create]);

  const link = state.status === 'ready' ? state.link : null;
  useEffect(() => {
    setQr(null);
    setEnlarged(null);
    if (!link) return;
    let active = true;
    void QRCode.toDataURL(link, { margin: 2, width: 224 }).then((url) => {
      if (active) setQr(url);
    });
    // 放大版按大尺寸单独生成,不把小图拉伸到看不清、扫不上。
    void QRCode.toDataURL(link, { margin: 2, width: 640 }).then((url) => {
      if (active) setEnlarged(url);
    });
    return () => {
      active = false;
    };
  }, [link]);

  const remainingMs = useShareLinkCountdown(state.status === 'ready' ? state.expiresAt : null);
  const expired = state.status === 'ready' && remainingMs <= 0;
  // 中转还不能给其他账号用(没开 Agent-Net 或服务器版本旧):链接只对本账号的设备有效,也不是端到端加密,
  // 讲给其他账号的说明都不适用。
  const ownOnly = state.status === 'ready' && !state.otherAccounts;
  // 链接过期、重新生成或出错时,放大的旧二维码不能留在屏幕上。
  const showEnlarged = enlargeOpen && enlarged !== null && !expired;

  const copy = useCallback(async () => {
    if (state.status !== 'ready' || expired) return;
    try {
      await window.electronAPI.copyTextToClipboard({ text: state.link });
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error(t(`${K}.copyFailed`));
    }
  }, [expired, state, t]);

  return (
    <ProviderShareDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        // 放大的二维码叠在上面时,这一层的 Radix 仍会先收到 Esc(实测外层先关、两层一起消失):
        // 只收起放大层,分享窗口留着。
        if (showEnlarged) {
          setEnlargeOpen(false);
          return;
        }
        onClose();
      }}
      maxWidth={500}
      initialFocusRef={doneRef}
      testId="relay-share-dialog"
    >
      <ProviderShareDialogTitle>{t(`${K}.title`, { name: relayName })}</ProviderShareDialogTitle>
      <p className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">{t(ownOnly ? `${K}.descriptionOwn` : `${K}.description`)}</p>

      {state.status === 'error' ? (
        <ErrorNotice
          role="alert"
          className="mt-4"
          message={t(`settings.remoteControl.relay.errors.${state.error}`)}
        />
      ) : (
        <div className="mt-4 flex items-center gap-4">
          {qr && !expired ? (
            <img src={qr} alt={t(`${K}.qrAlt`)} className="h-[112px] w-[112px] shrink-0 rounded-lg" />
          ) : (
            <div aria-hidden className="h-[112px] w-[112px] shrink-0 rounded-lg bg-[var(--surface)]" />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface)] py-1 pl-3 pr-1">
              {state.status === 'creating' ? (
                <span className="flex h-7 min-w-0 flex-1 items-center gap-2 text-12 text-[var(--text-secondary)]">
                  <Spinner size={14} />
                  {t(`${K}.generating`)}
                </span>
              ) : (
                <input
                  type="text"
                  readOnly
                  value={state.link}
                  aria-label={t(`${K}.fieldLabel`)}
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
                {copied ? t(`${K}.copied`) : t(`${K}.copy`)}
              </Button>
            </div>
            {/* 不挂 aria-live:每秒变化的倒计时会被读屏连续播报。 */}
            <p className="mt-2.5 flex flex-wrap gap-1.5 text-12 text-[var(--text-secondary)]">
              <span>{t(`${K}.oneTime`)}</span>
              <span aria-hidden="true">·</span>
              <span data-testid="relay-share-link-countdown">
                {state.status !== 'ready'
                  ? t(`${K}.expiresIn`, { time: '5:00' })
                  : expired
                    ? t(`${K}.expired`)
                    : t(`${K}.expiresIn`, { time: formatShareCountdown(remainingMs) })}
              </span>
              <span aria-hidden="true">·</span>
              <span>{t(`${K}.regenerateHint`)}</span>
            </p>
            <p className="mt-1 text-12 text-[var(--text-tertiary)]">{t(ownOnly ? `${K}.scanHintOwn` : `${K}.scanHint`)}</p>
            <div className="mt-2 flex">
              <Button
                ref={setEnlargeButton}
                variant="secondary"
                size="sm"
                disabled={!enlarged || expired}
                onClick={() => setEnlargeOpen(true)}
              >
                {t(`${K}.enlarge`)}
              </Button>
            </div>
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-1 rounded-lg bg-[var(--surface)] px-3 py-2.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
        {ownOnly ? (
          <>
            <p className="flex items-start gap-1.5 text-[var(--text-primary)]" data-testid="relay-share-own-account-only">
              <Info aria-hidden size={13} className="mt-0.5 shrink-0" />
              {t(`${K}.ownAccountOnly`)}
            </p>
            <p>{t(`${K}.calloutOwnFallback`)}</p>
          </>
        ) : (
          <>
            <p>{t(`${K}.calloutIsolation`)}</p>
            <p>{t(`${K}.calloutPrivacy`)}</p>
            <p>{t(`${K}.calloutOwnDevices`)}</p>
          </>
        )}
      </div>

      <ProviderShareDialogFooter>
        <Button ref={doneRef} variant="secondary" palette="confirmation" size="lg" onClick={onClose}>
          {t(`${K}.done`)}
        </Button>
        <Button
          variant="secondary"
          tone="quiet"
          size="lg"
          disabled={state.status === 'creating'}
          onClick={() => void create(true)}
        >
          {t(`${K}.regenerate`)}
        </Button>
      </ProviderShareDialogFooter>

      <ProviderShareDialog
        nested
        open={showEnlarged}
        onOpenChange={(open) => {
          if (!open) setEnlargeOpen(false);
        }}
        maxWidth={520}
        returnFocusTo={enlargeButton}
        testId="relay-share-qr-enlarged"
      >
        <ProviderShareDialogTitle>{t(`${K}.qrTitle`)}</ProviderShareDialogTitle>
        <p className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">{t(ownOnly ? `${K}.scanHintOwn` : `${K}.scanHint`)}</p>
        {/* 窗口很矮(最小窗口加界面缩放)时二维码跟着缩小,保底 120px;再矮由弹窗滚动,关闭按钮仍可达。 */}
        <div className="mt-4 flex min-h-[120px] justify-center">
          {enlarged ? (
            <img src={enlarged} alt={t(`${K}.qrAlt`)} className="aspect-square w-full max-w-[min(440px,60vh)] rounded-xl object-contain" />
          ) : null}
        </div>
        <ProviderShareDialogFooter>
          <Button variant="secondary" palette="confirmation" size="lg" onClick={() => setEnlargeOpen(false)}>
            {t(`${K}.close`)}
          </Button>
        </ProviderShareDialogFooter>
      </ProviderShareDialog>
    </ProviderShareDialog>
  );
}
