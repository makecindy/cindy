import { isContinuationMessage } from '@cindy/maker-shared/synthetic-trigger';
import { dropSyntheticTriggerItems, isHiddenSyntheticTriggerItem, type MobileMessageRenderItem } from '@/session/messageRenderModel';

export interface MobileTurnChanges {
  id: string;
  anchorClientId: string;
  fileCount: number;
  additions: number;
  deletions: number;
  fileNames: string[];
  partial: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Keep only the information used by the timeline. Host paths never enter render state. */
export function parseMobileTurnChanges(value: unknown, sessionId: string): MobileTurnChanges | null {
  const summary = record(value);
  if (!summary || summary.sessionId !== sessionId) return null;
  const { id, anchorClientId, fileCount, additions, deletions, files, state } = summary;
  if (typeof id !== 'string' || !id || typeof anchorClientId !== 'string' || !anchorClientId ||
    !count(fileCount) || fileCount === 0 || !count(additions) || !count(deletions) ||
    !Array.isArray(files)) return null;

  const fileNames = files.slice(0, Math.min(fileCount, 50)).flatMap((file) => {
    const path = record(file)?.path;
    if (typeof path !== 'string') return [];
    const name = path.split(/[\\/]/).at(-1);
    return name && name !== '.' && name !== '..' ? [name] : [];
  });
  return { id, anchorClientId, fileCount, additions, deletions, fileNames, partial: state === 'partial' };
}

export function insertMobileTurnChanges(
  items: readonly MobileMessageRenderItem[],
  summaries: readonly MobileTurnChanges[],
): readonly MobileMessageRenderItem[] {
  if (summaries.length === 0) return dropSyntheticTriggerItems(items);
  const byAnchor = new Map<string, MobileTurnChanges[]>();
  for (const summary of summaries) {
    const changes = byAnchor.get(summary.anchorClientId) ?? [];
    changes.push(summary);
    byAnchor.set(summary.anchorClientId, changes);
  }

  const result: MobileMessageRenderItem[] = [];
  let pending: MobileTurnChanges[] | undefined;
  let changed = false;
  const finishTurn = () => {
    for (const summary of pending ?? []) {
      changed = true;
      result.push({ type: 'turn_changes', key: `turnchanges-${summary.id}`, summary });
    }
  };
  for (const item of items) {
    if (item.type === 'message' && item.message.kind === 'user') {
      const { source, isSyntheticTrigger } = item.message;
      const anchored = byAnchor.get(source.clientId);
      // Match ordinary turns and recovery by the host's exact dispatch ID. A hidden
      // continuation still ends the preceding attempt, even without a summary.
      if (source.agentMeta?.delivery !== 'steer' &&
        (!isSyntheticTrigger || anchored || isContinuationMessage(source))) {
        finishTurn();
        pending = anchored;
        byAnchor.delete(source.clientId);
      }
    }
    if (isHiddenSyntheticTriggerItem(item)) changed = true;
    else result.push(item);
  }
  finishTurn();
  return changed ? result : items;
}
