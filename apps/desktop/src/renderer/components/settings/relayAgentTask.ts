import type { TFunction } from 'i18next';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import type { SelfHostedRelayDeploymentView } from '../../../shared/selfHostedRelay';

export type RelayAgentAction = 'deploy' | 'resume' | 'upgrade' | 'remove';

export function buildRelayAgentPrompt(
  t: TFunction,
  action: RelayAgentAction,
  target?: {
    host?: { id: string; hostname: string; user: string };
    deployment?: SelfHostedRelayDeploymentView;
  },
): string {
  const deployment = target?.deployment;
  const context = deployment
    ? { relayId: deployment.relayId, deploymentKey: deployment.deploymentKey, name: deployment.name }
    : target?.host
      ? { sshHostId: target.host.id, host: target.host.hostname, user: target.host.user }
      : null;
  const k = 'settings.remoteControl.relay.agent';
  return [
    t(`${k}.prompt.${action}`),
    t(`${k}.workflow`),
    ...(context ? [t(`${k}.context`), JSON.stringify(context, null, 2)] : []),
  ].join('\n\n');
}

/** Open an ordinary local task with its own unsent input, leaving the home-page draft untouched. */
export async function createRelayAgentTask(title: string, prompt: string): Promise<string | null> {
  const owner = getDataOwnerGeneration();
  const sessionService = await import('@/lib/sessionService');
  if (!isDataOwnerGenerationCurrent(owner)) return null;
  // Main applies the ordinary default model admission and allocates this task's local directory.
  // No workspace, remote execution target, directory grant or text is inherited from another draft.
  const session = await sessionService.create({ title, workspaceKind: 'dialogue' });
  if (!isDataOwnerGenerationCurrent(owner)) return null;
  saveDraft(session.id, { text: plainTextToTiptapDoc(prompt), attachments: [] });
  return session.id;
}
