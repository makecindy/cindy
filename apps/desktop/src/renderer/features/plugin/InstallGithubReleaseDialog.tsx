import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { DownloadMeter } from '@/components/ui/download-meter';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import type { DownloadProgress } from '../../../shared/downloadProgress';
import { ErrorNotice } from '@/components/ui/error-notice';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { extractIpcError } from '@/utils/ipcError';

export function InstallGithubReleaseDialog({ onClose, onInstalled }: {
  onClose: () => void;
  onInstalled: (instanceId: string) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress>();
  useEffect(() => window.electronAPI.ghosts.onGithubReleaseProgress?.((event, ownerStamp) => {
    if (event.instanceId === requestId.current && ownerStamp && isDataOwnerPushStampCurrent(ownerStamp)) {
      setProgress(event.progress);
    }
  }), []);
  const install = async () => {
    if (requestId.current || !url.trim()) return;
    const id = 'install:' + crypto.randomUUID();
    requestId.current = id;
    setProgress(undefined);
    setBusy(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.ghosts.installGithubRelease('install', url, id);
      if (typeof result === 'boolean') setStatus('unavailable');
      else if (result.status === 'installed') onInstalled(result.instanceId);
      else setStatus(result.status);
    } catch (error) {
      const code = extractIpcError(error)?.code;
      if (code !== 'MUTATION_CANCELLED') setStatus(code === 'ALREADY_EXISTS' ? 'installedAlready' : 'unavailable');
    } finally {
      requestId.current = null;
      setProgress(undefined);
      setBusy(false);
    }
  };

  const releaseKeys = ['sign-in', 'forbidden', 'empty', 'unavailable'];
  const message = status && t(releaseKeys.includes(status)
    ? 'settings.ghosts.detail.githubRelease.' + status
    : 'settings.ghosts.page.githubInstall.' + status);

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
        <Dialog.Content
          className="modal-panel fixed inset-0 z-modal m-auto flex h-fit max-h-[70vh] w-[calc(100%-2rem)] max-w-[440px] flex-col overflow-hidden p-6"
          style={WINDOW_NO_DRAG_STYLE}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className="shrink-0 text-18 font-medium text-[var(--confirm-title)]">
            {t('settings.ghosts.page.githubInstall.title')}
          </Dialog.Title>
          <form className="mt-4 flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); void install(); }}>
            <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-1">
              <Dialog.Description className="text-pretty text-13 leading-[1.54] text-[var(--confirm-desc)]">
                {t('settings.ghosts.page.githubInstall.description')}
              </Dialog.Description>
              <FormField label={t('settings.ghosts.page.githubInstall.url')}>
                {(control) => <Input
                  {...control}
                  inputRef={inputRef}
                  type="text"
                  inputMode="url"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={512}
                  placeholder="https://github.com/owner/repo"
                  disabled={busy}
                  value={url}
                  onChange={(value) => { setUrl(value); setStatus(null); }}
                />}
              </FormField>
              {busy && progress && <DownloadMeter label={t('settings.ghosts.page.githubInstall.title')} progress={progress} />}
              {message && <ErrorNotice role="alert" message={message} />}
            </div>
            <div className="mt-4 flex shrink-0 flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" palette="confirmation" size="lg" onClick={onClose} disabled={busy}>
                {t('settings.ghosts.installConsent.cancel')}
              </Button>
              {(status === 'sign-in' || status === 'forbidden' || status === 'not-found') && (
                <Button type="button" variant="secondary" palette="confirmation" size="lg" onClick={() => {
                  void window.electronAPI.ghosts.installGithubRelease('sign-in')
                    .then((opened) => { if (opened !== true) setStatus('unavailable'); })
                    .catch(() => setStatus('unavailable'));
                }}>
                  {t('settings.ghosts.detail.githubRelease.connect')}
                </Button>
              )}
              <Button type="submit" variant="primary" palette="confirmation" size="lg" disabled={busy || !url.trim()}>
                {t(busy ? 'settings.ghosts.page.githubInstall.loading' : 'settings.ghosts.page.githubInstall.submit')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
