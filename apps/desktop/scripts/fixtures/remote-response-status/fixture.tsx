import React from 'react';
import { mountPage } from '../../ui-page/harness';
import { RunningStatusBar } from '../../../src/renderer/features/cc-agent/CCAgentSessionView';
import { remoteResponsePendingStatus } from '../../../src/renderer/features/cc-agent/lib/localizeAgentStatus';
import type { UiPageContext } from '../../ui-page/harness/types';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';

function Subject({ context }: { context: UiPageContext }) {
  const messages: ChatMessage[] = context.data.response
    ? [{ clientId: 'thinking', role: 'thinking', content: 'Considering the request' } as ChatMessage] : [];
  return <div className="flex h-screen items-center bg-[var(--surface)] px-6" data-ui-page-subject>
    <RunningStatusBar status={remoteResponsePendingStatus('Thinking...', context.data.remote ? 'remote-device' : null, true, messages)}
      visible preparing={context.data.preparing === true} tokenUsage={context.data.preparing ? 1234 : 0}
      startedAt={null} generationReliable={false} inputWidth="100%" />
  </div>;
}

void mountPage({ render: context => <Subject context={context} /> });
