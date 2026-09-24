import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AccountDeletionAvailability } from '@cindy/auth-client';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import type { DesktopAccountDeletionChallenge } from '@/lib/authService';
import { cn } from '@/lib/utils';

/**
 * Server-gated personal-account deletion entry and OTP confirmation dialog.
 * Network, receipt storage, confirmation recovery, and local logout remain in
 * Electron main; this component only owns display state and user input.
 */
export function AccountDeletionSection() {
  const { t } = useTranslation();
  const {
    user,
    isAuthenticated,
    getAccountDeletionAvailability,
    requestAccountDeletionChallenge,
    confirmAccountDeletion,
  } = useAuth();
  const currentUserId = user?.id ?? null;
  const [availability, setAvailability] = useState<AccountDeletionAvailability | null>(null);
  const [open, setOpen] = useState(false);
  const [challenge, setChallenge] = useState<DesktopAccountDeletionChallenge | null>(null);
  const [code, setCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || !currentUserId) {
      setAvailability(null);
      return;
    }
    setAvailability(null);
    let stale = false;
    void getAccountDeletionAvailability()
      .then((result) => {
        if (stale) return;
        setAvailability(
          result.success && result.value.available ? result.value : null,
        );
      })
      .catch(() => {
        if (!stale) setAvailability(null);
      });
    return () => {
      stale = true;
    };
  }, [currentUserId, getAccountDeletionAvailability, isAuthenticated]);

  if (!availability) return null;

  const resetDraft = () => {
    setChallenge(null);
    setCode('');
    setAcknowledged(false);
    setErrorCode(null);
  };

  const setOperationBusy = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  };

  const requestChallenge = async () => {
    if (busyRef.current) return;
    setOperationBusy(true);
    setErrorCode(null);
    try {
      const result = await requestAccountDeletionChallenge();
      if (!result.success) {
        setErrorCode(result.code);
        return;
      }
      setChallenge(result.value);
      setCode('');
      setAcknowledged(false);
    } catch {
      setErrorCode('AUTH_REQUEST_FAILED');
    } finally {
      setOperationBusy(false);
    }
  };

  const confirmDeletion = async () => {
    if (busyRef.current || !challenge || code.length !== 6 || !acknowledged) return;
    setOperationBusy(true);
    setErrorCode(null);
    try {
      const result = await confirmAccountDeletion({
        challengeId: challenge.challengeId,
        code,
      });
      if (!result.success) {
        setErrorCode(result.code);
        return;
      }
      // Main has already torn down this account and broadcast logged-out state.
      setOpen(false);
    } catch {
      setErrorCode('AUTH_REQUEST_FAILED');
    } finally {
      setOperationBusy(false);
    }
  };

  const errorMessage = errorCode
    ? t(`accountDeletion.errors.${errorCode}`, {
        defaultValue: t('accountDeletion.errors.fallback'),
      })
    : null;

  return (
    <>
      <Button
        variant="secondary"
        size="md"
        type="button"
        onClick={() => {
          resetDraft();
          setOpen(true);
        }}
        aria-label={t('accountDeletion.entryAria')}
        tone="quiet"
        className="self-center"
      >
        {t('accountDeletion.entryButton')}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (busyRef.current && !next) return;
          setOpen(next);
          if (!next) resetDraft();
        }}
        title={challenge ? t('accountDeletion.confirmTitle') : t('accountDeletion.introTitle')}
        description={
          challenge
            ? t('accountDeletion.codeSent', {
                channel: t(`accountDeletion.channels.${challenge.channel}`),
                target: challenge.maskedTarget,
              })
            : t('accountDeletion.introDescription')
        }
        confirmText={
          challenge ? t('accountDeletion.confirmButton') : t('accountDeletion.sendCodeButton')
        }
        cancelText={t('accountDeletion.cancelButton')}
        confirmVariant={challenge ? 'destructive' : 'default'}
        confirmDisabled={Boolean(challenge) && (code.length !== 6 || !acknowledged)}
        autoFocusConfirm={!challenge}
        loading={busy}
        onConfirm={() => void (challenge ? confirmDeletion() : requestChallenge())}
        content={
          challenge ? (
            <div className="flex flex-col gap-3">
              <input
                autoFocus
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                disabled={busy}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                aria-label={t('accountDeletion.codeInputAria')}
                placeholder={t('accountDeletion.codePlaceholder')}
                className={cn(
                  'h-10 w-full rounded-full border border-[var(--settings-input-border)]',
                  'bg-[var(--settings-input-bg)] px-4 text-center text-14 tracking-[0.35em]',
                  'text-[var(--settings-input-text)] outline-none',
                  'focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
              />
              <label className="flex cursor-pointer items-start gap-2 text-13 leading-5 text-[var(--confirm-desc)]">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-1 size-3.5 shrink-0 cursor-pointer accent-[hsl(var(--destructive))]"
                />
                <span>{t('accountDeletion.acknowledgement')}</span>
              </label>
              <Button
                variant="secondary"
                size="md"
                type="button"
                disabled={busy}
                onClick={() => void requestChallenge()}
                tone="quiet"
                className="self-start"
              >
                {t('accountDeletion.resendCodeButton')}
              </Button>
              {errorMessage && (
                <p role="alert" className="text-12 leading-5 text-[var(--error-fg)]">
                  {errorMessage}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-13 leading-5 text-[var(--confirm-desc)]">
              <p>{t('accountDeletion.sessionNotice')}</p>
              <p>{t('accountDeletion.gracePeriodNotice')}</p>
              {availability.verification && (
                <p>
                  {t('accountDeletion.verificationNotice', {
                    channel: t(`accountDeletion.channels.${availability.verification.channel}`),
                    target: availability.verification.maskedTarget,
                  })}
                </p>
              )}
              {availability.manualAppleRevocationRequired && (
                <p className="rounded-lg bg-[var(--warning-bg-soft)] px-3 py-2">
                  {t('accountDeletion.appleRevocationNotice')}
                </p>
              )}
              {errorMessage && (
                <p role="alert" className="text-12 leading-5 text-[var(--error-fg)]">
                  {errorMessage}
                </p>
              )}
            </div>
          )
        }
      />
    </>
  );
}
