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
import { pluginMarketFactsComplete, pluginOperationOpens } from "./pluginOperationOpens";
import { pluginSlotOwnerKey, samePluginSlotHolder, setPluginPendingCheckSource, type PluginSlotEntry, type PluginSlotHolder } from "./pluginManagementSlot";
import type { ManagedMarketDetail } from "./pluginManagementTypes";

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
  /** The operation whose final result this entry already told the list (told once). */
  concluded?: string;
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
  /**
   * Final receipt, or (installs and updates whose receipt is gone, contract V2.10) the verdict from the computer's
   * facts: `installed` (①), `mismatch` (② not attributable to this operation), `legacy` (③ an older computer without
   * evidence), `notInstalled` (no instance): only `installed` is a result; the others leave it unconfirmed.
   */
  result: "succeeded" | "failed" | "cancelled" | "installed" | "notInstalled" | "mismatch" | "legacy";
  errorCode?: string | null;
  /**
   * `pending`: the read is out; `verified`: the computer's facts name this operation's instance now (`instanceKey`,
   * `pluginOperationOpens`, V2.10 ①); `gone`, `unconfirmed`, `legacy`: they do not (no instance now; not attributable to
   * this operation; an older computer without evidence), so nothing opens and the success stays a past result;
   * `failed`: it did not come back (it can be read again); `none`: nothing to open (an uninstall, or no success).
   */
  readback: "pending" | "verified" | "gone" | "unconfirmed" | "legacy" | "failed" | "none";
  /** The instance found by that read (never the instance the operation started from: an uninstall has none). */
  instanceKey?: string;
  /** Its own view was attached when it ended (that view reads its lists again itself). */
  shown?: boolean;
  /**
   * The person has been shown how it settled (`tellPluginConclusion`): by the view that started it, by the page opening
   * the instance, or by the list of checks. A success that opens something stays listed (the notice at the top, the list
   * of checks) until then, whatever its read says: still out, failed, or settled with nobody there to show it.
   */
  told?: boolean;
}
/** A success that opens something, not yet shown to the person: listed at the top of the page and in the list of checks. */
export function pluginConclusionListed(conclusion: PluginCheckConclusion): boolean {
  return !conclusion.told && conclusion.readback !== "none" && (conclusion.result === "succeeded" || conclusion.result === "installed");
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
  /**
   * The computer no longer has this operation's receipt (NOT_FOUND) and its entry has no operation-level evidence
   * (`AFTER_RECEIPT_GONE`): what the facts read after it show now. The panel says the result cannot be confirmed, shows
   * this, and offers only "Stop tracking"; nothing looks it up again by itself.
   */
  unprovable?: { present: boolean; pagesApproved?: boolean };
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
    const gone = AFTER_RECEIPT_GONE[check.entry] === "unprovable" ? controller.currentMissingReceiptFacts() : null;
    const now = gone && check.who.instanceKey ? gone.ghosts.find((ghost) => ghost.instanceKey === check.who.instanceKey) : undefined;
    list.push({ ...check, state: controller.getState(), shown: !!entry.listener, controller,
      ...(gone ? { unprovable: { present: !!now, ...(check.entry === "page-approval" && now ? { pagesApproved: now.uiCapabilityApproved === true } : {}) } } : {}),
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
  // A read lives no longer than its conclusion.
  for (const operationId of [...readbacks.keys()]) if (!conclusions.some((item) => item.operationId === operationId)) readbacks.delete(operationId);
  notifyChecks();
}
type Finished = NonNullable<ManagementEntry["lastCheck"]>;
/**
 * The one read that closes a success (dispatcher L-3; maintainer review 03:52): for this account and computer, by its
 * own operation id, independent of the controller (which goes once its operation is over) and of any view. Every place
 * that opens an instance after an operation shows this read's conclusion: the market row that started an install, the
 * installed detail after an update or a page approval, the notice at the top and the list of checks. No second read
 * decides beside it, so two places cannot say different things about one operation.
 * - Every read of it is issued after the result. Read again before an earlier read came back: only the newest read
 *   issued settles it (an earlier reply landing last is older).
 * - "Open" only for the instance that one response proves (`pluginOperationOpens`, controller rule ④). A response that
 *   says its market part is incomplete and has no record of the plugin settles nothing: the same as a failed read.
 * - A failed read leaves it listed, to be read again: by "Read again", and by itself once each time its computer becomes
 *   reachable again for the page (`setPluginReadbackAvailable`), including when that happened while the read was out.
 *   Never on a timer.
 * Only reads; dropped when the account changed, when the person was shown how it settled, or on "Stop tracking".
 */
interface Readback { owner: ReturnType<typeof getMobileAuthOwner>; ownerKey: string; invoke: PluginManagementInvoke; snapshotRead?: "installed"; check: Finished; reads: number }
const readbacks = new Map<string, Readback>();
/** Per computer: whether the page can reach it now, and how many times it became reachable. */
const reachable = new Map<string, { up: boolean; edges: number }>();
async function readBack(operationId: string): Promise<void> {
  const job = readbacks.get(operationId);
  const before = conclusions.find((item) => item.operationId === operationId);
  if (!job || !before) return;
  const read = ++job.reads;
  const edges = reachable.get(job.check.who.deviceId)?.edges ?? 0;
  const current = () => isMobileAuthOwnerCurrent(job.owner) && readbacks.get(operationId) === job && job.reads === read;
  const latest = () => conclusions.find((item) => item.operationId === operationId) ?? before;
  conclude(job, { ...before, readback: "pending", instanceKey: undefined });
  let opens: ReturnType<typeof pluginOperationOpens> | undefined;
  try {
    const snapshot = await createPluginManagementClient({ invoke: job.invoke, deviceId: job.check.who.deviceId, isCurrent: current })
      .snapshot(job.snapshotRead);
    if (!current()) return;
    // The final receipt is a past result: only what the computer has now (its instance, package and evidence) opens it.
    opens = pluginOperationOpens(job.check, { ghosts: snapshot.ghosts, market: snapshot.market.items,
      marketComplete: pluginMarketFactsComplete(snapshot.market) });
  } catch {
    if (!current()) return;
  }
  if (opens?.open) { conclude(job, { ...latest(), readback: "verified", instanceKey: opens.instanceKey }); return; }
  if (opens && opens.reason !== "unread") { conclude(job, { ...latest(), readback: opens.reason, instanceKey: undefined }); return; }
  // Not read. Its computer became reachable again while this read was out: that edge's one read is this one, now.
  const now = reachable.get(job.check.who.deviceId);
  if (!opens && now?.up && now.edges !== edges) { void readBack(operationId); return; }
  conclude(job, { ...latest(), readback: "failed", instanceKey: undefined });
}
function startReadback(entry: ManagementEntry, check: Finished) {
  readbacks.set(check.operationId, { owner: entry.owner, ownerKey: entry.ownerKey, invoke: entry.invoke, snapshotRead: entry.snapshotRead, check, reads: 0 });
  void readBack(check.operationId);
}
/**
 * Whether the page can reach a computer now (it is online, and the page is focused and in the foreground). Each time one
 * becomes reachable, the successes on it whose read failed are read again, once.
 */
export function setPluginReadbackAvailable(deviceId: string, up: boolean) {
  const before = reachable.get(deviceId);
  if (before?.up === up) return;
  // The first word about a computer is not a change of it (reads issued before it count from the same zero).
  reachable.set(deviceId, { up, edges: before ? before.edges + (up ? 1 : 0) : 0 });
  if (!up) return;
  for (const [operationId, job] of [...readbacks]) {
    if (job.check.who.deviceId !== deviceId || !isMobileAuthOwnerCurrent(job.owner)) continue;
    if (conclusions.find((item) => item.operationId === operationId)?.readback === "failed") void readBack(operationId);
  }
}
/** The page went away: nothing is reachable for it until it is back (coming back reads the failed ones again). */
export function clearPluginReadbackAvailability() { reachable.clear(); }
/** Read the target computer again for a success ("Read again", and before "Open": the newest read decides). */
export function retryPluginCheckReadback(operationId: string): Promise<PluginCheckConclusion | undefined> {
  return readBack(operationId).then(() => conclusions.find((item) => item.operationId === operationId));
}
/**
 * The person was shown how a success settled (or stops following one that could not be read): it leaves the notice at
 * the top and the list of checks, and its read is dropped. Nothing is sent to the computer.
 */
export function tellPluginConclusion(operationId: string) {
  const conclusion = conclusions.find((item) => item.operationId === operationId);
  readbacks.delete(operationId);
  if (!conclusion || conclusion.told) return;
  conclusions = conclusions.map((item) => item.operationId === operationId
    ? { ...item, told: true, ...(item.readback === "pending" ? { readback: "failed" as const } : {}) } : item);
  notifyChecks();
}
/** Read live (an effect earlier in the same commit may have told it). */
export function pluginConclusionTold(operationId: string): boolean {
  return conclusions.find((item) => item.operationId === operationId)?.told === true;
}
/**
 * What settles a pending check once the computer no longer has its receipt (NOT_FOUND), per entry (dispatcher O-1; the
 * per-entry table in docs/dev-rules/plugin-mobile-implementation.md, "待核实记录的状态表"). Typed over every entry, so a
 * new entry does not compile until it has a row:
 * - `facts`: market install and update. The Host records the operation id of the install that put an instance there
 *   (`installedOperationId`, contract V2.9), so the facts read after NOT_FOUND can prove it (`settleFromFacts`).
 * - `unprovable`: uninstall and page approval. Nothing on the Host names the operation that did them, so the facts cannot
 *   settle it: the record stays listed with what the computer shows now, an explanation and "Stop tracking", and is
 *   never looked up again by itself (the controller stops automatic lookups once the receipt is gone).
 * - `never-recorded`: enable and task settings write directly (no operation, no receipt), so no pending check exists.
 */
type AfterReceiptGone = "facts" | "unprovable" | "never-recorded";
export const AFTER_RECEIPT_GONE: Record<PluginSlotEntry, AfterReceiptGone> = {
  "market-install": "facts", update: "facts", uninstall: "unprovable", "page-approval": "unprovable",
  enable: "never-recorded", "task-settings": "never-recorded",
};
/**
 * A market install or update whose receipt is gone (NOT_FOUND) settles from the facts the controller read right after it
 * (`missingReceiptFacts`), never from an earlier snapshot, wherever it is shown:
 * - No instance of the plugin in those facts: "could not confirm; not on this computer now".
 * - An instance of it is only a lead (a local package can share id and namespace): only the Host's own evidence makes it
 *   this attempt's result (contract V2.10 ①), and only as that one response gives it (controller rule ④): the market
 *   record in the same installed snapshot as the instance (`market.items` beside `ghosts`, which the Host checks against
 *   each other in that response). No other request's attribution is combined with these instances. The record missing
 *   from a complete response leaves it unconfirmed ("mismatch"); missing from a response that says its market part is
 *   incomplete, it settles nothing yet (still a pending check). The original operation is never sent again.
 * Valid only while these facts are still the ones read by the newest installed read issued (the controller derives it
 * when asked); a new lookup clears them.
 */
function settleFromFacts(entry: ManagementEntry, facts: NonNullable<PluginManagementState["missingReceiptFacts"]>) {
  const check = entry.controller.pendingCheck(), item = check?.detail;
  if (!check || AFTER_RECEIPT_GONE[check.entry] !== "facts" || !item || entry.settling === facts) return;
  entry.settling = facts;
  const controller = entry.controller;
  const valid = () => !entry.dead && isMobileAuthOwnerCurrent(entry.owner) && controller.currentMissingReceiptFacts() === facts
    && controller.getState().operationId === check.operationId;
  const settle = (result: "installed" | "notInstalled" | "mismatch" | "legacy", instanceKey?: string) => {
    if (!valid() || !controller.untrack()) return;
    // The instance and the market's record of this operation come from the same response read after NOT_FOUND: verified.
    conclude(entry, { operationId: check.operationId, entry: check.entry, who: check.who, result,
      readback: result === "installed" && instanceKey ? "verified" : "none", instanceKey: result === "installed" ? instanceKey : undefined });
    // Proven by the facts read after NOT_FOUND; "Open" reads the computer once more through the same read as any success.
    if (result === "installed" && instanceKey)
      readbacks.set(check.operationId, { owner: entry.owner, ownerKey: entry.ownerKey, invoke: entry.invoke, snapshotRead: entry.snapshotRead, check, reads: 0 });
  };
  // The same decision as after a final receipt (V2.10): only ① makes it this operation's result; ②, ③ and no
  // instance leave it unconfirmed (without a receipt, ② does not even show the operation succeeded).
  const opens = pluginOperationOpens(check, { ghosts: facts.ghosts, market: facts.market.items,
    marketComplete: pluginMarketFactsComplete(facts.market) });
  if (opens.open) { settle("installed", opens.instanceKey); return; }
  // An instance is there, but this response says its market part is incomplete and names no record of the plugin (the
  // computer just restarted and cannot reach its catalog or a custom market yet): nothing proves or disproves it. It
  // stays a pending check; "Check result" looks the operation up and reads the facts again.
  if (opens.reason === "unread") return;
  settle(opens.reason === "legacy" ? "legacy" : opens.reason === "gone" ? "notInstalled" : "mismatch");
}
/** After each change of an entry's controller: the list at the top, a market install's facts, a final result. */
function watch(entry: ManagementEntry) {
  const check = entry.controller.pendingCheck();
  const state = entry.controller.getState();
  // The receipt is gone: each entry settles as its row of AFTER_RECEIPT_GONE says (an unprovable one stays listed).
  if (check && AFTER_RECEIPT_GONE[check.entry] === "facts" && state.outcome === "unknown" && !state.busy && state.missingReceiptFacts)
    void settleFromFacts(entry, state.missingReceiptFacts);
  // A pending check that ended with a final result: told once (the list of checks says how it ended; when no view showed
  // it, also a market row note and the lists read again). A success is closed by the list's own read of the computer
  // (`readBack`), started here, before the controller goes; an uninstall has nothing to open.
  const kept = entry.lastCheck;
  if (check) entry.lastCheck = check;
  else entry.lastCheck = undefined;
  // One whose first word here was already its result (never seen under way) ends the same way; each operation once.
  const finished = check ? null : entry.controller.finishedOperation();
  const last = kept && state.operationId === kept.operationId ? kept : finished ? { ...finished, waiting: false } : undefined;
  if (!check && last && state.operationId === last.operationId && entry.concluded !== last.operationId
    && ["succeeded", "failed", "cancelled"].includes(state.outcome)) {
    entry.concluded = last.operationId;
    const succeeded = state.outcome === "succeeded", opens = succeeded && last.entry !== "uninstall" && last.entry !== "enable" && last.entry !== "task-settings";
    conclude(entry, { operationId: last.operationId, entry: last.entry, who: last.who,
      result: state.outcome as "succeeded" | "failed" | "cancelled", errorCode: state.errorCode, shown: !!entry.listener,
      readback: opens ? "pending" : "none" });
    if (opens) startReadback(entry, last);
  }
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
  clear: () => { for (const [scope, entry] of [...retained]) letGo(scope, entry); conclusions = []; readbacks.clear(); reachable.clear(); notifyChecks(); },
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
  // The successes whose read is still open follow the same reachability (their computer online, this page focused and in
  // the foreground): each time one becomes reachable its failed reads are read again, once. Told every render (a no-op
  // while nothing changed); the page going away makes nothing reachable.
  const all = useSyncExternalStore(subscribe, () => conclusions, () => conclusions);
  useEffect(() => {
    if (!isOnline) return;
    const devices = new Set(all.filter((item) => item.ownerKey === ownerKey && pluginConclusionListed(item)).map((item) => item.who.deviceId));
    for (const deviceId of devices) setPluginReadbackAvailable(deviceId, active && foreground && isOnline(deviceId));
  });
  useEffect(() => isOnline ? () => clearPluginReadbackAvailability() : undefined, [!!isOnline]);
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
