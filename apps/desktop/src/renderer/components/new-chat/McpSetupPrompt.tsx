import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { McpServerDialog } from '@/components/settings/McpServerDialog';
import { listCustomMcpServers } from '@/lib/customMcpServers';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { McpSetupRequest } from '../../../shared/mcpSetup';

/** Only public request metadata lives here; form values stay in McpServerDialog. */
export function useMcpSetupRequest(sessionId: string | null, enabled: boolean): McpSetupRequest | null {
  const [state, setState] = useState<{ sessionId: string; request: McpSetupRequest | null; owner: DataOwnerGeneration } | null>(null);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let current = true;
    let revision = 0;
    const owner = getDataOwnerGeneration();
    const requestOff = window.electronAPI.maker.onInteractionRequest((raw, ownerStamp?: unknown) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      const data = raw as { sessionId?: string; request?: McpSetupRequest };
      if (data.sessionId !== sessionId || data.request?.kind !== 'mcp_setup') return;
      revision += 1;
      setState({ sessionId, request: data.request, owner: getDataOwnerGeneration() });
    });
    const dismissed = new Set<string>();
    const dismissOff = window.electronAPI.maker.onInteractionDismissed(raw => {
      const data = raw as { sessionId?: string; requestId?: string };
      if (data.sessionId !== sessionId || !data.requestId) return;
      dismissed.add(data.requestId);
      setState(old => old?.request?.requestId === data.requestId ? null : old);
    });
    const initialRevision = revision;
    void window.electronAPI.maker.getPendingInteractions(sessionId).then(entries => {
      if (!current || !isDataOwnerGenerationCurrent(owner) || initialRevision !== revision) return;
      const request = entries.find(entry => entry.request.kind === 'mcp_setup' && !dismissed.has(entry.request.requestId))?.request;
      setState({ sessionId, request: request ? request as unknown as McpSetupRequest : null, owner });
    }).catch(() => {});
    return () => { current = false; requestOff(); dismissOff(); setState(null); };
  }, [sessionId, enabled]);
  return enabled && state?.sessionId === sessionId && isDataOwnerGenerationCurrent(state.owner) ? state.request : null;
}

export function McpSetupPrompt({ request }: { request: McpSetupRequest }) {
  const { t } = useTranslation();
  const [ids, setIds] = useState<string[] | null>(null);
  const [failedResult, setFailedResult] = useState<{ serverId?: string } | null>(null);
  const [finished, setFinished] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const finish = async (serverId?: string) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await window.electronAPI.maker.resolveInteraction(request.requestId, {
        kind: 'mcp_setup', status: serverId ? 'saved' : 'cancelled', ...(serverId ? { serverId } : {}),
      });
      // A rejected/expired request is also terminal; never recreate the saved MCP.
      setFinished(true);
    } catch {
      setFailedResult({ serverId });
      toast.error(t('settings.mcp.toast.saveFailed'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  useEffect(() => {
    let current = true;
    void listCustomMcpServers().then(servers => {
      if (current) setIds(servers.map(server => server.id));
    }).catch(() => {
      if (!current) return;
      toast.error(t('settings.mcp.toast.saveFailed'));
      void finish();
    });
    return () => { current = false; };
  }, [request.requestId]);
  if (finished) return null;
  if (failedResult) return <section role="alert"
    className="w-full min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
    <p className="text-13 text-[var(--text-primary)]">
      {t(failedResult.serverId ? 'settings.mcp.toast.created' : 'settings.mcp.toast.saveFailed')}
    </p>
    <div className="mt-4 flex flex-wrap justify-end gap-2.5">
      <Button variant="secondary" size="lg" palette="confirmation" disabled={submitting}
        onClick={() => { void finish(); }}>{t('settings.mcp.cancel')}</Button>
      <Button variant="primary" size="lg" palette="confirmation" loading={submitting}
        onClick={() => { void finish(failedResult.serverId); }}>{t('commonUi.retry')}</Button>
    </div>
  </section>;
  if (!ids) return null;
  return <McpServerDialog embedded proposal={request.proposal} existingIds={ids}
    onSaved={serverId => { void finish(serverId); }} onClose={() => { void finish(); }} />;
}
