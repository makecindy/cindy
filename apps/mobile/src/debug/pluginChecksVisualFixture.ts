import { createPluginManagementClient, type PluginManagementInvoke } from "@/plugins/pluginManagementClient";
import { createPluginManagementController } from "@/plugins/pluginManagementController";
import { pluginManagementSlotFor, pluginOperationHold } from "@/plugins/pluginManagementSlot";
import { __adoptPendingCheckForVisualMock } from "@/plugins/usePluginManagement";
import { REMOTE_RESOURCE_INVOKE_CHANNEL, REMOTE_RESOURCE_MANIFEST_CHANNEL } from "@cindy/device-link";
import { pluginMarketVisualHoldsInstalledReads, pluginMarketVisualManagement, resetPluginMarketVisualComputer,
  scriptVisualCheckOperation, withPluginManagementManifest, type VisualCheckBehavior } from "@/debug/pluginMarketVisualFixture";
import type { PluginSlotEntry } from "@/plugins/pluginManagementSlot";

/**
 * DEV visual mock only: `cindy://plugins?checks=<state>` opens the plugins page with the list of pending checks already
 * in one state (docs/dev-rules/ui-mock-data.md), without timing or taps: real controllers begin real operations on the
 * mock computer (scripted per operation id), become pending checks no view shows, and the page opens their list.
 */
export type VisualCheckState = "running" | "waiting" | "offline" | "awaitingYou" | "succeeded" | "unread" | "failed" | "untracked" | "many"
  | "readingBack" | "changed" | "uninstalled" | "decideBlocked" | "unprovableUninstall" | "updateGone";
export const VISUAL_CHECK_STATES: VisualCheckState[] = ["running", "waiting", "offline", "awaitingYou", "succeeded", "unread", "failed", "untracked", "many",
  "readingBack", "changed", "uninstalled", "decideBlocked", "unprovableUninstall", "updateGone"];
/** A computer that is not in the account's list: its pending check shows as offline. */
const AWAY_DEVICE = { deviceId: "cindy-visual-mock-away", deviceName: "CINDY Away Mock Mac" };
/** The online mock computer (visualMock's VISUAL_MOCK_DEVICE_ID; not imported, so this module stays out of its imports). */
const MAC = { deviceId: "cindy-visual-mock-mac", deviceName: "CINDY Mock Mac" };
let seeded = 0;
/** The mock computer, reached directly (same order as DeviceLinkContext.invoke: check, write receipt, answer). */
const invoke: PluginManagementInvoke = async (_deviceId, channel, args = [], options) => {
  options?.preSend?.();
  options?.onRequestWritten?.();
  if (channel === REMOTE_RESOURCE_MANIFEST_CHANNEL) return withPluginManagementManifest({ collections: [] }) as never;
  const request = args[0] as { actionId?: string; input?: Record<string, unknown>; resourceRef?: { id?: string } } | undefined;
  // `readingBack`: the computer's installed reads stay out (the list shows that it is still reading).
  if (request?.actionId === "management:snapshot" && request.input?.read === "installed" && pluginMarketVisualHoldsInstalledReads())
    return new Promise<never>(() => {});
  const value = channel === REMOTE_RESOURCE_INVOKE_CHANNEL
    ? pluginMarketVisualManagement(request?.actionId, request?.input, request?.resourceRef?.id) : undefined;
  if (value === undefined) throw new Error("[UNSUPPORTED] visual mock");
  return value as never;
};
/** `entry`: a market install (default), an update of the installed instance, or its uninstall. */
async function seedOne(plugin: { id: string; name: string }, behavior: VisualCheckBehavior, target = MAC,
  entry: Extract<PluginSlotEntry, "market-install" | "update" | "uninstall"> = "market-install") {
  const n = ++seeded;
  const operationId = `visual-check-${n}`;
  scriptVisualCheckOperation(operationId, behavior);
  const client = createPluginManagementClient({ invoke, deviceId: target.deviceId });
  const controller = createPluginManagementController(client, { snapshotRead: "installed", createOperationId: () => operationId });
  await controller.refresh();
  const detail = await client.detail(`demo-market/${plugin.id}`);
  const instance = entry === "market-install" ? undefined : controller.getState().snapshot?.ghosts.find((ghost) => ghost.manifest.id === plugin.id);
  if (entry !== "market-install" && !instance) return undefined;
  const slot = pluginManagementSlotFor();
  const token = slot.tryAcquire(entry, { name: plugin.name, deviceId: target.deviceId, deviceName: target.deviceName,
    pluginId: detail.pluginId, ghostId: detail.ghostId, ...(instance ? { instanceKey: instance.instanceKey } : {}) });
  if (!token) return undefined;
  // Kept once its operation is under way (an idle controller would be let go at once, as any view's).
  const hold = pluginOperationHold(slot, token);
  const started = entry === "uninstall" ? controller.uninstall(instance!, hold) : controller.install(detail, instance, hold);
  __adoptPendingCheckForVisualMock(controller, invoke, `visual-check:${n}`);
  await started;
  // Scripted operations answer their first lookup with a protocol error: take it now, so the check is already waiting.
  if (behavior !== "running") await controller.reconcile();
  return controller;
}
const AGENDA = { id: "demo-agenda", name: "Demo Agenda" };
const SIMULATOR = { id: "demo-device-simulator", name: "Demo Device Simulator" };
/** Installed on the mock computer at an older version, with an update. */
const READING = { id: "demo-reading-list", name: "Demo Reading List" };
const WEATHER = { id: "demo-weather-board", name: "Demo Weather Board" };
/**
 * Seeds the state; `after` runs once the list is open (the transitions it must show happen in front of it): a check
 * that finds the consent, the success, the failure, or "Stop tracking".
 */
export async function seedPluginChecksForVisualMock(state: string): Promise<(() => void) | undefined> {
  if (!VISUAL_CHECK_STATES.includes(state as VisualCheckState)) return undefined;
  // Every seed starts from the mock computer's first state (its installed plugins, no operations).
  resetPluginMarketVisualComputer();
  const one = (behavior: VisualCheckBehavior, target = MAC) => seedOne(AGENDA, behavior, target);
  switch (state as VisualCheckState) {
    // An uninstall that succeeds once looked up: "Uninstalled".
    case "uninstalled": { const c = await seedOne(WEATHER, "succeeded", MAC, "uninstall"); return () => { void c?.reconcile(); }; }
    // An uninstall whose receipt the computer forgot: cannot be confirmed (the plugin is still there), "Stop tracking" only.
    case "unprovableUninstall": { const c = await seedOne(WEATHER, "gone", MAC, "uninstall"); return () => { void c?.reconcile(); }; }
    // An update that took effect and whose receipt expired: verified from the computer's record of it ("Installed", Open).
    case "updateGone": { const c = await seedOne(READING, "gone", MAC, "update"); return () => { void c?.reconcile(); }; }
    // A consent waiting for this phone while another operation holds the computer: "View and decide" says it must wait.
    case "decideBlocked": {
      // The consent's check waits first (it lets go of the computer's slot), the other operation then takes the slot, and
      // only then does the check find the consent: it cannot take the slot back.
      const c = await one("consent");
      await seedOne(SIMULATOR, "running");
      await c?.reconcile();
      return () => {};
    }
    case "running": await one("running"); return () => {};
    case "waiting": await one("waiting"); return () => {};
    case "offline": await one("running", AWAY_DEVICE); return () => {};
    // The waiting one first: it lets go of the computer's slot, so the second operation may begin beside it.
    case "many": await one("waiting"); await seedOne(SIMULATOR, "running"); return () => {};
    case "untracked": { const c = await one("waiting"); return () => { c?.untrack(); }; }
    default: {
      const behavior: Record<string, VisualCheckBehavior> = { awaitingYou: "consent", succeeded: "succeeded", unread: "unread", failed: "failed",
        readingBack: "readingBack", changed: "changed" };
      const c = await one(behavior[state]);
      return () => { void c?.reconcile(); };
    }
  }
}
