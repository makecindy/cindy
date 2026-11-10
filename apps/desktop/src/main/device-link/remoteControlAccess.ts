/**
 * Process-local permission generation for the local "allow remote control" switch.
 *
 * A transition of the switch ends every routing context retained under the
 * previous permission. This generation is deliberately in-memory: a process
 * restart already drops all prepared contexts, and a persisted generation would
 * outlive the memory it is meant to fence.
 */
import { readDeviceLinkSettings } from './settings-store.desktop.js';
import { createRemoteControlAccess } from "./remoteControlAccessCore.js";
export type * from "./remoteControlAccessCore.js";
export const { remoteControlAccessGeneration, syncRemoteControlAccessGeneration, deviceAccessGeneration, isControllerAccessAllowed, bumpDeviceAccessGeneration, noteControllerAccessDenied, noteControllerAccessAllowed, onRemoteControlAccessChanged } = createRemoteControlAccess({
readDeviceLinkSettings,
});
