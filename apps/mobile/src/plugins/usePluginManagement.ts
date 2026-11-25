import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePluginPromptReads } from './PluginPromptReadsContext';
import { AppState } from "react-native";
import { useAuth } from "@/auth/AuthContext";
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from "@/auth/authOwnerGeneration";
import { startFocusedTopicSubscription } from "@/device-link/focusedTopicSubscription";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { createPluginManagementClient, type PluginManagementInvoke } from "./pluginManagementClient";
import {
  createPluginManagementController,
  nextDetachedStep,
  type PluginManagementController,
  type PluginManagementState,
} from "./pluginManagementController";
import { pluginSlotOwnerKey, samePluginSlotHolder, setPluginPendingCheckSource, type PluginSlotEntry, type PluginSlotHolder } from "./pluginManagementSlot";
import { marketItemMatchesPlugin, type ManagedMarketDetail } from "./pluginManagementTypes";

/**
 * Every controller of this account, shown or kept (maintainer reviews 15:37, 17:43, 18:45). A controller whose view
 * went away while its operation was still under way (switching to another plugin's detail, opening the README and
 * coming back, leaving the page) is kept here and followed to its end; the same view coming back takes it again.
 * - Waiting for this phone's answer (a confirmation not answered): leaving cancels it, once; the controller stays
 *   until the cancel settles.
 * - An operation an entry of the plugins page wrote (its begin at least) whose result is not settled is a pending
 *   check: it stays here, shown or not, offline or not, lookups stopped or not, until a final result, a result settled
 *   from the computer's facts (market installs), or the person's "Stop tracking". The page lists them at its top.
 * - A new account drops them all.
 */
interface ManagementEntry {
  controller: PluginManagementController;
  /** The hook instance showing it; none while retained. */
  listener?: (value: PluginManagementState) => void;
  owner: ReturnType<typeof getMobileAuthOwner>;
  ownerKey: string;
  invoke: PluginManagementInvoke;
  dead: boolean;
  stopWatching?: () => void;
  /** The missing-receipt facts a market install's result is being settled from (each set settled once). */
  settling?: unknown;
  /** Runs the detached review again (after a sheet showing this entry closed). */
  review?: () => void;
  /** The pending check this entry last had (its final result is told once, see `conclude`). */
  lastCheck?: ReturnType<PluginManagementController["pendingCheck"]>;
  /** The installed read this entry's view uses (the market's light read, or the full snapshot): the readback uses it too. */
  snapshotRead?: "installed";
  /** Views of the list of pending checks showing this entry's consent ("View and decide"): it counts as shown then. */
  viewers: number;
}
const retained = new Map<string, ManagementEntry>();
const entries = new Set<ManagementEntry>();

/**
 * How a pending check ended (the list of checks, the market row and the installed list show it). After a success the
 * list closes it with its own read of the computer's installed plugins (dispatcher L-3): `readback` says where that read
 * is, and `instanceKey` is set only once that read found the instance this operation installed, updated or approved.
 */
export interface PluginCheckConclusion {
  operationId: string;
  entry: PluginSlotEntry;
  who: PluginSlotHolder;
  /** Final receipt, or (installs and updates whose receipt is gone) the verdict from the computer's facts. */
  result: "succeeded" | "failed" | "cancelled" | "installed" | "notInstalled" | "mismatch";
  errorCode?: string | null;
  /**
   * `pending`: the read is out; `verified`: it found the instance (`instanceKey`); `missing`: it did not; `failed`: it did
   * not come back (it can be read again); `none`: nothing to open (an uninstall, or no success).
   */
  readback: "pending" | "verified" | "missing" | "failed" | "none";
  /** The instance found by that read (never the instance the operation started from: an uninstall has none). */
  instanceKey?: string;
  /** Its own view was showing it and handled the result already (only the list of checks still tells it). */
  shown?: boolean;
}
const CONCLUSIONS_KEPT = 20;
let conclusions: Array<PluginCheckConclusion & { ownerKey: string; seq: number }> = [];
let conclusionSeq = 0;

/** What the page lists: one pending check, with its own state and what the person can do. */
export interface PluginPendingCheck {
  operationId: string;
  entry: PluginSlotEntry;
  who: PluginSlotHolder;
  detail?: ManagedMarketDetail;
  /** The result waits for the person to check it (the computer's slot went; other plugins there may start). */
  waiting: boolean;
  state: PluginManagementState;
  /** Shown by its own view right now (the installed detail or the market row that started it). */
  shown: boolean;
  /**
   * The computer waits for this phone's answer to a consent this phone never showed (found by a lookup; dispatcher
   * L-2): read-only until the person opens it with `decide`.
   */
  awaitingYou: boolean;
  /** Look up the original operation once (never a second begin, answer or cancel). */
  verify(): Promise<void>;
  /**
   * Open the consent: takes the computer's slot first (false, and nothing opens, while someone else holds it); while
   * `view` is held the entry counts as shown, so nothing cancels it behind the open sheet.
   */
  decide(): boolean;
  /** Hold while a sheet shows this entry's consent; returns the release. */
  view(): () => void;
  controller: PluginManagementController;
  /** Only this phone stops following it; nothing is sent to the computer. False while a write of it is out. */
  stop(): boolean;
  canStop: boolean;
}

let version = 0;
const checkListeners = new Set<() => void>();
const notifyChecks = () => { version += 1; checkListeners.forEach((listener) => listener()); };
let cached: { version: number; ownerKey: string; list: PluginPendingCheck[] } | undefined;
function pendingChecksOf(ownerKey: string): PluginPendingCheck[] {
  if (cached && cached.version === version && cached.ownerKey === ownerKey) return cached.list;
  const list: PluginPendingCheck[] = [];
  for (const entry of entries) {
    if (entry.dead || entry.ownerKey !== ownerKey) continue;
    const check = entry.controller.pendingCheck();
    if (!check) continue;
    const controller = entry.controller;
    list.push({ ...check, state: controller.getState(), shown: !!entry.listener, controller,
      awaitingYou: controller.consentUnseen() && !entry.listener,
      canStop: controller.idle(),
      verify: async () => { entry.settling = undefined; await controller.reconcile(); },
      decide: () => controller.ensureHold(),
      view: () => {
        entry.viewers += 1;
        notifyChecks();
        let done = false;
        return () => { if (done) return; done = true; entry.viewers -= 1; notifyChecks(); entry.review?.(); };
      },
      stop: () => controller.untrack() });
  }
  cached = { version, ownerKey, list };
  return list;
}
setPluginPendingCheckSource({
  blocks: (ownerKey, who, self) => pendingChecksOf(ownerKey).some((check) => check.operationId !== self && samePluginSlotHolder(check.who, who)),
  subscribe: (listener) => { checkListeners.add(listener); return () => { checkListeners.delete(listener); }; },
  version: () => version,
});

function conclude(entry: { ownerKey: string }, conclusion: PluginCheckConclusion) {
  conclusions = [...conclusions.filter((item) => item.operationId !== conclusion.operationId),
    { ...conclusion, ownerKey: entry.ownerKey, seq: ++conclusionSeq }].slice(-CONCLUSIONS_KEPT);
  notifyChecks();
}
type Finished = NonNullable<ManagementEntry["lastCheck"]>;
/**
 * Closing a successful check (dispatcher L-3): the list reads the target computer's installed plugins itself, for this
 * account and computer, independent of the controller (which goes once its operation is over), and offers "Open" only
 * for the instance that read found: the market plugin an install or update put there, or the instance an approval was
 * for. Read again on request after a failed read; dropped when the account changed.
 */
interface Readback { owner: ReturnType<typeof getMobileAuthOwner>; ownerKey: string; invoke: PluginManagementInvoke; snapshotRead?: "installed"; check: Finished }
const readbacks = new Map<string, Readback>();
function instanceFor(check: Finished, ghosts: NonNullable<PluginManagementState["snapshot"]>["ghosts"]) {
  if (check.entry === "market-install" || check.entry === "update")
    return check.detail ? ghosts.find((ghost) => marketItemMatchesPlugin(check.detail!, ghost)) : undefined;
  return check.who.instanceKey ? ghosts.find((ghost) => ghost.instanceKey === check.who.instanceKey) : undefined;
}
async function readBack(operationId: string) {
  const job = readbacks.get(operationId);
  const before = conclusions.find((item) => item.operationId === operationId);
  if (!job || !before) return;
  const current = () => isMobileAuthOwnerCurrent(job.owner) && readbacks.get(operationId) === job;
  conclude(job, { ...before, readback: "pending", instanceKey: undefined });
  try {
    const snapshot = await createPluginManagementClient({ invoke: job.invoke, deviceId: job.check.who.deviceId, isCurrent: current })
      .snapshot(job.snapshotRead);
    if (!current()) return;
    const found = instanceFor(job.check, snapshot.ghosts);
    const latest = conclusions.find((item) => item.operationId === operationId) ?? before;
    conclude(job, found ? { ...latest, readback: "verified", instanceKey: found.instanceKey } : { ...latest, readback: "missing", instanceKey: undefined });
    readbacks.delete(operationId);
  } catch {
    if (!current()) return;
    const latest = conclusions.find((item) => item.operationId === operationId) ?? before;
    conclude(job, { ...latest, readback: "failed", instanceKey: undefined });
  }
}
/** Read the target computer again for a success whose read failed ("Read again" in the list of checks). */
export function retryPluginCheckReadback(operationId: string) { void readBack(operationId); }
/**
 * A market install whose receipt is gone (NOT_FOUND) settles from the facts the controller read right after it
 * (`missingReceiptFacts`), never from an earlier snapshot, wherever it is shown:
 * - No same-id instance in those facts: "could not confirm; not on this computer now".
 * - A same-id instance is only a lead (a local package can share id and namespace): contract V2.9, only the Host's own
 *   evidence makes it this attempt's result: installed at the release asked for, with this operation id recorded
 *   (`installedOperationId`). Anything else stays unconfirmed ("mismatch"). A failed read changes nothing ("Check
 *   result" verifies again). The original operation is never sent again.
 * Valid only while these facts are still the ones read by the newest installed read issued (the controller derives it
 * when asked); a new lookup clears them.
 */
async function settleFromFacts(entry: ManagementEntry, facts: NonNullable<PluginManagementState["missingReceiptFacts"]>) {
  const check = entry.controller.pendingCheck(), item = check?.detail;
  if (!check || (check.entry !== "market-install" && check.entry !== "update") || !item || entry.settling === facts) return;
  entry.settling = facts;
  const controller = entry.controller;
  const valid = () => !entry.dead && isMobileAuthOwnerCurrent(entry.owner) && controller.currentMissingReceiptFacts() === facts
    && controller.getState().operationId === check.operationId;
  const settle = (result: "installed" | "notInstalled" | "mismatch", instanceKey?: string) => {
    if (!valid() || !controller.untrack()) return;
    // The instance comes from the facts read after NOT_FOUND and the market's own record of this operation: verified.
    conclude(entry, { operationId: check.operationId, entry: check.entry, who: check.who, result,
      readback: result === "installed" && instanceKey ? "verified" : "none", instanceKey: result === "installed" ? instanceKey : undefined });
  };
  const instance = facts.ghosts.find((ghost) => marketItemMatchesPlugin(item, ghost));
  if (!instance) { settle("notInstalled"); return; }
  try {
    const market = await createPluginManagementClient({ invoke: entry.invoke, deviceId: check.who.deviceId, isCurrent: valid })
      .detail(item.pluginId);
    settle(market.installState === "installed" && market.releaseId === item.releaseId
      && market.installedOperationId === check.operationId ? "installed" : "mismatch", instance.instanceKey);
  } catch { /* Market facts not read: still unconfirmed; "Check result" verifies again. */ }
}
/** After each change of an entry's controller: the list at the top, a market install's facts, a final result. */
function watch(entry: ManagementEntry) {
  const check = entry.controller.pendingCheck();
  const state = entry.controller.getState();
  if (check?.entry === "market-install" && state.outcome === "unknown" && !state.busy && state.missingReceiptFacts)
    void settleFromFacts(entry, state.missingReceiptFacts);
  // A pending check that ended with a final result: told once (the list of checks says how it ended; when no view showed
  // it, also a market row note and the lists read again). A success is closed by the list's own read of the computer
  // (`readBack`), started here, before the controller goes; an uninstall has nothing to open.
  const last = entry.lastCheck;
  if (check) entry.lastCheck = check;
  else if (last && state.operationId === last.operationId && ["succeeded", "failed", "cancelled"].includes(state.outcome)) {
    entry.lastCheck = undefined;
    const succeeded = state.outcome === "succeeded", opens = succeeded && last.entry !== "uninstall" && last.entry !== "enable" && last.entry !== "task-settings";
    conclude(entry, { operationId: last.operationId, entry: last.entry, who: last.who,
      result: state.outcome as "succeeded" | "failed" | "cancelled", errorCode: state.errorCode, shown: !!entry.listener,
      readback: opens ? "pending" : "none" });
    if (opens) {
      readbacks.set(last.operationId, { owner: entry.owner, ownerKey: entry.ownerKey, invoke: entry.invoke, snapshotRead: entry.snapshotRead, check: last });
      void readBack(last.operationId);
    }
  } else if (!check) entry.lastCheck = undefined;
  notifyChecks();
}
function letGo(scope: string, entry: ManagementEntry) {
  if (retained.get(scope) === entry) retained.delete(scope);
  entry.stopWatching?.();
  entry.stopWatching = undefined;
  entry.dead = true;
  entries.delete(entry);
  entry.controller.dispose();
  notifyChecks();
}
function retain(scope: string, entry: ManagementEntry) {
  const previous = retained.get(scope);
  if (previous && previous !== entry) letGo(scope, previous);
  retained.set(scope, entry);
  const review = () => {
    if (entry.listener || entry.viewers > 0 || entry.dead) return;
    if (!isMobileAuthOwnerCurrent(entry.owner)) { letGo(scope, entry); return; }
    const step = nextDetachedStep(entry.controller);
    if (step === "letGo") letGo(scope, entry);
    else if (step === "cancel") void entry.controller.cancel();
  };
  entry.stopWatching = entry.controller.subscribe(review);
  entry.review = review;
  notifyChecks();
  review();
}
/**
 * DEV visual mock only (`cindy://plugins?checks=<state>`, pluginChecksVisualFixture): keep a controller whose operation
 * began against the mock computer as a pending check no view shows, exactly as one whose view went away.
 */
export function __adoptPendingCheckForVisualMock(controller: PluginManagementController, invoke: PluginManagementInvoke, scope: string) {
  const owner = getMobileAuthOwner();
  const entry = { controller, owner, ownerKey: pluginSlotOwnerKey(owner), invoke, snapshotRead: "installed", dead: false, viewers: 0 } as ManagementEntry;
  entries.add(entry);
  controller.subscribe(() => watch(entry));
  watch(entry);
  retain(scope, entry);
}
export const __retainedForTests = {
  size: () => retained.size,
  /** The signed-in account's pending checks and conclusions, as the page lists them. */
  checks: () => pendingChecksOf(pluginSlotOwnerKey(getMobileAuthOwner())),
  conclusions: () => conclusions.filter((item) => item.ownerKey === pluginSlotOwnerKey(getMobileAuthOwner())),
  clear: () => { for (const [scope, entry] of [...retained]) letGo(scope, entry); conclusions = []; readbacks.clear(); notifyChecks(); },
};

/**
 * The pending checks of the signed-in account (maintainer review 18:45), and while `isOnline` is given, the driver
 * of the ones no view shows: each follows its computer's connection (offline: nothing is sent; back online or in the
 * foreground: the original operation is looked up again, with the controller's one pacing rule). Kept in memory only:
 * the app process ending ends them (docs/dev-rules/plugin-mobile-implementation.md, known limits).
 */
export function usePluginPendingChecks(isOnline?: (deviceId: string) => boolean, active = true): PluginPendingCheck[] {
  const ownerKey = pluginSlotOwnerKey(getMobileAuthOwner());
  const subscribe = (listener: () => void) => { checkListeners.add(listener); return () => { checkListeners.delete(listener); }; };
  const checks = useSyncExternalStore(subscribe, () => pendingChecksOf(ownerKey), () => pendingChecksOf(ownerKey));
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => setForeground(next === "active"));
    return () => subscription.remove();
  }, []);
  const driven = isOnline ? checks.filter((check) => !check.shown).map((check) => [check.operationId, check.who.deviceId,
    active && foreground && isOnline(check.who.deviceId)] as const) : [];
  const drivenKey = JSON.stringify(driven);
  useEffect(() => {
    for (const [operationId, , online] of driven) {
      for (const entry of entries) {
        if (!entry.dead && !entry.listener && entry.ownerKey === ownerKey && entry.controller.pendingCheck()?.operationId === operationId)
          entry.controller.setOnline(online);
      }
    }
  }, [drivenKey, ownerKey]);
  return checks;
}

/** Results of pending checks that ended without their view, oldest first (`after`: only later ones). */
export function usePluginCheckConclusions(): PluginCheckConclusion[] {
  const ownerKey = pluginSlotOwnerKey(getMobileAuthOwner());
  const subscribe = (listener: () => void) => { checkListeners.add(listener); return () => { checkListeners.delete(listener); }; };
  const all = useSyncExternalStore(subscribe, () => conclusions, () => conclusions);
  const ref = useRef<{ all: typeof conclusions; mine: PluginCheckConclusion[] } | undefined>(undefined);
  if (ref.current?.all !== all) ref.current = { all, mine: all.filter((item) => item.ownerKey === ownerKey) };
  return ref.current.mine;
}

/** A screen owns one target. Visibility changes pause polling without replaying writes. */
export function usePluginManagement(
  deviceId: string | undefined,
  online: boolean,
  visible: boolean,
  selectionKey?: string,
  chatPrompt = false,
  /** The market install path reads `{read:'installed'}`; every existing caller keeps the full snapshot. */
  snapshotRead?: "installed",
) {
  const sharedReads = usePluginPromptReads();
  const displayReads = chatPrompt ? sharedReads : null;
  const { invoke, onRemoteResourceChanged, subscribe, unsubscribe, connectionEpoch } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const [state, setState] = useState<PluginManagementState | null>(null);
  const [controller, setController] =
    useState<PluginManagementController | null>(null);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const scope = JSON.stringify([deviceId, accountGeneration, selectionKey]);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const [publishedScope, setPublishedScope] = useState(scope);
  /** The controller this hook shows right now: only it follows this view's connection (a kept one is driven by the page). */
  const attached = useRef<PluginManagementController | null>(null);
  const availability = useRef(online && visible && foreground);
  availability.current = online && visible && foreground;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setForeground(next === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    setState(null);
    setPublishedScope(scope);
    if (!deviceId) {
      setController(null);
      return;
    }
    // The same view coming back takes over the operation it left under way.
    const owner = getMobileAuthOwner();
    const kept = retained.get(scope);
    let entry: ManagementEntry;
    if (kept && !kept.dead && isMobileAuthOwnerCurrent(kept.owner)) {
      retained.delete(scope);
      kept.stopWatching?.();
      kept.stopWatching = undefined;
      entry = kept;
    } else {
      if (kept) letGo(scope, kept);
      const created = { owner, ownerKey: pluginSlotOwnerKey(owner), invoke, snapshotRead, dead: false, viewers: 0 } as ManagementEntry;
      // Current while this entry lives (shown or retained) and the account is the same; a retained controller keeps
      // following its operation after the view moved on.
      const client = createPluginManagementClient({
        invoke,
        deviceId,
        isCurrent: () => !created.dead && isMobileAuthOwnerCurrent(owner),
      });
      created.controller = createPluginManagementController(client, {
        online: availability.current,
        snapshotRead,
        readDisplay: displayReads ? () => displayReads.read(deviceId) : undefined,
        onChange: (value) => {
          if (value.operationId) displayReads?.invalidate(deviceId);
          created.listener?.(value);
          watch(created);
        },
      });
      entries.add(created);
      entry = created;
    }
    entry.listener = (value) => { if (liveScope.current === scope) setState(value); };
    notifyChecks();
    const next = entry.controller;
    attached.current = next;
    setController(next);
    setState(next.getState());
    if (!kept || kept !== entry) void next.refresh();
    else next.setOnline(availability.current);
    return () => {
      entry.listener = undefined;
      if (attached.current === next) attached.current = null;
      notifyChecks();
      if (!entry.dead && isMobileAuthOwnerCurrent(entry.owner) && next.hasOpenOperation()) retain(scope, entry);
      else letGo(scope, entry);
    };
  }, [deviceId, accountGeneration, invoke, selectionKey, displayReads, snapshotRead]);
  useEffect(() => {
    // The render's `controller` may be one this view just handed over (its scope changed in the same commit): leave it
    // alone, or the computer would be taken offline for an operation still under way.
    if (controller && attached.current === controller) controller.setOnline(availability.current);
  }, [controller, online, visible, foreground]);
  useEffect(() => {
    if (!deviceId || !controller || !online || !visible || !foreground) return;
    const release = displayReads?.retain(deviceId);
    // A reconnect can replace the read epoch without changing this chat's identity.
    if (displayReads) void controller.refresh();
    const stop = startFocusedTopicSubscription({ deviceId, owner: `plugin-management:${scope}`,
      topic: 'sessions', subscribe, unsubscribe });
    const off = onRemoteResourceChanged((source, payload) => {
      if (source === deviceId && payload.collectionId === 'plugins') {
        displayReads?.invalidate(deviceId, payload);
        void controller.refresh();
      }
    });
    return () => { release?.(); off(); stop(); };
  }, [deviceId, controller, online, visible, foreground, onRemoteResourceChanged, subscribe, unsubscribe, connectionEpoch, scope, displayReads]);
  return publishedScope === scope
    ? { state, controller }
    : { state: null, controller: null };
}
