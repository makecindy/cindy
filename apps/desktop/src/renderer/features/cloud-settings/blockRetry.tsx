import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Tip } from '@/components/ui/tooltip';

/**
 * How a failed read is tried again on its own (what the page can do itself, it does first): at
 * once, after 2 s and after 5 s. The page reconnects its session on the same rhythm.
 */
export const CLOUD_RETRY_DELAYS_MS = [0, 2_000, 5_000] as const;

export const errorCode = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'CLOUD_SETTINGS_UNAVAILABLE';

/**
 * Re-reads one block (a group of settings, an authorization list) after a failed read, three
 * times, reading only. `exhausted` turns true once those reads have failed too; any successful
 * read resets it. `paused` holds the tries while the page reports its own read failure, which
 * re-reads every block once it reconnects.
 */
export function useBlockRetry({
  failed,
  failures,
  retry,
  paused = false,
}: {
  failed: boolean;
  /**
   * Counts failed reads. A read that fails at once sets and clears its loading flag within one
   * render, so the count, not the flag, is what starts the next try.
   */
  failures: number;
  retry(): void;
  paused?: boolean;
}) {
  const attempts = useRef(0);
  const [exhausted, setExhausted] = useState(false);
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (!failed) {
      attempts.current = 0;
      setExhausted(false);
      return;
    }
    if (paused) return;
    if (attempts.current >= CLOUD_RETRY_DELAYS_MS.length) {
      setExhausted(true);
      return;
    }
    const delay = CLOUD_RETRY_DELAYS_MS[attempts.current]!;
    const timer = setTimeout(() => retryRef.current(), delay);
    attempts.current += 1;
    return () => clearTimeout(timer);
  }, [failed, failures, paused]);
  return {
    exhausted: failed && exhausted && !paused,
    /** The notice's reload: one read now, no further automatic tries. */
    reload() {
      attempts.current = CLOUD_RETRY_DELAYS_MS.length;
      retryRef.current();
    },
  };
}

/** The block's own read failure, where the block would be (the same notice for every block). */
export function BlockReadFailure({
  title,
  code,
  disabled,
  onReload,
  bare = false,
}: {
  title: string;
  code?: string;
  disabled: boolean;
  onReload(): void;
  /** Inside a card: no border or fill of its own, as ImConnectionError (no card inside a card). */
  bare?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ErrorNotice
      role="alert"
      message={title}
      details={code}
      className={bare ? 'border-0 bg-transparent p-0' : undefined}
      actions={
        <Button size="sm" disabled={disabled} onClick={onReload}>
          {t('cloudSettings.reload')}
        </Button>
      }
    />
  );
}

/**
 * Beside a read failure that asks to try again, on a compact text line (the retry goes next to
 * 「请重试」): the icon-only quiet button the local restore control uses
 * (DefaultOverrideControls), as the settings group heading does. It does not make the line taller.
 */
export function InlineRetry({
  onRetry,
  disabled = false,
  loading = false,
}: {
  onRetry(): void;
  disabled?: boolean;
  /** Its read is running: it spins and cannot be pressed, as the device list's 「刷新」 does. */
  loading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Tip text={t('commonUi.retry')} side="top">
      <Button
        variant="secondary"
        tone="quiet"
        size="sm"
        type="button"
        className="-my-2 w-7 shrink-0 px-0"
        disabled={disabled}
        loading={loading}
        onClick={onRetry}
        aria-label={t('commonUi.retry')}
        data-cloud-inline-retry
      >
        <RefreshCw size={15} aria-hidden />
      </Button>
    </Tip>
  );
}
