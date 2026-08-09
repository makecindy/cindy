import { isDataOwnerPushStamp, type DataOwnerPushStamp } from './dataOwnerPush.js';

export interface SidebarSettingsSnapshot extends DataOwnerPushStamp {
  readonly pinnedOrder: string[];
  readonly hiddenProjectKeys: string[];
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

export function isSidebarSettingsSnapshot(value: unknown): value is SidebarSettingsSnapshot {
  if (!isDataOwnerPushStamp(value)) return false;
  const candidate = value as Partial<SidebarSettingsSnapshot>;
  return isStringArray(candidate.pinnedOrder) && isStringArray(candidate.hiddenProjectKeys);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
