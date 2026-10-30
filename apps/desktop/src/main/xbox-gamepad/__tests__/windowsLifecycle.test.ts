import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createXboxGamepadDefaultSettings } from '../../../shared/xboxGamepad.js';
import { XboxGamepadController } from '../controller.js';
import { createXboxGamepadHost } from '../host.js';
import fixture from './fixtures/windowsLifecycle.json';

vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

interface Step {
  messages: unknown[];
  repeat?: number;
  expect: {
    present: boolean;
    name: string | null;
    voiceHeld: boolean;
    scrollHeld: boolean;
    releases: number;
  };
}

/** The Rust producer validates the same fixture against its real snapshot/message functions. */
describe('Windows snapshot → NDJSON host → controller lifecycle contract', () => {
  it.each(['disable', 'background', 'preview'] as const)(
    '%s releases held input once and blocks further dispatch',
    async (reason) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      let frontmost = true;
      const dispatch = vi.fn();
      const controller = new XboxGamepadController({ isCindyFrontmost: () => frontmost, dispatch });
      const enabled = { ...createXboxGamepadDefaultSettings(), deviceEnabled: true };
      controller.applySettings('xbox', enabled);
      const spawnHelper = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
      const host = createXboxGamepadHost((message) => controller.handleHostMessage(message), {
        resolveHelperPath: async () => 'fixture-helper',
        spawnHelper,
      });
      const send = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
      try {
        host.start();
        await vi.waitFor(() => expect(spawnHelper).toHaveBeenCalledOnce());
        send({ kind: 'presence', family: 'xbox', present: true, name: 'Xbox Test' });
        send(fixture.frames.neutral);
        send(fixture.frames.held);
        expect(dispatch).toHaveBeenCalledWith({ type: 'voice', phase: 'press' });
        dispatch.mockClear();
        if (reason === 'disable')
          controller.applySettings('xbox', { ...enabled, deviceEnabled: false });
        if (reason === 'background') {
          frontmost = false;
          controller.setCindyFrontmost(false);
        }
        if (reason === 'preview') controller.setLayoutPreviewActive(true, 'xbox');
        send(fixture.frames.held);
        send(fixture.frames.neutral);
        expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
          { type: 'voice', phase: 'release' },
          { type: 'scroll-stop' },
        ]);
      } finally {
        host.stop();
      }
    },
  );
  for (const scenario of fixture.scenarios) {
    it(scenario.name, async () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      const held = { voice: false, scroll: false, releases: 0, scrollStops: 0 };
      const controller = new XboxGamepadController({
        isCindyFrontmost: () => true,
        dispatch: (action) => {
          if (action.type === 'voice') {
            held.voice = action.phase === 'press';
            if (action.phase === 'release') held.releases++;
          }
          if (action.type === 'scroll') held.scroll = true;
          if (action.type === 'scroll-stop') {
            held.scroll = false;
            held.scrollStops++;
          }
        },
      });
      controller.applySettings('xbox', {
        ...createXboxGamepadDefaultSettings(),
        deviceEnabled: true,
      });
      const spawnHelper = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
      const host = createXboxGamepadHost((message) => controller.handleHostMessage(message), {
        resolveHelperPath: async () => 'fixture-helper',
        spawnHelper,
      });
      try {
        host.start();
        await vi.waitFor(() => expect(spawnHelper).toHaveBeenCalledOnce());
        for (const step of scenario.steps as Step[]) {
          for (let repeat = 0; repeat < (step.repeat ?? 1); repeat++) {
            const messages = step.messages.map((message) =>
              typeof message === 'string'
                ? fixture.frames[message as keyof typeof fixture.frames]
                : message,
            );
            if (messages.length) {
              const bytes = Buffer.from(
                messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
              );
              // Fragment both JSON lines and UTF-8 device names through the actual stream decoder.
              for (let offset = 0; offset < bytes.length; offset += 7)
                child.stdout.write(bytes.subarray(offset, offset + 7));
            }
            const state = controller.getState('xbox');
            expect(state.devicePresent).toBe(step.expect.present);
            expect(state.deviceName).toBe(step.expect.name);
            expect(state.connectionStatus).toBe(step.expect.present ? 'connected' : 'not-detected');
            expect(held.voice).toBe(step.expect.voiceHeld);
            expect(held.scroll).toBe(step.expect.scrollHeld);
            expect(held.releases).toBe(step.expect.releases);
            expect(held.scrollStops).toBe(step.expect.releases);
          }
        }
      } finally {
        host.stop();
      }
    });
  }
});
