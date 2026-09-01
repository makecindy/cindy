import type { GamepadFamily } from '../../shared/xboxGamepad.js';

/** Switch 2 USB claim is wanted iff Nintendo hardware is allowed to run right now. */
export function computeSwitch2UsbWanted(input: {
  taskSlotsSuspended: boolean;
  nintendoDeviceEnabled: boolean;
  previewFamily: GamepadFamily | null;
}): boolean {
  if (input.taskSlotsSuspended) return false;
  return input.nintendoDeviceEnabled || input.previewFamily === 'nintendo';
}
