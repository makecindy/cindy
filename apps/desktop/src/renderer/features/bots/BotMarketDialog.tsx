import * as Dialog from '@radix-ui/react-dialog';
import { ChevronLeft, Send, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';
import { extractIpcError } from '../../../shared/ipcError';
import { localizedBotMarketEntry, type BotMarketApi, type BotMarketEntry } from '../../../shared/botMarket';
import type { InstalledGhost } from '../../../shared/ghost';
import type { CompanionImportResult } from '@cindy/maker-shared/companion-import';
import { BotDeleteDialog } from './BotDeleteDialog';
import { bundledPluginNames } from './botMarketDisplay';
import { BotMarketModules, capabilityIcons, rise, type BotMarketPluginInfo } from './BotMarketModules';
import { ensureBotProfilesLoaded, useBotProfiles } from './botStore';

const SKELETON_DELAY_MS = 300;

/** Static placeholders (no shimmer): rows for the list, identity plus module blocks for a directly opened detail. */
function MarketSkeleton({ detail }: { detail: boolean }) {
  const block = 'bg-[var(--surface-chip)]';
  return <div aria-hidden className="animate-fade-in">{detail ? <>
    <div className="flex items-center gap-5 border-b border-[var(--border-default)] py-7">
      <div className={cn('h-[72px] w-[72px] shrink-0 rounded-full', block)} />
      <div className="flex-1 space-y-3"><div className={cn('h-6 w-40 rounded-lg', block)} /><div className={cn('h-8 w-72 max-w-full rounded-xl', block)} /></div>
    </div>
    <div className="space-y-6 py-8">{[0, 1].map(row => <div key={row} className="space-y-3"><div className={cn('h-4 w-24 rounded-lg', block)} /><div className={cn('h-24 rounded-xl', block)} /></div>)}</div>
  </> : <div className="grid grid-cols-2 gap-x-14 max-[720px]:grid-cols-1">{[0, 1, 2, 3, 4, 5].map(row => <div key={row} className="flex items-start gap-4 py-5">
    <div className={cn('h-14 w-14 shrink-0 rounded-full', block)} />
    <div className="flex-1 space-y-2.5"><div className={cn('h-4 w-32 rounded-lg', block)} /><div className={cn('h-3 w-full rounded-lg', block)} /></div>
  </div>)}</div>}</div>;
}

export function BotMarketRoute() {
  const { packageId } = useParams();
  const navigate = useNavigate();
  return <BotMarketDialog initialPackageId={packageId} onClose={() => navigate('/bots')} />;
}

/** Catalog and invitation only. The original import owns every write and retry. */
export function BotMarketDialog({ onClose, initialPackageId, api = window.electronAPI.botMarket }: {
  onClose(): void; initialPackageId?: string; api?: BotMarketApi;
}) {
  const { t, i18n } = useTranslation();
  const { dataOwnerId } = useAuth();
  const navigate = useNavigate();
  const profiles = useBotProfiles();
  const [entries, setEntries] = useState<BotMarketEntry[]>([]);
  const [selectedId, setSelectedId] = useState(initialPackageId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  // The result belongs to the package that was invited, so another teammate's detail never shows or retries it.
  const [result, setResult] = useState<{ packageId: string; value: CompanionImportResult }>();
  const [plugins, setPlugins] = useState<Record<string, BotMarketPluginInfo>>({});
  const [stuck, setStuck] = useState(false);
  const [skeleton, setSkeleton] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const avatar = useRef<HTMLImageElement>(null);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const localized = useMemo(() => entries.map(entry => localizedBotMarketEntry(entry, language)), [entries, language]);
  const selection = localized.find(entry => entry.packageId === selectedId);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [selectedId]);
  // Static placeholders appear only if loading outlasts SKELETON_DELAY_MS, so a quick load never flashes them.
  useEffect(() => {
    setSkeleton(false);
    if (!loading) return;
    const timer = setTimeout(() => setSkeleton(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loading]);
  // Once the large avatar has scrolled out of view the header carries the identity and a compact action.
  const selectedPackage = selection?.packageId;
  useEffect(() => {
    setStuck(false);
    const target = avatar.current;
    if (!selectedPackage || !target || !content.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([change]) => setStuck(!change!.isIntersecting), { root: content.current, threshold: 0 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [selectedPackage]);
  useEffect(() => { setSelectedId(initialPackageId); setResult(undefined); setError(undefined); }, [initialPackageId]);

  useEffect(() => {
    alive.current = true;
    const generation = getDataOwnerGeneration();
    let active = true;
    setEntries([]); setDeleting(undefined); setResult(undefined); setError(undefined); setBusyId(undefined); inFlight.current = false; setLoading(true);
    void api.list().then(items => {
      if (active && isDataOwnerGenerationCurrent(generation)) setEntries(items);
    }).catch(() => { if (active && isDataOwnerGenerationCurrent(generation)) setError(t('bots.market.loadFailed')); })
      .finally(() => { if (active && isDataOwnerGenerationCurrent(generation)) setLoading(false); });
    return () => { active = false; alive.current = false; };
  }, [api, dataOwnerId, t]);

  useEffect(() => {
    const generation = getDataOwnerGeneration();
    let active = true;
    setPlugins({});
    const bridge = window.electronAPI;
    if (!bridge?.pluginMarket || !bridge.ghosts) return;
    // Read existing installation/catalog projections for display names only; no install, enable or OAuth here.
    const installed = bridge.ghosts.listSync().ghosts as InstalledGhost[];
    void bridge.pluginMarket.snapshot().then(snapshot => {
      if (!active || !isDataOwnerGenerationCurrent(generation)) return;
      const projected: Record<string, BotMarketPluginInfo> = {};
      for (const id of new Set(entries.flatMap(entry => entry.tools.map(tool => tool.id)))) {
        const localMatches = installed.filter(ghost => ghost.manifest.id === id);
        const local = localMatches.find(ghost => ghost.namespace === null) ?? (localMatches.length === 1 ? localMatches[0] : undefined);
        const marketMatches = snapshot.items.filter(item => item.ghostId === id);
        const market = marketMatches.find(item => item.namespace === null) ?? (marketMatches.length === 1 ? marketMatches[0] : undefined);
        const name = local?.manifest.name ?? market?.name;
        const isInstalled = !!local || market?.installState === 'installed' || market?.installState === 'update-available';
        if (name || local) projected[id] = { name, installed: isInstalled };
      }
      setPlugins(projected);
    }).catch(() => { /* Bundled names remain; the plugin page owns unavailable-source recovery. */ });
    return () => { active = false; };
  }, [entries, dataOwnerId]);

  const openBot = async (botId: string) => {
    // The teammate is being removed: its listing is stale until the removal returns, so never open it.
    if (deleting === botId) return;
    const generation = getDataOwnerGeneration();
    try { await ensureBotProfilesLoaded(true); }
    catch { if (alive.current && isDataOwnerGenerationCurrent(generation)) setError(t('bots.market.installFailed')); return; }
    if (!alive.current || !isDataOwnerGenerationCurrent(generation)) return;
    onClose(); navigate('/bots/' + encodeURIComponent(botId));
  };
  const invite = async (entry: BotMarketEntry) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusyId(entry.packageId); setError(undefined); setResult(undefined);
    const generation = getDataOwnerGeneration();
    const current = () => alive.current && isDataOwnerGenerationCurrent(generation);
    try {
      let next = await api.invite({ packageId: entry.packageId, packageVersion: entry.packageVersion,
        packageHash: entry.packageHash, locale: language });
      if (!current()) return;
      setResult({ packageId: entry.packageId, value: next });
      // Closing only stops observing; the import owner retains the request.
      while (next.status === 'running' && current()) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!current()) return;
        const status = await api.status(next.requestId);
        if (!current()) return;
        if (!status) throw new Error('IMPORT_STATUS_UNAVAILABLE');
        next = status; setResult({ packageId: entry.packageId, value: next });
      }
      if (!current()) return;
      setEntries(items => items.map(item => item.packageId === entry.packageId ? { ...item, installation: next } : item));
      // A partial save from the list opens its detail, where the failed items and the retry live; a user who already moved on is left alone.
      if (next.status === 'needs-attention') setSelectedId(selected => selected ?? entry.packageId);
      if (next.status === 'complete' && next.saved) await openBot(next.botId);
    } catch (cause) {
      if (current()) setError(t(extractIpcError(cause)?.code === 'IMPORT_NAME_EXISTS' ? 'bots.market.nameExists' : 'bots.market.installFailed'));
    } finally { if (current()) { inFlight.current = false; setBusyId(undefined); } }
  };
  /** `compact` is the header copy of the detail action: same state and busy lock, shorter height. */
  const action = (entry: BotMarketEntry, detail: boolean, compact = false) => {
    const installed = entry.installation;
    const size = compact ? 'md' : detail ? 'lg' : 'sm';
    if (installed?.saved) {
      return <Button variant={detail ? 'cta' : 'secondary'} size={size} onClick={() => void openBot(installed.botId)}>{t('bots.market.open')}</Button>;
    }
    return <Button variant={detail ? 'cta' : 'secondary'} size={size} loading={busyId === entry.packageId} disabled={!!busyId}
      onClick={() => void invite(entry)}>
      {t('bots.market.invite')}
    </Button>;
  };
  const back = () => { setSelectedId(undefined); setResult(undefined); setError(undefined); };
  const visibleResult = result && result.packageId === selection?.packageId ? result.value : selection?.installation;
  const failedChecks = visibleResult?.checks.filter(check => check.status === 'needs-attention') ?? [];
  const failedText = (entry: BotMarketEntry, check: { entryId: string; message?: string }) => {
    if (check.message === 'MEMORY_DISABLED') return t('bots.market.memoryDisabled');
    const name = entry.itemNames[check.entryId];
    if (!name) return t('bots.market.itemFailed.unknown');
    const key = check.entryId.startsWith('routine-') ? 'bots.market.itemFailed.routine' : check.entryId.startsWith('skill-') ? 'bots.market.itemFailed.skill'
      : check.entryId.startsWith('ref-') ? 'bots.market.itemFailed.knowledge' : 'bots.market.itemFailed.other';
    return t(key, { name });
  };
  // Names known without a projection (bundled) show without an install state; the state itself comes only from the projection.
  const pluginInfo = (entry: BotMarketEntry): Record<string, BotMarketPluginInfo> => Object.fromEntries(entry.tools.flatMap(({ id }) => {
    const info = plugins[id] ?? (bundledPluginNames[id] ? { name: bundledPluginNames[id] } : undefined);
    return info ? [[id, info]] : [];
  }));
  const closeButton = <Dialog.Close aria-label={t('bots.close')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"><X size={18} /></Dialog.Close>;
  const lastRowStart = entries.length - (entries.length % 2 || 2);
  return <>
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[60]" />
        <Dialog.Content onPointerDownOutside={event => event.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-[61] flex max-h-[min(760px,calc(100vh-32px))] w-[min(960px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none">
          <header className={cn('flex shrink-0 items-center justify-between gap-4 px-8 transition-colors', selection
            ? cn('border-b py-3', stuck ? 'border-[var(--border-default)]' : 'border-transparent') : 'pb-2 pt-6')}>
            {selection ? <>
              <Button variant="secondary" tone="quiet" compact onClick={back} className="-ml-2 shrink-0"><ChevronLeft size={16} />{t('bots.market.back')}</Button>
              <Dialog.Title className="sr-only">{selection.name}</Dialog.Title>
              {/* Appears once the large avatar has scrolled away; hidden (not just transparent) otherwise so it never takes focus. */}
              <div aria-hidden={!stuck} data-sticky-identity data-stuck={stuck}
                className={cn('flex min-w-0 flex-1 items-center justify-center gap-2 transition-[opacity,transform,visibility]',
                  stuck ? 'visible translate-y-0 opacity-100 duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]'
                    : 'invisible -translate-y-1 opacity-0 duration-[var(--motion-instant)] ease-[var(--motion-ease-in)]')}>
                <img src={selection.avatar} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
                <span className="truncate text-14 font-medium text-[var(--text-primary)]">{selection.name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div aria-hidden={!stuck} className={cn('transition-[opacity,transform,visibility]', stuck
                  ? 'visible translate-y-0 opacity-100 duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]'
                  : 'invisible -translate-y-1 opacity-0 duration-[var(--motion-instant)] ease-[var(--motion-ease-in)]')}>
                  {action(selection, true, true)}
                </div>
                {closeButton}
              </div>
            </> : <>
              <Dialog.Title className="text-24 font-medium text-[var(--text-primary)]">{t('bots.market.heading')}</Dialog.Title>
              {closeButton}
            </>}
          </header>
          <Dialog.Description className="sr-only">{t('bots.market.description')}</Dialog.Description>
          <div ref={content} className="min-h-0 overflow-y-auto px-8 pb-6">
            {error && <p role="alert" className="mt-4 text-13 text-[var(--text-danger)]">{error}</p>}
            {loading ? <>
              <p role="status" className="sr-only">{t('bots.market.loading')}</p>
              {skeleton && <MarketSkeleton detail={!!selectedId} />}
            </> : selection ? <div key={selection.packageId}>
                <section className="bot-market-rise flex items-center gap-5 border-b border-[var(--border-default)] py-7 max-[720px]:flex-wrap" style={rise(0)}>
                  <img ref={avatar} src={selection.avatar} alt="" className="h-[72px] w-[72px] shrink-0 rounded-full object-cover" />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-24 font-medium text-[var(--text-primary)]">{selection.name}</h2>
                    <button type="button" disabled={!!busyId}
                      onClick={() => { if (selection.installation?.saved) void openBot(selection.installation.botId); else void invite(selection); }}
                      className="group relative mt-2 flex max-w-full cursor-pointer rounded-xl text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] active:opacity-80 disabled:cursor-default disabled:opacity-60">
                      {/* Same recipe as the user's message bubble; hover and focus step up to --surface-hover so it reads as tappable without borrowing the CTA fill. */}
                      <span className="flex min-w-0 items-center gap-2 rounded-xl rounded-bl-none border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-14 leading-6 text-[var(--text-primary)] transition-colors group-hover:bg-[var(--surface-hover)] group-focus-visible:bg-[var(--surface-hover)]">
                        <span className="min-w-0">{selection.bubble}</span>
                        <Send size={14} aria-hidden className="shrink-0 text-[var(--text-secondary-mid)]" />
                      </span>
                      {/* Bubble tail, a registered exception in DESIGN.md. The fill covers the bubble's left border; the stroke continues the border around the curve and along the bottom edge. */}
                      <svg aria-hidden viewBox="0 0 10 14" className="pointer-events-none absolute -left-[9px] bottom-0 h-[14px] w-[10px] overflow-visible">
                        <path d="M10 0V14H0C4.5 13 9 9.5 10 0Z" className="fill-[var(--surface-elevated)] transition-colors group-hover:fill-[var(--surface-hover)] group-focus-visible:fill-[var(--surface-hover)]" />
                        <path d="M9.6 0C8.6 9.2 4.5 12.5 0 13.5H10" fill="none" strokeWidth="1" className="stroke-[var(--border-default)]" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {selection.installation?.saved && <Button variant="secondary" size="lg" onClick={() => setDeleting(selection.installation!.botId)}>{t('bots.market.remove')}</Button>}
                    {action(selection, true)}
                  </div>
                </section>
                {busyId && <p role="status" className="mt-4 text-13 text-[var(--text-secondary)]">{t('bots.market.installing')}</p>}
                {visibleResult?.status === 'needs-attention' && <div role="status" className="mt-4 rounded-xl bg-[var(--surface-elevated-soft)] p-4 text-13 text-[var(--text-secondary)]">
                  {failedChecks.map(check => <p key={check.entryId}>{failedText(selection, check)}</p>)}
                  <p className={failedChecks.length ? 'mt-1' : undefined}>{t(visibleResult.saved ? 'bots.market.partialReady' : 'bots.market.partialUnsaved')}</p>
                  <Button variant="secondary" className="mt-3" loading={busyId === selection.packageId} disabled={!!busyId} onClick={() => void invite(selection)}>{t('bots.market.retry')}</Button>
                </div>}
                <ul aria-label={t('bots.market.capabilities')} style={rise(1)} className="bot-market-rise grid grid-cols-3 border-b border-[var(--border-default)] py-6 max-[720px]:grid-cols-1 max-[720px]:gap-4">
                  {selection.capabilities.map(({ icon, label }, index) => {
                    const Icon = capabilityIcons[icon];
                    return <li key={label} className={cn('flex min-w-0 items-center gap-3 px-6 first:pl-0 max-[720px]:px-0', index > 0 && 'border-l border-[var(--border-default)] max-[720px]:border-l-0')}>
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)] text-[var(--text-secondary)]"><Icon size={18} aria-hidden /></span>
                      <span className="break-keep text-16 text-[var(--text-primary)]">{label}</span>
                    </li>;
                  })}
                </ul>
                <BotMarketModules entry={selection} plugins={pluginInfo(selection)}
                  heading={<h3 className="text-16 font-medium text-[var(--text-primary)]">{t('bots.market.workTogether')}</h3>} />
              </div> : <>
                <div className="grid grid-cols-2 gap-x-14 max-[720px]:grid-cols-1">{localized.map((entry, index) => <section key={entry.packageId}
                  className={cn('group relative isolate flex min-w-0 items-start gap-4 py-5', index < lastRowStart && 'border-b border-[var(--border-default)]',
                    index % 2 === 1 && 'before:absolute before:-left-7 before:bottom-5 before:top-5 before:w-px before:bg-[var(--border-default)] max-[720px]:before:hidden',
                    'max-[720px]:border-b max-[720px]:last:border-b-0')}>
                  {/* Row feedback sits behind the content; the name button's overlay below makes the whole row open the detail. */}
                  <span aria-hidden className="pointer-events-none absolute inset-x-[-8px] inset-y-2 -z-10 rounded-lg group-hover:bg-[hsl(var(--sidebar-item-hover))] group-has-[[data-open-detail]:active]:bg-[hsl(var(--sidebar-item-active))]" />
                  <img src={entry.avatar} alt="" className="h-14 w-14 shrink-0 rounded-full object-cover" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <button type="button" data-open-detail onClick={() => setSelectedId(entry.packageId)} className="min-w-0 cursor-pointer text-left text-16 font-medium text-[var(--text-primary)] after:absolute after:inset-0 after:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] after:focus-visible:rounded-lg">{entry.name}</button>
                      <div className="relative z-10 shrink-0">{action(entry, false)}</div>
                    </div>
                    <p className="mt-2 text-13 leading-5 text-[var(--text-secondary)]">{entry.description}</p>
                  </div>
                </section>)}</div>
                {entries.length === 0 && <p className="py-12 text-13 text-[var(--text-secondary)]">{t('bots.market.empty')}</p>}
              </>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <BotDeleteDialog bot={profiles.find(profile => profile.id === deleting) ?? null} onOpenChange={open => { if (!open) setDeleting(undefined); }}
      onDeleted={id => { setDeleting(undefined); setResult(undefined); setEntries(items => items.map(entry => entry.installation?.botId === id ? { ...entry, installation: undefined } : entry)); }} />
  </>;
}
