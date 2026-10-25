/** Rewound/cleared deliveries do not acknowledge a still-visible card. A new
 * deterministic id avoids both the message unique key and the queue's old id. */
export async function resolveBotAuthorizationDelivery(
  baseId: string,
  read: (clientId: string) => Promise<{ id: string; createdAt: number; rewindAt: number | null; clearedAt: number | null } | null>,
): Promise<{ clientId: string; delivered: boolean }> {
  let clientId = baseId;
  while (true) {
    const row = await read(clientId);
    if (!row) return { clientId, delivered: false };
    if (row.rewindAt === null && (row.clearedAt === null || row.createdAt > row.clearedAt))
      return { clientId, delivered: true };
    clientId = `${baseId}:retry:${row.id}`;
  }
}

export interface BotAuthorizationInputGuard {
  validate(): Promise<void>;
  assertCurrent(): void;
}

/** Called while the existing session send lock is held. No await may separate
 * the synchronous clear-generation check from enqueue. */
export async function commitBotAuthorizationInput(
  guard: BotAuthorizationInputGuard,
  enqueue: () => void,
) {
  await guard.validate();
  guard.assertCurrent();
  enqueue();
}

