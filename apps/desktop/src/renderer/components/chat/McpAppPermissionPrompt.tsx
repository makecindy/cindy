import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { makerChatStore, type PendingAppPermission } from '@/lib/makerChatStore';
import { Button } from '@/components/ui/button';
const EMPTY: PendingAppPermission[] = [];

/** Both surfaces answer the same Host request; neither owns a separate approval. */
export function McpAppPermissionPrompt({
  sessionId,
  clientId,
  floating = false,
}: {
  sessionId: string;
  clientId?: string;
  floating?: boolean;
}) {
  const { t } = useTranslation();
  const permissions = useSyncExternalStore(
    (cb) => makerChatStore.subscribe(sessionId, cb),
    () => makerChatStore.getSnapshot(sessionId).pendingAppPermissions ?? EMPTY,
  ).filter((permission) => !clientId || permission.mcpApp.clientId === clientId);
  if (!permissions.length) return null;
  return (
    <section
      aria-label={t('mcpApps.awaitingApproval')}
      data-mcp-app-permission
      className={
        floating
          ? 'absolute inset-x-0 bottom-full z-40 mb-2 max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-[var(--surface-elevated)] p-3 shadow-lg'
          : 'border-t border-border px-3 py-2 text-13 text-[var(--text-secondary)]'
      }
    >
      <p className="text-13 font-medium text-[var(--text-primary)]">
        {permissions.length > 1
          ? t('mcpApps.pendingApprovals', { count: permissions.length })
          : t('mcpApps.awaitingApproval')}
      </p>
      {permissions.map((permission) => (
        <div key={permission.requestId} className="mt-2 space-y-2">
          <details>
            <summary className="cursor-pointer break-words text-13 text-[var(--text-secondary)]">
              {permission.title ?? permission.toolName} · {permission.mcpApp.title}
            </summary>
            <p className="break-words text-12 text-[var(--text-secondary)]">
              {permission.mcpApp.serverId}
            </p>
            {permission.autoReviewReason && (
              <p className="text-12 text-[var(--text-secondary)]">{permission.autoReviewReason}</p>
            )}
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-12 text-[var(--text-secondary)]">
              {JSON.stringify(permission.input, null, 2)}
            </pre>
          </details>
          {permission.submissionFailed && (
            <p role="status" className="text-12 text-[var(--text-secondary)]">
              {t('newChat.permissionPrompt.submissionFailed')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={permission.submitting}
              onClick={() =>
                makerChatStore.respondToPermission(
                  sessionId,
                  { behavior: 'allow' },
                  permission.requestId,
                )
              }
            >
              {t('agentIsland.native.allowOnce')}
            </Button>
            {permission.mcpApp.scope === 'session' && !!permission.suggestions?.length && (
              <Button
                size="sm"
                variant="secondary"
                disabled={permission.submitting}
                onClick={() =>
                  makerChatStore.respondToPermission(
                    sessionId,
                    { behavior: 'allow', updatedPermissions: permission.suggestions },
                    permission.requestId,
                  )
                }
              >
                {t('agentIsland.native.alwaysAllowForSession')}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={permission.submitting}
              onClick={() =>
                makerChatStore.respondToPermission(
                  sessionId,
                  { behavior: 'deny', message: 'User denied the App tool call' },
                  permission.requestId,
                )
              }
            >
              {t('agentIsland.native.deny')}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
