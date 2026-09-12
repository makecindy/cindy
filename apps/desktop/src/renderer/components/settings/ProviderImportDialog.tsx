import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderOAuthDeviceCode } from '@/hooks/useProviderOAuthDeviceCode';
import { toast } from '@/lib/toast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { ProviderImportPreview } from '../../../shared/providerImport';
import { OAuthBrowserLink, OAuthDeviceCodeCard } from './OAuthDeviceCodeCard';

interface ProviderImportDialogProps {
  importId: string;
  onClose: () => void;
  onDone: (providerId: string) => void;
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
  const oauth = useProviderOAuthDeviceCode(
    preview?.authMethod === 'oauth' ? preview.providerId : null,
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
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
    onClose();
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
