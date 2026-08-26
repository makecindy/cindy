import { describe, expect, it } from 'vitest';

import {
  INPUT_DEVICE_COMMAND_IDS,
  inputDeviceHasCapability,
  isInputDeviceCommandId,
} from '../inputDevices';
import {
  WORKLOUDER_CODEX_COMMAND_IDS,
  WORKLOUDER_CODEX_DEVICE,
} from '../workLouderCodex';

describe('input device contract', () => {
  it('keeps Codex Micro commands on the shared action list', () => {
    expect(WORKLOUDER_CODEX_COMMAND_IDS).toBe(INPUT_DEVICE_COMMAND_IDS);
    expect(isInputDeviceCommandId('forkTask')).toBe(true);
    expect(isInputDeviceCommandId('not-a-command')).toBe(false);
  });

  it('describes Codex Micro as one adapter with its own capabilities', () => {
    expect(WORKLOUDER_CODEX_DEVICE.id).toBe('worklouder-codex-micro');
    expect(inputDeviceHasCapability(WORKLOUDER_CODEX_DEVICE, 'task-slots')).toBe(true);
    expect(inputDeviceHasCapability(WORKLOUDER_CODEX_DEVICE, 'voice')).toBe(true);
    expect(inputDeviceHasCapability(WORKLOUDER_CODEX_DEVICE, 'lighting')).toBe(true);
  });
});
