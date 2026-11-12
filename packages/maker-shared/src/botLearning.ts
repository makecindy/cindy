/**
 * Durable receipts attached to the originating assistant message, never timeline rows.
 * Teammate replies and ordinary task replies share this shape and the `botLearning` meta key.
 */
export interface BotLearningReceipt {
  kind: 'memory' | 'skill';
  key: string;
  title: string;
  action: 'created' | 'updated';
  /**
   * Ordinary tasks only: which of the task's two Cindy memories was written — `user` (about
   * the user, every project) or `project` (the task's repository or folder) — so the receipt
   * opens there. A name, never a path: the receipt is stored on the message and travels to
   * phones and shared-task guests. Absent on teammate receipts.
   */
  scope?: 'user' | 'project';
}

export function readBotLearningReceipts(value: unknown): BotLearningReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is BotLearningReceipt =>
      !!item &&
      typeof item === 'object' &&
      (item.kind === 'memory' || item.kind === 'skill') &&
      typeof item.key === 'string' &&
      item.key.length > 0 &&
      typeof item.title === 'string' &&
      item.title.length > 0 &&
      (item.action === 'created' || item.action === 'updated'),
  );
}

export function mergeBotLearningReceipts(
  previous: BotLearningReceipt[],
  incoming: BotLearningReceipt[],
) {
  const merged = new Map(previous.map((item) => [`${item.kind}:${item.key}`, item]));
  for (const item of incoming) merged.set(`${item.kind}:${item.key}`, item);
  return [...merged.values()].sort(
    (a, b) => Number(a.kind === 'skill') - Number(b.kind === 'skill'),
  );
}

function scopeOfLast(items: BotLearningReceipt[]): { scope?: 'user' | 'project' } {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const scope = items[index]!.scope;
    if (scope === 'user' || scope === 'project') return { scope };
  }
  return {};
}

/** Two quiet rows at most: memory and Skills remain separate even after several saves. */
export function botLearningRows(value: unknown): BotLearningReceipt[] {
  const receipts = readBotLearningReceipts(value);
  return (['memory', 'skill'] as const).flatMap((kind) => {
    const items = receipts.filter((item) => item.kind === kind);
    return items.length
      ? [
          {
            kind,
            key: kind,
            title: items.map((item) => item.title).join(' · '),
            action: items.some((item) => item.action === 'updated')
              ? ('updated' as const)
              : ('created' as const),
            // One row, one destination: the most recent save that knows its scope.
            ...scopeOfLast(items),
          },
        ]
      : [];
  });
}
