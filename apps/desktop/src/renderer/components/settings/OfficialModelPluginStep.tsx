import * as Dialog from '@radix-ui/react-dialog';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { installReviewedMarketRelease } from '@/features/plugin/lib/installReviewedMarketRelease';
import { marketItemMatchesInstalledGhost } from '@/features/plugin/lib/pluginMarketPresentation';
import { pluginMarketErrorKey } from '@/features/plugin/lib/pluginMarketErrorKey';
import { requestPluginEnginesRefresh, usePluginEngines } from '@/hooks/usePluginEngines';
import { extractIpcError } from '@/utils/ipcError';
import { ghostInstallApprovalToken } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import type { OfficialModelPlugin, PluginMarketDetail } from '../../../shared/pluginMarket';

const GhostSettingsWebview = lazy(async () => ({ default: (await import('@/cindy-brain/GhostSettingsWebview')).GhostSettingsWebview }));

export function OfficialModelPluginStep({ item, owner, onBack, onDone }: {
  item: OfficialModelPlugin;
  owner: DataOwnerGeneration;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const ghosts = useInstalledGhosts();
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ detail?: PluginMarketDetail; error?: string; roster: typeof ghosts }>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const detail = await window.electronAPI.pluginMarket.detail(item.pluginId);
        if (!active || !isDataOwnerGenerationCurrent(owner)) return;
        if (detail.pluginId !== item.pluginId || detail.ghostId !== item.ghostId ||
            detail.scope !== 'public' || detail.sourceType !== 'server' || detail.publisherKind !== 'official' ||
            !detail.manifest.harnesses?.some(engine => engine.protocol === 'acp')) {
          setResult({ error: 'settings.ghosts.market.errors.stateChanged', roster: ghosts });
          return;
        }
        setResult({ detail, roster: ghosts });
      } catch (error) {
        if (active && isDataOwnerGenerationCurrent(owner)) setResult({ error: pluginMarketErrorKey(error), roster: ghosts });
      }
    }
    void load();
    return () => { active = false; };
  }, [item, owner, ghosts, reload]);
  const detail = result?.roster === ghosts ? result.detail : undefined;
  const installed = detail?.installState === 'installed' || detail?.installState === 'update-available';
  const ghost = detail && installed ? ghosts.find(g => marketItemMatchesInstalledGhost(detail, g)) : undefined;
  const approved = ghost?.approval.state === 'approved' && !ghost.retirement;
  const instance = ghost && installedGhostStoragePart(ghost);
  const configured = approved && ghost.enabled;
  const engines = usePluginEngines(Boolean(configured)).filter(engine => engine.ghostId === instance);
  const canInstall = detail?.installState === 'not-installed';
  const error = actionError || result?.error || (detail?.installState === 'conflict' ? 'settings.ghosts.market.errors.conflict' :
    installed && !approved ? 'settings.ghosts.market.errors.stateChanged' : '');
  async function act() {
    if (!detail || pending.current || !isDataOwnerGenerationCurrent(owner)) return;
    pending.current = true;
    setBusy(true);
    setActionError('');
    try {
      if (canInstall) await installReviewedMarketRelease(detail);
      else if (approved && instance) await window.electronAPI.ghosts.setEnabled(instance, true, ghostInstallApprovalToken(ghost.approval));
      if (mounted.current && isDataOwnerGenerationCurrent(owner)) {
        setReload(v => v + 1);
        requestPluginEnginesRefresh();
      }
    } catch (cause) {
      if (mounted.current && isDataOwnerGenerationCurrent(owner) && extractIpcError(cause)?.code !== 'MUTATION_CANCELLED')
        setActionError(pluginMarketErrorKey(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <>
    <Dialog.Title className="px-4 py-3 text-16 font-medium">{t('settings.ghosts.detail.settingsTitle', { name: item.name })}</Dialog.Title>
    <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-3">
      {item.description && <p className="text-13 text-[var(--text-secondary)]">{item.description}</p>}
      {error && <p role="alert">{t(error)}</p>}
      {!detail && !error && <p role="status">{t('settings.providers.wizard.pluginLoading')}</p>}
      {configured && ghost.manifest.settingsHtml &&
        <Suspense fallback={<p role="status">{t('settings.providers.wizard.pluginLoading')}</p>}><GhostSettingsWebview key={instance} ghost={ghost} title={t('settings.ghosts.detail.settingsTitle', { name: item.name })} appearance="plugin" /></Suspense>}
      {configured && <div role="status">
        {engines.length ? engines.map(engine => <p key={engine.key}>{engine.name} · {t('settings.providers.wizard.engineState.' + engine.availability.state)} {engine.availability.message}</p>) :
          t('settings.providers.wizard.engineState.unknown')}
      </div>}
    </div>
    <div className="flex items-center justify-between px-4 py-3">
      <Button variant="secondary" onClick={onBack}>{t('settings.providers.wizard.back')}</Button>
      {configured ? <Button variant="cta" onClick={() => { requestPluginEnginesRefresh(instance); onDone(); }}>{t('settings.providers.wizard.finish')}</Button> :
        canInstall || approved ? <Button variant="cta" loading={busy} disabled={busy} onClick={() => void act()}>
          {t(canInstall ? 'settings.providers.wizard.installAndConfigure' : 'settings.ghosts.detail.enable')}</Button> :
        error ? <Button variant="secondary" onClick={() => { setActionError(''); setReload(v => v + 1); }}>{t('settings.providers.wizard.retryPlugin')}</Button> : null}
    </div>
  </>;
}
