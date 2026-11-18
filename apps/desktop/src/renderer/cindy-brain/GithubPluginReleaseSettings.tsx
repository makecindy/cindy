import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadMeter } from '@/components/ui/download-meter';
import { initialDownloadProgress, type DownloadProgress } from '../../shared/downloadProgress';
import { Button } from '@/components/ui/button';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { extractIpcError } from '@/utils/ipcError';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import type { InstalledGhost } from '../../shared/ghost';
import type { GithubPluginReleaseResult } from '../../shared/githubPluginRelease';

export function GithubPluginReleaseSettings({ ghost, repository }: { ghost: InstalledGhost; repository: string }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<GithubPluginReleaseResult>();
  const [busy, setBusy] = useState<'check' | 'update' | 'sign-in'>();
  const [progress, setProgress] = useState<DownloadProgress>();
  const instanceId = installedGhostStoragePart(ghost);
  useEffect(() => window.electronAPI.ghosts.onGithubReleaseProgress?.((event, ownerStamp) => {
    if (ownerStamp !== undefined && !isDataOwnerPushStampCurrent(ownerStamp)) return;
    if (event.instanceId === instanceId) setProgress(event.progress);
  }), [instanceId]);
  const [failed, setFailed] = useState(false);
  const release = result && 'release' in result ? result.release : undefined;
  const currentVersion = result?.status === 'updated' ? result.version : ghost.manifest.version;
  const remoteVersion = result?.status === 'updated' ? result.version : release?.version;

  async function run(action: 'check' | 'update' | 'sign-in') {
    setBusy(action);
    if (action === 'update') setProgress(initialDownloadProgress('preparing'));
    setFailed(false);
    try {
      const reply = await window.electronAPI.ghosts.githubRelease(action, instanceId, release?.assetId);
      if (typeof reply !== 'boolean') setResult(reply);
      else if (!reply) setFailed(true);
    } catch (error) {
      if (extractIpcError(error)?.code !== 'MUTATION_CANCELLED') setFailed(true);
    } finally {
      setBusy(undefined);
    }
  }

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
          <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void run('update')}>{t('settings.ghosts.detail.githubRelease.update')}</Button>
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
