export interface BotDeliveryDiagnostic {
  retrySafe: boolean | null;
  transport: string | null;
  startedAt: number | null;
  textMessageId: string | null;
  sentMediaCount: number;
  committedFinal: boolean;
  attachmentMessageIds: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseBotDeliveryDiagnostic(
  value: string | null | undefined,
): BotDeliveryDiagnostic | undefined {
  try {
    const root = record(JSON.parse(value ?? 'null'));
    if (!root) return undefined;
    const dispatch = record(root.externalDispatch);
    const progress = record(root.progress);
    const attachmentMessageIds = Array.isArray(progress?.attachmentMessageIds)
      ? progress.attachmentMessageIds.filter((item): item is string => typeof item === 'string')
      : [];
    const diagnostic: BotDeliveryDiagnostic = {
      retrySafe: typeof dispatch?.retrySafe === 'boolean' ? dispatch.retrySafe : null,
      transport: typeof dispatch?.transport === 'string' ? dispatch.transport : null,
      startedAt: typeof dispatch?.startedAt === 'number' ? dispatch.startedAt : null,
      textMessageId: typeof progress?.textMessageId === 'string' ? progress.textMessageId : null,
      sentMediaCount:
        typeof progress?.sentMediaCount === 'number' && Number.isSafeInteger(progress.sentMediaCount)
          ? Math.max(0, progress.sentMediaCount)
          : attachmentMessageIds.length,
      committedFinal: progress?.committedFinal === true,
      attachmentMessageIds,
    };
    return dispatch || progress ? diagnostic : undefined;
  } catch {
    return undefined;
  }
}
