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

/** 设置页与伙伴页共用同一套扫码 UI; 由调用方注入各自的 IPC 与轮次通道。 */
export interface FeishuBotRegistrationTransport {
  begin: (service: 'feishu' | 'lark') => Promise<FeishuBotRegistrationBeginResult>;
  /** 带上本窗口那一轮的 runId, 避免关窗时误杀别的窗口的新轮次。 */
  cancel: (runId?: number) => Promise<unknown>;
  onStatus: (callback: (payload: FeishuBotRegistrationStatusPayload) => void) => () => void;
}

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
  transport?: FeishuBotRegistrationTransport,
): UseFeishuBotRegistrationReturn {
  const { t } = useTranslation();
  const resolvedTransport = useMemo<FeishuBotRegistrationTransport>(
    () =>
      transport ?? {
        begin: (next) => window.electronAPI.feishuBot.registrationBegin(next),
        cancel: (runId) => window.electronAPI.feishuBot.registrationCancel(runId),
        onStatus: (callback) => window.electronAPI.feishuBot.onRegistrationStatus(callback),
      },
    [transport],
  );
  const [phase, setPhase] = useState<FeishuBotRegistrationPhase>('idle');
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const generationRef = useRef(0);
  const activeRunRef = useRef<number | null>(null);
  /** 正在推进的那一代 begin(含等待作废旧轮次); 同代不重复发起。 */
  const beginInFlightRef = useRef<number | null>(null);
  // main 侧授权轮次代号。renderer 自己的代次管"我发起了几次",main 的 runId
  // 管"这一轮是第几次"——两轮并发时只有两者同时对得上,结果才属于当前界面。
  const mainRunIdRef = useRef<number | null>(null);

  /** 只收拾本界面的状态, 不发全局取消; 用于本轮根本没在 main 侧跑起来的情况。 */
  const clearLocalRegistration = useCallback(() => {
    generationRef.current += 1;
    mainRunIdRef.current = null;
    activeRunRef.current = null;
  }, []);

  const invalidateRegistration = useCallback(() => {
    generationRef.current += 1;
    if (activeRunRef.current === null) {
      mainRunIdRef.current = null;
      return;
    }
    activeRunRef.current = null;
    const runId = mainRunIdRef.current;
    mainRunIdRef.current = null;
    void resolvedTransport.cancel(runId ?? undefined).catch((err: unknown) => {
      log.warn('registration cancel failed:', err);
    });
  }, [resolvedTransport]);

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
    const off = resolvedTransport.onStatus((payload) => {
      if (payload.status === 'pending') return;
      // 旧轮次的结果一律不认: main 侧 runId 与当前轮次对不上,说明这是
      // 用户切换服务或重新发起之前那一轮的收尾,写回界面会打断当前授权。
      if (payload.runId === undefined || payload.runId !== mainRunIdRef.current) return;
      if (activeRunRef.current === null) return;
      activeRunRef.current = null;
      generationRef.current += 1;

      if (payload.status === 'cancelled') {
        // 另一窗口开始了新授权, 这一轮被 main 作废: 收起二维码并释放活动轮次,
        // 关窗时就不会再发全局 cancel 打断对方的新轮次。
        setPhase('cancelled');
        setErrorMessage(null);
        return;
      }

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
      setErrorMessage(
        // 凭证没落盘时 main 只回错误码; 这里的提示必须说清"没保存成功",
        // 否则用户会以为机器人已经绑定, 实际什么都没留下。
        payload.error === 'CREDENTIAL_SAVE_FAILED'
          ? t('logic.errors.credentialSaveFailed')
          : (payload.error ?? t('logic.errors.registrationFailed')),
      );
    });
    return off;
  }, [t, resolvedTransport]);

  const beginRegistration = useCallback(async () => {
    // 只挡"同一代"的重复点击: 取消或切换服务会推进代次, 之后必须能重新发起。
    if (beginInFlightRef.current === generationRef.current) return;
    let token = generationRef.current;
    beginInFlightRef.current = token;
    try {
      // 上一轮可能还没收口: 倒计时结束只收起二维码,轮询仍在途。用户这时点
      // 「重新授权」必须真的能重来,所以显式重试要先作废旧轮次——若直接
      // return,按钮会点了没反应,而且 main 侧请求没有超时,可能一直等下去。
      if (activeRunRef.current !== null) {
        // 先记下这次重试的代次并立刻进入"发起中": 等待取消期间若用户切换
        // 服务或关掉面板, 这次重试就作废了, 不能拿旧的 service 再发一轮。
        const retryGeneration = ++generationRef.current;
        token = retryGeneration;
        beginInFlightRef.current = retryGeneration;
        const previousRunId = mainRunIdRef.current;
        activeRunRef.current = null;
        mainRunIdRef.current = null;
        setPhase('starting');
        setErrorMessage(null);
        setQrDataUrl(null);
        try {
          await resolvedTransport.cancel(previousRunId ?? undefined);
        } catch (err) {
          log.warn('registration cancel failed:', err);
        }
        if (generationRef.current !== retryGeneration) return;
      }
      const runId = ++generationRef.current;
      token = runId;
      beginInFlightRef.current = runId;
      activeRunRef.current = runId;
      mainRunIdRef.current = null;
      setPhase('starting');
      setErrorMessage(null);
      setQrDataUrl(null);

      try {
        const result = await resolvedTransport.begin(service);
        if (generationRef.current !== runId) return;
        if (!result.ok || !result.verificationUrl || !result.expiresIn) {
          // begin 失败时 main 没留下轮次, 只清本地状态; 这里发 cancel 会误杀
          // 另一窗口已经开始的新授权。
          clearLocalRegistration();
          if (result.error === 'CANCELLED') {
            setPhase('cancelled');
            setErrorMessage(null);
            return;
          }
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
        clearLocalRegistration();
        const msg = err instanceof Error ? err.message : String(err);
        log.error('registration begin failed:', msg);
        setPhase('error');
        setErrorMessage(msg);
      }
    } finally {
      if (beginInFlightRef.current === token) beginInFlightRef.current = null;
    }
  }, [clearLocalRegistration, invalidateRegistration, resolvedTransport, service, t]);

  const cancelRegistration = useCallback(async () => {
    const runId = ++generationRef.current;
    activeRunRef.current = null;
    setPhase('cancelled');
    setErrorMessage(null);
    try {
      await resolvedTransport.cancel(mainRunIdRef.current ?? undefined);
    } catch (err) {
      if (generationRef.current !== runId) return;
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [resolvedTransport]);

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
