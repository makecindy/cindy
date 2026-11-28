import { useSyncExternalStore } from "react";
import { getMobileAuthOwner, type MobileAuthOwnerGeneration } from "@/auth/authOwnerGeneration";

/**
 * The plugins page's management slots, one per signed-in account and target computer (maintainer reviews 15:37, 18:45):
 * every entry that writes to a computer's plugins takes that computer's slot synchronously when pressed, and only then
 * does anything. Whether an entry may start is decided here and nowhere else; what the screen shows (unavailable
 * buttons, the notice at the top) is a projection of the holders and the pending checks.
 *
 * - `tryAcquire` succeeds only while nobody holds the computer's slot and no pending check (an operation this phone
 *   wrote whose result is not settled; see usePluginManagement) concerns the same plugin there. It returns a token of
 *   its own; a press delivered from a stale render, a second press in the same frame, or a press from a form that was
 *   mounted again all fail.
 * - Only the token can release it (`release` with another token does nothing), so a late reply of an older request
 *   cannot free the slot a newer one holds.
 * - The slots belong to the signed-in account, not to a component: unmounting or mounting the page, a detail, a form
 *   or the market again neither releases nor resets them. Another account gets other slots.
 * - Every later step of the holder (preflight reply, Allow / Reject in the confirmation, each write) checks
 *   `holds(token)` before doing anything.
 *
 * When each entry releases, and the rules beside a pending check, are listed in docs/dev-rules/plugin-mobile-implementation.md.
 */
export type PluginSlotEntry = "market-install" | "update" | "uninstall" | "enable" | "page-approval" | "task-settings";
/**
 * Who holds a slot, kept with it (maintainer review 17:43): a page or component mounted again finds the holder here,
 * shows that an operation is under way on which computer, and can go to it.
 */
export interface PluginSlotHolder {
  /** The plugin as shown to the person. */
  name: string;
  /** The computer whose slot this is. */
  deviceId: string;
  deviceName: string;
  /** Installed instance (installed-detail entries). */
  instanceKey?: string;
  /** Market plugin id (market install). */
  pluginId?: string;
  /** The plugin's own id (its manifest id), the same for its market item and its installed instances. */
  ghostId?: string;
  /** The installed list's row key (its detail's management scope, to take the kept controller back). */
  rowKey?: string;
}
export interface PluginSlotToken { readonly id: number; readonly entry: PluginSlotEntry; readonly who: PluginSlotHolder }
export interface PluginManagementSlot {
  /** Takes the slot of `who.deviceId`. `self`: the operation taking it back (its own pending check does not block it). */
  tryAcquire(entry: PluginSlotEntry, who: PluginSlotHolder, self?: string): PluginSlotToken | null;
  /** Releases only when `token` is the holder; returns whether it did. */
  release(token: PluginSlotToken | null | undefined): boolean;
  holds(token: PluginSlotToken | null | undefined): boolean;
  /** The holder of one computer's slot. */
  holder(deviceId: string | undefined): PluginSlotToken | null;
  /** Every computer's holder. */
  holders(): readonly PluginSlotToken[];
  /** `tryAcquire` would succeed now (display only: the buttons it makes unavailable). */
  available(who: PluginSlotHolder): boolean;
  subscribe(listener: () => void): () => void;
}
/** What a controller operation is given by the entry that holds the slot for it. */
export interface PluginOperationHold {
  readonly entry: PluginSlotEntry;
  readonly who: PluginSlotHolder;
  /** Still the holder: checked before every write of the operation. */
  guard: () => boolean;
  /** The operation is over (or never started), or waits for the person to check it: called once; releases the slot. */
  onSettled: () => void;
  /** Take the computer's slot again for the same operation (`operationId`), once settled; null when it is taken. */
  reacquire: (operationId: string) => PluginOperationHold | null;
}
/** Same plugin on the same computer: the same installed instance, market plugin or manifest id. */
export function samePluginSlotHolder(a: PluginSlotHolder, b: PluginSlotHolder): boolean {
  const same = (key: "instanceKey" | "pluginId" | "ghostId") => !!a[key] && a[key] === b[key];
  return a.deviceId === b.deviceId && (same("instanceKey") || same("pluginId") || same("ghostId"));
}
/**
 * Pending checks of an account (registered by usePluginManagement, which keeps them): a new operation on the same
 * plugin and computer waits until the check is settled or the person stops tracking it.
 */
export interface PluginPendingCheckSource {
  blocks(ownerKey: string, who: PluginSlotHolder, self?: string): boolean;
  subscribe(listener: () => void): () => void;
  version(): number;
}
let pendingChecks: PluginPendingCheckSource = { blocks: () => false, subscribe: () => () => {}, version: () => 0 };
export function setPluginPendingCheckSource(source: PluginPendingCheckSource) { pendingChecks = source; }

export function createPluginManagementSlot(ownerKey = ""): PluginManagementSlot {
  const held = new Map<string, PluginSlotToken>();
  let nextId = 0, list: readonly PluginSlotToken[] = [];
  const listeners = new Set<() => void>();
  const notify = () => { list = [...held.values()]; listeners.forEach((listener) => listener()); };
  return {
    tryAcquire(entry, who, self) {
      if (held.has(who.deviceId) || pendingChecks.blocks(ownerKey, who, self)) return null;
      const token = { id: ++nextId, entry, who };
      held.set(who.deviceId, token);
      notify();
      return token;
    },
    release(token) {
      if (!token || held.get(token.who.deviceId) !== token) return false;
      held.delete(token.who.deviceId);
      notify();
      return true;
    },
    holds: (token) => !!token && held.get(token.who.deviceId) === token,
    holder: (deviceId) => (deviceId ? held.get(deviceId) : undefined) ?? null,
    holders: () => list,
    available: (who) => !held.has(who.deviceId) && !pendingChecks.blocks(ownerKey, who),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** A hold for one controller operation: guards with the token and releases it once. */
export function pluginOperationHold(slot: PluginManagementSlot, token: PluginSlotToken): PluginOperationHold {
  let settled = false;
  return {
    entry: token.entry, who: token.who,
    guard: () => slot.holds(token),
    onSettled: () => { if (settled) return; settled = true; slot.release(token); },
    reacquire: (operationId) => {
      const again = slot.tryAcquire(token.entry, token.who, operationId);
      return again ? pluginOperationHold(slot, again) : null;
    },
  };
}

const slots = new Map<string, PluginManagementSlot>();
export const pluginSlotOwnerKey = (owner: MobileAuthOwnerGeneration) => `${owner.accountKey}\u0000${owner.generation}`;
/** The slots of the signed-in account (the same object for every mount until the account changes). */
export function pluginManagementSlotFor(owner: MobileAuthOwnerGeneration = getMobileAuthOwner()): PluginManagementSlot {
  const key = pluginSlotOwnerKey(owner);
  let slot = slots.get(key);
  if (!slot) {
    // Older accounts' slots go: their tokens still release on their own (unreachable) slots, harmlessly.
    slots.clear();
    slot = createPluginManagementSlot(key);
    slots.set(key, slot);
  }
  return slot;
}

/** The current account's slots and their holders, for display. Deciding goes through `tryAcquire`. */
export function usePluginManagementSlot(): { slot: PluginManagementSlot; holders: readonly PluginSlotToken[]; holderOn: (deviceId: string | undefined) => PluginSlotToken | null } {
  // The account is read on every render (an account switch re-renders the page); only the slots are subscribed to.
  const slot = pluginManagementSlotFor(getMobileAuthOwner());
  const holders = useSyncExternalStore(slot.subscribe, slot.holders, slot.holders);
  // `available` also depends on the pending checks: re-render when they change.
  useSyncExternalStore(pendingChecks.subscribe, pendingChecks.version, pendingChecks.version);
  return { slot, holders, holderOn: (deviceId) => holders.find((token) => token.who.deviceId === deviceId) ?? null };
}

export const __testing = { reset: () => slots.clear() };
