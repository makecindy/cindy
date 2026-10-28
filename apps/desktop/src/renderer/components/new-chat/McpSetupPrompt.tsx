import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { McpServerDialog } from '@/components/settings/McpServerDialog';
import type { McpSetupSnapshot, CustomMcpMutation } from '@/../shared/mcpSetup';

export function McpSetupPrompt({
  snapshot,
  onDismiss,
}: {
  snapshot: McpSetupSnapshot;
  onDismiss(): void;
}) {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const retryActivation = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await window.electronAPI.maker.retryMcpSetupActivation({
        requestId: snapshot.requestId,
        expectedRevision: snapshot.revision,
      });
    } catch {
      toast.error(t('settings.mcp.setup.errors.CONFIG_CONFLICT'));
    } finally {
      setRefreshing(false);
    }
  };
  const cancel = () => {
    void window.electronAPI.maker
      .cancelMcpSetup({ requestId: snapshot.requestId, expectedRevision: snapshot.revision })
      .catch(() => {});
  };
  const submit = async (config: CustomMcpMutation) => {
    const updated = await window.electronAPI.maker.updateMcpSetup({
      requestId: snapshot.requestId,
      expectedRevision: snapshot.revision,
      draft: {
        name: config.name,
        url: config.url,
        transport: config.transport,
        headerNames: Object.keys(config.headers),
      },
    });
    const result = await window.electronAPI.maker.submitMcpSetup({
      requestId: updated.requestId,
      expectedRevision: updated.revision,
      submissionId: updated.operationId,
      token: config.token ?? '',
      headers: config.headers,
    });
    if (result.status === 'awaiting_user') throw new Error('MCP_SETUP_FAILED');
  };
  return (
    <section
      aria-live="polite"
      className="min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]"
    >
      {snapshot.errorCode && (
        <p role="alert" className="px-4 pt-4 text-13 text-[var(--error-fg)]">
          {t('settings.mcp.setup.errors.' + snapshot.errorCode)}
        </p>
      )}
      {snapshot.status === 'awaiting_user' ? (
        <McpServerDialog
          embedded
          deviceName={snapshot.deviceName}
          proposal={snapshot.draft}
          submit={submit}
          onClose={cancel}
          onSaved={() => {}}
        />
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-13">{t('settings.mcp.setup.states.' + snapshot.status)}</p>
          {snapshot.status === 'saved' && (
            <div className="min-w-0 space-y-1 text-12 text-[var(--text-secondary)]">
              <p className="break-words">{snapshot.draft.name}</p>
              <p className="break-all">{snapshot.draft.url}</p>
            </div>
          )}
          {snapshot.status === 'saved' && (
            <p className="text-12 text-[var(--text-secondary)]">
              {t(
                snapshot.activation === 'pending'
                  ? 'settings.mcp.setup.activationPending'
                  : 'settings.mcp.setup.nextTask',
              )}
            </p>
          )}
          {snapshot.status === 'saved' && snapshot.activation === 'pending' && (
            <Button
              variant="primary"
              loading={refreshing}
              disabled={refreshing}
              className="self-end"
              onClick={() => void retryActivation()}
            >
              {t('settings.mcp.setup.retryActivation')}
            </Button>
          )}
          {snapshot.status === 'saved' && (
            <Button variant="secondary" className="self-end" onClick={onDismiss}>
              {t('settings.mcp.setup.dismiss')}
            </Button>
          )}
          {snapshot.status === 'verifying' && (
            <Button variant="secondary" className="self-end" onClick={cancel}>
              {t('settings.mcp.cancel')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
