import { useEffect, useState, useSyncExternalStore } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { getLiveErrorMessageClientId, makerChatStore, type ChatMessage } from '../../../src/renderer/lib/makerChatStore';
import { findErrorTailMessage } from '../../../src/renderer/lib/errorTailMessage';
import { ErrorTailErrorBanner } from '../../../src/renderer/components/chat/InterruptedTurnBanner';
import type { AgentInputProjection } from '../../../src/shared/agentInputQueue';

const sessionId = 'error-identity-fixture';
const message = '任务执行失败（模型未返回错误详情）。';
const projection: AgentInputProjection = {
  sessionId, pendingQueue: [], steeringQueueClientIds: [], queuePaused: false,
  queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false,
  error: message, errorReason: 'turn-failed', errorPersistId: 'error-current',
  recovery: null, errorRetryText: 'fixture-retry', credentialSwitchWait: null,
};
const row = (clientId: string, role: ChatMessage['role'], content: string): ChatMessage => ({
  clientId, role, content, createdAt: '2026-11-09T00:00:00.000Z',
});
const messages: ChatMessage[] = [
  row('request', 'user', '检查当前任务的错误提示。'),
  row('error-earlier', 'error', 'Earlier test failure'),
  row('reply', 'assistant', '已完成上一轮检查。'),
  { ...row('error-current', 'error', message), errorReason: 'turn-failed' },
  // A later system row is why the old last-message-only fallback cannot deduplicate.
  { ...row('later-system', 'assistant', ''), systemCardType: 'auto-resume',
    systemCardData: { attempt: 1, maxAttempts: 3, sessionTotal: 1 } },
];
const timeoutRows = makerChatStore.__mapServerMessagesForTest([
  { id: 'request', clientId: 'request', sessionId, role: 'user',
    toolUseId: null, agentMeta: null,
    content: 'Check the project status.', createdAt: '2026-11-09T00:00:00.000Z' },
  { id: 'timeout', clientId: 'timeout', sessionId, role: 'error',
    toolUseId: null, agentMeta: null,
    content: { message: 'The model connection has been retrying for 120s without making progress; the turn was interrupted automatically.',
      reason: 'codex_reconnect_stalled' }, createdAt: '2026-11-09T00:02:00.000Z' },
  { id: 'location', clientId: 'location', sessionId, role: 'agent_switch',
    toolUseId: null, agentMeta: null,
    content: { fromAgentKind: 'codex', toAgentKind: 'codex', nativeHistory: 'restored' },
    createdAt: '2026-11-09T00:03:00.000Z' },
]);

function TerminalTask({ mode = 'tail' }: { mode?: 'tail' | 'live' | 'readonly' | 'standalone' | 'pending' }) {
  const [rows, setRows] = useState(timeoutRows);
  const [readOnly, setReadOnly] = useState(mode === 'readonly');
  const [liveError, setLiveError] = useState(mode === 'live' ? timeoutRows[1]!.content : null);
  const error = findErrorTailMessage(rows);
  const showLive = !readOnly && !!liveError;
  const showTail = !readOnly && mode === 'tail' && !!error;
  const bannerErrorClientId = showLive
    ? getLiveErrorMessageClientId({ error: liveError, errorPersistId: null, historyLoaded: true,
      messages: rows, disposedErrorPersistId: null })
    : showTail ? error?.clientId : null;
  return <div className="flex h-screen min-w-0 flex-col bg-[var(--surface)]" data-ui-page-subject>
    <div data-ui-page-control>
      <button data-testid="disconnect" onClick={() => setReadOnly(current => !current)}>Toggle connection</button>
      <button data-testid="boundary" onClick={() => setRows(current => [...current,
        { ...timeoutRows[2]!, clientId: `location-${current.length}` },
      ])}>Append location record</button>
      <button data-testid="progress" onClick={() => setRows(current => [...current,
        { clientId: 'reply', role: 'assistant', content: 'The project check is complete.' },
        { ...timeoutRows[2]!, clientId: 'location-after-reply' },
      ])}>Resolve with progress</button>
    </div>
    <div className="min-h-0 flex-1">
      <MessageStream workingDir="" historyLoaded messages={rows} activeErrorClientId={bannerErrorClientId} />
    </div>
    <div className="shrink-0 p-4" data-testid="tail-error">
      {showLive && <ErrorBanner error={liveError!} errorReason="codex_reconnect_stalled" agentKind="codex"
        retryText="fixture-retry"
        onRetry={() => setLiveError(null)} onCancel={() => {
          const dismissedId = bannerErrorClientId;
          setLiveError(null);
          setRows(current => current.map(row => row.clientId === dismissedId ? { ...row, errorDismissed: true } : row));
        }} />}
      {showTail && error && <ErrorTailErrorBanner errorText={error.content} errorReason={error.errorReason}
        agentKind="codex" onContinue={() => setRows(current => [...current,
          { clientId: 'retry', role: 'user', content: 'Continue', isSyntheticTrigger: true },
        ])} onDismiss={() => setRows(current => current.map(row => row.clientId === error.clientId
          ? { ...row, errorDismissed: true } : row))} />}
    </div>
  </div>;
}
function Task({ taskId }: { taskId: string }) {
  const state = useSyncExternalStore(
    callback => makerChatStore.subscribeLight(taskId, callback),
    () => makerChatStore.getLightSnapshot(taskId),
  );
  useEffect(() => {
    makerChatStore.__applyInputProjectionForTest({ ...projection, sessionId: taskId });
    return () => makerChatStore.purgeSession(taskId);
  }, [taskId]);
  return <div className="flex h-screen min-w-0 flex-col bg-[var(--surface)]" data-ui-page-subject>
    <div className="min-h-0 flex-1">
      <MessageStream workingDir="" historyLoaded messages={messages}
        activeErrorClientId={state.error ? getLiveErrorMessageClientId({ ...state, historyLoaded: true, messages }) : null} />
    </div>
    <div className="shrink-0 p-4" data-testid="live-error">
      {state.error && <ErrorBanner error={state.error} errorReason={state.errorReason}
        retryText={state.errorRetryText} onRetry={() => {}}
        onCancel={() => makerChatStore.__applyInputProjectionForTest({ ...projection, sessionId: taskId, error: null })} />}
    </div>
  </div>;
}
function Subject() {
  const [generation, setGeneration] = useState(0);
  return <>
    <div data-ui-page-control className="fixed left-0 top-0 z-50">
      <button onClick={() => setGeneration(value => value + 1)} data-testid="restore">Reload snapshot</button>
    </div>
    <Task key={generation} taskId={`${sessionId}-${generation}`} />
  </>;
}
void mountPage({
  route: '/fixture',
  host: () => ({
    agentIsland: { onSessionActivity: subscription('activity') },
    maker: {
      polishWorkingStatus: async () => null,
      codexRuntimeRouteGet: async () => ({ authInjection: 'env-key' }),
      onCodexRuntimeRouteChanged: subscription('codexRuntimeRouteChanged'),
      auth: { onStateChanged: subscription('authStateChanged') },
    },
  }),
  render: (context) => context.data.terminal
    ? <TerminalTask mode={context.data.mode as 'tail' | 'live' | 'readonly' | 'standalone' | 'pending' | undefined} />
    : <Subject />,
});
