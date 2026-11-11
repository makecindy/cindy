import { isSafeBranchBaseRef } from './reviewBranchRef';

export type ReviewSourceDescriptor =
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'commit'; commitOid: string | null }
  | { kind: 'branch'; baseRef: string | null }
  | { kind: 'last-turn' }
  | { kind: 'turn-set'; targetSessionId: string | null; changeSetIds: string[] };

/** Entry-point positioning is independent from the selected review data source. */
export interface ReviewJumpTarget {
  diffId: string | null;
  path: string | null;
  nonce: number;
}

export interface ReviewCapabilities {
  canDiscardHunk: boolean;
  canCommit: boolean;
  canPush: boolean;
  canRichPreview: boolean;
  canOpenFile: boolean;
  canSwitchSource: boolean;
  showBranchInfo: boolean;
}

export interface MigratedLegacyTurnTarget {
  descriptor: Extract<ReviewSourceDescriptor, { kind: 'turn-set' }>;
  jumpTarget: ReviewJumpTarget;
}

const MAX_CHANGE_SET_IDS = 16;
const MAX_ID_LENGTH = 256;
const MAX_DIFF_ID_LENGTH = 512;

function nullableString(
  value: unknown,
  maxLength = Number.POSITIVE_INFINITY,
): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > maxLength ? undefined : trimmed;
}

function nullableOpaqueString(
  value: unknown,
  maxLength = Number.POSITIVE_INFINITY,
): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  return value === '' || value.length > maxLength ? undefined : value;
}

function parseChangeSetIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANGE_SET_IDS) return null;
  if (
    !value.every(
      (id) => typeof id === 'string' && id.trim() !== '' && id.trim().length <= MAX_ID_LENGTH,
    )
  )
    return null;
  return value.map((id) => id.trim());
}

export function parseReviewSourceDescriptor(value: unknown): ReviewSourceDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (obj.kind === 'unstaged' || obj.kind === 'staged' || obj.kind === 'last-turn') {
    return { kind: obj.kind };
  }
  if (obj.kind === 'commit') {
    const commitOid = nullableString(obj.commitOid, MAX_ID_LENGTH);
    return commitOid === undefined ? null : { kind: 'commit', commitOid };
  }
  if (obj.kind === 'branch') {
    const baseRef = nullableString(obj.baseRef);
    if (baseRef === undefined || (baseRef !== null && !isSafeBranchBaseRef(baseRef))) return null;
    return { kind: 'branch', baseRef };
  }
  if (obj.kind === 'turn-set') {
    const changeSetIds = parseChangeSetIds(obj.changeSetIds);
    const targetSessionId = nullableString(obj.targetSessionId, MAX_ID_LENGTH);
    if (!changeSetIds || targetSessionId === undefined) return null;
    return { kind: 'turn-set', targetSessionId, changeSetIds };
  }
  return null;
}

export function parseReviewJumpTarget(value: unknown): ReviewJumpTarget | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const diffId = nullableOpaqueString(obj.diffId, MAX_DIFF_ID_LENGTH);
  const path = nullableOpaqueString(obj.path);
  const nonce = obj.nonce;
  if (
    diffId === undefined ||
    path === undefined ||
    typeof nonce !== 'number' ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0
  ) {
    return null;
  }
  return { diffId, path, nonce };
}

/** Maps persisted pre-descriptor state without mutating the stored legacy payload. */
export function migrateLegacyTurnTarget(value: unknown): MigratedLegacyTurnTarget | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const changeSetIds = parseChangeSetIds(obj.changeSetIds);
  const targetSessionId = nullableString(obj.targetSessionId, MAX_ID_LENGTH);
  const diffId = nullableOpaqueString(obj.selectedDiffId, MAX_DIFF_ID_LENGTH);
  const path = nullableOpaqueString(obj.selectedPath);
  const nonce =
    typeof obj.requestNonce === 'number' &&
    Number.isSafeInteger(obj.requestNonce) &&
    obj.requestNonce >= 0
      ? obj.requestNonce
      : 0;
  if (!changeSetIds || targetSessionId === undefined || diffId === undefined || path === undefined)
    return null;
  return {
    descriptor: { kind: 'turn-set', targetSessionId, changeSetIds },
    jumpTarget: { diffId, path, nonce },
  };
}

export function capabilitiesFor(descriptor: ReviewSourceDescriptor): ReviewCapabilities {
  if (descriptor.kind === 'turn-set') {
    return {
      canDiscardHunk: false,
      canCommit: false,
      canPush: false,
      canRichPreview: false,
      canOpenFile: false,
      canSwitchSource: true,
      showBranchInfo: false,
    };
  }

  return {
    canDiscardHunk: descriptor.kind === 'unstaged',
    canCommit: true,
    canPush: true,
    canRichPreview: true,
    canOpenFile: true,
    canSwitchSource: true,
    showBranchInfo: true,
  };
}
