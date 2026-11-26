import type { ManagedMarketItem } from "./pluginManagementTypes";

/**
 * What the computer says about whose operation installed the plugin that is there now (dispatcher R-1), read in this one
 * place from a market record the computer returned with its installed facts (snapshot item or market detail):
 * - `own`: the record names this operation (contract V2.9 `installedOperationId`, given only to the controller that ran
 *   that install, only while that very package is installed: the computer checks the package digest bound to it).
 * - `not-own`: the computer says the plugin there now is not this operation's.
 * - `unavailable`: the record gives no evidence either way.
 *
 * Today the wire cannot say `not-own` when the plugin was installed by someone else: the computer leaves the field out
 * (computer's own install or update, another controller's, background update, a lost binding) exactly as an older
 * computer that never gives it. Only another id of this same phone is visible. Contract V2.10 (front PR #12731) adds the
 * markers; only this function changes then.
 */
export type PluginInstallEvidence = "own" | "not-own" | "unavailable";
export function pluginInstallEvidence(record: Pick<ManagedMarketItem, "installedOperationId"> | null | undefined,
  operationId: string): PluginInstallEvidence {
  const id = record?.installedOperationId;
  if (id === undefined) return "unavailable";
  return id === operationId ? "own" : "not-own";
}
