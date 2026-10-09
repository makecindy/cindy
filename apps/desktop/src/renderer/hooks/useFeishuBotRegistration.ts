import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  // main 侧的注册轮询有自己的 runId, 但只有 registrationCancel 才作废得了它。
  // 本地这份代次管另一半: 切服务或已出终态之后, 还在飞的旧 promise 与旧推送
  // 一律不许再写界面(0 = 没有在跑的 run)。
  const runIdRef = useRef(0);

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

  // 切换飞书/Lark 服务时丢弃当前 QR: 老二维码对应的设备码授权只对原服务
  // 有效, 继续展示会让用户用新服务扫旧码, 造成「绑定了但渠道不对」的困惑。
  // 只清本地状态不够 —— main 侧的轮询还在跑, 完成后照旧会把原服务的凭证存
  // 下来, 所以这里同时作废那个 run: 本地代次归零 + 让 main 取消。
  const lastServiceRef = useRef(service);
  useEffect(() => {
    if (lastServiceRef.current === service) return;
    lastServiceRef.current = service;
    runIdRef.current = 0;
    void window.electronAPI.feishuBot
      .registrationCancel()
      .catch((err) => log.warn('registration cancel failed:', err));
    setPhase((prev) => (prev === 'qr' || prev === 'starting' ? 'idle' : prev));
    setQrDataUrl(null);
    setVerificationUrl(null);
    setUserCode(null);
    setExpiresAt(null);
    setErrorMessage(null);
  }, [service]);

  useEffect(() => {
    const off = window.electronAPI.feishuBot.onRegistrationStatus((payload) => {
      if (payload.status === 'pending') return;

      // 没有在跑的 run(切了服务 / 用户取消 / 已出终态)时, 这些推送属于旧 run:
      // 认下来就会把作废掉的 QR 或凭证状态写回界面。终态推送顺手把代次清零。
      if (runIdRef.current === 0) return;
      runIdRef.current = 0;

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
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setPhase('starting');
    setErrorMessage(null);
    setQrDataUrl(null);

    try {
      const result = await window.electronAPI.feishuBot.registrationBegin(service);
      // 期间切了服务 / 又点了一次生成: 这次的结果已经不属于当前界面。
      if (runIdRef.current !== runId) return;
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
      if (runIdRef.current !== runId) return;

      setVerificationUrl(result.verificationUrl);
      setUserCode(result.userCode ?? null);
      setExpiresAt(Date.now() + result.expiresIn * 1000);
      setNow(Date.now());
      setQrDataUrl(dataUrl);
      setPhase('qr');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('registration begin failed:', msg);
      if (runIdRef.current !== runId) return;
      setPhase('error');
      setErrorMessage(msg);
    }
  }, [phase, service, t]);

  const cancelRegistration = useCallback(async () => {
    runIdRef.current = 0;
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
