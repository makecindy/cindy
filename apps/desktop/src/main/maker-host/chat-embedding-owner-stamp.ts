import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';

export interface ChatEmbeddingOwnerStamp {
  dataOwnerId: string | null;
  ownerGeneration: number;
}

export function parseChatEmbeddingOwnerStamp(raw: unknown): ChatEmbeddingOwnerStamp | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const dataOwnerId = (raw as { dataOwnerId?: unknown }).dataOwnerId;
  const ownerGeneration = (raw as { ownerGeneration?: unknown }).ownerGeneration;
  if (
    !(typeof dataOwnerId === 'string' || dataOwnerId === null) ||
    typeof ownerGeneration !== 'number' ||
    !Number.isSafeInteger(ownerGeneration)
  ) {
    return null;
  }
  return { dataOwnerId, ownerGeneration };
}

export function isChatEmbeddingOwnerStampCurrent(
  expected: ChatEmbeddingOwnerStamp,
  current: DataOwnerPushStamp,
  boundaryPending: boolean,
): boolean {
  return (
    !boundaryPending &&
    expected.dataOwnerId !== null &&
    expected.dataOwnerId === current.dataOwnerId &&
    expected.ownerGeneration === current.ownerGeneration
  );
}
