import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';

interface ConfirmFacts {
  orgSlug: string;
  orgName: string | null;
  ghostId: string;
  name: string;
  version: string;
  sizeBytes: number;
}

interface ConfirmRequest {
  requestId: string;
  ownerStamp: { dataOwnerId: string; ownerGeneration: number };
  facts: ConfirmFacts;
}

function isConfirmRequest(value: unknown): value is ConfirmRequest {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.requestId !== 'string') return false;
  if (!raw.ownerStamp || typeof raw.ownerStamp !== 'object') return false;
  if (!raw.facts || typeof raw.facts !== 'object') return false;
  const facts = raw.facts as Record<string, unknown>;
  return (
    typeof facts.orgSlug === 'string' &&
    typeof facts.ghostId === 'string' &&
    typeof facts.name === 'string' &&
    typeof facts.version === 'string' &&
    typeof facts.sizeBytes === 'number'
  );
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PluginPublisherConfirmHost() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  useEffect(() => {
    return window.electronAPI.pluginPublisher.onConfirm((raw) => {
      if (!isConfirmRequest(raw)) return;
      void (async () => {
        let confirmed = false;
        let unsubscribeAuth: () => void = () => undefined;
        try {
          if (!isDataOwnerPushStampCurrent(raw.ownerStamp)) return;
          const abort = new AbortController();
          unsubscribeAuth = window.electronAPI.onAuthStateChange((state) => {
            if (
              state.dataOwnerId !== raw.ownerStamp.dataOwnerId ||
              state.ownerGeneration !== raw.ownerStamp.ownerGeneration
            ) {
              abort.abort();
            }
          });
          if (!isDataOwnerPushStampCurrent(raw.ownerStamp)) abort.abort();
          confirmed = await confirm(
            {
              title: t('settings.ghosts.publish.confirmTitle', { name: raw.facts.name }),
              description: t('settings.ghosts.publish.confirmDescription'),
              content: (
                <dl className="space-y-2 text-13 text-[var(--text-secondary)]">
                  <div className="flex justify-between gap-4">
                    <dt>{t('settings.ghosts.publish.org')}</dt>
                    <dd className="text-[var(--text-primary)]">
                      {raw.facts.orgName ?? raw.facts.orgSlug}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>{t('settings.ghosts.publish.pluginId')}</dt>
                    <dd className="text-[var(--text-primary)]">{raw.facts.ghostId}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>{t('settings.ghosts.publish.version')}</dt>
                    <dd className="text-[var(--text-primary)]">{raw.facts.version}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>{t('settings.ghosts.publish.size')}</dt>
                    <dd className="text-[var(--text-primary)]">{formatBytes(raw.facts.sizeBytes)}</dd>
                  </div>
                </dl>
              ),
              maxWidth: 480,
              confirmText: t('settings.ghosts.publish.confirm'),
              cancelText: t('settings.ghosts.publish.cancel'),
              autoFocusConfirm: true,
            },
            abort.signal,
          );
        } finally {
          unsubscribeAuth();
          try {
            await window.electronAPI.pluginPublisher.resolveConfirm(raw.requestId, confirmed);
          } catch {
            // Window teardown cancels the pending confirm in Main.
          }
        }
      })();
    });
  }, [confirm, t]);

  return null;
}
