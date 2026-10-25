/**
 * Ownership metadata attached to live main → renderer messages.
 *
 * The payload itself stays backwards compatible; this stamp is only an
 * ingress fence. `ownerGeneration` advances whenever main commits a new app
 * session, so a late message from an earlier account/session cannot be
 * applied to a newly mounted renderer slice with the same session id.
 */
export interface DataOwnerPushStamp {
  readonly dataOwnerId: string | null;
  readonly ownerGeneration: number;
}

export function isDataOwnerPushStamp(value: unknown): value is DataOwnerPushStamp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { dataOwnerId?: unknown; ownerGeneration?: unknown };
  return (
    (candidate.dataOwnerId === null || typeof candidate.dataOwnerId === 'string') &&
    typeof candidate.ownerGeneration === 'number' &&
    Number.isInteger(candidate.ownerGeneration) &&
    candidate.ownerGeneration >= 0
  );
}
