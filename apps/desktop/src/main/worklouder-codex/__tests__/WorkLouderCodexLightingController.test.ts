import { describe, expect, it, vi } from 'vitest';

import {
  createWorkLouderCodexDefaultSettings,
  type WorkLouderCodexSettings,
} from '../../../shared/workLouderCodex.js';
import { WorkLouderCodexLightingController } from '../WorkLouderCodexLightingController.js';
import { isWorkLouderCodexLightingFrameOff, WorkLouderLightingEffect } from '../protocol.js';

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

  it('lights a lead task key from a running Orca worker', async () => {
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(
      sink,
      vi.fn(),
      async () => ['lead-1'],
      vi.fn(),
      vi.fn(),
      async () => ({ 'lead-1': ['worker-1'] }),
    );
    await controller.resumeTaskSlots();
    sink.update.mockClear();

    controller.updateSessionActivity([
      {
        sessionId: 'worker-1',
        phase: 'running',
        compactDetail: '',
        attention: false,
      },
    ]);

    const frame = sink.update.mock.lastCall?.[0];
    expect(isWorkLouderCodexLightingFrameOff(frame)).toBe(false);
    expect(frame?.threads[0]?.brightness).toBeGreaterThan(0);
  });

  it('promotes an unslotted lead when only its worker is running', async () => {
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const catalog = [
      'idle-1',
      'idle-2',
      'idle-3',
      'idle-4',
      'idle-5',
      'idle-6',
      'lead-outside',
    ];
    const loadWorkerSessions = vi.fn(async (leadIds: readonly string[]) => {
      expect(leadIds).toContain('lead-outside');
      return { 'lead-outside': ['worker-1'] };
    });
    const controller = new WorkLouderCodexLightingController(
      sink,
      vi.fn(),
      async () => catalog,
      vi.fn(),
      vi.fn(),
      loadWorkerSessions,
    );
    controller.applySettings(settings({ agentSource: 'priority' }));
    await controller.resumeTaskSlots();

    controller.updateSessionActivity([
      {
        sessionId: 'worker-1',
        phase: 'running',
        compactDetail: '',
        attention: false,
      },
    ]);

    expect(controller.getState().agentSlots[0]?.action).toMatchObject({
      type: 'task',
      sessionId: 'lead-outside',
    });
    expect(sink.update.mock.lastCall?.[0]?.threads[0]?.brightness).toBeGreaterThan(0);
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

    expect(activateSession).toHaveBeenCalledWith('waiting-session', true);
  });

  it('maps last-sent keys by the last user message, not sidebar order', async () => {
    const hidRef: { current: ((event: { key: string; act: number }) => void) | null } = {
      current: null,
    };
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
    const activateSession = vi.fn();
    const controller = new WorkLouderCodexLightingController(sink, activateSession, async () => ({
      sidebar: [
        { id: 'older', title: 'Older send', pinned: false },
        { id: 'newer', title: 'Newer send', pinned: false },
      ],
      lastSent: [
        { id: 'newer', title: 'Newer send', pinned: false },
        { id: 'older', title: 'Older send', pinned: false },
      ],
      options: [
        { id: 'older', title: 'Older send', pinned: false },
        { id: 'newer', title: 'Newer send', pinned: false },
      ],
    }));
    controller.applySettings(settings({ agentSource: 'last-sent' }));
    await controller.resumeTaskSlots();

    hidRef.current?.({ key: 'AG00', act: 1 });

    expect(activateSession).toHaveBeenCalledWith('newer', true);
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

    expect(activateSession).toHaveBeenCalledWith('first', true);
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

  it('turns the encoder through the task list in its default mode', async () => {
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
    await controller.resumeTaskSlots();

    // The knob follows the sidebar list: turning right walks down it, turning
    // left walks up. ENC_CW is the clockwise/right direction, the same one
    // `custom` mode maps to `right`.
    hidRef.current?.({ key: 'ENC_CW', act: 2 });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'command',
      commandId: 'session.selectPrevious',
    });

    hidRef.current?.({ key: 'ENC_CC', act: 2 });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'command',
      commandId: 'session.selectNext',
    });
  });

  it('mirrors physical presses onto the settings preview without changing actions', async () => {
    const hidRef: { current: ((event: { key: string; act: number }) => void) | null } = {
      current: null,
    };
    const dispatch = vi.fn();
    const preview = vi.fn();
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
    const controller = new WorkLouderCodexLightingController(
      sink,
      vi.fn(),
      undefined,
      dispatch,
      preview,
    );
    controller.start();
    await controller.resumeTaskSlots();

    hidRef.current?.({ key: 'ACT06', act: 1 });
    hidRef.current?.({ key: 'ACT06', act: 0 });
    hidRef.current?.({ key: 'ENC_CW', act: 2 });
    hidRef.current?.({ key: 'ENC_CC', act: 2 });
    hidRef.current?.({ key: 'ENC', act: 1 });

    expect(preview).toHaveBeenCalledWith({ part: 'ACT06', pressed: true });
    expect(preview).toHaveBeenCalledWith({ part: 'ACT06', pressed: false });
    expect(preview).toHaveBeenCalledWith({ part: 'encoder', pressed: false, turn: 1 });
    expect(preview).toHaveBeenCalledWith({ part: 'encoder', pressed: false, turn: -1 });
    expect(preview).toHaveBeenCalledWith({ part: 'encoder', pressed: true });
    expect(dispatch).toHaveBeenCalled();
  });

  it('keeps physical presses on the preview while the layout editor is open', () => {
    const hidRef: { current: ((event: { key: string; act: number }) => void) | null } = {
      current: null,
    };
    const dispatch = vi.fn();
    const preview = vi.fn();
    const activateSession = vi.fn();
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
    const controller = new WorkLouderCodexLightingController(
      sink,
      activateSession,
      undefined,
      dispatch,
      preview,
    );
    controller.start();
    controller.setLayoutPreviewActive(true);

    hidRef.current?.({ key: 'AG00', act: 1 });
    hidRef.current?.({ key: 'ACT06', act: 1 });
    hidRef.current?.({ key: 'ENC_CW', act: 2 });

    expect(preview).toHaveBeenCalledWith({ part: 'AG00', pressed: true });
    expect(preview).toHaveBeenCalledWith({ part: 'ACT06', pressed: true });
    expect(preview).toHaveBeenCalledWith({ part: 'encoder', pressed: false, turn: 1 });
    expect(activateSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  describe('joystick scrolling', () => {
    function makeStick(preview = vi.fn()) {
      const stickRef: { current: ((event: { angle: number; distance: number }) => void) | null } = {
        current: null,
      };
      const dispatch = vi.fn();
      const sink = {
        update: vi.fn(),
        setAgentKeyPressHandler: vi.fn(),
        setDeviceActivityHandler: vi.fn(),
        setConnectionStatusHandler: vi.fn(),
        setHidInputHandler: vi.fn(),
        setJoystickInputHandler: vi.fn((handler: typeof stickRef.current) => {
          stickRef.current = handler;
        }),
        dispose: vi.fn(async () => undefined),
      };
      const controller = new WorkLouderCodexLightingController(
        sink,
        vi.fn(),
        undefined,
        dispatch,
        preview,
      );
      controller.start();
      return { stickRef, dispatch, controller, preview };
    }

    async function makeReadyStick() {
      const stick = makeStick();
      await stick.controller.resumeTaskSlots();
      return stick;
    }

    // Angles come from joystickDirection(): up is 0.625–0.875.
    const up = (distance: number) => ({ angle: 0.75, distance });
    const centre = { angle: 0.75, distance: 0 };

    it('keeps scrolling while the stick is held, carrying how hard it is pushed', async () => {
      const { stickRef, dispatch } = await makeReadyStick();

      stickRef.current?.(up(0.75));
      stickRef.current?.(up(1));

      // Both events scroll — the old code only fired as the stick crossed into
      // a direction, so holding it did nothing after the first report.
      const scrolls = dispatch.mock.calls.filter((call) => call[0].type === 'scroll');
      expect(scrolls).toHaveLength(2);
      expect(scrolls[0][0].direction).toBe('up');
      // Pushed further reads as more pressure.
      expect(scrolls[1][0].intensity).toBeGreaterThan(scrolls[0][0].intensity);
    });

    it('scrolls for the whole push and stops on release, as the hardware reports it', async () => {
      vi.useFakeTimers();
      try {
        const { stickRef, dispatch } = await makeReadyStick();

        // A real push, taken from device logs: it ramps in, sits silent while
        // held, eases off, then lands on zero when let go. The 0.24 lead-in is
        // below the activation point, so it correctly does not scroll.
        stickRef.current?.(up(0.24));
        stickRef.current?.(up(1));
        vi.advanceTimersByTime(2_190);
        stickRef.current?.(up(0.79));
        stickRef.current?.({ angle: 0, distance: 0 });

        const kinds = dispatch.mock.calls.map((call) => call[0].type);
        // Nothing during the silence, and no early stop before the release.
        expect(kinds).toEqual(['scroll', 'scroll', 'scroll-stop']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops when the stick returns to centre', async () => {
      const { stickRef, dispatch } = await makeReadyStick();

      stickRef.current?.(up(1));
      dispatch.mockClear();
      stickRef.current?.(centre);

      expect(dispatch).toHaveBeenCalledWith({ type: 'scroll-stop' });
    });

    it('keeps scrolling through the long silences a held stick produces', async () => {
      vi.useFakeTimers();
      try {
        const { stickRef, dispatch } = await makeReadyStick();

        stickRef.current?.(up(1));
        dispatch.mockClear();
        // Measured against the hardware: holding the stick still reports
        // nothing for seconds at a time. Treating that silence as a release is
        // exactly what made held-to-scroll stop after a moment.
        vi.advanceTimersByTime(3_000);

        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up if the device disappears mid-push', async () => {
      vi.useFakeTimers();
      try {
        const { stickRef, dispatch } = await makeReadyStick();

        stickRef.current?.(up(1));
        dispatch.mockClear();
        // Release has its own signal, so this only covers the device going
        // away while pushed — unplugged, asleep, or a dropped packet. Without
        // it the page would scroll forever.
        vi.advanceTimersByTime(30_000);

        expect(dispatch).toHaveBeenCalledWith({ type: 'scroll-stop' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves the sideways directions as one-shot actions', async () => {
      const { stickRef, dispatch } = await makeReadyStick();

      // Left is 0.375–0.625; it toggles a sidebar, which must not repeat.
      stickRef.current?.({ angle: 0.5, distance: 1 });
      stickRef.current?.({ angle: 0.5, distance: 1 });

      const commands = dispatch.mock.calls.filter((call) => call[0].type === 'command');
      expect(commands).toHaveLength(1);
      expect(commands[0][0].commandId).toBe('toggleSidebar');
      expect(dispatch.mock.calls.some((call) => call[0].type === 'scroll')).toBe(false);
    });

    it('mirrors the raw stick angle and distance onto the settings preview', () => {
      const { stickRef, dispatch, preview, controller } = makeStick();
      controller.setLayoutPreviewActive(true);

      stickRef.current?.({ angle: 0.75, distance: 0.8 });
      stickRef.current?.({ angle: 0.12, distance: 0.6 });
      stickRef.current?.({ angle: 0.75, distance: 0 });

      expect(preview).toHaveBeenNthCalledWith(1, {
        part: 'analog',
        pressed: true,
        angle: 0.75,
        distance: 0.8,
      });
      expect(preview).toHaveBeenNthCalledWith(2, {
        part: 'analog',
        pressed: true,
        angle: 0.12,
        distance: 0.6,
      });
      expect(preview).toHaveBeenNthCalledWith(3, {
        part: 'analog',
        pressed: false,
        angle: 0.75,
        distance: 0,
      });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it('flashes a greeting when the window comes back, then returns to status lighting', async () => {
    vi.useFakeTimers();
    try {
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
      controller.applySettings(settings({ lightingBrightness: 100, lightingAutoDim: 'off' }));
      await controller.resumeTaskSlots();
      controller.updateSessionActivity([
        {
          sessionId: 'running-session',
          phase: 'running',
          compactDetail: '',
          attention: false,
        },
      ]);
      sink.update.mockClear();

      controller.playWindowReveal();
      expect(sink.update.mock.lastCall?.[0]?.ambient.effect).toBe(WorkLouderLightingEffect.Snake);

      // Status lighting must not punch through the greeting mid-sweep.
      controller.updateSessionActivity([
        {
          sessionId: 'running-session',
          phase: 'needs-interaction',
          compactDetail: '',
          attention: false,
        },
      ]);
      expect(sink.update.mock.lastCall?.[0]?.ambient.effect).toBe(WorkLouderLightingEffect.Snake);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(sink.update.mock.lastCall?.[0]?.ambient.effect).toBe(WorkLouderLightingEffect.Breath);
      expect(sink.update.mock.calls[0]?.[0]?.ambient.color).toBe(0xd0060c);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the greeting early when the user touches the keyboard', () => {
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
      const controller = new WorkLouderCodexLightingController(sink, vi.fn());
      controller.start();
      controller.playWindowReveal();
      expect(sink.update.mock.lastCall?.[0]?.ambient.effect).toBe(WorkLouderLightingEffect.Snake);

      activityHandlerRef.current?.();
      expect(isWorkLouderCodexLightingFrameOff(sink.update.mock.lastCall?.[0])).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the last device snapshot when the keyboard disappears', () => {
    const statusRef: { current: ((status: 'connected' | 'not-detected') => void) | null } = {
      current: null,
    };
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn((handler: typeof statusRef.current) => {
        statusRef.current = handler;
      }),
      setDeviceStateHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn());
    controller.applySettings(settings({ deviceEnabled: true }));
    controller.start();
    sink.setDeviceStateHandler.mock.calls.at(-1)?.[0]?.({
      deviceType: 'codex-micro',
      isUsbConnection: true,
      firmwareVersion: '1.2.3',
      batteryPercentage: 80,
      isCharging: false,
      inputMonitoringPermission: 'granted',
    });
    expect(controller.getState().device.deviceType).toBe('codex-micro');

    statusRef.current?.('not-detected');
    expect(controller.getState().connectionStatus).toBe('not-detected');
    expect(controller.getState().device.deviceType).toBeNull();
    expect(controller.getState().device.batteryPercentage).toBeNull();
    expect(controller.getState().device.inputMonitoringPermission).toBe('granted');
  });

  it('keeps the instance disabled while still recording keyboard presence', () => {
    const presenceRef: {
      current: ((
        present: boolean,
        identity?: { deviceType: 'codex-micro' | 'creator-micro-2'; isUsbConnection: boolean },
      ) => void) | null;
    } = { current: null };
    const statusRef: { current: ((status: 'connecting' | 'disabled') => void) | null } = {
      current: null,
    };
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn((handler: typeof statusRef.current) => {
        statusRef.current = handler;
      }),
      setPresenceHandler: vi.fn((handler: typeof presenceRef.current) => {
        presenceRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn());
    controller.start();

    statusRef.current?.('connecting');
    presenceRef.current?.(true, { deviceType: 'codex-micro', isUsbConnection: true });

    expect(controller.getState().connectionStatus).toBe('disabled');
    expect(controller.getState().devicePresent).toBe(true);
    expect(controller.getState().device.deviceType).toBe('codex-micro');
    expect(controller.getState().device.isUsbConnection).toBe(true);
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

  it('stops leftover stick scrolling and encoder presses when the account suspends', async () => {
    const hidRef: { current: ((event: { key: string; act: number }) => void) | null } = {
      current: null,
    };
    const joystickRef: { current: ((event: { angle: number; distance: number }) => void) | null } = {
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
      setJoystickInputHandler: vi.fn((handler: typeof joystickRef.current) => {
        joystickRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn(), undefined, dispatch);
    controller.start();
    await controller.resumeTaskSlots();
    joystickRef.current?.({ angle: 0.25, distance: 1 });
    hidRef.current?.({ key: 'ENC', act: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scroll', direction: 'down' }),
    );
    dispatch.mockClear();

    controller.suspendTaskSlots();
    hidRef.current?.({ key: 'ENC', act: 0 });

    expect(dispatch).toHaveBeenCalledWith({ type: 'scroll-stop' });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'keyboard' }));

    dispatch.mockClear();
    joystickRef.current?.({ angle: 0.25, distance: 1 });
    hidRef.current?.({ key: 'ACT06', act: 1 });
    hidRef.current?.({ key: 'ENC_CW', act: 2 });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('releases a held microphone when the account suspends or the key is later released', async () => {
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
    await controller.resumeTaskSlots();
    hidRef.current?.({ key: 'ACT10', act: 1 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'voice', phase: 'press' });

    dispatch.mockClear();
    controller.suspendTaskSlots();
    expect(dispatch).toHaveBeenCalledWith({ type: 'voice', phase: 'release' });

    dispatch.mockClear();
    hidRef.current?.({ key: 'ACT10', act: 0 });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'voice', phase: 'press' });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'voice', phase: 'release' });
  });

  it('releases held voice and scroll when this instance turns the keyboard off', async () => {
    const hidRef: { current: ((event: { key: string; act: number }) => void) | null } = {
      current: null,
    };
    const joystickRef: { current: ((event: { angle: number; distance: number }) => void) | null } = {
      current: null,
    };
    const dispatch = vi.fn();
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      setDeviceEnabled: vi.fn(),
      setHidInputHandler: vi.fn((handler: typeof hidRef.current) => {
        hidRef.current = handler;
      }),
      setJoystickInputHandler: vi.fn((handler: typeof joystickRef.current) => {
        joystickRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn(), undefined, dispatch);
    controller.start();
    controller.applySettings(settings({ deviceEnabled: true }));
    await controller.resumeTaskSlots();
    hidRef.current?.({ key: 'ACT10', act: 1 });
    joystickRef.current?.({ angle: 0.25, distance: 1 });
    dispatch.mockClear();

    controller.applySettings(settings({ deviceEnabled: false }));

    expect(dispatch).toHaveBeenCalledWith({ type: 'voice', phase: 'release' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'scroll-stop' });
    expect(sink.setDeviceEnabled).toHaveBeenLastCalledWith(false);
  });

  it('releases held voice and scroll when the layout editor opens', async () => {
    const hidRef: { current: ((event: { key: string; act: number }) => void) | null } = {
      current: null,
    };
    const joystickRef: { current: ((event: { angle: number; distance: number }) => void) | null } = {
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
      setJoystickInputHandler: vi.fn((handler: typeof joystickRef.current) => {
        joystickRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn(), undefined, dispatch);
    controller.start();
    await controller.resumeTaskSlots();
    hidRef.current?.({ key: 'ACT10', act: 1 });
    joystickRef.current?.({ angle: 0.25, distance: 1 });
    dispatch.mockClear();

    controller.setLayoutPreviewActive(true);

    expect(dispatch).toHaveBeenCalledWith({ type: 'voice', phase: 'release' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'scroll-stop' });
  });

  it('does not fire a held stick action after the account resumes', async () => {
    const joystickRef: { current: ((event: { angle: number; distance: number }) => void) | null } = {
      current: null,
    };
    const dispatch = vi.fn();
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      setHidInputHandler: vi.fn(),
      setJoystickInputHandler: vi.fn((handler: typeof joystickRef.current) => {
        joystickRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn(), async () => [], dispatch);
    controller.start();
    await controller.resumeTaskSlots();
    joystickRef.current?.({ angle: 0.5, distance: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'command', commandId: 'toggleSidebar' }),
    );

    dispatch.mockClear();
    controller.suspendTaskSlots();
    await controller.resumeTaskSlots();
    joystickRef.current?.({ angle: 0.5, distance: 1 });
    expect(dispatch).not.toHaveBeenCalled();

    joystickRef.current?.({ angle: 0.5, distance: 0 });
    joystickRef.current?.({ angle: 0.5, distance: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'command', commandId: 'toggleSidebar' }),
    );
  });

  it('clears a held stick during suspend so the next push after resume works', async () => {
    const joystickRef: { current: ((event: { angle: number; distance: number }) => void) | null } = {
      current: null,
    };
    const dispatch = vi.fn();
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      setHidInputHandler: vi.fn(),
      setJoystickInputHandler: vi.fn((handler: typeof joystickRef.current) => {
        joystickRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn(), async () => [], dispatch);
    controller.start();
    await controller.resumeTaskSlots();
    joystickRef.current?.({ angle: 0.5, distance: 1 });
    controller.suspendTaskSlots();
    joystickRef.current?.({ angle: 0.5, distance: 0 });
    dispatch.mockClear();
    await controller.resumeTaskSlots();
    joystickRef.current?.({ angle: 0.5, distance: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'command', commandId: 'toggleSidebar' }),
    );
  });

  it('keeps the first push after resume when the stick was already centred', async () => {
    const joystickRef: { current: ((event: { angle: number; distance: number }) => void) | null } = {
      current: null,
    };
    const dispatch = vi.fn();
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      setDeviceActivityHandler: vi.fn(),
      setConnectionStatusHandler: vi.fn(),
      setHidInputHandler: vi.fn(),
      setJoystickInputHandler: vi.fn((handler: typeof joystickRef.current) => {
        joystickRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn(), async () => [], dispatch);
    controller.start();
    await controller.resumeTaskSlots();
    controller.suspendTaskSlots();
    dispatch.mockClear();
    await controller.resumeTaskSlots();
    joystickRef.current?.({ angle: 0.5, distance: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'command', commandId: 'toggleSidebar' }),
    );
  });

  it('does not dispatch hardware actions until the account resumes', () => {
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
    hidRef.current?.({ key: 'ACT06', act: 1 });
    hidRef.current?.({ key: 'ENC_CW', act: 2 });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
