/**
 * What a computer (Host) actually answers about an installed plugin after a phone's install or update, per situation
 * (dispatcher R-3). Tests use these shapes instead of convenient values the Host never sends.
 *
 * Derived from the Host's own projection and its tests, at the front PR's head merged here:
 * - catalog / detail `installState` (apps/desktop/src/main/plugin-market/service.ts, custom markets ~L3150-3165, server
 *   market alike): `installed` when the installation record's release equals the catalog's current release,
 *   `update-available` when the record is on this route but an older release, `not-installed` without an install;
 *   `releaseId` / `version` are always the catalog's current release, never the installed one (no installed-release
 *   field exists on the item);
 * - `installedOperationId` (service.ts `withInstalledOperationIds` ~L3685-3732, contract V2.9): added only for the
 *   controller that ran that remote install, only for `installed` / `update-available`, only while the record's binding
 *   (operation id, controller tag, key id, package digest) matches the package on disk; any other install (computer's
 *   own, another controller's, background update) rewrites the record: the field is then absent for this phone. An
 *   older computer never sends it. Asserted by service-custom-sources.test.ts "records which remote operation installed a
 *   custom-market plugin and shows it only to that controller" (phone-a sees `op-…1`, desktop-b sees nothing; after
 *   desktop-b's update phone-a sees nothing; after a local update nobody does) and "records the remote operation for a
 *   server-market install as well";
 * - installed snapshot `ghosts[i].manifest` is the installed package (its version is the installed version).
 *
 * Situations that look the same on the wire today (V2.9): `localReinstall`, `otherControllerReinstall`, `bindingLost`,
 * `olderHost`. Contract V2.10 (front PR) will tell them apart; its sample responses join here then.
 */
import type { ManagedMarketItem, ManagedPlugin } from "@/plugins/pluginManagementTypes";

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
    const { installedOperationId: _dropped, ...rest } = target;
    return { ...rest, ...fields } as I;
  };
  switch (situation) {
    // This phone's install is still the one there.
    case "own": return { ghosts: [at(target.version)], record: record({ installState: "installed", installedOperationId: operationId }) };
    // The computer (or a background update) or another controller installed the same release again: the record is
    // rewritten, its evidence is not this phone's; a lost binding (key rotated, package digest changed) and an older
    // computer look the same.
    case "localReinstall": case "otherControllerReinstall": case "bindingLost": case "olderHost":
      return { ghosts: [at(target.version)], record: record({ installState: "installed" }) };
    // Another controller updated it to the catalog's next release (the catalog moved there too).
    case "otherControllerUpdate":
      return { ghosts: [at(next.version)], record: record({ ...next, installState: "installed" }) };
    case "uninstalled": return { ghosts: [], record: record({ installState: "not-installed", enabled: null }) };
    // Only the catalog published its next release; this phone's install is untouched.
    case "catalogAdvanced":
      return { ghosts: [at(target.version)], record: record({ ...next, installState: "update-available", installedOperationId: operationId }) };
  }
}
