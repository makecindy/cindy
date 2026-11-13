import type { NativeSubscriptionAccount } from '@cindy/maker-core';

// Only the executing host registers these capabilities. Callers resolve a
// business session through the existing authenticated proxy route first.
const sessions = new Map<string, NativeSubscriptionAccount>();

export function registerSessionSubscriptionAccount(
  sessionId: string | undefined,
  account: NativeSubscriptionAccount,
): () => void {
  if (!sessionId) return () => {};
  account.assertCurrent();
  sessions.set(sessionId, account);
  return () => {
    if (sessions.get(sessionId) === account) sessions.delete(sessionId);
  };
}

export function getSessionSubscriptionAccount(
  sessionId: string | null | undefined,
): NativeSubscriptionAccount | undefined {
  const account = sessionId ? sessions.get(sessionId) : undefined;
  account?.assertCurrent();
  return account;
}
