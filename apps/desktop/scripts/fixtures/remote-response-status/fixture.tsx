import React from 'react';
import { mountPage } from '../../ui-page/harness';
import { RunningStatusBar } from '../../../src/renderer/features/cc-agent/CCAgentSessionView';
import { remoteResponsePendingStatus } from '../../../src/renderer/features/cc-agent/lib/localizeAgentStatus';
import type { UiPageContext } from '../../ui-page/harness/types';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';

function Subject({ context }: { context: UiPageContext }) {
  const [stopped, setStopped] = React.useState(false);
  const messages: ChatMessage[] = context.data.response
    ? [{ clientId: 'thinking', role: 'thinking', content: 'Considering the request' } as ChatMessage] : [];
  return <div className="flex h-screen items-center bg-[var(--surface)] px-6" data-ui-page-subject data-background-stopped={stopped}>
    <RunningStatusBar status={remoteResponsePendingStatus('Thinking...', context.data.remote ? 'remote-device' : null, true, messages)}
      visible preparing={context.data.preparing === true} tokenUsage={context.data.clock ? 85900 : context.data.preparing ? 1234 : 0}
      backgroundTasksRunning={context.data.background === true} onStopBackgroundTasks={() => setStopped(true)}
      sessionKey={context.data.clock ? 'task' : null} clockDeviceId="remote-device"
      startedAt={context.data.clock ? 1 : null} generationReliable={false} inputWidth="100%" />
  </div>;
}

void mountPage({
  host: context => ({ deviceLink: {
    invoke: async () => ({
      id: 'task', activeTurnStartedAt: 1000,
      ...(context.data.clock === 'sampled' ? { turnElapsedMs: 252000 } : {}),
    }),
  } }),
  render: context => <Subject context={context} />,
});
