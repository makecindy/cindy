import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadMeter } from '@/components/ui/download-meter';
import { initialDownloadProgress, type DownloadProgress } from '../../shared/downloadProgress';
import { Button } from '@/components/ui/button';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushStampCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import { extractIpcError } from '@/utils/ipcError';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../shared/ghost';
import type { GithubPluginReleaseResult } from '../../shared/githubPluginRelease';

type ReleaseAction = 'check' | 'update' | 'sign-in';

// A rapid reopen can share the pending read. Completed checks are not cached.
const pendingChecks = new Map<string, Promise<GithubPluginReleaseResult | boolean>>();

function checkRelease(key: string, instanceId: string): Promise<GithubPluginReleaseResult | boolean> {
  const pending = pendingChecks.get(key);
  if (pending) return pending;
  const request = window.electronAPI.ghosts.githubRelease('check', instanceId, undefined)
    .finally(() => pendingChecks.delete(key));
  pendingChecks.set(key, request);
  return request;
}

export function GithubPluginReleaseSettings({ ghost, repository }: { ghost: InstalledGhost; repository: string }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<GithubPluginReleaseResult>();
  const [busy, setBusy] = useState<ReleaseAction>();
  const [progress, setProgress] = useState<DownloadProgress>();
  const mounted = useRef(false);
  const running = useRef(false);
  const checkedOnOpen = useRef(false);
  const instanceId = installedGhostStoragePart(ghost);
  const installedVersion = ghost.manifest.version;
  const approvalToken = ghostInstallApprovalToken(ghost.approval);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.electronAPI.ghosts.onGithubReleaseProgress?.((event, ownerStamp) => {
      if (ownerStamp !== undefined && !isDataOwnerPushStampCurrent(ownerStamp)) return;
      if (event.instanceId === instanceId) setProgress(event.progress);
    });
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, [instanceId]);
  const [failed, setFailed] = useState(false);
  const release = result && 'release' in result ? result.release : undefined;
  const currentVersion = result?.status === 'updated' ? result.version : installedVersion;
  const remoteVersion = result?.status === 'updated' ? result.version : release?.version;

  const run = useCallback(async (action: ReleaseAction, assetId?: number) => {
    if (running.current) return;
    running.current = true;
    const owner = getDataOwnerGeneration();
    const isCurrent = () => mounted.current && isDataOwnerGenerationCurrent(owner);
    setBusy(action);
    if (action === 'update') setProgress(initialDownloadProgress('preparing'));
    setFailed(false);
    try {
      const reply = action === 'check'
        ? await checkRelease(
          JSON.stringify([owner.dataOwnerId, owner.generation, instanceId, approvalToken, repository, installedVersion]),
          instanceId,
        )
        : await window.electronAPI.ghosts.githubRelease(action, instanceId, assetId);
      if (!isCurrent()) return;
      if (typeof reply !== 'boolean') setResult(reply);
      else if (!reply) setFailed(true);
    } catch (error) {
      if (isCurrent() && extractIpcError(error)?.code !== 'MUTATION_CANCELLED') setFailed(true);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(undefined);
    }
  }, [approvalToken, instanceId, installedVersion, repository]);

  useEffect(() => {
    let windowHidden = isWindowHidden();
    const checkWhenVisible = () => {
      if (checkedOnOpen.current || windowHidden || document.visibilityState === 'hidden') return;
      checkedOnOpen.current = true;
      void run('check');
    };
    checkWhenVisible();
    document.addEventListener('visibilitychange', checkWhenVisible);
    const unsubscribe = window.electronAPI.onWindowHiddenChange?.((hidden) => {
      windowHidden = hidden;
      checkWhenVisible();
    });
    return () => {
      document.removeEventListener('visibilitychange', checkWhenVisible);
      unsubscribe?.();
    };
  }, [run]);

  const label = failed ? t('settings.ghosts.detail.githubRelease.unavailable')
    : busy === 'check' ? t('settings.ghosts.detail.githubRelease.checking')
    : busy === 'update' ? t('settings.ghosts.detail.githubRelease.updating')
    : result && t(`settings.ghosts.detail.githubRelease.${result.status}`);
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] pt-3">
      <div className="min-w-0 space-y-1">
        <h3 className="text-13 font-medium text-[var(--text-primary)]">{t('settings.ghosts.detail.githubRelease.title')}</h3>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-12 text-[var(--text-secondary)]">
          <span className="break-all">{repository}</span>
          <span>{t('settings.ghosts.detail.githubRelease.installed', { version: currentVersion })}</span>
          <span>{t('settings.ghosts.detail.githubRelease.upstream', { version: remoteVersion ?? '—' })}{release?.prerelease ? ` · ${t('settings.ghosts.detail.githubRelease.prerelease')}` : ''}</span>
        </p>
        <p role="status" className="text-12 text-[var(--text-secondary)] empty:hidden">{label}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void run('check')}>{t('settings.ghosts.detail.githubRelease.check')}</Button>
        {result?.status === 'available' && (
          <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void run('update', release?.assetId)}>{t('settings.ghosts.detail.githubRelease.update')}</Button>
        )}
        {(result?.status === 'sign-in' || result?.status === 'forbidden') && (
          <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void run('sign-in')}>{t('settings.ghosts.detail.githubRelease.connect')}</Button>
        )}
      </div>
      {busy === 'update' && progress && (
        <div className="basis-full">
          <DownloadMeter label={t('settings.ghosts.detail.githubRelease.title')} progress={progress} />
        </div>
      )}
    </section>
  );
}
