import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import type { LocalRuntimeInstallProgress } from '../../../shared/localModelRuntime';
import { LocalRuntimeInstallView } from './LocalModelDownloadUI';

/** Mac / Windows 上，本机还没 Ollama 时默认给出 Cindy 内安装；主进程明确拒绝才藏。 */
export function offersManagedOllamaInstall(platform: string, canInstallRuntime?: boolean): boolean {
  if (platform !== 'darwin' && platform !== 'win32') return false;
  return canInstallRuntime !== false;
}

const DETECT_INTERVAL_MS = 2_000;

export function LocalOllamaInstall({
  canInstall,
  onReady,
}: {
  canInstall: boolean;
  onReady?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<LocalRuntimeInstallProgress | null>(null);
  const installing = Boolean(
    progress &&
    progress.phase !== 'cancelled' &&
    progress.phase !== 'error' &&
    (!progress.done || progress.phase === 'success'),
  );
  const onReadyRef = useRef(onReady);
  const connectingRef = useRef(false);
  onReadyRef.current = onReady;

  const notifyReady = async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    try {
      await onReadyRef.current?.();
    } finally {
      connectingRef.current = false;
    }
  };

  useEffect(() => {
    return window.electronAPI.maker.onLocalModelInstallProgress((next) => {
      setProgress(next as LocalRuntimeInstallProgress);
    });
  }, []);

  useEffect(() => {
    if (installing) return;
    let cancelled = false;
    let inFlight = false;

    const detect = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const status = await window.electronAPI.maker.localModelStatus();
        if (cancelled) return;
        if (status.kind === 'ready' || (status.kind === 'stopped' && status.appInstalled)) {
          await notifyReady();
        }
      } catch {
        /* 检测失败时下一轮再试 */
      } finally {
        inFlight = false;
      }
    };

    void detect();
    const timer = window.setInterval(() => void detect(), DETECT_INTERVAL_MS);
    const offStatus = window.electronAPI.maker.onLocalModelStatus((status) => {
      if (status.kind === 'ready' || (status.kind === 'stopped' && status.appInstalled)) {
        void detect();
      }
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      offStatus();
    };
  }, [installing]);

  const handleInstall = async () => {
    setProgress({ phase: 'resolving', done: false });
    try {
      const result = await window.electronAPI.maker.localModelInstall({ consent: true });
      if (result.stopped === 'cancel') {
        setProgress({ phase: 'cancelled', done: true });
        return;
      }
      if (result.status?.kind === 'ready') {
        setProgress({ phase: 'success', version: result.status.version, done: true });
        await notifyReady();
        return;
      }
      setProgress({
        phase: 'error',
        done: true,
        error: result.status?.message ?? result.status?.kind,
      });
      toast.error(t('settings.providers.local.installFailed'));
    } catch {
      setProgress({ phase: 'error', done: true });
      toast.error(t('settings.providers.local.installFailed'));
    }
  };

  return (
    <LocalRuntimeInstallView
      description={
        canInstall
          ? t('settings.providers.local.installConsent', {
              size: window.electronAPI.platform === 'win32' ? '1.4GB' : '150MB',
            })
          : t('settings.providers.local.onboardingBody')
      }
      progress={
        progress
          ? {
              label: t(`settings.providers.local.installPhase.${progress.phase}`),
              percent: progress.percent,
              completed: progress.completed,
              total: progress.total,
              bytesPerSecond: progress.bytesPerSecond,
              error: progress.phase === 'error',
            }
          : undefined
      }
      canInstall={canInstall}
      installing={installing}
      onInstall={() => void handleInstall()}
      onCancel={() => void window.electronAPI.maker.localModelInstallAbort()}
    />
  );
}
