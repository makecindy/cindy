import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { SkillhubDetailView } from './SkillhubDetailView';
import { SkillhubMarketDetailView } from './SkillhubMarketDetailView';
import { SkillDetailHeader, SkillDetailPage } from './components/SkillDetailLayout';
import { LocalSkillControls } from './components/LocalSkillControls';
import { InstallTargetPicker } from './components/InstallTargetPicker';
import { MarketManagementDialogs, useMarketManagement } from './hooks/useMarketManagement';
import { useSkillhubIdentityPolicy } from './hooks/useSkillhubIdentityPolicy';
import { useMarketSkillUpdate } from './hooks/useMarketSkillUpdate';
import { deriveLocalInstall, type MarketSkill } from './hooks/useMarketList';
import { refresh, useSkillhub } from './hooks/useSkillhub';
import { buildLocalSkillRoute, findLocalSkillRouteEntry } from './lib/localRoutes';
import { buildMarketSkillRoute, skillDetailCatalog, skillDetailLocalParams, skillDetailReturnRoute, withSkillDetailReturn } from './lib/detailRoutes';
import { marketLocalCopies } from './lib/marketLocalCopies';

function marketViewModel(info: SkillhubInfoResult, local: SkillhubSkill | null, catalogScope: MarketSkill['catalogScope']): MarketSkill {
  const primary = local ? {
    version: local.registryEntry?.version ?? null, absolutePath: local.absolutePath, hasRegistryEntry: !!local.registryEntry,
  } : undefined;
  const installed = deriveLocalInstall(info, primary ? { global: primary, projects: [] } : undefined);
  return {
    ...info, icon: info.icon ?? undefined, catalogScope, ...installed,
    authorAvatarUrl: null, avatarInitial: info.authorName.slice(0, 1),
    categories: info.categories ?? [], tags: info.tags ?? [], githubUrl: info.githubUrl ?? null,
    relativeTime: '', latestPublishedFromDeviceId: null,
    cardState: installed.updateAvailable ? 'installed-outdated' : installed.installedLocally ? 'installed-latest' : 'not-installed',
  };
}

/** Both list entry points resolve identity here; content readers retain their own authority. */
export function SkillhubDetailRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { user } = useAuth();
  const identity = useSkillhubIdentityPolicy(user);
  const owner = getDataOwnerGeneration();
  const { skills, bootstrapped, loading, learnSkillEnabled } = useSkillhub();
  const explicitLocal = findLocalSkillRouteEntry(skills, skillDetailLocalParams(search), search);
  const remoteName = search.get('remote')
    ?? (explicitLocal?.kind === 'skill' && !explicitLocal.builtIn ? explicitLocal.registrySkillName ?? explicitLocal.name : null);
  const catalogScope = search.has('remote') ? skillDetailCatalog(search) : explicitLocal?.registryEntry?.catalogScope;
  const targetKey = JSON.stringify([owner, remoteName, catalogScope]);
  const [remote, setRemote] = useState<{ key: string; info: SkillhubInfoResult | null; failed: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const returnTo = skillDetailReturnRoute(search);
  const showingMarket = search.get('view') === 'market';
  const marketUpdate = useMarketSkillUpdate();
  const [pickerOpen, setPickerOpen] = useState(false);

  const commandPath = search.get('path');
  useEffect(() => { if (commandPath) void refresh(); }, [commandPath]);
  useEffect(() => {
    if (!remoteName) return;
    let cancelled = false;
    setRemote(null);
    void window.electronAPI.skillhub.info(remoteName, catalogScope).then((result) => {
      if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
      setRemote({ key: targetKey, info: result.success && result.info ? result.info : null, failed: !result.success });
    }, () => {
      if (!cancelled && isDataOwnerGenerationCurrent(owner)) setRemote({ key: targetKey, info: null, failed: true });
    });
    return () => { cancelled = true; };
  }, [remoteName, catalogScope, targetKey, owner, revision, showingMarket]);

  // A same-name market record is not an association for an unregistered local author folder.
  const info = remote?.key === targetKey && remote.info
    && (search.has('remote') || explicitLocal?.registryEntry || remote.info.isCreator === true)
    ? remote.info : null;
  const copies = useMemo(() => info
    ? marketLocalCopies(skills, { ...info, isMine: info.isCreator === true, catalogScope })
    : explicitLocal ? [explicitLocal] : [], [info, skills, explicitLocal, catalogScope]);
  const selected = copies.find((copy) => copy.id === explicitLocal?.id) ?? copies[0] ?? null;
  const market = info ? marketViewModel(info, selected, catalogScope) : null;

  const selectSource = (view: 'local' | 'market', local: SkillhubSkill | null = selected, action?: 'publish') => {
    if (!isDataOwnerGenerationCurrent(owner)) return;
    let route = view === 'local' && local
      ? withSkillDetailReturn(buildLocalSkillRoute(local), returnTo)
      : buildMarketSkillRoute({ name: remoteName ?? '', catalogScope }, returnTo);
    const query = new URLSearchParams(route.split('?')[1]);
    if (info) { query.set('remote', info.name); query.set('catalog', catalogScope ?? 'native'); }
    if (local) {
      const localQuery = new URLSearchParams(buildLocalSkillRoute(local).split('?')[1]);
      for (const [key, value] of localQuery) if (key !== 'view') query.set(key, value);
    }
    if (action) query.set('action', action);
    route = `/skillhub/detail?${query}`;
    navigate(route, { replace: true });
  };
  const management = useMarketManagement({
    active: !!info?.canManage, reload, onClone: () => setPickerOpen(true),
    onDeleted: () => selected ? selectSource('local') : navigate(returnTo),
  });

  const navigation = (beforeLeave: () => Promise<boolean> = async () => true, disabled = false) => (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-default)] px-4 py-2">
      <div className="flex items-center gap-1" role="group" aria-label={t('skillhub.unifiedDetail.contentSource')}>
        {selected && <Button variant={showingMarket ? 'secondary' : 'primary'} disabled={disabled} aria-pressed={!showingMarket}
          onClick={() => { if (showingMarket) void beforeLeave().then((ok) => { if (ok) selectSource('local'); }); }}>{t('skillhub.unifiedDetail.local')}</Button>}
        {(info || showingMarket) && <Button variant={showingMarket ? 'primary' : 'secondary'} disabled={disabled} aria-pressed={showingMarket}
          onClick={() => { if (!showingMarket) void beforeLeave().then((ok) => { if (ok) selectSource('market'); }); }}>{t('skillhub.unifiedDetail.market')}</Button>}
      </div>
      {copies.length > 1 && (
        <Select label={t('skillhub.sidebar.marketInstalledHeading')} value={selected?.id ?? ''} disabled={disabled}
          className="max-w-sm"
          onValueChange={(value) => {
            const next = copies.find((copy) => copy.id === value);
            if (next && next.id !== selected?.id) void beforeLeave().then((ok) => { if (ok) selectSource(showingMarket ? 'market' : 'local', next); });
          }} options={copies.map((copy) => ({ value: copy.id, label: `${copy.scope === 'global' ? t('skillhub.detail.scopeGlobal') : copy.projectRoot} · ${copy.discoveredPath ?? copy.absolutePath}` }))} />
      )}
      {showingMarket && selected && <span className="min-w-0 truncate text-xs text-[var(--text-secondary)]" title={selected.absolutePath}>{selected.absolutePath}</span>}
    </div>
  );

  return <>
    {!showingMarket && selected ? (
      <SkillhubDetailView key={`${owner.generation}:${selected.id}`} entryOverride={selected} renderNavigation={navigation}
        onUninstalled={() => info ? selectSource('market', null) : navigate(returnTo)} />
    ) : showingMarket && market ? (
      <SkillhubMarketDetailView key={`${owner.generation}:${remoteName}:${catalogScope}`} skill={market} onClose={() => navigate(returnTo)}
        navigation={navigation()} primaryAction={user ? info?.canManage && identity.canWrite ? 'manage' : 'clone' : 'none'}
        onClone={() => setPickerOpen(true)} onManageAction={management.handleManageAction} learnSkillEnabled={learnSkillEnabled}
        onUpdate={user ? marketUpdate.update : undefined} updating={marketUpdate.updatingNames.has(market.name)}
        localActions={selected ? <LocalSkillControls key={selected.id} skill={selected} disabled={marketUpdate.updatingNames.has(market.name)} /> : null} />
    ) : (
      <SkillDetailPage>
        <SkillDetailHeader title={remoteName ?? t('skillhub.home.title')} backLabel={t('skillhub.detail.backToSkillhub')} onBack={() => navigate(returnTo)} />
        {navigation()}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
          {!bootstrapped || loading || (showingMarket && remoteName && remote?.key !== targetKey)
            ? t('skillhub.detail.loadingContent') : t(remote?.failed ? 'skillhub.unifiedDetail.marketUnavailable' : 'skillhub.detail.notFound')}
          {remote?.key === targetKey && remote.failed && <Button onClick={reload}>{t('skillhub.unifiedDetail.retry')}</Button>}
        </div>
      </SkillDetailPage>
    )}
    <InstallTargetPicker open={pickerOpen && !!market} skill={market} onClose={() => setPickerOpen(false)}
      onInstallComplete={() => { setPickerOpen(false); void refresh(); reload(); }} />
    <MarketManagementDialogs controller={management} />
  </>;
}

/** Preserve existing bookmarks, command-palette links, and older market URLs. */
export function LegacySkillDetailRedirect({ market = false }: { market?: boolean }) {
  const params = useParams();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.set('view', market ? 'market' : 'local');
  if (market) {
    search.set('remote', params.name ?? '');
    if (!search.has('catalog')) search.set('catalog', location.pathname.startsWith('/skillhub/market/manage/') ? 'native' : 'market');
    if (!search.has('returnTo')) search.set('returnTo', '/skillhub/market');
  } else {
    if (params.kind) search.set('kind', params.kind);
    if (params.name) search.set('name', params.name);
    if (params.projectHash) search.set('project', params.projectHash);
    if (!search.has('scope') && params.kind) search.set('scope', params.projectHash ? 'project' : 'global');
  }
  return <Navigate to={`/skillhub/detail?${search}`} replace state={location.state} />;
}
