import { useEffect, useState, useSyncExternalStore } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { makerChatStore, type ChatMessage } from '../../../src/renderer/lib/makerChatStore';
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
        activeErrorClientId={state.error ? state.errorPersistId : null} />
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
    maker: { polishWorkingStatus: async () => null },
  }),
  render: () => <Subject />,
});
