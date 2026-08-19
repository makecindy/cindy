import { afterEach, describe, expect, it } from 'vitest';

import {
  disposeInputDevices,
  listInputDevices,
  playInputDeviceWindowReveal,
  registerInputDevice,
  resumeInputDeviceTaskSlots,
  startInputDevices,
  suspendInputDeviceTaskSlots,
  updateInputDeviceSessionActivity,
  type InputDeviceHost,
} from '../registry.js';

function createHost(id: string, calls: string[]): InputDeviceHost {
  return {
    descriptor: {
      id,
      label: id,
      capabilities: [{ kind: 'commands' }],
    },
    start: () => {
      calls.push(`${id}:start`);
    },
    updateSessionActivity: () => {
      calls.push(`${id}:activity`);
    },
    playWindowReveal: () => {
      calls.push(`${id}:reveal`);
    },
    resumeTaskSlots: async () => {
      calls.push(`${id}:resume`);
    },
    suspendTaskSlots: () => {
      calls.push(`${id}:suspend`);
    },
    dispose: async () => {
      calls.push(`${id}:dispose`);
    },
  };
}

describe('input device registry', () => {
  afterEach(async () => {
    await disposeInputDevices();
  });

  it('fans host lifecycle out to every registered adapter', async () => {
    const calls: string[] = [];
    registerInputDevice(createHost('one', calls));
    registerInputDevice(createHost('two', calls));

    expect(listInputDevices().map((device) => device.id)).toEqual(['one', 'two']);

    startInputDevices();
    updateInputDeviceSessionActivity([]);
    playInputDeviceWindowReveal();
    await resumeInputDeviceTaskSlots();
    suspendInputDeviceTaskSlots();
    await disposeInputDevices();

    expect(calls).toEqual([
      'one:start',
      'two:start',
      'one:activity',
      'two:activity',
      'one:reveal',
      'two:reveal',
      'one:resume',
      'two:resume',
      'one:suspend',
      'two:suspend',
      'one:dispose',
      'two:dispose',
    ]);
  });
});
