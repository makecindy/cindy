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
 * Why a finished operation offers no "Open" (the success, when there was one, stays a past result): `gone`, no instance
 * of it on the computer now (not installed, a conflict, or not in the installed snapshot); `unconfirmed`, the computer
 * cannot attribute the instance there now to this operation (V2.10 ②); `legacy`, an older computer gives no evidence
 * (③: the person opens it from the installed list).
 */
export type PluginOperationNotOpened = "gone" | "unconfirmed" | "legacy";
export type PluginOperationOpens = { open: true; instanceKey: string } | { open: false; reason: PluginOperationNotOpened };
/** What the list of checks and the installed detail say for each reason (plugins.json, 12 languages). */
export const PLUGIN_NOT_OPENED_TEXT: Record<PluginOperationNotOpened, string> = {
  gone: "plugins.checks.result.goneSince",
  unconfirmed: "plugins.checks.result.unconfirmed",
  legacy: "plugins.checks.result.legacyHost",
};
type MarketRecord = Pick<ManagedMarketItem, "pluginId" | "ghostId" | "namespace" | "installState" | "installedOperationId" | "installedOperationAttribution">;

/**
 * Whether a finished install, update or page approval offers "Open" for an instance, and which (dispatcher O-2, R-1,
 * R-2; contract V2.10). The one decision for every place that opens one after an operation: the list of checks (after
 * a final receipt, and after the receipt was gone), the market row that started an install, and the installed detail
 * after an update. It reads only the newest facts read from the computer: a success receipt is a past result and never
 * makes an instance openable, however recent. The caller has already fenced the account and the computer.
 * Install and update: the computer's record of this plugin (same market id; `pluginInstallEvidence`) is ① for this
 * operation and the attempt's instance (ghostId, namespace), and that instance is in the installed snapshot (an update:
 * the instance it started from). The record's catalog `releaseId` / `version` are not compared, nor versions at all: ①
 * pins the installed package. Page approval: the instance it started from, its pages approved now.
 */
export function pluginOperationOpens(operation: FinishedPluginOperation, facts: {
  ghosts: readonly ManagedPlugin[];
  /** The market records read with those facts (snapshot items) or the market detail; absent when not read. */
  market?: readonly MarketRecord[] | MarketRecord | null;
}): PluginOperationOpens {
  if (operation.entry === "page-approval") {
    const instance = facts.ghosts.find((ghost) => ghost.instanceKey === operation.who.instanceKey);
    if (!instance) return { open: false, reason: "gone" };
    return instance.uiCapabilityApproved === true ? { open: true, instanceKey: instance.instanceKey } : { open: false, reason: "unconfirmed" };
  }
  const item = operation.detail;
  if ((operation.entry !== "market-install" && operation.entry !== "update") || !item) return { open: false, reason: "gone" };
  const records: readonly MarketRecord[] = !facts.market ? [] : Array.isArray(facts.market) ? facts.market : [facts.market as MarketRecord];
  // Only the records of this attempt's market id; of several, the one for its namespace.
  const same = records.filter((entry) => entry.pluginId === item.pluginId);
  const record = same.find((entry) => (entry.namespace ?? null) === (item.namespace ?? null)) ?? same[0];
  const evidence = pluginInstallEvidence(record, { operationId: operation.operationId, ghostId: item.ghostId, namespace: item.namespace });
  // A conflict: a package of the same id from elsewhere is there (not this attempt's instance, but not "gone" either).
  if (evidence === "none") return { open: false, reason: record?.installState === "conflict" ? "unconfirmed" : "gone" };
  if (evidence !== "confirmed") return { open: false, reason: evidence };
  const instance = facts.ghosts.find((ghost) => marketItemMatchesPlugin(item, ghost)
    && (operation.entry !== "update" || ghost.instanceKey === operation.who.instanceKey));
  return instance ? { open: true, instanceKey: instance.instanceKey } : { open: false, reason: "gone" };
}
