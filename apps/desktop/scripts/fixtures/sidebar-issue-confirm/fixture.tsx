import { useState, useSyncExternalStore } from 'react';

import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { IssueConfirmCard } from '../../../src/renderer/features/cc-agent/IssueConfirmCard';
import { SessionCard } from '../../../src/renderer/features/cc-agent/sidebar/SessionCard';
import { SessionItem } from '../../../src/renderer/features/cc-agent/sidebar/SessionItem';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { makerChatStore } from '../../../src/renderer/lib/makerChatStore';
import { ctx, mountPage, subscription } from '../../ui-page/harness';

const ownerStamp = { dataOwnerId: 'fixture', ownerGeneration: 1 };
setDataOwnerGeneration(ownerStamp.dataOwnerId, ownerStamp.ownerGeneration);

const foreground = 'fixture-foreground';
const feedback = 'fixture-feedback';
const requestId = 'fixture-issue-confirm';
const now = '2026-11-23T10:00:00.000Z';
const taskDefaults = {
  userId: ownerStamp.dataOwnerId,
  model: 'fixture-model',
  effort: 'medium',
  permissionMode: 'default',
  sdkSessionId: null,
  totalTokenUsage: 0,
  totalCostUsd: 0,
  contextTokens: 0,
  contextWindow: 0,
  fastMode: false,
  clearedAt: null,
  pinnedAt: null,
  userSendAt: now,
  extraDirs: [],
} as const;
const sessions: Session[] = [
  {
    ...taskDefaults, id: foreground, title: 'Current task', source: 'desktop',
    status: 'active', workspaceKind: 'dialogue', workingDir: '/fixture/current',
    agentKind: 'codex', createdAt: now, updatedAt: now, _count: { messages: 1 },
  },
  {
    ...taskDefaults, id: feedback, title: 'Feedback task', source: 'slack',
    status: 'active', workspaceKind: 'dialogue', workingDir: '/fixture/feedback',
    agentKind: 'codex', createdAt: now, updatedAt: now, _count: { messages: 1 },
  },
];

type Push = (payload: unknown, ownerStamp: unknown) => void;
const onInteractionRequest = (callback: Push) =>
  subscription('issue-request')((input) => {
    const { dataOwnerId } = input as { dataOwnerId: string };
    callback({
      sessionId: feedback,
      request: {
        kind: 'issue_confirm',
        requestId,
        draft: { title: 'Synthetic feedback draft', body: 'Synthetic feedback body.', type: 'bug' },
        env: { appVersion: 'fixture', platform: 'darwin', arch: 'arm64', osVersion: 'fixture' },
        submissionIdentity: { kind: 'platform', login: 'cindy-issue' },
      },
    }, { ...ownerStamp, dataOwnerId });
  });

const onInteractionDismissed = (callback: Push) =>
  subscription('issue-dismissed')((input) =>
    callback({ sessionId: feedback, requestId: input, reason: 'resolved' }, ownerStamp),
  );

const noop = () => {};
function Surface() {
  const [activeSessionId, setActiveSessionId] = useState(foreground);
  const pending = useSyncExternalStore(
    (callback) => makerChatStore.subscribeLight(activeSessionId, callback),
    () => makerChatStore.getLightSnapshot(activeSessionId).pendingIssueConfirm,
  );
  const rowProps = (session: Session) => ({
    session,
    isActive: activeSessionId === session.id,
    isRunning: false,
    hasAttentionNotification: false,
    onClick: setActiveSessionId,
    onAction: noop,
    onRename: noop,
    onTogglePin: noop,
  });
  return (
    <div className="grid grid-cols-[260px_1fr] h-screen">
      <aside className="bg-sidebar p-2">
        {sessions.map((session) => ctx.case === 'list'
          ? <SessionCard key={session.id} variant="list" {...rowProps(session)} />
          : <SessionItem key={session.id} {...rowProps(session)} />
        )}
      </aside>
      <main className="p-5" data-active-task={activeSessionId}>
        {pending && (
          <IssueConfirmCard
            sessionId={activeSessionId}
            pending={pending}
            onRespond={(decision) => makerChatStore.respondToIssueConfirm(activeSessionId, decision)}
          />
        )}
      </main>
    </div>
  );
}

void mountPage({
  route: '/cc-agent',
  host: {
    localDb: {
      messages: {
        list: async () => [],
        onCreated: subscription('message-created'),
      },
      sessions: { get: async (id: string) => sessions.find((session) => session.id === id) },
    },
    maker: {
      onInteractionRequest,
      onInteractionDismissed,
      resolveInteraction: async (id: string, decision: { confirmed: boolean }) => {
        if (id !== requestId || decision.confirmed !== false)
          throw new Error('The fixture accepts only cancellation of its own request');
        const { dataset } = document.documentElement;
        dataset.issueCancelled = id;
        dataset.issueCancelCount = String(Number(dataset.issueCancelCount ?? 0) + 1);
        return { accepted: true };
      },
    },
  },
  render: () => {
    makerChatStore.initGlobalListeners({ ownsRemoteAuthRetry: false });
    return <WorktreeProvider><Surface /></WorktreeProvider>;
  },
});
