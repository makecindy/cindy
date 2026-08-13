import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Check, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useProviderOAuthDeviceCode } from '@/hooks/useProviderOAuthDeviceCode';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { ProviderImportPreview } from '../../../shared/providerImport';
import { OAuthDeviceCodeCard } from './OAuthDeviceCodeCard';

interface ProviderImportDialogProps {
  importId: string;
  onClose: () => void;
  onDone: (providerId: string) => void;
}

function harnessLabel(agent: ProviderImportPreview['runtimes'][number]['agent']): string {
  if (agent === 'claude-code') return 'Claude Code';
  if (agent === 'codex') return 'Codex';
  return 'Pi';
}

export function ProviderImportDialog({ importId, onClose, onDone }: ProviderImportDialogProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ProviderImportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [createdProviderId, setCreatedProviderId] = useState<string | null>(null);
  const confirmingRef = useRef(false);
  const oauth = useProviderOAuthDeviceCode(
    preview?.authMethod === 'oauth' ? preview.providerId : null,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.electronAPI.maker
      .previewProviderImport(importId)
      .then((value) => {
        if (!cancelled) setPreview(value);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('settings.providers.import.loadFailed'));
        if (!cancelled) onClose();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [importId, onClose, t]);

  const cancel = useCallback(() => {
    // Do not interrupt the short config/credential transaction. Once the provider is created,
    // OAuth is an independently cancellable operation and the dialog must remain dismissible.
    if (confirmingRef.current) return;
    oauth.cancelOwnedLogin();
    if (!createdProviderId) {
      void window.electronAPI.maker.cancelProviderImport(importId).catch(() => undefined);
    }
    onClose();
  }, [createdProviderId, importId, oauth, onClose]);

  const loginOAuth = useCallback(
    async (providerId: string): Promise<boolean> => {
      oauth.clearDeviceCode();
      const ownership = oauth.beginOwnedLogin();
      setAuthorizing(true);
      try {
        const result = await window.electronAPI.maker.providerOAuthLogin(providerId, {
          ownerId: ownership.ownerId,
        });
        if (!result.ok) {
          toast.error(t('settings.providers.import.oauthFailed'));
          return false;
        }
        ownership.finish();
        return true;
      } catch {
        toast.error(t('settings.providers.import.oauthFailed'));
        return false;
      } finally {
        setAuthorizing(false);
      }
    },
    [oauth, t],
  );

  const confirmImport = useCallback(async () => {
    if (!preview || confirmingRef.current || authorizing) return;
    try {
      if (createdProviderId) {
        if (await loginOAuth(createdProviderId)) {
          toast.success(t('settings.providers.import.oauthDone', { name: preview.name }));
          onDone(createdProviderId);
        }
        return;
      }
      confirmingRef.current = true;
      setConfirming(true);
      const result = await window.electronAPI.maker.confirmProviderImport(importId);
      confirmingRef.current = false;
      setConfirming(false);
      if (result.authMethod === 'oauth') {
        setCreatedProviderId(result.providerId);
        if (await loginOAuth(result.providerId)) {
          toast.success(t('settings.providers.import.oauthDone', { name: preview.name }));
          onDone(result.providerId);
        }
        return;
      }
      toast.success(t('settings.providers.import.done', { name: preview.name }));
      onDone(result.providerId);
    } catch {
      toast.error(t('settings.providers.import.confirmFailed'));
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  }, [authorizing, createdProviderId, importId, loginOAuth, onDone, preview, t]);

  const actionLabel = preview
    ? preview.authMethod === 'oauth'
      ? createdProviderId
        ? t('settings.providers.import.retryOAuth')
        : t('settings.providers.import.addAndAuthorize')
      : preview.action === 'replace-key'
        ? t('settings.providers.import.replaceKey')
        : preview.action === 'update'
          ? t('settings.providers.import.update')
          : t('settings.providers.import.create')
    : t('settings.providers.import.create');

  return (
    <Dialog.Root open onOpenChange={(open) => !open && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10001] bg-[var(--overlay-modal)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => {
            if (confirmingRef.current) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (confirmingRef.current) event.preventDefault();
          }}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[78vh] w-[600px] max-w-[92vw] flex-col overflow-hidden rounded-xl',
            'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <header className="flex shrink-0 items-center justify-between py-3.5 pl-5 pr-3.5">
            <Dialog.Title className="text-15 font-medium text-[var(--settings-section-title)]">
              {t('settings.providers.import.title')}
            </Dialog.Title>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {loading && (
              <div className="flex min-h-32 items-center justify-center text-[var(--settings-section-desc)]">
                <span className="inline-flex animate-spin motion-reduce:animate-none">
                  <Loader2 size={20} />
                </span>
              </div>
            )}

            {preview && (
              <>
                <div className="flex items-start gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-input-bg)] p-3.5">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-hover)] text-[var(--settings-section-title)]">
                    {preview.authMethod === 'oauth' ? (
                      <ShieldCheck size={17} />
                    ) : (
                      <KeyRound size={17} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-14 font-medium text-[var(--settings-section-title)]">
                      {preview.name}
                    </div>
                    <div className="mt-1 text-12 text-[var(--settings-section-desc)]">
                      {t(`settings.providers.import.action.${preview.action}`, {
                        name: preview.existingProviderName ?? preview.name,
                      })}
                    </div>
                  </div>
                </div>

                {(preview.action === 'update' || preview.action === 'replace-key') && (
                  <div className="flex gap-2 rounded-lg bg-[var(--warning-bg-soft)] px-3 py-2.5 text-12 leading-[1.5] text-[var(--settings-section-title)]">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                    <span>{t('settings.providers.import.replaceWarning')}</span>
                  </div>
                )}

                {preview.runtimes.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className="text-12 font-medium text-[var(--settings-section-title)]">
                      {t('settings.providers.import.harnesses')}
                    </span>
                    <div className="overflow-hidden rounded-lg border border-[var(--settings-theme-card-border)]">
                      {preview.runtimes.map((runtime) => (
                        <div
                          key={runtime.agent}
                          className="flex flex-col gap-1 border-b border-[var(--settings-theme-card-border)] px-3 py-2.5 last:border-b-0"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-13 font-medium text-[var(--settings-section-title)]">
                              {harnessLabel(runtime.agent)}
                            </span>
                            <span className="text-11 text-[var(--settings-section-desc)]">
                              {runtime.protocol}
                            </span>
                          </div>
                          <span className="break-all text-11 text-[var(--settings-section-desc)]">
                            {runtime.baseUrl}
                          </span>
                          <span className="text-11 text-[var(--settings-section-desc)]">
                            {runtime.willFetchModels
                              ? t('settings.providers.import.fetchAfterConfirm')
                              : t('settings.providers.import.modelCount', {
                                  count: runtime.modelCount,
                                })}
                            {runtime.hasApiKey
                              ? ` · ${t('settings.providers.import.keyIncluded')}`
                              : ''}
                            {runtime.headerNames.length > 0
                              ? ` · ${t('settings.providers.import.headers', { names: runtime.headerNames.join(', ') })}`
                              : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {preview.oauth && (
                  <div className="rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2.5 text-12 text-[var(--settings-section-desc)]">
                    {t('settings.providers.import.oauthHosts', {
                      authorizeHost: preview.oauth.authorizeHost,
                      tokenHost: preview.oauth.tokenHost,
                    })}
                  </div>
                )}

                {preview.authMethod === 'oauth' &&
                  authorizing &&
                  preview.oauth?.flow === 'device-code' && (
                    <OAuthDeviceCodeCard deviceCode={oauth.deviceCode} />
                  )}

                {preview.authMethod === 'oauth' &&
                  authorizing &&
                  preview.oauth?.flow === 'authorization-code' && (
                    <div className="flex items-center gap-2 rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2.5 text-12 text-[var(--settings-section-desc)]">
                      <span className="inline-flex animate-spin motion-reduce:animate-none">
                        <Loader2 size={14} />
                      </span>
                      <span>{t('settings.providers.import.browserAuthorizationInProgress')}</span>
                    </div>
                  )}

                <p className="flex items-start gap-2 text-11 leading-[1.5] text-[var(--settings-section-desc)]">
                  <Check size={13} className="mt-0.5 shrink-0" />
                  {createdProviderId
                    ? t('settings.providers.import.authorizationPendingNote')
                    : t('settings.providers.import.confirmNote')}
                </p>

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={cancel}
                    disabled={confirming}
                    className="h-8 rounded-lg border border-[var(--settings-btn-secondary-border)] px-3.5 text-13 font-medium text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:opacity-40"
                  >
                    {t('settings.providers.import.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmImport()}
                    disabled={confirming || authorizing}
                    className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent-cta-bg)] px-3.5 text-13 font-medium text-[var(--accent-pure-cta-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:opacity-40"
                  >
                    {(confirming || authorizing) && (
                      <span className="inline-flex animate-spin motion-reduce:animate-none">
                        <Loader2 size={13} />
                      </span>
                    )}
                    {actionLabel}
                  </button>
                </div>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
