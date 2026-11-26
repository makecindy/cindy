import { marketItemMatchesPlugin, type ManagedMarketItem, type ManagedPlugin } from "./pluginManagementTypes";
import { pluginInstallEvidence } from "./pluginInstallEvidence";
import type { PluginSlotEntry, PluginSlotHolder } from "./pluginManagementSlot";

/** A finished operation, as its pending check or its own view kept it. */
export interface FinishedPluginOperation {
  operationId: string;
  entry: PluginSlotEntry;
  /** Update, page approval: the instance it started from (its computer and account are the caller's fence). */
  who: Pick<PluginSlotHolder, "instanceKey">;
  /** Install and update: the market release it was for (its version is the target). */
  detail?: Pick<ManagedMarketItem, "pluginId" | "ghostId" | "namespace" | "releaseId" | "version">;
}

/**
 * Why a finished operation offers no "Open" (the success, when there was one, stays): `gone`, the instance is not on
 * the computer now; `changed`, the plugin there now is another version, or the computer says it is not this
 * operation's; `unproven`, the computer gives no evidence that it is (see `pluginInstallEvidence`).
 */
export type PluginOperationNotOpened = "gone" | "changed" | "unproven";
export type PluginOperationOpens = { open: true; instanceKey: string } | { open: false; reason: PluginOperationNotOpened };
/** What the list of checks and the installed detail say for each reason (plugins.json, 12 languages). */
export const PLUGIN_NOT_OPENED_TEXT: Record<PluginOperationNotOpened, string> = {
  gone: "plugins.checks.result.goneSince",
  changed: "plugins.checks.result.changedSince",
  unproven: "plugins.checks.result.unproven",
};
type MarketRecord = Pick<ManagedMarketItem, "pluginId" | "namespace" | "installedOperationId">;

/**
 * Whether a finished install, update or page approval offers "Open" for an instance, and which (dispatcher O-2, R-1,
 * R-2). The one decision for every place that opens one after an operation: the list of checks (after a final receipt,
 * and after the receipt was gone), the market row that started an install, and the installed detail after an update.
 * It reads only what the computer has now; a success receipt is a past result and never makes an instance openable.
 * The caller has already fenced the account and the computer (the facts were read for this account from that computer).
 * Install and update, all of:
 * - the instance: an install, the market plugin it installed (its id and namespace; one of the same name in another
 *   namespace is not it); an update, the instance it started from (same instance key);
 * - the installed package: the instance's version (from the installed snapshot, the package on disk) is the version this
 *   operation installed. The market record's catalog fields (`releaseId`, `version`, `installState`) describe the
 *   catalog's current release, which may have moved on (`update-available`) with this install still in place, so they
 *   are not compared;
 * - the evidence: the computer's record of this plugin names this operation (`own`). `not-own` and `unavailable` do not
 *   open (`unavailable` stays closed until contract V2.10 says how an older computer is told apart).
 * Page approval: the instance it started from, with its pages approved now.
 */
export function pluginOperationOpens(operation: FinishedPluginOperation, facts: {
  ghosts: readonly ManagedPlugin[];
  /** The market records read with those facts (snapshot items) or the market detail; absent when not read. */
  market?: readonly MarketRecord[] | MarketRecord | null;
}): PluginOperationOpens {
  if (operation.entry === "page-approval") {
    const instance = facts.ghosts.find((ghost) => ghost.instanceKey === operation.who.instanceKey);
    if (!instance) return { open: false, reason: "gone" };
    return instance.uiCapabilityApproved === true ? { open: true, instanceKey: instance.instanceKey } : { open: false, reason: "changed" };
  }
  const item = operation.detail;
  if ((operation.entry !== "market-install" && operation.entry !== "update") || !item) return { open: false, reason: "gone" };
  const instance = facts.ghosts.find((ghost) => marketItemMatchesPlugin(item, ghost)
    && (operation.entry !== "update" || ghost.instanceKey === operation.who.instanceKey));
  if (!instance) return { open: false, reason: "gone" };
  if (instance.manifest.version !== item.version) return { open: false, reason: "changed" };
  const records: readonly MarketRecord[] = !facts.market ? [] : Array.isArray(facts.market) ? facts.market : [facts.market as MarketRecord];
  // The record of this plugin's instance: the same market id and namespace (the computer keys its evidence by both).
  const record = records.find((entry) => entry.pluginId === item.pluginId && (entry.namespace ?? null) === (item.namespace ?? null));
  const evidence = pluginInstallEvidence(record, operation.operationId);
  if (evidence === "own") return { open: true, instanceKey: instance.instanceKey };
  return { open: false, reason: evidence === "not-own" ? "changed" : "unproven" };
}
