import { useCallback, useEffect, useRef, useState } from 'react';
import { isLocalPluginSnapshotId, type LocalPluginShareSnapshot } from '@cindy/plugin-protocol';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { GhostInstallConsentContent, ghostInstallConsentSourceLabel } from '@/cindy-brain/GhostInstallConsentHost';
import { useSignInToCindy } from '@/hooks/useSignInToCindy';
import { extractIpcError } from '@/utils/ipcError';
import type { InstalledGhost } from '../../../shared/ghost';
import type { PluginManagementReceipt } from '../../../shared/pluginManagement';
import { GhostPluginIcon } from './GhostPluginIcon';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';
import { pluginMarketErrorKey } from './lib/pluginMarketErrorKey';
import { PluginDevicePicker, type CatalogDeviceControl } from './PluginDevicePicker';
import { hasPluginManagement, invokePluginManagement, parsePluginManagementSnapshot, parsePluginManagementReceipt } from './remotePluginManagementClient';

/** A shared local package is a fixed manual import, with no marketplace/update identity. */
export function LocalPluginShareView({ snapshotId, onBack, onInstalled, deviceControl }: {
  snapshotId: string; onBack: () => void; onInstalled: (ghost?: InstalledGhost) => void;
  deviceControl?: CatalogDeviceControl;
}) {
  const { t } = useTranslation();
  const { isAuthenticated, dataOwnerId, dataOwnerGeneration } = useAuth();
  const signIn = useSignInToCindy(`/plugins?share=${encodeURIComponent(snapshotId)}`);
  const { scrolled, onScroll } = usePluginDetailScrolled();
  const [snapshot, setSnapshot] = useState<LocalPluginShareSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const installing = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(null); setError(null);
    if (!isLocalPluginSnapshotId(snapshotId)) setError('settings.ghosts.market.errors.invalidRequest');
    else if (isAuthenticated) void window.electronAPI.pluginMarket.localShareDetail(snapshotId)
      .then(value => { if (generation.current === current) setSnapshot(value); })
      .catch(() => { if (generation.current === current) setError('sharing.localReadFailed'); });
    return () => { generation.current++; };
  }, [snapshotId, isAuthenticated, dataOwnerId, dataOwnerGeneration, revision]);
  const install = async () => {
    if (!snapshot || !isAuthenticated || installing.current) return;
    const current = generation.current;
    installing.current = true; setBusy(true); setError(null);
    try {
      const result = await window.electronAPI.pluginMarket.installLocalShare(snapshotId, snapshot);
      if (current === generation.current) onInstalled(result.ghost);
    } catch (cause) {
      if (current === generation.current && extractIpcError(cause)?.code !== 'MUTATION_CANCELLED')
        setError(pluginMarketErrorKey(cause));
    } finally {
      installing.current = false;
      if (current === generation.current) setBusy(false);
    }
  };
  return <main className="app-wallpaper-surface plugin-motion-root h-full min-h-0 w-full overflow-y-auto bg-[var(--surface)]" onScroll={onScroll}>
    <PluginDetailTopBar label={t('settings.ghosts.detail.backToList')} onBack={onBack} scrolled={scrolled} />
    <article className="plugin-detail-frame mx-auto w-full max-w-[824px] px-6 pb-16 pt-5">
      {!isAuthenticated ? <div className="space-y-4 text-14 text-[var(--text-secondary)]">
        <p>{t('sharing.localOpenHint')}</p>
        <Button variant="cta" onClick={() => void signIn()}>{t('sharing.localSignIn')}</Button>
      </div> : snapshot ? <>
        <header className="flex flex-wrap items-center gap-4">
          <GhostPluginIcon iconDataUrl={snapshot.icon ?? undefined} iconId={snapshot.ghostId} iconName={snapshot.name} size="detail" />
          <div className="min-w-0 flex-1 basis-40">
            <h1 className="break-words text-28 font-medium text-[var(--text-primary)]">{snapshot.name}</h1>
            <p className="mt-2 flex flex-wrap gap-2 text-12 text-[var(--text-tertiary)]">
              <span>{t('sharing.localPackage')}</span><span>·</span><span>v{snapshot.version}</span>
              {snapshot.author ? <span>· {snapshot.author}</span> : null}
            </p>
          </div>
        </header>
        {snapshot.description ? <p className="mt-6 whitespace-pre-wrap break-words text-14 leading-relaxed text-[var(--text-secondary)]">{snapshot.description}</p> : null}
        <p className="mt-6 text-13 leading-relaxed text-[var(--text-secondary)]">{t('sharing.localVersionNotice')}</p>
        <section className="mt-6 space-y-3" aria-label={t('sharing.localInstallTarget')}>
          {deviceControl && (deviceControl.selected || deviceControl.directory.candidates.length > 0) ? <>
            <p className="text-13 text-[var(--text-secondary)]">{t('sharing.localInstallTarget')}</p>
            <div className="[&>button]:max-w-full"><PluginDevicePicker {...deviceControl} disabled={busy} /></div>
          </> : null}
          {deviceControl?.selected ? <RemoteShareInstall
            key={`${dataOwnerId}:${dataOwnerGeneration}:${snapshotId}:${deviceControl.selected.deviceId}`}
            snapshot={snapshot} device={deviceControl.selected} online={deviceControl.directory.online}
            onBusy={setBusy} onError={setError} onInstalled={() => onInstalled()}
          /> : <div><Button variant="cta" loading={busy} disabled={busy} onClick={() => void install()}>
            <Download size={15} aria-hidden />{t(busy ? 'sharing.localInstalling' : 'sharing.localInstallButton', { version: snapshot.version })}
          </Button></div>}
        </section>
      </> : !error ? <div role="status" className="flex items-center gap-2 text-13 text-[var(--text-secondary)]"><Spinner size={16} />{t('sharing.localLoading')}</div> : null}
      {error ? <div role="alert" className="mt-5 text-13 text-[var(--text-secondary)]">
        <p>{t(error)}</p>
        {!snapshot ? <Button className="mt-3" variant="secondary" onClick={() => setRevision(value => value + 1)}>{t('sharing.retry')}</Button> : null}
      </div> : null}
    </article>
  </main>;
}

/** Projects the original Host receipt; a reconnect only reads the same operation. */
function RemoteShareInstall({ snapshot, device, online, onBusy, onError, onInstalled }: {
  snapshot: LocalPluginShareSnapshot; device: { deviceId: string; name: string }; online: boolean;
  onBusy: (busy: boolean) => void; onError: (key: string | null) => void; onInstalled: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'readFailed' | 'unknown' | null>(null);
  const scope = useRef({ owner: getDataOwnerGeneration(), alive: true, online });
  scope.current.online = online;
  const operation = useRef<string | null>(null);
  const readRevision = useRef(0);
  const dialog = useRef<AbortController | null>(null);
  const current = useCallback(() => scope.current.alive && isDataOwnerGenerationCurrent(scope.current.owner), []);
  const writable = useCallback(() => current() && scope.current.online, [current]);
  const invoke = useCallback((action: string, input?: Record<string, unknown>) =>
    invokePluginManagement(device.deviceId, action, input), [device.deviceId]);
  useEffect(() => {
    scope.current.alive = true;
    return () => {
      scope.current.alive = false; readRevision.current++; dialog.current?.abort();
      if (operation.current && isDataOwnerGenerationCurrent(scope.current.owner))
        void invoke('cancel', { operationId: operation.current }).catch(() => {});
      onBusy(false);
    };
  }, [invoke, onBusy]);
  const refresh = useCallback(async () => {
    if (!writable()) return;
    const revision = ++readRevision.current;
    setSupported(null); setStatus(null);
    try {
      const supported = await hasPluginManagement(device.deviceId) &&
        parsePluginManagementSnapshot(await invoke('snapshot')).localShares === true;
      if (writable() && revision === readRevision.current) setSupported(supported);
    } catch { if (writable() && revision === readRevision.current) setStatus('readFailed'); }
  }, [device.deviceId, invoke, writable]);
  useEffect(() => {
    if (online) void refresh();
    else { readRevision.current++; setSupported(null); dialog.current?.abort(); }
  }, [online, refresh]);
  const acceptReceipt = useCallback(async (next: PluginManagementReceipt) => {
    if (!writable() || next.operationId !== operation.current) return;
    setStatus(null);
    if (['succeeded', 'cancelled', 'failed'].includes(next.phase)) {
      operation.current = null; setBusy(false); onBusy(false);
      if (next.phase === 'succeeded') onInstalled();
      else if (next.phase === 'failed') onError('settings.ghosts.remote.actionFailed');
      return;
    }
    if (next.phase !== 'confirmation' || !next.consent || dialog.current) return;
    const abort = new AbortController(); dialog.current = abort;
    try {
      const consent = next.consent;
      const replacement = consent.purpose === 'share-replace' && consent.facts.kind === 'update';
      const confirmed = await confirm({
        title: t('settings.ghosts.remote.confirmOn', { device: device.name, name: consent.facts.name }),
        description: `${device.name} · ${consent.facts.kind === 'install'
          ? t('settings.ghosts.installConsent.installMeta', { version: consent.facts.version, source: ghostInstallConsentSourceLabel(t, consent) })
          : t('settings.ghosts.installConsent.updateMeta', { from: consent.facts.previousVersion, to: consent.facts.version, source: ghostInstallConsentSourceLabel(t, consent) })}`,
        content: <GhostInstallConsentContent facts={consent.facts} replacement={replacement} sourceChanged={consent.target?.sourceChanged} />,
        confirmText: t(replacement ? 'sharing.localReplaceButton' : consent.facts.kind === 'install'
          ? 'settings.ghosts.installConsent.confirmInstall' : 'settings.ghosts.installConsent.confirmUpdate'),
        cancelText: t('settings.ghosts.installConsent.cancel'), maxWidth: 460, contentSelectable: true,
      }, abort.signal);
      if (writable() && !abort.signal.aborted && operation.current === next.operationId)
        await invoke('answer', { operationId: next.operationId, requestId: consent.requestId, confirmed });
    } catch { if (writable()) setStatus('unknown'); }
    finally { if (dialog.current === abort) dialog.current = null; }
  }, [confirm, device.name, invoke, onBusy, onError, onInstalled, t, writable]);
  const poll = useCallback(async () => {
    const id = operation.current;
    if (!id || !writable()) return;
    try { await acceptReceipt(parsePluginManagementReceipt(await invoke('operation', { operationId: id }), id)); }
    catch { if (writable() && id === operation.current) setStatus('unknown'); }
  }, [acceptReceipt, invoke, writable]);
  useEffect(() => {
    if (!online || !busy) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await poll();
      if (alive && operation.current) timer = setTimeout(tick, 1200);
    };
    timer = setTimeout(tick, 600);
    return () => { alive = false; clearTimeout(timer); };
  }, [online, busy, poll]);
  const install = async () => {
    if (!writable() || !supported || operation.current) return;
    const id = crypto.randomUUID(); operation.current = id;
    setBusy(true); onBusy(true); onError(null); setStatus(null);
    try {
      await acceptReceipt(parsePluginManagementReceipt(await invoke('begin', {
        // Icons are presentation only; keep the action within device-link's size bound.
        operationId: id, kind: 'install-share', expectedSnapshot: { ...snapshot, icon: null },
      }), id));
    } catch (cause) {
      if (!current() || id !== operation.current) return;
      const code = extractIpcError(cause)?.code;
      if (['INVALID_PARAMS', 'NOT_FOUND', 'PRECONDITION_FAILED', 'UNSUPPORTED_CAPABILITY', 'PERMISSION_DENIED'].includes(code ?? '')) {
        operation.current = null; setBusy(false); onBusy(false); setStatus(null);
        onError('settings.ghosts.remote.actionFailed');
      } else setStatus('unknown');
    }
  };
  return <div className="space-y-3">
    <Button variant="cta" loading={busy} disabled={busy || !online || supported !== true} onClick={() => void install()}>
      <Download size={15} aria-hidden />{t(busy ? 'sharing.localInstalling' : 'sharing.localInstallButton', { version: snapshot.version })}
    </Button>
    {!online ? <p className="text-13 text-[var(--text-secondary)]">{t('settings.ghosts.remote.offlineNotice', { device: device.name })}</p>
      : supported === false ? <p className="text-13 text-[var(--text-secondary)]">{t('sharing.localTargetUnsupported', { device: device.name })}</p> : null}
    {status ? <div role="status" className="space-y-2 text-13 text-[var(--text-secondary)]">
      <p>{t(`settings.ghosts.remote.${status}`)}</p>
      <Button variant="secondary" onClick={() => void (operation.current ? poll() : refresh())}>{t('sharing.retry')}</Button>
    </div> : null}
  </div>;
}
