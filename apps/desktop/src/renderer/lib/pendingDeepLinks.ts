import { isSecondaryWindow } from './secondaryWindow';

/** Drain retained invitations before the existing last ordinary navigation intent. */
export async function drainPendingDeepLinks<T extends { type: string }>(
  take: () => Promise<T | null>,
  receive: (payload: T) => void,
): Promise<void> {
  if (isSecondaryWindow()) return;
  let payload;
  do {
    payload = await take();
    if (payload) receive(payload);
  } while (payload?.type === 'chat-invite' || payload?.type === 'chat-invite-malformed' || payload?.type === 'external-task' || payload?.type === 'external-task-error');
}
