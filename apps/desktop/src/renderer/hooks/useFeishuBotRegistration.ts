import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as QRCode from 'qrcode';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('useFeishuBotRegistration');

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getQrColors(): { dark: string; light: string } {
  if (document.documentElement.classList.contains('dark')) {
    return {
      dark: getCssVar('--settings-btn-primary-text'),
      light: getCssVar('--settings-btn-primary-bg'),
    };
  }

  return {
    dark: getCssVar('--settings-section-title'),
    light: getCssVar('--settings-btn-primary-text'),
  };
}

export type FeishuBotRegistrationPhase =
  'idle' | 'starting' | 'qr' | 'success' | 'expired' | 'cancelled' | 'error';

interface UseFeishuBotRegistrationReturn {
  phase: FeishuBotRegistrationPhase;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number | null;
  qrDataUrl: string | null;
  errorMessage: string | null;
  secondsLeft: number | null;
  beginRegistration: () => Promise<void>;
  cancelRegistration: () => Promise<void>;
}

export function useFeishuBotRegistration(
  service: 'feishu' | 'lark' = 'feishu',
): UseFeishuBotRegistrationReturn {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<FeishuBotRegistrationPhase>('idle');
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!expiresAt || phase !== 'qr') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, phase]);

  const secondsLeft = useMemo(() => {
    if (!expiresAt || phase !== 'qr') return null;
    return Math.max(0, Math.ceil((expiresAt - now) / 1000));
  }, [expiresAt, now, phase]);

  useEffect(() => {
    if (phase === 'qr' && secondsLeft === 0) {
      setPhase('expired');
    }
  }, [phase, secondsLeft]);

  useEffect(() => {
    const off = window.electronAPI.feishuBot.onRegistrationStatus((payload) => {
      if (payload.status === 'pending') return;

      if (payload.status === 'success') {
        setPhase('success');
        setErrorMessage(null);
        toast.success(
          payload.verdict === 'connected'
            ? t('logic.toasts.feishuBotCreatedConnected')
            : t('logic.toasts.feishuBotCreatedCheck'),
        );
        return;
      }

      if (payload.status === 'expired') {
        setPhase('expired');
        setErrorMessage(payload.error ?? t('logic.errors.qrExpired'));
        return;
      }

      if (payload.status === 'cancelled') {
        setPhase('cancelled');
        setErrorMessage(null);
        return;
      }

      setPhase('error');
      setErrorMessage(payload.error ?? t('logic.errors.registrationFailed'));
    });
    return off;
  }, [t]);

  const beginRegistration = useCallback(async () => {
    if (phase === 'starting') return;
    setPhase('starting');
    setErrorMessage(null);
    setQrDataUrl(null);

    try {
      const result = await window.electronAPI.feishuBot.registrationBegin(service);
      if (!result.ok || !result.verificationUrl || !result.expiresIn) {
        setPhase('error');
        setErrorMessage(result.error ?? t('logic.errors.registrationFailed'));
        return;
      }

      const dataUrl = await QRCode.toDataURL(result.verificationUrl, {
        margin: 1,
        width: 180,
        color: getQrColors(),
      });

      setVerificationUrl(result.verificationUrl);
      setUserCode(result.userCode ?? null);
      setExpiresAt(Date.now() + result.expiresIn * 1000);
      setNow(Date.now());
      setQrDataUrl(dataUrl);
      setPhase('qr');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('registration begin failed:', msg);
      setPhase('error');
      setErrorMessage(msg);
    }
  }, [phase, service, t]);

  const cancelRegistration = useCallback(async () => {
    await window.electronAPI.feishuBot.registrationCancel();
    setPhase('cancelled');
    setErrorMessage(null);
  }, []);

  return {
    phase,
    verificationUrl,
    userCode,
    expiresAt,
    qrDataUrl,
    errorMessage,
    secondsLeft,
    beginRegistration,
    cancelRegistration,
  };
}
