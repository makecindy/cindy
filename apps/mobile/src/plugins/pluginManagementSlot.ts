import { useSyncExternalStore } from "react";
import { getMobileAuthOwner, type MobileAuthOwnerGeneration } from "@/auth/authOwnerGeneration";

/**
 * The plugins page's one management slot (maintainer review 15:37): every entry that writes to a computer's plugins
 * takes it synchronously when pressed, and only then does anything. Whether an entry may start is decided here and
 * nowhere else; what the screen shows (unavailable buttons) is a projection of the holder.
 *
 * - `tryAcquire` succeeds only while nobody holds the slot and returns a token of its own; a press delivered from a
 *   stale render, a second press in the same frame, or a press from a form that was mounted again all fail.
 * - Only the token can release it (`release` with another token does nothing), so a late reply of an older request
 *   cannot free the slot a newer one holds.
 * - The slot belongs to the signed-in account, not to a component: unmounting or mounting the page, a detail, a
 *   form or the market again neither releases nor resets it. Another account gets another slot.
 * - Every later step of the holder (preflight reply, Allow / Reject in the confirmation, each write) checks
 *   `holds(token)` before doing anything.
 *
 * When each entry releases it is listed in docs/dev-rules/plugin-mobile-implementation.md.
 */
export type PluginSlotEntry = "market-install" | "update" | "uninstall" | "enable" | "page-approval" | "task-settings";
/**
 * Who holds the slot, kept with it (maintainer review 17:43): a page or component mounted again finds the holder here,
 * shows that an operation is under way on which computer, and can go to it (the market row or the plugin's detail).
 */
export interface PluginSlotHolder {
  /** The plugin as shown to the person. */
  name: string;
  deviceId: string;
  deviceName: string;
  /** Installed instance (installed-detail entries) or market plugin (market install). */
  instanceKey?: string;
  pluginId?: string;
  /** The installed list's row key (its detail's management scope, to take the kept controller back). */
  rowKey?: string;
}
export interface PluginSlotToken { readonly id: number; readonly entry: PluginSlotEntry; readonly who?: PluginSlotHolder }
export interface PluginManagementSlot {
  tryAcquire(entry: PluginSlotEntry, who?: PluginSlotHolder): PluginSlotToken | null;
  /** Releases only when `token` is the holder; returns whether it did. */
  release(token: PluginSlotToken | null | undefined): boolean;
  holds(token: PluginSlotToken | null | undefined): boolean;
  holder(): PluginSlotToken | null;
  subscribe(listener: () => void): () => void;
}
/** What a controller operation is given by the entry that holds the slot for it. */
export interface PluginOperationHold {
  /** Still the holder: checked before every write of the operation. */
  guard: () => boolean;
  /** The operation is over (or never started): called once; releases the slot. */
  onSettled: () => void;
}

export function createPluginManagementSlot(): PluginManagementSlot {
  let holder: PluginSlotToken | null = null, nextId = 0;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    tryAcquire(entry, who) {
      if (holder) return null;
      holder = { id: ++nextId, entry, ...(who ? { who } : {}) };
      notify();
      return holder;
    },
    release(token) {
      if (!token || holder !== token) return false;
      holder = null;
      notify();
      return true;
    },
    holds: (token) => !!token && holder === token,
    holder: () => holder,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** A hold for one controller operation: guards with the token and releases it once. */
export function pluginOperationHold(slot: PluginManagementSlot, token: PluginSlotToken): PluginOperationHold {
  let settled = false;
  return {
    guard: () => slot.holds(token),
    onSettled: () => { if (settled) return; settled = true; slot.release(token); },
  };
}

const slots = new Map<string, PluginManagementSlot>();
const ownerKey = (owner: MobileAuthOwnerGeneration) => `${owner.accountKey}\u0000${owner.generation}`;
/** The slot of the signed-in account (the same object for every mount until the account changes). */
export function pluginManagementSlotFor(owner: MobileAuthOwnerGeneration = getMobileAuthOwner()): PluginManagementSlot {
  const key = ownerKey(owner);
  let slot = slots.get(key);
  if (!slot) {
    // Older accounts' slots go: their tokens still release on their own (unreachable) slot, harmlessly.
    slots.clear();
    slot = createPluginManagementSlot();
    slots.set(key, slot);
  }
  return slot;
}

/** The current account's slot and its holder, for display. Deciding goes through `tryAcquire`. */
export function usePluginManagementSlot(): { slot: PluginManagementSlot; holder: PluginSlotToken | null } {
  // The account is read on every render (an account switch re-renders the page); only the slot is subscribed to.
  const slot = pluginManagementSlotFor(getMobileAuthOwner());
  const holder = useSyncExternalStore(slot.subscribe, slot.holder, slot.holder);
  return { slot, holder };
}

export const __testing = { reset: () => slots.clear() };
