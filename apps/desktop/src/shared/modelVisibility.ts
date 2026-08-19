import { isDataOwnerPushStamp, type DataOwnerPushStamp } from './dataOwnerPush.js';

/** Main's decision for importing the one pre-account model visibility namespace. */
export interface ModelVisibilityLegacyOwnerClaim extends DataOwnerPushStamp {
  /** The stamped local/cloud owner is stable and may write only its owner-scoped preference key. */
  readonly canWriteOwnerScoped: boolean;
  /** The model visibility legacy marker belongs to the active stable local/cloud owner. */
  readonly claimed: boolean;
  /** The model visibility legacy marker durably belongs to another account. */
  readonly claimedByOtherOwner: boolean;
  /** This process currently has exclusive access and may snapshot the legacy Renderer key. */
  readonly canInitialize: boolean;
}

export function isModelVisibilityLegacyOwnerClaim(
  value: unknown,
): value is ModelVisibilityLegacyOwnerClaim {
  return (
    isDataOwnerPushStamp(value) &&
    typeof (value as Partial<ModelVisibilityLegacyOwnerClaim>).canWriteOwnerScoped === 'boolean' &&
    typeof (value as Partial<ModelVisibilityLegacyOwnerClaim>).claimed === 'boolean' &&
    typeof (value as Partial<ModelVisibilityLegacyOwnerClaim>).claimedByOtherOwner === 'boolean' &&
    typeof (value as Partial<ModelVisibilityLegacyOwnerClaim>).canInitialize === 'boolean'
  );
}
