import * as Dialog from '@radix-ui/react-dialog';
import { Building2, Check, ChevronRight, FileText, Globe } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type {
  MyPluginView,
  PluginContributionsApi,
  PreparedPluginContribution,
} from '../../../shared/pluginContributions';
import type { PersonalPluginSummary } from '../../../shared/pluginAuthor';
import type { GhostPluginListItem } from './lib/ghostPluginViewModel';
import { teamPendingRelease } from './team/teamPluginModel';
import { contributionErrorKey, useContributionPreview } from './lib/useContributionPreview';
import { GhostPluginIcon } from './GhostPluginIcon';
import { PluginDetailRecordRow } from './PluginDetailRecord';

const copy = 'settings.ghosts.contribution';

export interface PluginSubmitOptions {
  prepared?: PreparedPluginContribution;
  /** Closing/reopening the dialog must not let an old completion navigate. */
  isCurrent?: () => boolean;
}

/** Organization identity only: publishing to the team goes through the org confirmation screen. */
export interface TeamPublishingOption {
  orgName: string;
  plugins: readonly GhostPluginListItem[];
  /** Starts the organization publish; resolves false when it could not start. */
  onStart: (instanceId: string) => Promise<boolean>;
}

type PublishTarget = 'team' | 'public';

export interface PluginPublishDialogRequest {
  id: number;
  owner: string;
  open: boolean;
  instanceId?: string;
}

/** Mounted for one owner-bound opening; retained through Radix's exit animation. */
export function PluginPublishDialog({
  open, ownerKey, initialInstanceId, onOpenChange, onClosed,
  reader, localPlugins, installedPluginCount, onPrepare, onSubmitUpdate, sourceDevice,
  submitBusy = false, installedRevision, submissionRevision = 0, team, teamPlugins = null,
}: {
  open: boolean;
  ownerKey: string;
  initialInstanceId?: string;
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
  reader: Pick<PluginContributionsApi, 'prepare' | 'discard'> &
    Partial<Pick<PluginContributionsApi, 'list' | 'releases'>>;
  sourceDevice?: string;
  localPlugins: readonly GhostPluginListItem[];
  installedPluginCount: number;
  onPrepare?: PluginContributionsApi['prepare'];
  onSubmitUpdate: (instanceId: string, options?: PluginSubmitOptions) => Promise<boolean>;
  submitBusy?: boolean;
  installedRevision?: string;
  submissionRevision?: number;
  /** Present for organization identities; personal identities only publish to the public market. */
  team?: TeamPublishingOption;
  /**
   * The team plugins the page has already read; null while unread or after a failed read. Only used
   * to mark plugins with a version under review, so no request is made here; anything not marked
   * is still refused at upload (PLUGIN_PENDING_RELEASE_EXISTS).
   */
  teamPlugins?: readonly PersonalPluginSummary[] | null;
}) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const pickerStatusId = useId();
  const [pickerSelection, setPickerSelection] = useState<string | null>(initialInstanceId ?? null);
  // Organization members start on team sharing (product prototype); the quick "submit for review"
  // entry from a public plugin is public.
  const [target, setTarget] = useState<PublishTarget>(team && !initialInstanceId ? 'team' : 'public');
  const [teamSelection, setTeamSelection] = useState<string | null>(null);
  const [teamStarting, setTeamStarting] = useState(false);
  const [teamFailed, setTeamFailed] = useState(false);
  const publicTarget = target === 'public';
  const [pickerRefresh, setPickerRefresh] = useState(0);
  const [pickerPlugins, setPickerPlugins] = useState<{
    key: string; plugins: MyPluginView[]; failure?: string;
  } | null>(null);
  const [versionRead, setVersionRead] = useState<{
    key: string; used: boolean; failure?: string;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const pickerReadKey = JSON.stringify([ownerKey, installedRevision, submissionRevision]);
  const pickerRead = pickerPlugins?.key === pickerReadKey ? pickerPlugins : null;
  const pickerReady = !reader.list || Boolean(pickerRead && !pickerRead.failure);
  const pickerItem = localPlugins.find(item => item.id === pickerSelection);
  const pickerUnavailable = (local: GhostPluginListItem) => {
    const plugin = pickerRead?.plugins.find(item => item.localInstanceId === local.id);
    if (!plugin) return null;
    if (plugin.publisherKind === 'official') return `${copy}.unavailable.officialGithubRequired`;
    if (!plugin.actions.submitUpdate) return `${copy}.permissionDenied`;
    if (plugin.latestSubmission?.reviewStatus === 'pending' && plugin.latestSubmission.revisionState === 'current')
      return `${copy}.errors.PLUGIN_PENDING_RELEASE_EXISTS`;
    if (plugin.market.version === local.version || plugin.latestSubmission?.version === local.version)
      return `${copy}.errors.VERSION_ALREADY_SUBMITTED`;
    return null;
  };
  const selectedPlugin = pickerRead?.plugins.find(item => item.localInstanceId === pickerItem?.id);
  const initialUnavailable = pickerItem ? pickerUnavailable(pickerItem) : null;
  const versionReadKey = JSON.stringify([pickerReadKey, pickerItem?.id, pickerItem?.version, selectedPlugin?.pluginId]);
  const selectedVersionRead = versionRead?.key === versionReadKey ? versionRead : null;
  const selectedPickerUnavailable = initialUnavailable ?? (selectedVersionRead?.used ? `${copy}.errors.VERSION_ALREADY_SUBMITTED` : null);
  const versionReady = !reader.releases || !selectedPlugin || Boolean(selectedVersionRead && !selectedVersionRead.used && !selectedVersionRead.failure);
  const pickerKey = JSON.stringify([pickerReadKey, location.key, pickerSelection, pickerItem?.version, pickerRefresh]);
  const pickerContextKey = JSON.stringify([pickerKey, open]);
  const pickerContext = useRef({ key: pickerContextKey, token: {}, open });
  if (pickerContext.current.key !== pickerContextKey)
    pickerContext.current = { key: pickerContextKey, token: {}, open };
  const currentPickerDraft = useContributionPreview(pickerKey,
    publicTarget && pickerReady && versionReady && !selectedPickerUnavailable ? pickerItem?.id : undefined,
    publicTarget ? pickerItem?.version : undefined, onPrepare ?? reader.prepare, reader.discard);
  const pickerBlocker = currentPickerDraft?.prepared?.preflight?.blockers[0];

  useEffect(() => {
    let disposed = false;
    const list = reader.list;
    if (!open || !localPlugins.length || !publicTarget || !list) return;
    setPickerPlugins(null);
    void (async () => {
      const plugins: MyPluginView[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await list({ query: '', filter: 'all', cursor });
        if (disposed) return;
        plugins.push(...page.plugins);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Repeated contribution cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      setPickerPlugins({ key: pickerReadKey, plugins });
    })().catch(error => {
      if (!disposed) setPickerPlugins({ key: pickerReadKey, plugins: [], failure: contributionErrorKey(error) });
    });
    return () => { disposed = true; };
  }, [open, pickerReadKey, reader, localPlugins.length, publicTarget]);

  useEffect(() => {
    const releases = reader.releases;
    if (!open || !publicTarget || !pickerReady || !pickerItem || !selectedPlugin || initialUnavailable || !releases) return;
    let disposed = false;
    setVersionRead(null);
    const pluginId = selectedPlugin.pluginId, version = pickerItem.version;
    void (async () => {
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await releases(pluginId, cursor);
        if (disposed) return;
        if (page.releases.some(release => release.version === version)) {
          setVersionRead({ key: versionReadKey, used: true });
          return;
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Repeated release cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      setVersionRead({ key: versionReadKey, used: false });
    })().catch(error => {
      if (!disposed) setVersionRead({ key: versionReadKey, used: false, failure: contributionErrorKey(error) });
    });
    return () => { disposed = true; };
  }, [open, publicTarget, pickerReady, versionReadKey, reader, pickerItem, selectedPlugin, initialUnavailable]);

  // Same pending rule as the team list and detail: a plugin with a version under review takes no
  // new upload. The prototype reads 「这个版本正在审核」; another version under review is named.
  const teamReviewing = (local: GhostPluginListItem) => {
    const published = teamPlugins?.find(plugin => plugin.ghostId === local.ghostId);
    const release = published ? teamPendingRelease(published) : null;
    if (!release) return null;
    return {
      key: `${copy}.unavailable.${release.version === local.version ? 'teamReviewing' : 'teamOtherReviewing'}`,
      version: release.version,
    };
  };
  const teamItemCandidate = team?.plugins.find(item => item.id === teamSelection);
  const teamItem = teamItemCandidate && !teamReviewing(teamItemCandidate) ? teamItemCandidate : undefined;
  const startTeam = () => {
    if (!team || !teamItem || teamStarting) return;
    const token = pickerContext.current.token;
    setTeamStarting(true);
    setTeamFailed(false);
    void team.onStart(teamItem.id).then((started) => {
      if (!mounted.current || pickerContext.current.token !== token) return;
      setTeamStarting(false);
      if (started) onOpenChange(false);
      else setTeamFailed(true);
    });
  };

  const targetPicker = team ? (
    <fieldset>
      <legend className="mb-2 text-13 leading-[1.5385] text-[var(--confirm-desc)]">{t(`${copy}.publishTo`)}</legend>
      <div role="radiogroup" aria-label={t(`${copy}.publishTo`)} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {([
          ['team', Building2, t(`${copy}.target.team`), t(`${copy}.target.teamHint`, { org: team.orgName })],
          ['public', Globe, t(`${copy}.target.public`), t(`${copy}.target.publicHint`)],
        ] as const).map(([value, Icon, label, hint]) => (
          <button key={value} type="button" role="radio" aria-checked={target === value}
            disabled={!open || submitBusy || teamStarting}
            onClick={() => setTarget(value)}
            className={`flex min-h-11 flex-col items-start justify-center gap-1 rounded-xl border p-3 text-left transition-colors duration-[var(--motion-fast)] enabled:hover:bg-[var(--surface-hover-soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60 ${target === value ? 'border-[var(--confirm-title)]' : 'border-[var(--border-default)]'}`}>
            <span className="flex items-center gap-2">
              <Icon size={14} aria-hidden="true" className={target === value ? 'text-[var(--confirm-title)]' : 'text-[var(--confirm-desc)]'} />
              <span className="text-14 font-medium leading-[1.4286] text-[var(--confirm-title)]">{label}</span>
            </span>
            <span className="text-12 leading-[1.3333] text-[var(--confirm-desc)]">{hint}</span>
          </button>
        ))}
      </div>
    </fieldset>
  ) : null;

  const pluginRow = (local: GhostPluginListItem, options: {
    selected: boolean; disabled: boolean; unavailable: string | null; onSelect: () => void;
    unavailableValues?: Record<string, string>;
  }) => (
    <button type="button" key={local.id}
      className="flex w-full min-w-0 items-start gap-3 rounded-lg p-2 text-left transition-colors duration-[var(--motion-fast)] aria-pressed:bg-[var(--surface-chip)] enabled:aria-[pressed=false]:hover:bg-[var(--surface-hover-soft)] enabled:active:bg-[var(--surface-chip)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
      aria-label={`${local.name} · ${local.version} · ${local.id}`}
      aria-describedby={options.unavailable ? `${pickerStatusId}-${local.id}` : undefined}
      aria-pressed={options.selected}
      disabled={options.disabled}
      onClick={options.onSelect}>
      <GhostPluginIcon iconDataUrl={local.iconDataUrl} iconId={local.id} iconName={local.name} />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className={`block text-14 font-medium leading-[1.4286] ${options.unavailable ? 'text-[var(--confirm-desc)]' : 'text-[var(--confirm-title)]'}`}>{local.name}</span>
        <span className="mt-1 block text-12 leading-[1.3333] text-[var(--confirm-desc)]">
          <span className="tabular-nums">{local.version}</span> · <code>{local.id}</code>
        </span>
        {options.unavailable ? <span id={`${pickerStatusId}-${local.id}`} className="mt-1 block text-13 leading-[1.5385] text-[var(--confirm-desc)]">{t(options.unavailable, options.unavailableValues)}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 self-center text-[var(--confirm-desc)]">
        {options.selected ? <Check size={16} aria-hidden="true" /> : null}
        <ChevronRight size={16} aria-hidden="true" />
      </span>
    </button>
  );
  const emptyList = (count: number) => !count ? (
    <p className="text-14 leading-6 text-[var(--confirm-desc)]">
      {t(`${copy}.${installedPluginCount === 0 ? 'noLocalPlugins' : 'noPublishablePlugins'}`)}
    </p>
  ) : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
        <Dialog.Content
          onCloseAutoFocus={() => {
            if (!pickerContext.current.open) onClosed();
          }}
          onInteractOutside={event => event.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-modal flex max-h-[70vh] w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col p-6">
          <Dialog.Title className="shrink-0 text-18 font-medium text-[var(--confirm-title)]">
            {t(`${copy}.publishPlugin`)}
          </Dialog.Title>
          <Dialog.Description className={team ? 'sr-only' : 'mt-2 shrink-0 text-13 leading-[1.5385] text-[var(--confirm-desc)]'}>
            {sourceDevice ? <span className="block font-medium">{t('settings.ghosts.remote.managingTarget', { device: sourceDevice })}</span> : null}
            {t(`${copy}.chooseLocal`)}
          </Dialog.Description>
          <div className="my-4 min-h-0 space-y-4 overflow-y-auto p-1">
            {targetPicker}
            <div className="grid gap-1">
              {/* Organization identities see 「插件」 above the list, as in the product prototype. */}
              {team ? <h3 className="mb-1 text-13 leading-[1.5385] text-[var(--confirm-desc)]">{t(`${copy}.pluginList`)}</h3> : null}
              {target === 'team' && team ? <>
                {team.plugins.map(local => {
                  const reviewing = teamReviewing(local);
                  return pluginRow(local, {
                    selected: teamItem?.id === local.id,
                    disabled: !open || teamStarting || Boolean(reviewing),
                    unavailable: reviewing?.key ?? null,
                    unavailableValues: reviewing ? { version: reviewing.version } : undefined,
                    onSelect: () => setTeamSelection(local.id),
                  });
                })}
                {emptyList(team.plugins.length)}
              </> : <>
                {localPlugins.map(local => {
                  const unavailable = pickerUnavailable(local);
                  return pluginRow(local, {
                    selected: pickerSelection === local.id,
                    disabled: !open || submitBusy || !pickerReady || Boolean(unavailable),
                    unavailable,
                    onSelect: () => setPickerSelection(local.id),
                  });
                })}
                {emptyList(localPlugins.length)}
              </>}
            </div>
            {target === 'team' && teamItem ? (
              <section aria-label={t(`${copy}.publishingVersion`, { version: teamItem.version })}
                className="space-y-2 border-t border-[var(--border-default)] pt-3 text-13 leading-[1.5385] text-[var(--confirm-desc)]">
                <p className="font-medium text-[var(--confirm-title)]">{teamItem.name} · <span className="tabular-nums">{teamItem.version}</span></p>
                {teamItem.description ? <p className="whitespace-pre-wrap break-words">{teamItem.description}</p> : null}
              </section>
            ) : null}
            {publicTarget && pickerItem ? (
              <section aria-label={t(`${copy}.publishingVersion`, { version: pickerItem.version })}
                className="space-y-2 border-t border-[var(--border-default)] pt-3 text-13 leading-[1.5385] text-[var(--confirm-desc)] [&_summary]:text-[var(--confirm-title)]">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="font-medium text-[var(--confirm-title)]">{pickerItem.name} · <span className="tabular-nums">{pickerItem.version}</span></p>
                  {currentPickerDraft?.prepared ? <p className="text-12 tabular-nums leading-[1.6667]">
                    {t(`${copy}.packageSize`, { size: currentPickerDraft.prepared.sizeBytes.toLocaleString(i18n?.resolvedLanguage ?? i18n?.language) })}
                  </p> : null}
                </div>
                <p className="whitespace-pre-wrap break-words">{currentPickerDraft?.prepared?.description ?? pickerItem.description}</p>
                {currentPickerDraft?.prepared ? <>
                  {currentPickerDraft.prepared.releaseNotes?.trim() ? (
                    <PluginDetailRecordRow icon={FileText} title={t(`${copy}.releaseNotes`)}>
                      <p className="whitespace-pre-wrap break-words">{currentPickerDraft.prepared.releaseNotes}</p>
                    </PluginDetailRecordRow>
                  ) : null}
                  {sourceDevice && currentPickerDraft.prepared.permissionLabels?.length ? (
                    <div>
                      <h3 className="font-medium text-[var(--confirm-title)]">{t('settings.ghosts.detail.permissionsTitle')}</h3>
                      <ul className="list-inside list-disc">
                        {currentPickerDraft.prepared.permissionLabels.map(label => (
                          <li key={label}>{t(`settings.ghosts.perm.${label}`, { defaultValue: label })}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </> : pickerReady && !selectedPickerUnavailable && !currentPickerDraft?.error && !selectedVersionRead?.failure ? <p role="status">{t(`${copy}.${versionReady ? 'preparing' : 'loading'}`)}</p> : null}
              </section>
            ) : null}
          </div>
          {teamFailed && target === 'team' ? (
            <p role="alert" className="mb-3 shrink-0 text-13 leading-[1.5385] text-[var(--confirm-desc)]">{t(`${copy}.teamStartFailed`)}</p>
          ) : null}
          {publicTarget && localPlugins.length > 0 && !pickerReady && !pickerRead ? <p role="status" className="mb-3 shrink-0 text-13 leading-[1.5385] text-[var(--confirm-desc)]">{t(`${copy}.loading`)}</p> : null}
          {!publicTarget ? null : pickerRead?.failure || selectedVersionRead?.failure || currentPickerDraft?.error ? (
            <p role="alert" className="mb-3 shrink-0 text-13 leading-[1.5385] text-[var(--confirm-desc)]">
              {t((pickerRead?.failure ?? selectedVersionRead?.failure ?? currentPickerDraft?.error)!, { defaultValue: t(`${copy}.loadFailed`) })}
            </p>
          ) : pickerBlocker || selectedPickerUnavailable ? (
            <p role="status" className="mb-3 shrink-0 text-13 leading-[1.5385] text-[var(--confirm-title)]">
              {selectedPickerUnavailable ? t(selectedPickerUnavailable) : t(`${copy}.errors.${pickerBlocker?.code}`, { defaultValue: t(`${copy}.errors.PRECONDITION_FAILED`) })}
            </p>
          ) : null}
          {publicTarget && currentPickerDraft?.prepared ? (
            <p className="shrink-0 border-t border-[var(--border-default)] py-3 text-13 leading-normal text-[var(--confirm-desc)]">
              {t(`${copy}.confirmPublic`)}
            </p>
          ) : null}
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="secondary" palette="confirmation" size="lg">{t(team ? 'settings.ghosts.publish.cancel' : 'settings.ghosts.detail.closeDialog')}</Button>
            </Dialog.Close>
            {target === 'team' ? (
              <Button variant="primary" palette="confirmation" size="lg" loading={teamStarting}
                disabled={!open || !teamItem || teamStarting || !navigator.onLine} onClick={startTeam}>{t(`${copy}.next`)}</Button>
            ) : null}
            {publicTarget && pickerReady && !selectedPickerUnavailable && !pickerBlocker && pickerItem && currentPickerDraft?.prepared?.preflight?.actions.canSubmit ? (
              <Button variant="primary" palette="confirmation" size="lg" loading={submitBusy} disabled={!open || submitBusy || !navigator.onLine}
                onClick={() => {
                  const prepared = currentPickerDraft.prepared!;
                  const token = pickerContext.current.token;
                  const isCurrent = () => mounted.current && pickerContext.current.token === token;
                  void onSubmitUpdate(pickerItem.id, { prepared, isCurrent }).then(submitted => {
                    if (!isCurrent()) return;
                    if (submitted) onOpenChange(false);
                    else setPickerRefresh(value => value + 1);
                  });
                }}>{t(`${copy}.submitVersion`, { version: currentPickerDraft.prepared.version })}</Button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
