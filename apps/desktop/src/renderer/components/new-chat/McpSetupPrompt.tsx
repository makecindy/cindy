import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { McpServerDialog } from '@/components/settings/McpServerDialog';
import { listCustomMcpServers } from '@/lib/customMcpServers';
import { toast } from '@/lib/toast';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { McpSetupRequest } from '../../../shared/mcpSetup';
import type { CustomMcpConfig } from '../../../shared/customMcp';

/** Same endpoint (ignoring trailing slashes) or same display name means “this is that entry”. */
function findReusableServer(servers: CustomMcpConfig[], request: McpSetupRequest): CustomMcpConfig | null {
  const normalize = (value: string | undefined) => (value ?? '').trim().replace(/\/+$/, '');
  const url = normalize(request.proposal.url);
  const name = normalize(request.proposal.name).toLowerCase();
  if (url) {
    const byUrl = servers.find(server => normalize(server.url) === url);
    if (byUrl) return byUrl;
  }
  if (name) {
    const byName = servers.find(server => normalize(server.name).toLowerCase() === name);
    if (byName) return byName;
  }
  return null;
}

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

export function McpSetupPrompt({ request, teammate }: { request: McpSetupRequest; teammate?: boolean }) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<CustomMcpConfig[] | null>(null);
  const [forceCreate, setForceCreate] = useState(false);
  const [failedResult, setFailedResult] = useState<{ serverId?: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
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
    setLoadFailed(false);
    void listCustomMcpServers().then(list => {
      if (current) setServers(list);
    }).catch(() => {
      if (!current) return;
      setLoadFailed(true);
    });
    return () => { current = false; };
  }, [request.requestId, loadAttempt]);
  useEffect(() => {
    if (!servers || finished) return;
    // A presentation acknowledgement never authorizes tools or settles the request.
    void window.electronAPI.maker.resolveInteraction(request.requestId, {
      kind: 'mcp_setup', status: 'presented',
    }).catch(() => {});
  }, [servers, request.requestId, finished]);
  if (finished) return null;
  if (loadFailed || failedResult) return <ErrorNotice role="alert"
    message={t(loadFailed ? 'settings.mcp.setup.loadFailed' : failedResult?.serverId
      ? 'settings.mcp.setup.savedDeliveryFailed' : 'settings.mcp.toast.saveFailed')}
    actions={<>
      {!failedResult?.serverId && <Button variant="secondary" size="lg" palette="confirmation" disabled={submitting}
        onClick={() => { void finish(); }}>{t('settings.mcp.cancel')}</Button>}
      <Button variant="primary" size="lg" palette="confirmation" loading={submitting}
        onClick={() => {
          if (loadFailed) setLoadAttempt(attempt => attempt + 1);
          else void finish(failedResult?.serverId);
        }}>{t('commonUi.retry')}</Button>
    </>} />;
  if (!servers) return <p role="status" className="text-13 text-[var(--text-secondary)]">{t('ccAgent.common.loading')}</p>;
  // Re-running setup for the same endpoint must repair that entry, not fork a `custom_x-2`
  // duplicate the owner then has to choose between. Same-endpoint duplicates stay possible on
  // purpose: the owner can explicitly ask for a new entry instead.
  const reusable = forceCreate ? null : findReusableServer(servers, request);
  return <>
    {reusable && <p className="text-13 text-[var(--text-secondary)]">
      {t('settings.mcp.dialog.matchNotice')}{' '}
      <Button variant="ghost" size="sm" onClick={() => setForceCreate(true)}>
        {t('settings.mcp.dialog.createInstead')}
      </Button>
    </p>}
    <McpServerDialog embedded teammate={teammate} proposal={request.proposal}
      initial={reusable ?? undefined}
      existingIds={servers.map(server => server.id)}
      onSaved={serverId => { void finish(serverId); }} onClose={() => { void finish(); }} />
  </>;
}
