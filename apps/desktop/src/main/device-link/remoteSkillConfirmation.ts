import { REMOTE_RESOURCE_INVOKE_CHANNEL } from '@cindy/device-link';
import { parseRemoteSkillReceipt, type RemoteSkillReceipt } from '../../shared/remoteSkills';

/** Ordinary Renderer remote invokes cannot authorize a native Skill mutation. */
export function isRemoteSkillApproval(channel: unknown, args: unknown): boolean {
  if (channel !== REMOTE_RESOURCE_INVOKE_CHANNEL || !Array.isArray(args)) return false;
  return args.some(
    (request) =>
      request &&
      typeof request === 'object' &&
      request.collectionId === 'skills' &&
      request.actionId === 'management:answer',
  );
}
export async function confirmRemoteSkillMutation(
  deps: {
    invoke(action: string, input: Record<string, unknown>): Promise<unknown>;
    current(): void;
    prompt(facts: NonNullable<RemoteSkillReceipt['confirmation']>): Promise<boolean>;
  },
  operationId: string,
): Promise<RemoteSkillReceipt> {
  deps.current();
  const receipt = parseRemoteSkillReceipt(
    await deps.invoke('operation', { operationId }),
    operationId,
  );
  deps.current();
  if (receipt.phase !== 'confirmation') return receipt;
  const facts = receipt.confirmation!;
  const accepted = await deps.prompt(facts);
  deps.current();
  return parseRemoteSkillReceipt(
    await deps.invoke('answer', { operationId, requestId: facts.requestId, accepted }),
    operationId,
  );
}
