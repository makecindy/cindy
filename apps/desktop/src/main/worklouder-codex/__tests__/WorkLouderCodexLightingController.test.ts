import { describe, expect, it, vi } from 'vitest';

import {
  createWorkLouderCodexDefaultSettings,
  type WorkLouderCodexSettings,
} from '../../../shared/workLouderCodex.js';
import { WorkLouderCodexLightingController } from '../WorkLouderCodexLightingController.js';
import { isWorkLouderCodexLightingFrameOff } from '../protocol.js';

function settings(patch: Partial<WorkLouderCodexSettings>): WorkLouderCodexSettings {
  return { ...createWorkLouderCodexDefaultSettings(), ...patch };
}

describe('WorkLouderCodexLightingController', () => {
  it('deduplicates activity updates that produce the same lighting frame', () => {
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn());
    const snapshot = [
      {
        sessionId: 'session-1',
        phase: 'running' as const,
        compactDetail: 'first detail',
        attention: false,
      },
    ];

    controller.updateSessionActivity(snapshot);
    controller.updateSessionActivity([{ ...snapshot[0], compactDetail: 'new detail' }]);

    expect(sink.update).toHaveBeenCalledTimes(1);
  });

  it('activates the task assigned to the pressed Agent key', async () => {
    const keyHandlerRef: { current: ((slot: number) => void) | null } = { current: null };
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn((handler: ((slot: number) => void) | null) => {
        keyHandlerRef.current = handler;
      }),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const activateSession = vi.fn();
    const controller = new WorkLouderCodexLightingController(sink, activateSession, async () => [
      'running-session',
      'waiting-session',
    ]);
    await controller.resumeTaskSlots();

    controller.updateSessionActivity([
      {
        sessionId: 'running-session',
        phase: 'running',
        compactDetail: '',
        attention: false,
      },
      {
        sessionId: 'acknowledged-session',
        phase: 'completed',
        compactDetail: '',
        attention: false,
      },
      {
        sessionId: 'waiting-session',
        phase: 'needs-interaction',
        compactDetail: '',
        attention: false,
      },
    ]);
    keyHandlerRef.current?.(1);

    expect(activateSession).toHaveBeenCalledWith('waiting-session', false);
  });

  it('uses the published assignment for the current press and refreshes only later presses', async () => {
    let resolveRefresh: ((value: readonly string[]) => void) | undefined;
    const keyHandlerRef: { current: ((slot: number) => void) | null } = { current: null };
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn((handler: ((slot: number) => void) | null) => {
        keyHandlerRef.current = handler;
      }),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const activateSession = vi.fn();
    const loadSlotSessionIds = vi
      .fn<() => Promise<readonly string[]>>()
      .mockResolvedValueOnce(['first'])
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRefresh = resolve)))
      .mockResolvedValue(['second']);
    const controller = new WorkLouderCodexLightingController(
      sink,
      activateSession,
      loadSlotSessionIds,
    );
    const running = (sessionId: string) => ({
      sessionId,
      phase: 'running' as const,
      compactDetail: '',
      attention: false,
    });

    controller.updateSessionActivity([running('first')]);
    await controller.resumeTaskSlots();
    sink.update.mockClear();
    keyHandlerRef.current?.(0);

    expect(activateSession).toHaveBeenCalledWith('first', false);
    expect(loadSlotSessionIds).toHaveBeenCalledTimes(2);
    resolveRefresh?.(['second']);
    await vi.waitFor(() => expect(sink.update).toHaveBeenCalledTimes(1));
    keyHandlerRef.current?.(0);
    expect(activateSession).toHaveBeenLastCalledWith('second', true);
    expect(loadSlotSessionIds).toHaveBeenCalledTimes(3);
  });

  it('ignores keys and stale refreshes while task slots are suspended', async () => {
    let resolveSlots: ((value: readonly string[]) => void) | undefined;
    const keyHandlerRef: { current: ((slot: number) => void) | null } = { current: null };
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn((handler: ((slot: number) => void) | null) => {
        keyHandlerRef.current = handler;
      }),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const activateSession = vi.fn();
    const controller = new WorkLouderCodexLightingController(
      sink,
      activateSession,
      () => new Promise((resolve) => (resolveSlots = resolve)),
    );

    const resume = controller.resumeTaskSlots();
    controller.suspendTaskSlots();
    sink.update.mockClear();
    keyHandlerRef.current?.(0);
    resolveSlots?.(['old-owner-task']);
    await resume;

    expect(sink.update).not.toHaveBeenCalled();
    expect(activateSession).not.toHaveBeenCalled();
  });

  it('scales every lighting zone with the configured overall brightness', async () => {
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn(), async () => [
      'running-session',
    ]);
    controller.applySettings(
      settings({
        lightingBrightness: 50,
        lightingAutoDim: 'off',
        singleTapAgentKeys: true,
      }),
    );
    await controller.resumeTaskSlots();
    sink.update.mockClear();

    controller.updateSessionActivity([
      {
        sessionId: 'running-session',
        phase: 'running',
        compactDetail: '',
        attention: false,
      },
    ]);

    expect(sink.update).toHaveBeenCalledOnce();
    const frame = sink.update.mock.calls[0]?.[0];
    expect(frame?.ambient.brightness).toBe(0.35);
    expect(frame?.keys.brightness).toBe(0.08);
    expect(frame?.threads[0]?.brightness).toBe(0.4);
  });

  it('auto-dims after inactivity and wakes on the next device event', async () => {
    vi.useFakeTimers();
    try {
      const activityHandlerRef: { current: (() => void) | null } = { current: null };
      const sink = {
        update: vi.fn(),
        setAgentKeyPressHandler: vi.fn(),
        setDeviceActivityHandler: vi.fn((handler: (() => void) | null) => {
          activityHandlerRef.current = handler;
        }),
        setConnectionStatusHandler: vi.fn(),
        dispose: vi.fn(async () => undefined),
      };
      const controller = new WorkLouderCodexLightingController(sink, vi.fn(), async () => [
        'running-session',
      ]);
      controller.applySettings(
        settings({
          lightingBrightness: 100,
          lightingAutoDim: '30-seconds',
          singleTapAgentKeys: true,
        }),
      );
      await controller.resumeTaskSlots();
      controller.updateSessionActivity([
        {
          sessionId: 'running-session',
          phase: 'running',
          compactDetail: '',
          attention: false,
        },
      ]);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(isWorkLouderCodexLightingFrameOff(sink.update.mock.lastCall?.[0])).toBe(true);

      activityHandlerRef.current?.();
      expect(isWorkLouderCodexLightingFrameOff(sink.update.mock.lastCall?.[0])).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches tasks in the background first and focuses Cindy on the second tap', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const keyHandlerRef: { current: ((slot: number) => void) | null } = { current: null };
      const sink = {
        update: vi.fn(),
        setAgentKeyPressHandler: vi.fn((handler: ((slot: number) => void) | null) => {
          keyHandlerRef.current = handler;
        }),
        setDeviceActivityHandler: vi.fn(),
        setConnectionStatusHandler: vi.fn(),
        dispose: vi.fn(async () => undefined),
      };
      const activateSession = vi.fn();
      const controller = new WorkLouderCodexLightingController(sink, activateSession, async () => [
        'first',
        'second',
      ]);
      controller.applySettings(
        settings({
          lightingBrightness: 100,
          lightingAutoDim: 'off',
          singleTapAgentKeys: false,
        }),
      );
      await controller.resumeTaskSlots();

      keyHandlerRef.current?.(0);
      expect(activateSession).toHaveBeenLastCalledWith('first', false);
      vi.setSystemTime(1_350);
      keyHandlerRef.current?.(0);
      expect(activateSession).toHaveBeenLastCalledWith('first', true);

      vi.setSystemTime(2_000);
      keyHandlerRef.current?.(0);
      vi.setSystemTime(2_200);
      keyHandlerRef.current?.(1);
      expect(activateSession).toHaveBeenLastCalledWith('second', false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns the encoder through the task list in its default mode', () => {
    const hidRef: { current: ((event: { key: string; act: number }) => void) | null } = {
      current: null,
    };
    const dispatch = vi.fn();
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      setHidInputHandler: vi.fn((handler: typeof hidRef.current) => {
        hidRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn(), undefined, dispatch);
    controller.start();

    // Clockwise is the same direction `custom` mode maps to `right`.
    hidRef.current?.({ key: 'ENC_CW', act: 2 });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'command',
      commandId: 'session.selectNext',
    });

    hidRef.current?.({ key: 'ENC_CC', act: 2 });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'command',
      commandId: 'session.selectPrevious',
    });
  });

  it('delegates shutdown so the host can turn the device off', async () => {
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn());

    await controller.dispose();

    expect(sink.setAgentKeyPressHandler).toHaveBeenLastCalledWith(null);
    expect(sink.setDeviceActivityHandler).toHaveBeenLastCalledWith(null);
    expect(sink.setConnectionStatusHandler).toHaveBeenLastCalledWith(null);
    expect(sink.dispose).toHaveBeenCalledOnce();
  });
});
