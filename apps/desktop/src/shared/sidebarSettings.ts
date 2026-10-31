import { isDataOwnerPushStamp, type DataOwnerPushStamp } from './dataOwnerPush.js';
import { projectKeyComparisonKey } from './projectKeys.js';
import { isValidPluginStoragePart } from './pluginIdentity.js';

export const SIDEBAR_PINNED_ORDER_MAX_ENTRIES = 10_000;
export const SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH = 4_096;
export const SIDEBAR_HIDDEN_MAIN_VIEW_MAX_ENTRIES = 1_000;
export const SIDEBAR_PROJECT_PIN_HOST_MAX_ENTRIES = 1_000;
const SIDEBAR_PROJECT_PIN_HOST_ID_MAX_LENGTH = 256;

export function isSidebarGhostId(value: unknown): value is string {
  return typeof value === 'string' && isValidPluginStoragePart(value);
}

export interface SidebarSettingsSnapshot extends DataOwnerPushStamp {
  /** True when Main has a durable pinnedOrder override, including an explicit empty array. */
  readonly pinnedOrderIsAuthoritative: boolean;
  readonly pinnedOrder: string[];
  readonly hiddenProjectKeys: string[];
  /** Plugin ids with an explicit user override that hides their main-view sidebar entry. */
  readonly hiddenMainViewGhostIds: string[];
  /**
   * Remote devices that own their project pins. This computer has handed its old local pins
   * for their projects to them; its `project:device:<id>:` entries are now display order only.
   * Main always sends it; fixtures and fallbacks may omit it (treated as empty).
   */
  readonly projectPinHostDeviceIds?: string[];
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

export const PINNED_PROJECT_ENTRY_PREFIX = 'project:';

/** Project pins compare by local Windows identity; conversation ids stay exact. */
export function sidebarPinnedEntryComparisonKey(entryId: string, localPlatform: string): string {
  if (!entryId.startsWith(PINNED_PROJECT_ENTRY_PREFIX)) return entryId;
  const projectKey = entryId.slice(PINNED_PROJECT_ENTRY_PREFIX.length);
  const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
  return comparisonKey == null ? entryId : `${PINNED_PROJECT_ENTRY_PREFIX}${comparisonKey}`;
}

export interface SidebarPinnedOrderWriteRequest extends DataOwnerPushStamp {
  readonly mutation: SidebarPinnedOrderMutation;
}

export interface SidebarProjectHiddenWriteRequest extends DataOwnerPushStamp {
  readonly projectKey: string;
  readonly hidden: boolean;
}

export interface SidebarMainViewHiddenWriteRequest extends DataOwnerPushStamp {
  readonly ghostId: string;
  readonly hidden: boolean;
}

export interface SidebarProjectPinHostWriteRequest extends DataOwnerPushStamp {
  readonly deviceId: string;
}

export function isSidebarProjectPinHostDeviceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= SIDEBAR_PROJECT_PIN_HOST_ID_MAX_LENGTH
  );
}

export function normalizeSidebarProjectPinHostDeviceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const next: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isSidebarProjectPinHostDeviceId(entry) || seen.has(entry)) continue;
    seen.add(entry);
    next.push(entry);
    if (next.length >= SIDEBAR_PROJECT_PIN_HOST_MAX_ENTRIES) break;
  }
  return next;
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
    isHiddenMainViewGhostIds(candidate.hiddenMainViewGhostIds) &&
    (candidate.projectPinHostDeviceIds === undefined ||
      (isStringArray(candidate.projectPinHostDeviceIds) &&
        candidate.projectPinHostDeviceIds.every(isSidebarProjectPinHostDeviceId))) &&
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

function isHiddenMainViewGhostIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= SIDEBAR_HIDDEN_MAIN_VIEW_MAX_ENTRIES &&
    value.every(isSidebarGhostId) &&
    new Set(value).size === value.length
  );
}
