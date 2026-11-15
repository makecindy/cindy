import * as Dialog from '@radix-ui/react-dialog';
import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type {
  MyPluginView,
  PluginContributionsApi,
  PreparedPluginContribution,
} from '../../../shared/pluginContributions';
import type { GhostPluginListItem } from './lib/ghostPluginViewModel';
import { contributionErrorKey, useContributionPreview } from './lib/useContributionPreview';
import { GhostPluginIcon } from './GhostPluginIcon';

const copy = 'settings.ghosts.contribution';

export interface PluginSubmitOptions {
  prepared?: PreparedPluginContribution;
  /** Closing/reopening the dialog must not let an old completion navigate. */
  isCurrent?: () => boolean;
}

export interface PluginPublishDialogRequest {
  id: number;
  owner: string;
  open: boolean;
  instanceId?: string;
}

/** Mounted for one owner-bound opening; retained through Radix's exit animation. */
export function PluginPublishDialog({
  open, ownerKey, initialInstanceId, onOpenChange, onClosed,
  reader, localPlugins, installedPluginCount, onPrepare, onSubmitUpdate,
  submitBusy = false, installedRevision, submissionRevision = 0,
}: {
  open: boolean;
  ownerKey: string;
  initialInstanceId?: string;
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
  reader: PluginContributionsApi;
  localPlugins: readonly GhostPluginListItem[];
  installedPluginCount: number;
  onPrepare?: PluginContributionsApi['prepare'];
  onSubmitUpdate: (instanceId: string, options?: PluginSubmitOptions) => Promise<boolean>;
  submitBusy?: boolean;
  installedRevision?: string;
  submissionRevision?: number;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const pickerStatusId = useId();
  const [pickerSelection, setPickerSelection] = useState<string | null>(initialInstanceId ?? null);
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
  const pickerReady = Boolean(pickerRead && !pickerRead.failure);
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
  const versionReady = !selectedPlugin || Boolean(selectedVersionRead && !selectedVersionRead.used && !selectedVersionRead.failure);
  const pickerKey = JSON.stringify([pickerReadKey, location.key, pickerSelection, pickerItem?.version, pickerRefresh]);
  const pickerContextKey = JSON.stringify([pickerKey, open]);
  const pickerContext = useRef({ key: pickerContextKey, token: {}, open });
  if (pickerContext.current.key !== pickerContextKey)
    pickerContext.current = { key: pickerContextKey, token: {}, open };
  const currentPickerDraft = useContributionPreview(pickerKey,
    pickerReady && versionReady && !selectedPickerUnavailable ? pickerItem?.id : undefined,
    pickerItem?.version, onPrepare ?? reader.prepare, reader.discard);
  const pickerBlocker = currentPickerDraft?.prepared?.preflight?.blockers[0];

  useEffect(() => {
    let disposed = false;
    if (!open || !localPlugins.length) return;
    setPickerPlugins(null);
    void (async () => {
      const plugins: MyPluginView[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await reader.list({ query: '', filter: 'all', cursor });
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
  }, [open, pickerReadKey, reader, localPlugins.length]);

  useEffect(() => {
    if (!open || !pickerReady || !pickerItem || !selectedPlugin || initialUnavailable) return;
    let disposed = false;
    setVersionRead(null);
    const pluginId = selectedPlugin.pluginId, version = pickerItem.version;
    void (async () => {
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await reader.releases(pluginId, cursor);
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
  }, [open, pickerReady, versionReadKey, reader, pickerItem, selectedPlugin, initialUnavailable]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          onCloseAutoFocus={() => {
            if (!pickerContext.current.open) onClosed();
          }}
          onInteractOutside={event => event.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[85vh] w-[calc(100vw-32px)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 flex-col p-4">
          <Dialog.Title className="text-18 font-medium text-[var(--text-primary)]">
            {t(`${copy}.publishPlugin`)}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-13 leading-5 text-[var(--text-secondary)]">
            {t(`${copy}.chooseLocal`)}
          </Dialog.Description>
          <div className="my-4 min-h-0 overflow-y-auto p-1">
            {localPlugins.map(local => {
              const unavailable = pickerUnavailable(local);
              return (
                <button type="button" key={local.id}
                  className={`flex w-full min-w-0 items-center gap-3 rounded-lg border px-2 py-3 text-left enabled:hover:bg-[var(--surface-hover)] disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] ${submitBusy || !pickerReady ? 'opacity-60' : ''} ${pickerSelection === local.id ? 'border-[var(--border-default)] bg-[var(--surface-hover)]' : 'border-transparent'}`}
                  aria-label={`${local.name} · ${local.version} · ${local.id}`}
                  aria-describedby={unavailable ? `${pickerStatusId}-${local.id}` : undefined}
                  aria-pressed={pickerSelection === local.id}
                  disabled={!open || submitBusy || !pickerReady || Boolean(unavailable)}
                  onClick={() => setPickerSelection(local.id)}>
                  <GhostPluginIcon iconDataUrl={local.iconDataUrl} iconId={local.id} iconName={local.name} />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span className={`block text-14 font-medium leading-5 ${unavailable ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>{local.name}</span>
                    <span className="mt-1 block text-12 leading-4 text-[var(--text-tertiary)]">{local.version}</span>
                    <span className="mt-1 block text-12 leading-4 text-[var(--text-tertiary)]">{local.id}</span>
                    {unavailable ? <span id={`${pickerStatusId}-${local.id}`} className="mt-1 block text-13 leading-5 text-[var(--text-secondary)]">{t(unavailable)}</span> : null}
                  </span>
                  {pickerSelection === local.id ? <Check size={16} aria-hidden="true" className="shrink-0 text-[var(--text-primary)]" /> : null}
                </button>
              );
            })}
            {!localPlugins.length ? (
              <p className="text-14 leading-6 text-[var(--text-secondary)]">
                {t(`${copy}.${installedPluginCount === 0 ? 'noLocalPlugins' : 'noPublishablePlugins'}`)}
              </p>
            ) : null}
          </div>
          {pickerItem ? (
            <section aria-label={t(`${copy}.publishingVersion`, { version: pickerItem.version })}
              className="mb-4 max-h-52 space-y-2 overflow-y-auto border-t border-[var(--border-default)] pt-3 text-13 leading-5 text-[var(--text-secondary)]">
              <p className="font-medium text-[var(--text-primary)]">{pickerItem.name} · {pickerItem.version}</p>
              <p className="whitespace-pre-wrap break-words">{currentPickerDraft?.prepared?.description ?? pickerItem.description}</p>
              {currentPickerDraft?.prepared ? <>
                {currentPickerDraft.prepared.releaseNotes?.trim() ? <>
                  <h3 className="font-medium">{t(`${copy}.releaseNotes`)}</h3>
                  <p className="whitespace-pre-wrap break-words">{currentPickerDraft.prepared.releaseNotes}</p>
                </> : null}
                <p>{t(`${copy}.confirmPublic`)}</p>
              </> : pickerReady && !selectedPickerUnavailable && !currentPickerDraft?.error && !selectedVersionRead?.failure ? <p role="status">{t(`${copy}.${versionReady ? 'preparing' : 'loading'}`)}</p> : null}
            </section>
          ) : null}
          {localPlugins.length > 0 && !pickerRead ? <p role="status" className="mb-3 shrink-0 text-13 leading-5 text-[var(--text-secondary)]">{t(`${copy}.loading`)}</p> : null}
          {pickerRead?.failure || selectedVersionRead?.failure || currentPickerDraft?.error ? (
            <p role="alert" className="mb-3 shrink-0 text-13 leading-5 text-[var(--text-secondary)]">
              {t((pickerRead?.failure ?? selectedVersionRead?.failure ?? currentPickerDraft?.error)!, { defaultValue: t(`${copy}.loadFailed`) })}
            </p>
          ) : pickerBlocker || selectedPickerUnavailable ? (
            <p role="status" className="mb-3 shrink-0 text-13 leading-5 text-[var(--text-primary)]">
              {selectedPickerUnavailable ? t(selectedPickerUnavailable) : t(`${copy}.errors.${pickerBlocker?.code}`, { defaultValue: t(`${copy}.errors.PRECONDITION_FAILED`) })}
            </p>
          ) : null}
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="secondary">{t('settings.ghosts.detail.closeDialog')}</Button>
            </Dialog.Close>
            {pickerReady && !selectedPickerUnavailable && !pickerBlocker && pickerItem && currentPickerDraft?.prepared?.preflight?.actions.canSubmit ? (
              <Button variant="cta" loading={submitBusy} disabled={!open || submitBusy || !navigator.onLine}
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
