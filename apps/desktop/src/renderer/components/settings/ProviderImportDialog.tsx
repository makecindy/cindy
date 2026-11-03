import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderOAuthDeviceCode } from '@/hooks/useProviderOAuthDeviceCode';
import { toast } from '@/lib/toast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { extractIpcError } from '@/utils/ipcError';
import { ChevronDown, Download, FileUp } from 'lucide-react';
import type { ProviderImportPreview } from '../../../shared/providerImport';
import { PROVIDER_IMPORT_EXAMPLE_JSON, PROVIDER_IMPORT_BATCH_EXAMPLE_JSON } from '../../../shared/providerImportExample';
import { OAuthBrowserLink, OAuthDeviceCodeCard } from './OAuthDeviceCodeCard';

interface ProviderImportDialogProps {
  importId: string;
  onClose: (savedProviderId?: string) => void;
  onDone: (providerId: string) => void;
}

/** The native picker and secret-bearing file stay in Main; only a draft id comes back. */
export function ProviderImportFileButton({ onImported }: { onImported: (id: string | string[]) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showFormat, setShowFormat] = useState(false);
  const formatId = useId();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function selectFile() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const id = await window.electronAPI.maker.importProviderFile();
      if (id) {
        if (alive.current) {
          setOpen(false);
          onImported(id);
        }
        else for (const draftId of Array.isArray(id) ? id : [id])
          void window.electronAPI.maker.cancelProviderImport(draftId).catch(() => undefined);
      }
    } catch (error) {
      if (alive.current) {
        const code = extractIpcError(error)?.code;
        toast.error(t(code === 'PROVIDER_IMPORT_FILE_TOO_LARGE'
          ? 'settings.providers.import.fileTooLarge'
          : code === 'PROVIDER_IMPORT_FILE_INVALID'
            ? 'settings.providers.import.fileInvalid'
            : 'settings.providers.import.fileReadFailed'));
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="secondary" size="lg" className="w-full"
        onClick={() => { setShowFormat(false); setOpen(true); }}>
        <FileUp size={15} />
        {t('settings.providers.import.fromFile')}
      </Button>
      <ConfirmDialog
        presentation="standard"
        open={open}
        onOpenChange={(next) => { if (!busyRef.current) setOpen(next); }}
        maxWidth={560}
        title={t('settings.providers.import.fromFile')}
        description={t('settings.providers.import.fileGuideDescription')}
        descriptionClassName="text-13 font-normal leading-relaxed"
        confirmText={t('settings.providers.import.selectJsonFile')}
        cancelText={t('settings.providers.import.cancel')}
        loading={busy}
        onConfirm={() => void selectFile()}
        contentSelectable
        content={
          <div className="flex flex-col gap-5 pt-2 text-14 font-normal leading-relaxed text-[var(--text-primary)]">
            <ol className="flex flex-col gap-5">
              <li className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2">
                <span aria-hidden="true" className="flex h-9 items-center text-[var(--text-secondary)]">1.</span>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-3">
                    <p className="font-medium">{t('settings.providers.import.fileGuidePrepare')}</p>
                    <div className="flex flex-wrap items-center gap-x-4">
                    <a
                      href={`data:application/json;charset=utf-8,${encodeURIComponent(PROVIDER_IMPORT_EXAMPLE_JSON)}`}
                      download="cindy-provider-example.json"
                      className="inline-flex min-h-9 items-center gap-1.5 text-13 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring-soft)]"
                    >
                      <Download size={15} aria-hidden="true" />
                      {t('settings.providers.import.downloadExample')}
                    </a>
                    <a href={`data:application/json;charset=utf-8,${encodeURIComponent(PROVIDER_IMPORT_BATCH_EXAMPLE_JSON)}`}
                      download="cindy-providers-example.json"
                      className="inline-flex min-h-9 items-center gap-1.5 text-13 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring-soft)]">
                      <Download size={15} aria-hidden="true" />{t('settings.providers.import.downloadBatchExample')}
                    </a>
                    </div>
                  </div>
                  <p className="text-13 text-[var(--text-secondary)]">{t('settings.providers.import.fileGuideSteps')}</p>
                </div>
              </li>
              <li className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2">
                <span aria-hidden="true" className="text-[var(--text-secondary)]">2.</span>
                <div className="space-y-1">
                  <p className="font-medium">{t('settings.providers.import.fileGuideReview')}</p>
                  <p className="text-13 text-[var(--text-secondary)]">{t('settings.providers.import.fileGuideReviewHint')}</p>
                </div>
              </li>
            </ol>
            <div className="border-t border-[var(--border-default)] pt-3">
              <Button type="button" variant="secondary" tone="quiet" size="lg" compact
                className="w-full justify-between"
                aria-expanded={showFormat} aria-controls={formatId}
                onClick={() => setShowFormat(value => !value)}>
                {t(`settings.providers.import.${showFormat ? 'hideFormat' : 'showFormat'}`)}
                <ChevronDown size={15} aria-hidden="true" className={showFormat ? 'rotate-180' : undefined} />
              </Button>
              {showFormat && (
                <div id={formatId} className="flex flex-col gap-4 pt-3 text-13">
                  <p className="text-[var(--text-secondary)]">{t('settings.providers.import.formatConversion')}</p>
                  <p>{t('settings.providers.import.formatBatch')}</p>
                  <p>{t('settings.providers.import.formatStructure')}</p>
                  <dl className="divide-y divide-[var(--border-default)]">
                    {[
                      ['kind · name', 'formatIdentity'],
                      ['auth.method · auth.apiKey', 'formatAuth'],
                      ['endpoints[].protocol · baseUrl', 'formatEndpoint'],
                      ['endpoints[].targets', 'formatTargets'],
                      ['endpoints[].models', 'formatModels'],
                      ['group · contextWindow · maxOutputTokens', 'formatMetadata'],
                      ['efforts · defaultEffort', 'formatEffort'],
                    ].map(([fields, key]) => (
                      <div key={key} className="space-y-1 py-3 first:pt-0 last:pb-0">
                        <dt className="break-words font-mono text-12 font-medium">{fields}</dt>
                        <dd className="text-[var(--text-secondary)]">{t(`settings.providers.import.${key}`)}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-[var(--text-secondary)]">{t('settings.providers.import.formatLimits')}</p>
                  <p className="font-medium">{t('settings.providers.import.exampleTitle')}</p>
                  <pre className="whitespace-pre-wrap break-all rounded-xl border border-[var(--border-default)] p-3 font-mono text-12">{PROVIDER_IMPORT_EXAMPLE_JSON}</pre>
                </div>
              )}
            </div>
            <p className="text-12 text-[var(--text-secondary)]">{t('settings.providers.import.fileGuidePrivacy')}</p>
          </div>
        }
      />
    </>
  );
}

/** A secret-free review surface. Mutations and credentials remain in Main. */
export function ProviderImportDialog({ importId, onClose, onDone }: ProviderImportDialogProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ProviderImportPreview | null>(null);
  const previewRef = useRef<ProviderImportPreview | null>(null);
  const [target, setTarget] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [busyCount, setBusyCount] = useState<number | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const authorizingRef = useRef(false);
  const alive = useRef(true);
  const activeImportId = useRef(importId);
  const oauth = useProviderOAuthDeviceCode(
    preview?.authMethod === 'oauth' ? preview.providerId : null,
  );

  useEffect(() => {
    alive.current = true;
    activeImportId.current = importId;
    return () => {
      alive.current = false;
      // StrictMode immediately reattaches the same effect; only a real departure
      // or a different import releases the secret-bearing draft.
      queueMicrotask(() => {
        if (!alive.current || activeImportId.current !== importId) {
          void window.electronAPI.maker.cancelProviderImport(importId).catch(() => undefined);
        }
      });
    };
  }, [importId]);

  useEffect(() => {
    let cancelled = false;
    previewRef.current = null;
    setLoading(true);
    void window.electronAPI.maker
      .previewProviderImport(importId, target || undefined)
      .then((value) => {
        if (!cancelled && alive.current) {
          previewRef.current = value;
          setPreview(value);
        }
      })
      .catch(() => {
        if (!cancelled && alive.current) {
          toast.error(t('settings.providers.import.loadFailed'));
          onClose();
        }
      })
      .finally(() => {
        if (!cancelled && alive.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [importId, target, onClose, t]);

  function cancel() {
    if (savingRef.current || !alive.current) return;
    alive.current = false;
    oauth.cancelOwnedLogin();
    void window.electronAPI.maker.cancelProviderImport(importId).catch(() => undefined);
    onClose(createdId ?? undefined);
  }

  async function login(providerId: string, name: string) {
    if (authorizingRef.current) return;
    authorizingRef.current = true;
    setAuthorizing(true);
    const ownership = oauth.beginOwnedLogin();
    try {
      const result = await window.electronAPI.maker.providerOAuthLogin(providerId, {
        ownerId: ownership.ownerId,
      });
      if (!alive.current) return;
      if (result.ok) {
        ownership.finish();
        toast.success(t('settings.providers.import.oauthDone', { name }));
        onDone(providerId);
      } else toast.error(t('settings.providers.import.oauthFailed'));
    } catch {
      if (alive.current) toast.error(t('settings.providers.import.oauthFailed'));
    } finally {
      authorizingRef.current = false;
      if (alive.current) setAuthorizing(false);
    }
  }

  async function confirm(interrupt?: true) {
    const review = previewRef.current;
    if (!review || savingRef.current || authorizingRef.current || !alive.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (createdId) {
        // Keep AlertDialog.Action's synchronous close from cancelling the retry.
        await Promise.resolve();
        savingRef.current = false;
        setSaving(false);
        if (alive.current) await login(createdId, review.name);
        return;
      }
      const result = await window.electronAPI.maker.confirmProviderImport(
        importId,
        target || undefined,
        interrupt,
      );
      if (!alive.current) return;
      if (!result.ok) {
        setBusyCount(result.busyCount);
        return;
      }
      setBusyCount(null);
      if (result.authMethod === 'oauth') {
        setCreatedId(result.providerId);
        // Saving and OAuth have separate lifetimes; failed/cancelled login retains the connection.
        savingRef.current = false;
        setSaving(false);
        await login(result.providerId, review.name);
      } else {
        toast.success(
          t(
            result.modelsPending
              ? 'settings.providers.import.modelsPending'
              : 'settings.providers.import.done',
            { name: review.name },
          ),
        );
        onDone(result.providerId);
      }
    } catch {
      if (alive.current) toast.error(t('settings.providers.import.confirmFailed'));
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
      else {
        // Main does not interrupt a confirmed write. If it failed after unmount,
        // release the now-retryable draft as well as the earlier cleanup attempt.
        void window.electronAPI.maker.cancelProviderImport(importId).catch(() => undefined);
      }
    }
  }

  const action = createdId
    ? 'retryOAuth'
    : preview?.authMethod === 'oauth'
      ? 'addAndAuthorize'
      : preview?.action === 'replace-key' || preview?.action === 'update'
        ? 'replaceKey'
        : 'create';

  return (
    <>
      <ConfirmDialog
        presentation="standard"
        open={busyCount === null}
        maxWidth={600}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
        title={t('settings.providers.import.title')}
        description={t(
          createdId
            ? 'settings.providers.import.authorizationPendingNote'
            : 'settings.providers.import.confirmNote',
        )}
        confirmText={t(`settings.providers.import.${action}`)}
        cancelText={t('settings.providers.import.cancel')}
        confirmDisabled={loading || !preview || authorizing}
        loading={saving}
        onConfirm={() => void confirm()}
        onCancel={cancel}
        contentSelectable
        content={
          preview && !loading ? (
            <div className="flex flex-col gap-3 text-13 text-[var(--text-primary)]">
              <p className="font-medium">{preview.name}</p>
              {!createdId && preview.updateTargets.length > 0 && (
                <label className="flex flex-col gap-2">
                  {t('settings.providers.import.destination')}
                  <select
                    aria-label={t('settings.providers.import.destination')}
                    value={target}
                    disabled={saving}
                    className="h-9 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-[var(--text-primary)]"
                    onChange={(event) => {
                      previewRef.current = null;
                      setLoading(true);
                      setTarget(event.target.value);
                    }}
                  >
                    <option value="">{t('settings.providers.import.newConnection')}</option>
                    {preview.updateTargets.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p>
                {t(`settings.providers.import.action.${preview.action}`, {
                  name: preview.existingProviderName ?? preview.name,
                })}
              </p>
              {(preview.action === 'update' || preview.action === 'replace-key') && (
                <p>{t('settings.providers.import.keyOnly')}</p>
              )}
              {preview.kind === 'builtin' && <p>{t('settings.providers.import.keyIncluded')}</p>}
              {preview.runtimes.map((runtime) => (
                <div
                  key={runtime.agent}
                  className="rounded-xl border border-[var(--border-default)] p-3"
                >
                  <div>
                    {runtime.agent === 'claude-code'
                      ? 'Claude Code'
                      : runtime.agent === 'codex'
                        ? 'Codex'
                        : 'Pi'}{' '}
                    · {runtime.protocol}
                  </div>
                  <div className="break-all text-[var(--text-secondary)]">{runtime.baseUrl}</div>
                  {runtime.modelsUrl && preview.action === 'create' && (
                    <div className="break-all text-[var(--text-secondary)]">
                      {runtime.modelsUrl}
                    </div>
                  )}
                  {runtime.hasApiKey && <div>{t('settings.providers.import.keyIncluded')}</div>}
                  {preview.action === 'create' && (
                    <>
                      <div>
                        {runtime.willFetchModels
                          ? t('settings.providers.import.fetchAfterConfirm')
                          : t('settings.providers.import.modelCount', {
                              count: runtime.modelCount,
                            })}
                      </div>
                      {runtime.headerNames.length > 0 && (
                        <div>
                          {t('settings.providers.import.headers', {
                            names: runtime.headerNames.join(', '),
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
              {preview.oauth && <p>{t('settings.providers.import.oauthHosts', preview.oauth)}</p>}
              {authorizing && preview.oauth?.flow === 'device-code' && (
                <OAuthDeviceCodeCard deviceCode={oauth.deviceCode} />
              )}
              {authorizing && preview.oauth?.flow === 'authorization-code' && (
                <>
                  <p>{t('settings.providers.import.browserAuthorizationInProgress')}</p>
                  {oauth.browserUrl && <OAuthBrowserLink url={oauth.browserUrl} />}
                </>
              )}
            </div>
          ) : undefined
        }
      />
      <ConfirmDialog
        presentation="standard"
        open={busyCount !== null}
        zIndex={10002}
        onOpenChange={(open) => {
          if (!open && !savingRef.current) setBusyCount(null);
        }}
        title={t('settings.providers.custom.imageGenerationReload.title')}
        description={t('settings.providers.import.busyWarning', { count: busyCount ?? 0 })}
        confirmText={t('settings.providers.custom.imageGenerationReload.interrupt')}
        confirmVariant="destructive"
        loading={saving}
        onCancel={() => {
          if (!savingRef.current) setBusyCount(null);
        }}
        onConfirm={() => void confirm(true)}
      />
    </>
  );
}

type BatchStatus = 'loading' | 'ready' | 'saving' | 'saved' | 'modelsPending' | 'failed' | 'manual' | 'invalid' | 'skipped' | 'authorizationPending';
interface BatchRow {
  id: string;
  preview?: ProviderImportPreview;
  status: BatchStatus;
  selected: boolean;
}

/** Only orchestrates the existing preview/confirm operations; Main retains all validation and writes. */
export function ProviderImportBatchDialog({ importIds, onClose, onDone }: {
  importIds: string[];
  onClose: () => void;
  onDone: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<BatchRow[]>(() => importIds.map(id => ({ id, status: 'loading', selected: false })));
  const [saving, setSaving] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);
  const lastSavedId = useRef<string | null>(null);
  const patchRow = useCallback((id: string, patch: Partial<BatchRow>) => {
    setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row));
  }, []);
  // Provider-change broadcasts rerender Settings during a save. Stable callbacks
  // keep individual review from previewing an already-consumed OAuth draft again.
  const closeIndividual = useCallback((savedId?: string) => {
    if (!activeId) return;
    if (savedId) lastSavedId.current = savedId;
    patchRow(activeId, { status: savedId ? 'authorizationPending' : 'skipped', selected: false });
    setActiveId(null);
  }, [activeId, patchRow]);
  const finishIndividual = useCallback((providerId: string) => {
    if (!activeId) return;
    lastSavedId.current = providerId;
    patchRow(activeId, { status: 'saved', selected: false });
    setActiveId(null);
  }, [activeId, patchRow]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void Promise.all(importIds.map(async id => {
      try {
        const preview = await window.electronAPI.maker.previewProviderImport(id);
        return { id, preview, status: preview.authMethod === 'oauth' ? 'manual' : 'ready', selected: preview.authMethod !== 'oauth' } as BatchRow;
      } catch {
        return { id, status: 'invalid', selected: false } as BatchRow;
      }
    })).then(value => { if (!cancelled) setRows(value); });
    return () => {
      cancelled = true;
      alive.current = false;
      queueMicrotask(() => {
        if (!alive.current) for (const id of importIds)
          void window.electronAPI.maker.cancelProviderImport(id).catch(() => undefined);
      });
    };
  }, [importIds]);

  const selectable = (row: BatchRow) => row.status === 'ready' || row.status === 'failed';
  const selected = rows.filter(row => row.selected && selectable(row));
  const savedCount = rows.filter(row => ['saved', 'modelsPending', 'authorizationPending'].includes(row.status)).length;
  const close = () => {
    if (savingRef.current) return;
    if (lastSavedId.current) onDone(lastSavedId.current);
    else onClose();
  };

  async function confirmSelected() {
    if (savingRef.current || !selected.length) return;
    savingRef.current = true;
    setSaving(true);
    try {
      for (const row of selected) {
        if (!alive.current) break;
        patchRow(row.id, { status: 'saving' });
        try {
          // Never consent to interruption or run OAuth implicitly for a batch.
          const result = await window.electronAPI.maker.confirmProviderImport(row.id);
          if (!alive.current) break;
          if (result.ok) {
            lastSavedId.current = result.providerId;
            patchRow(row.id, { status: result.modelsPending ? 'modelsPending' : 'saved', selected: false });
          } else patchRow(row.id, { status: 'manual', selected: false });
        } catch {
          if (alive.current) patchRow(row.id, { status: 'failed' });
        } finally {
          if (!alive.current) void window.electronAPI.maker.cancelProviderImport(row.id).catch(() => undefined);
        }
      }
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }

  if (activeId) return <ProviderImportDialog
    key={activeId}
    importId={activeId}
    onClose={closeIndividual}
    onDone={finishIndividual}
  />;

  return <ConfirmDialog
    presentation="standard"
    open
    maxWidth={600}
    title={t('settings.providers.import.batchTitle', { count: rows.length })}
    description={t('settings.providers.import.batchNote')}
    descriptionClassName="text-13 font-normal leading-relaxed"
    confirmText={t('settings.providers.import.batchImport', { count: selected.length })}
    cancelText={t('common.dismiss')}
    confirmDisabled={!selected.length || rows.some(row => row.status === 'loading')}
    loading={saving}
    onOpenChange={open => { if (!open) close(); }}
    onConfirm={() => void confirmSelected()}
    contentSelectable
    content={<div className="space-y-3 text-13 font-normal leading-relaxed text-[var(--text-primary)]">
      <p className="text-[var(--text-secondary)]">{t('settings.providers.import.batchProgress', { count: savedCount, total: rows.length })}</p>
      <ul className="divide-y divide-[var(--border-default)]">
        {rows.map((row, index) => <li key={row.id} className="space-y-2 py-3 first:pt-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex min-h-9 min-w-0 items-center gap-2 font-medium">
              <input type="checkbox" className="size-4 shrink-0 accent-[var(--text-primary)]" checked={row.selected} disabled={saving || !selectable(row)}
                onChange={event => patchRow(row.id, { selected: event.target.checked })} />
              <span className="break-words">{row.preview?.name ?? t('settings.providers.import.batchItem', { index: index + 1 })}</span>
            </label>
            {row.preview && (selectable(row) || row.status === 'manual') && <Button variant="secondary" size="md" disabled={saving}
              onClick={() => setActiveId(row.id)}>{t('settings.providers.import.batchReviewOne')}</Button>}
          </div>
          {row.preview && <>
            {!['saved', 'modelsPending', 'authorizationPending'].includes(row.status) && <p>{t(`settings.providers.import.action.${row.preview.action}`, { name: row.preview.existingProviderName ?? row.preview.name })}</p>}
            {(row.preview.action === 'replace-key' || row.preview.action === 'update') && <p>{t('settings.providers.import.keyOnly')}</p>}
            {row.preview.kind === 'builtin' && <p>{t('settings.providers.import.keyIncluded')}</p>}
            {row.preview.runtimes.map(runtime => <div key={runtime.agent} className="break-words text-[var(--text-secondary)]">
              <p>{runtime.agent === 'claude-code' ? 'Claude Code' : runtime.agent === 'codex' ? 'Codex' : 'Pi'} · {runtime.protocol} · {runtime.willFetchModels ? t('settings.providers.import.fetchAfterConfirm') : t('settings.providers.import.modelCount', { count: runtime.modelCount })}</p>
              <p className="break-all">{runtime.baseUrl}</p>
              {runtime.modelsUrl && <p className="break-all">{runtime.modelsUrl}</p>}
              {runtime.hasApiKey && <p>{t('settings.providers.import.keyIncluded')}</p>}
              {runtime.headerNames.length > 0 && <p>{t('settings.providers.import.headers', { names: runtime.headerNames.join(', ') })}</p>}
            </div>)}
          </>}
          {row.status !== 'ready' && <p className="text-[var(--text-secondary)]" role="status">{t(`settings.providers.import.batchStatus.${row.status}`)}</p>}
        </li>)}
      </ul>
    </div>}
  />;
}
