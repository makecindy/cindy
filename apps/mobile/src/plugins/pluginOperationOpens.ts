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
 * of it on the computer now; `unconfirmed`, an instance is there but the computer does not attribute it to this
 * operation (V2.10 ②: another install since, a conflict, or no record of it in a complete response); `legacy`, an older
 * computer gives no evidence (③: the person opens it from the installed list); `unread`, an instance is there but this
 * response says its own market part is incomplete and has no record of the plugin (the computer could not read its
 * catalog or a custom market then): nothing can be concluded from it, it has to be read again.
 */
export type PluginOperationNotOpened = "gone" | "unconfirmed" | "legacy" | "unread";
export type PluginOperationOpens = { open: true; instanceKey: string } | { open: false; reason: PluginOperationNotOpened };
/** What the list of checks and the installed detail say for each reason (plugins.json, 12 languages). */
export const PLUGIN_NOT_OPENED_TEXT: Record<PluginOperationNotOpened, string> = {
  gone: "plugins.checks.result.goneSince",
  unconfirmed: "plugins.checks.result.unconfirmed",
  legacy: "plugins.checks.result.legacyHost",
  unread: "plugins.checks.result.succeededUnread",
};
/** Whether a snapshot's market part says it is whole (the computer read its catalog and every custom market). */
export function pluginMarketFactsComplete(market: { unavailableReason: string | null; unavailableCustomSourceNames: readonly string[]; organizationAccessError?: string | null }): boolean {
  return !market.unavailableReason && market.unavailableCustomSourceNames.length === 0 && !market.organizationAccessError;
}
type MarketRecord = Pick<ManagedMarketItem, "pluginId" | "ghostId" | "namespace" | "installState" | "installedOperationId" | "installedOperationAttribution">;

/**
 * Whether a finished install, update or page approval offers "Open" for an instance, and which (dispatcher O-2, R-1,
 * R-2; contract V2.10). The one decision for every place that opens one after an operation: the list of checks (after
 * a final receipt, and after the receipt was gone), the market row that started an install, and the installed detail
 * after an update. It reads only the newest facts read from the computer: a success receipt is a past result and never
 * makes an instance openable, however recent. The caller has already fenced the account and the computer.
 * Install and update: the computer's record of this plugin (same market id; `pluginInstallEvidence`) is ① for this
 * operation and the attempt's instance (ghostId, namespace), and that instance is in the installed snapshot (an update:
 * the instance it started from). The instance is found by the record's own identity: record and instance come from the
 * same response, and the computer fills in the namespace of an install only once it is there (an item read before the
 * install can lack it). The record's catalog `releaseId` / `version` are not compared, nor versions at all: ① pins the
 * installed package. Without ①, an instance of the plugin being there only chooses the sentence, never an "Open".
 * Page approval: the instance it started from, its pages approved now.
 */
export function pluginOperationOpens(operation: FinishedPluginOperation, facts: {
  ghosts: readonly ManagedPlugin[];
  /** The market records read with those facts (the same snapshot's items); absent when not read. */
  market?: readonly MarketRecord[] | MarketRecord | null;
  /** False when that snapshot says its market part is incomplete (`pluginMarketFactsComplete`). */
  marketComplete?: boolean;
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
  const started = (ghost: ManagedPlugin) => operation.entry !== "update" || ghost.instanceKey === operation.who.instanceKey;
  if (evidence === "none") {
    // A conflict: a package of the same id from elsewhere is there (not this attempt's instance, but not "gone" either).
    if (record?.installState === "conflict") return { open: false, reason: "unconfirmed" };
    // No installed record of it. "Gone" only when no instance of the plugin is there either; one that is there cannot
    // be attributed (②), and when the response itself says its market part is incomplete it settles nothing.
    // (An instance of the same id in another known namespace is another plugin.)
    const there = (ghost: ManagedPlugin) => ghost.manifest.id === item.ghostId
      && (item.namespace === undefined || ghost.namespace === undefined || item.namespace === ghost.namespace);
    if (!facts.ghosts.some((ghost) => there(ghost) && started(ghost))) return { open: false, reason: "gone" };
    return { open: false, reason: !record && facts.marketComplete === false ? "unread" : "unconfirmed" };
  }
  if (evidence !== "confirmed") return { open: false, reason: evidence };
  const identity = record && record.namespace !== undefined ? record : item;
  const instance = facts.ghosts.find((ghost) => marketItemMatchesPlugin(identity, ghost) && started(ghost));
  return instance ? { open: true, instanceKey: instance.instanceKey } : { open: false, reason: "gone" };
}
