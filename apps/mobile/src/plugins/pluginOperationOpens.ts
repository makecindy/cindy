import { marketItemMatchesPlugin, type ManagedMarketItem, type ManagedPlugin } from "./pluginManagementTypes";
import type { PluginSlotEntry, PluginSlotHolder } from "./pluginManagementSlot";

/** A finished operation, as its pending check or its own view kept it. */
export interface FinishedPluginOperation {
  operationId: string;
  entry: PluginSlotEntry;
  /** Update, page approval: the instance it started from (its computer and account are the caller's fence). */
  who: Pick<PluginSlotHolder, "instanceKey">;
  /** Install and update: the market release it was for. */
  detail?: Pick<ManagedMarketItem, "pluginId" | "ghostId" | "namespace" | "releaseId" | "version">;
}

/**
 * Whether a finished install, update or page approval offers "Open" for an instance, and which (dispatcher O-2). The one
 * decision for every place that opens one after an operation: the list of checks (after a final receipt, and after the
 * receipt was gone), the market row that started an install, and the installed detail after an update. The caller has
 * already fenced the account and the computer (the facts were read for this account from `who.deviceId`). All of:
 * - the instance: an install, the market plugin it installed (its id and namespace; an instance of the same name in
 *   another namespace is not it); an update or a page approval, the instance it started from (same instance key);
 * - the version: the instance's version is the release's (install, update), its pages approved (page approval);
 * - the Host's evidence: the market item names this operation (`installedOperationId`, contract V2.9; another id means
 *   another operation installed what is there now), or, while it names none, this operation's own final receipt.
 * Otherwise the success stands, nothing is opened, and the list says the plugin changed on the computer since.
 */
export type PluginOperationOpens = { open: true; instanceKey: string } | { open: false };
export function pluginOperationOpens(operation: FinishedPluginOperation, facts: {
  ghosts: readonly ManagedPlugin[];
  /** The market's record of this plugin read with the facts (snapshot item or market detail); absent when not read. */
  market?: Pick<ManagedMarketItem, "pluginId" | "releaseId" | "installState" | "installedOperationId"> | null;
  /** `final`: this operation's final receipt said it succeeded; `gone`: the computer no longer has its receipt. */
  receipt: "final" | "gone";
}): PluginOperationOpens {
  const no = { open: false } as const;
  if (operation.entry === "page-approval") {
    const instance = facts.ghosts.find((ghost) => ghost.instanceKey === operation.who.instanceKey);
    return instance && instance.uiCapabilityApproved === true && facts.receipt === "final"
      ? { open: true, instanceKey: instance.instanceKey } : no;
  }
  if (operation.entry !== "market-install" && operation.entry !== "update") return no;
  const item = operation.detail;
  if (!item) return no;
  const instance = facts.ghosts.find((ghost) => marketItemMatchesPlugin(item, ghost)
    && (operation.entry !== "update" || ghost.instanceKey === operation.who.instanceKey));
  if (!instance || instance.manifest.version !== item.version) return no;
  const market = facts.market && facts.market.pluginId === item.pluginId ? facts.market : null;
  if (market && (market.installState !== "installed" || market.releaseId !== item.releaseId)) return no;
  const evidence = market?.installedOperationId;
  if (evidence !== undefined ? evidence !== operation.operationId : facts.receipt !== "final") return no;
  return { open: true, instanceKey: instance.instanceKey };
}
