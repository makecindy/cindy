import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadMeter } from '@/components/ui/download-meter';
import { isDownloadProgressActive } from '../../shared/downloadProgress';
import { Button } from '@/components/ui/button';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import { extractIpcError } from '@/utils/ipcError';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import type { InstalledGhost } from '../../shared/ghost';
import type { GithubPluginReleaseResult } from '../../shared/githubPluginRelease';
import { checkGithubRelease, runGithubReleaseUpdate } from '@/features/plugin/lib/githubReleaseUpdates';
import { githubUpdateKey } from '@/features/plugin/lib/updateAllModel';
import {
  beginPluginInstallProgress,
  endPluginInstallProgress,
  succeedPluginInstallProgress,
  usePluginInstallProgress,
} from '@/features/plugin/lib/pluginInstallProgress';

type ReleaseAction = 'check' | 'update' | 'sign-in';

export function GithubPluginReleaseSettings({ ghost, repository }: { ghost: InstalledGhost; repository: string }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<GithubPluginReleaseResult>();
  const [busy, setBusy] = useState<ReleaseAction>();
  const mounted = useRef(false);
  const running = useRef(false);
  const checkedOnOpen = useRef(false);
  const instanceId = installedGhostStoragePart(ghost);
  const installedVersion = ghost.manifest.version;
  const progressKey = githubUpdateKey(instanceId);
  const progress = usePluginInstallProgress(progressKey)?.download;
  const updating = !!progress && isDownloadProgressActive(progress.phase);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, [instanceId]);
  const [failed, setFailed] = useState(false);
  const release = result && 'release' in result ? result.release : undefined;
  const currentVersion = result?.status === 'updated' ? result.version : installedVersion;
  const remoteVersion = result?.status === 'updated' ? result.version : release?.version;

  const run = useCallback(async (action: ReleaseAction, assetId?: number) => {
    if (running.current || updating || (action === 'update' && assetId === undefined)) return;
    running.current = true;
    const owner = getDataOwnerGeneration();
    const isCurrent = () => mounted.current && isDataOwnerGenerationCurrent(owner);
    setBusy(action);
    setFailed(false);
    const target = { instanceId, repository, installedVersion };
    try {
      // Opening or clicking "check" always reads fresh; a rapid reopen shares the pending read, and
      // the answer also updates the Plugin page banner.
      let reply: GithubPluginReleaseResult | boolean;
      if (action === 'update' && assetId !== undefined) {
        beginPluginInstallProgress(progressKey);
        try {
          reply = await runGithubReleaseUpdate({ target, assetId, progressKey });
          if (isDataOwnerGenerationCurrent(owner) && reply.status === 'updated') {
            succeedPluginInstallProgress(progressKey);
          }
        } finally {
          if (isDataOwnerGenerationCurrent(owner)) endPluginInstallProgress(progressKey);
        }
      } else if (action === 'check') {
        reply = await checkGithubRelease(target, { force: true });
      } else {
        reply = await window.electronAPI.ghosts.githubRelease('sign-in', instanceId);
      }
      if (!isCurrent()) return;
      if (typeof reply !== 'boolean') setResult(reply);
      else if (!reply) setFailed(true);
    } catch (error) {
      if (isCurrent() && extractIpcError(error)?.code !== 'MUTATION_CANCELLED') setFailed(true);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(undefined);
    }
  }, [instanceId, installedVersion, progressKey, repository, updating]);

  useEffect(() => {
    let windowHidden = isWindowHidden();
    const checkWhenVisible = () => {
      if (checkedOnOpen.current || updating || windowHidden || document.visibilityState === 'hidden') return;
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
  }, [run, updating]);

  const label = updating ? t('settings.ghosts.detail.githubRelease.updating')
    : failed ? t('settings.ghosts.detail.githubRelease.unavailable')
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
        <Button variant="secondary" size="sm" disabled={!!busy || updating} onClick={() => void run('check')}>{t('settings.ghosts.detail.githubRelease.check')}</Button>
        {result?.status === 'available' && (
          <Button variant="secondary" size="sm" disabled={!!busy || updating} onClick={() => void run('update', release?.assetId)}>{t('settings.ghosts.detail.githubRelease.update')}</Button>
        )}
        {(result?.status === 'sign-in' || result?.status === 'forbidden') && (
          <Button variant="secondary" size="sm" disabled={!!busy || updating} onClick={() => void run('sign-in')}>{t('settings.ghosts.detail.githubRelease.connect')}</Button>
        )}
      </div>
      {updating && progress && (
        <div className="basis-full">
          <DownloadMeter label={t('settings.ghosts.detail.githubRelease.title')} progress={progress} />
        </div>
      )}
    </section>
  );
}
