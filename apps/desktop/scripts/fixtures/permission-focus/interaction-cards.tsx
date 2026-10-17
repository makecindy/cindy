// Synthetic requests only. Callbacks record decisions and never invoke the host.
import { PlanActionCard } from '../../../src/renderer/components/new-chat/PlanActionCard';
import { AskUserQuestionPrompt } from '../../../src/renderer/components/new-chat/AskUserQuestionPrompt';
import { PermissionPrompt } from '../../../src/renderer/components/new-chat/PermissionPrompt';
import { IssueConfirmCard } from '../../../src/renderer/features/cc-agent/IssueConfirmCard';
import { RenameSessionsConfirmCard } from '../../../src/renderer/features/cc-agent/RenameSessionsConfirmCard';
import { GhostGrantConfirmCard } from '../../../src/renderer/features/cc-agent/GhostGrantConfirmCard';

export const interactionKinds = ['plan', 'ask', 'permission', 'issue', 'rename', 'ghost'] as const;
export type InteractionKind = typeof interactionKinds[number];
const noop = () => {};

export function SyntheticInteraction({ kind, session, enabled, onRespond }: {
  kind: InteractionKind;
  session: string;
  enabled: boolean;
  onRespond: (session: string, request: string, result: unknown) => void;
}) {
  const requestId = `request-${session}`;
  const respond = (result: unknown) => onRespond(session, requestId, result);
  const keyboard = { keyboardShortcutsEnabled: enabled };
  let card;
  switch (kind) {
    case 'plan':
      card = <PlanActionCard {...keyboard} requestId={requestId}
        onRespond={(request, approved, feedback) => onRespond(session, request, { approved, feedback })}
        onCancel={(request) => onRespond(session, request, { cancelled: true })} />;
      break;
    case 'ask':
      card = <AskUserQuestionPrompt {...keyboard} sessionId={session}
        pending={{ requestId, questions: [{ question: `Synthetic question ${session}`, header: 'Demo',
          multiSelect: false, options: [{ label: 'Choice', description: 'Synthetic choice' }] }] }}
        viewerState="expanded" onViewerStateChange={noop} draft={null} onDraftChange={noop}
        onAnswer={(request, answers) => onRespond(session, request, answers)} />;
      break;
    case 'permission':
      card = <PermissionPrompt {...keyboard} permission={{ requestId, toolName: 'Bash',
        input: { command: 'echo synthetic-only' } }} onRespond={respond} />;
      break;
    case 'issue':
      card = <IssueConfirmCard {...keyboard} sessionId={`synthetic-${session}`} pending={{ requestId,
        draft: { title: 'Synthetic title', body: 'Synthetic body', type: 'bug' },
        env: { appVersion: '0.0.0', platform: 'darwin', arch: 'arm64', osVersion: 'synthetic' },
        submissionIdentity: { kind: 'platform', login: 'synthetic-bot' },
      }} onRespond={respond} />;
      break;
    case 'rename':
      card = <RenameSessionsConfirmCard {...keyboard} pending={{ requestId, changes: [{
        sessionId: session, currentTitle: `Demo ${session}`, newTitle: `Renamed ${session}`,
        workingDir: '/synthetic', updatedAt: '2026-10-15T00:00:00Z',
      }] }} onRespond={respond} />;
      break;
    case 'ghost':
      card = <GhostGrantConfirmCard {...keyboard} pending={{ requestId, ghostId: 'synthetic',
        ghostName: 'Synthetic plugin', lane: 'dir', items: [{ name: 'demo.txt', absPath: '/synthetic/demo.txt', size: 0 }],
      }} onRespond={respond} />;
      break;
  }
  return <div data-interaction-session={session} data-interaction-kind={kind}>{card}</div>;
}
