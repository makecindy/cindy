import { registerWorkLouderCodexInputDevice } from '../worklouder-codex/index.js';
import { registerXboxGamepadInputDevice } from '../xbox-gamepad/index.js';

let started = false;

/** Register first-party adapters. Each adapter owns its HID, lights, and settings. */
export function registerBuiltInInputDevices(): void {
  registerWorkLouderCodexInputDevice();
  registerXboxGamepadInputDevice();
}

export function startInputDeviceRuntime(): void {
  if (started) return;
  started = true;
  registerBuiltInInputDevices();
}

export {
  disposeInputDevices,
  listInputDevices,
  playInputDeviceWindowReveal,
  resumeInputDeviceTaskSlots,
  startInputDevices,
  suspendInputDeviceTaskSlots,
  updateInputDeviceSessionActivity,
} from './registry.js';
