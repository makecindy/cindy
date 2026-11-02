import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as QRCode from 'qrcode';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { parseCssColorComposited, toHex } from '../../shared/theme-import/color';

const log = createLogger('useFeishuBotRegistration');

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * qrcode 只接受 hex。主题色可能是半透明墨水(Cindy 的文字色),先叠到二维码底色上
 * 再转成不透明 hex;解析不了时回落黑码白底,保证二维码照样能扫。
 */
export function toQrColors(darkRaw: string, lightRaw: string): { dark: string; light: string } {
  const light = parseCssColorComposited(lightRaw, null) ?? { r: 255, g: 255, b: 255 };
  const dark = parseCssColorComposited(darkRaw, light) ?? { r: 0, g: 0, b: 0 };
  return { dark: toHex(dark), light: toHex(light) };
}

function getQrColors(): { dark: string; light: string } {
  if (document.documentElement.classList.contains('dark')) {
    return toQrColors(
      getCssVar('--settings-btn-primary-text'),
      getCssVar('--settings-btn-primary-bg'),
    );
  }

  return toQrColors(
    getCssVar('--settings-section-title'),
    getCssVar('--settings-btn-primary-text'),
  );
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
  const generationRef = useRef(0);
  const activeRunRef = useRef<number | null>(null);
  // main 侧授权轮次代号。renderer 自己的代次管"我发起了几次",main 的 runId
  // 管"这一轮是第几次"——两轮并发时只有两者同时对得上,结果才属于当前界面。
  const mainRunIdRef = useRef<number | null>(null);

  const invalidateRegistration = useCallback(() => {
    generationRef.current += 1;
    mainRunIdRef.current = null;
    if (activeRunRef.current === null) return;
    activeRunRef.current = null;
    void window.electronAPI.feishuBot.registrationCancel().catch((err: unknown) => {
      log.warn('registration cancel failed:', err);
    });
  }, []);

  useEffect(() => {
    setPhase('idle');
    setVerificationUrl(null);
    setUserCode(null);
    setExpiresAt(null);
    setQrDataUrl(null);
    setErrorMessage(null);
    return invalidateRegistration;
  }, [service, invalidateRegistration]);

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
      // 倒计时只负责收起二维码,不取消在途轮询: 用户可能刚好在最后一刻
      // 完成授权,再发一次 registrationCancel 会作废 main 侧那一轮,
      // 导致已批准的凭证被丢弃、用户被迫重新授权。
      // 真正的过期由 main 侧轮询结束后广播 expired 收口。
      setPhase('expired');
    }
  }, [phase, secondsLeft]);

  useEffect(() => {
    const off = window.electronAPI.feishuBot.onRegistrationStatus((payload) => {
      if (payload.status === 'pending') return;
      // 旧轮次的结果一律不认: main 侧 runId 与当前轮次对不上,说明这是
      // 用户切换服务或重新发起之前那一轮的收尾,写回界面会打断当前授权。
      if (payload.runId === undefined || payload.runId !== mainRunIdRef.current) return;
      if (activeRunRef.current === null || payload.status === 'cancelled') return;
      activeRunRef.current = null;
      generationRef.current += 1;

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

      setPhase('error');
      setErrorMessage(payload.error ?? t('logic.errors.registrationFailed'));
    });
    return off;
  }, [t]);

  const beginRegistration = useCallback(async () => {
    if (activeRunRef.current !== null) return;
    const runId = ++generationRef.current;
    activeRunRef.current = runId;
    mainRunIdRef.current = null;
    setPhase('starting');
    setErrorMessage(null);
    setQrDataUrl(null);

    try {
      const result = await window.electronAPI.feishuBot.registrationBegin(service);
      if (generationRef.current !== runId) return;
      if (!result.ok || !result.verificationUrl || !result.expiresIn) {
        invalidateRegistration();
        setPhase('error');
        setErrorMessage(result.error ?? t('logic.errors.registrationFailed'));
        return;
      }

      const deadline = Date.now() + result.expiresIn * 1000;
      if (result.runId !== undefined) mainRunIdRef.current = result.runId;
      const dataUrl = await QRCode.toDataURL(result.verificationUrl, {
        margin: 1,
        width: 180,
        color: getQrColors(),
      });
      if (generationRef.current !== runId) return;

      setVerificationUrl(result.verificationUrl);
      setUserCode(result.userCode ?? null);
      setExpiresAt(deadline);
      setNow(Date.now());
      setQrDataUrl(dataUrl);
      setPhase('qr');
    } catch (err) {
      if (generationRef.current !== runId) return;
      invalidateRegistration();
      const msg = err instanceof Error ? err.message : String(err);
      log.error('registration begin failed:', msg);
      setPhase('error');
      setErrorMessage(msg);
    }
  }, [invalidateRegistration, service, t]);

  const cancelRegistration = useCallback(async () => {
    const runId = ++generationRef.current;
    activeRunRef.current = null;
    setPhase('cancelled');
    setErrorMessage(null);
    try {
      await window.electronAPI.feishuBot.registrationCancel();
    } catch (err) {
      if (generationRef.current !== runId) return;
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
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
