import type { ManagedMarketItem } from "./pluginManagementTypes";

/**
 * Whose install the computer says is there now, read in this one place from a market record it returned (snapshot
 * item or market detail), by contract V2.10 (front PR #12731; it replaces V2.9's controller rule):
 * - `confirmed` (①): `installed` / `update-available`, attributed `'self'` with this operation's id, and (when the
 *   attempt knows its instance) the same ghostId and namespace. The computer then guarantees the installed record is the
 *   one this operation committed and nothing installed another package since; no version comparison is needed.
 * - `unconfirmed` (②): `installed` / `update-available` with a marker that is not ①: `'unattributed'` (the computer,
 *   another controller, a lost binding or key), `'self'` with another id or none usable, any other value, an id without a
 *   marker (the parser reads those last two as `'unknown'`).
 * - `legacy` (③): `installed` / `update-available` with neither field: an older computer that gives no evidence.
 * - `none`: no record of the plugin, or `not-installed` / `conflict`: no instance of this attempt there now.
 * The record's `releaseId` / `version` are the catalog's current release and are never compared (V2.10).
 */
export type PluginInstallEvidence = "confirmed" | "unconfirmed" | "legacy" | "none";
export function pluginInstallEvidence(
  record: Pick<ManagedMarketItem, "installState" | "installedOperationId" | "installedOperationAttribution" | "ghostId" | "namespace"> | null | undefined,
  attempt: { operationId: string; ghostId?: string; namespace?: string | null },
): PluginInstallEvidence {
  if (!record || (record.installState !== "installed" && record.installState !== "update-available")) return "none";
  const marker = record.installedOperationAttribution;
  if (marker === undefined && record.installedOperationId === undefined) return "legacy";
  const sameInstance = attempt.ghostId === undefined
    || (record.ghostId === attempt.ghostId && (record.namespace ?? null) === (attempt.namespace ?? null));
  return marker === "self" && record.installedOperationId === attempt.operationId && sameInstance ? "confirmed" : "unconfirmed";
}
