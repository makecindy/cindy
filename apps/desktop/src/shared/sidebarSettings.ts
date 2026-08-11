import { isDataOwnerPushStamp, type DataOwnerPushStamp } from './dataOwnerPush.js';

export const SIDEBAR_PINNED_ORDER_MAX_ENTRIES = 10_000;
export const SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH = 4_096;

export interface SidebarSettingsSnapshot extends DataOwnerPushStamp {
  /** True when Main has a durable pinnedOrder override, including an explicit empty array. */
  readonly pinnedOrderIsAuthoritative: boolean;
  readonly pinnedOrder: string[];
  readonly hiddenProjectKeys: string[];
}

/** Main's durable arbitration result for the one unscoped Renderer namespace. */
export interface SidebarLegacyRendererOwnerClaim extends DataOwnerPushStamp {
  /** The durable marker belongs to this owner, so an existing envelope is readable. */
  readonly claimed: boolean;
  /** This process is currently exclusive and may publish a new legacy envelope. */
  readonly canInitialize: boolean;
  /** Main has durably consumed or superseded the legacy Renderer pin staging. */
  readonly pinnedLegacyConsumed: boolean;
}

export type SidebarPinnedOrderMutation =
  | {
      readonly kind: 'reorder';
      /** The renderer snapshot that the drag started from. */
      readonly baseOrder: readonly string[];
      /** The renderer's desired order after the drag. */
      readonly order: readonly string[];
    }
  | { readonly kind: 'promote'; readonly entryId: string }
  | { readonly kind: 'remove'; readonly entryId: string }
  | { readonly kind: 'migrate-legacy'; readonly order: readonly string[] };

export interface SidebarPinnedOrderWriteRequest extends DataOwnerPushStamp {
  readonly mutation: SidebarPinnedOrderMutation;
}

export interface SidebarProjectHiddenWriteRequest extends DataOwnerPushStamp {
  readonly projectKey: string;
  readonly hidden: boolean;
}

export function normalizeSidebarPinnedOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH ||
      seen.has(entry)
    ) {
      continue;
    }
    seen.add(entry);
    order.push(entry);
    if (order.length >= SIDEBAR_PINNED_ORDER_MAX_ENTRIES) break;
  }
  return order;
}

export function isSidebarSettingsSnapshot(value: unknown): value is SidebarSettingsSnapshot {
  if (!isDataOwnerPushStamp(value)) return false;
  const candidate = value as Partial<SidebarSettingsSnapshot>;
  return (
    typeof candidate.pinnedOrderIsAuthoritative === 'boolean' &&
    isStringArray(candidate.pinnedOrder) &&
    isStringArray(candidate.hiddenProjectKeys) &&
    (candidate.pinnedOrderIsAuthoritative || candidate.pinnedOrder.length === 0)
  );
}

export function isSidebarLegacyRendererOwnerClaim(
  value: unknown,
): value is SidebarLegacyRendererOwnerClaim {
  return (
    isDataOwnerPushStamp(value) &&
    typeof (value as Partial<SidebarLegacyRendererOwnerClaim>).claimed === 'boolean' &&
    typeof (value as Partial<SidebarLegacyRendererOwnerClaim>).canInitialize === 'boolean' &&
    typeof (value as Partial<SidebarLegacyRendererOwnerClaim>).pinnedLegacyConsumed === 'boolean'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
