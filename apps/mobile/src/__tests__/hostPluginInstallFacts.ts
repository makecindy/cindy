/**
 * What a computer (Host) actually answers about an installed plugin after a phone's install or update, per situation
 * (dispatcher R-3, contract V2.10). Tests use these shapes instead of convenient values the Host never sends.
 *
 * - `CONTRACT_SAMPLES`: the three `management:market-detail` results of contract V2.10 (catalog at 2.1.0, the computer
 *   on 2.0.0), copied byte for byte from the contract text; the Host asserts the same bytes
 *   (service-custom-sources.test.ts "produces the contract samples byte for byte"). ① this phone's install, ② after the
 *   computer or another controller installed it again, ③ an older computer.
 * - `hostInstallFacts`: the same rules applied to this test file's own items (the Host's catalog projection, service.ts
 *   ~L3150-3165: `installState` from the installation record's release against the catalog's current one; `releaseId` /
 *   `version` always the catalog's; the attribution projection: `'self'` with the operation id only for the controller
 *   that ran that remote install while its binding holds, `'unattributed'` for every other `installed` /
 *   `update-available` record, neither field for `not-installed` / `conflict` or from an older computer).
 * - `secondShapes`: the five shapes contract V2.10 lists under ② (not proven).
 */
import type { ManagedMarketItem, ManagedPlugin } from "@/plugins/pluginManagementTypes";

export const CONTRACT_SAMPLES = {
  own: JSON.parse("{\"pluginId\":\"custom:Acme%20Team%20Plugins/weather-chip\",\"ghostId\":\"weather-chip\",\"namespace\":null,\"releaseId\":\"custom:Acme%20Team%20Plugins:weather-chip:2.1.0\",\"version\":\"2.1.0\",\"installState\":\"update-available\",\"sourceType\":\"local-market\",\"installedOperationId\":\"3f9c2a7e-5b1d-4c8e-9a6f-0d2b7e4c1a58\",\"installedOperationAttribution\":\"self\"}"),
  unattributed: JSON.parse("{\"pluginId\":\"custom:Acme%20Team%20Plugins/weather-chip\",\"ghostId\":\"weather-chip\",\"namespace\":null,\"releaseId\":\"custom:Acme%20Team%20Plugins:weather-chip:2.1.0\",\"version\":\"2.1.0\",\"installState\":\"update-available\",\"sourceType\":\"local-market\",\"installedOperationAttribution\":\"unattributed\"}"),
  olderHost: JSON.parse("{\"pluginId\":\"custom:Acme%20Team%20Plugins/weather-chip\",\"ghostId\":\"weather-chip\",\"namespace\":null,\"releaseId\":\"custom:Acme%20Team%20Plugins:weather-chip:2.1.0\",\"version\":\"2.1.0\",\"installState\":\"update-available\",\"sourceType\":\"local-market\"}"),
} as const;
/** The operation id in sample ①. */
export const CONTRACT_SAMPLE_OPERATION_ID: string = CONTRACT_SAMPLES.own.installedOperationId;

export type HostInstallSituation =
  | "own" | "localReinstall" | "otherControllerReinstall" | "otherControllerUpdate" | "uninstalled"
  | "catalogAdvanced" | "bindingLost" | "olderHost";
export const HOST_INSTALL_SITUATIONS: readonly HostInstallSituation[] = ["own", "localReinstall", "otherControllerReinstall",
  "otherControllerUpdate", "uninstalled", "catalogAdvanced", "bindingLost", "olderHost"];

/**
 * The facts after this phone's operation `operationId` installed `target` (a catalog item at the target release) as
 * `instance` (the installed ghost), then `situation` happened. `next`: the catalog's following release.
 */
export function hostInstallFacts<I extends ManagedMarketItem, G extends ManagedPlugin>(situation: HostInstallSituation,
  { operationId, target, instance, next }: { operationId: string; target: I; instance: G; next: { releaseId: string; version: string } }):
  { ghosts: G[]; record: I } {
  const at = (version: string): G => ({ ...instance, manifest: { ...instance.manifest, version } });
  const record = (fields: Partial<ManagedMarketItem>): I => {
    const { installedOperationId: _id, installedOperationAttribution: _marker, ...rest } = target;
    return { ...rest, ...fields } as I;
  };
  const own = { installedOperationId: operationId, installedOperationAttribution: "self" as const };
  const unattributed = { installedOperationAttribution: "unattributed" as const };
  switch (situation) {
    // This phone's install is still the one there.
    case "own": return { ghosts: [at(target.version)], record: record({ installState: "installed", ...own }) };
    // The computer (or a background update) or another controller installed the same release again, or the binding was
    // lost (key rotated, package digest changed): the computer cannot attribute it to this phone.
    case "localReinstall": case "otherControllerReinstall": case "bindingLost":
      return { ghosts: [at(target.version)], record: record({ installState: "installed", ...unattributed }) };
    // An older computer (no V2.10, no V2.9): neither field.
    case "olderHost": return { ghosts: [at(target.version)], record: record({ installState: "installed" }) };
    // Another controller updated it to the catalog's next release (the catalog moved there too).
    case "otherControllerUpdate":
      return { ghosts: [at(next.version)], record: record({ ...next, installState: "installed", ...unattributed }) };
    case "uninstalled": return { ghosts: [], record: record({ installState: "not-installed", enabled: null }) };
    // Only the catalog published its next release; this phone's install is untouched (contract sample ①).
    case "catalogAdvanced":
      return { ghosts: [at(target.version)], record: record({ ...next, installState: "update-available", ...own }) };
  }
}

/** The shapes contract V2.10 lists under ② (not proven), as the computer could send them for `operationId`. */
export function secondShapes(operationId: string): Array<[string, Record<string, unknown>]> {
  return [
    ["'unattributed'", { installedOperationAttribution: "unattributed" }],
    ["'self' with another operation id", { installedOperationAttribution: "self", installedOperationId: "4b1d2c3e-0000-4000-8000-000000000002" }],
    ["an unknown value", { installedOperationAttribution: "someone-else" }],
    ["'self' without an id", { installedOperationAttribution: "self" }],
    ["'self' with an id of another shape", { installedOperationAttribution: "self", installedOperationId: "bad id!" }],
    ["an id without a marker", { installedOperationId: operationId }],
  ];
}
