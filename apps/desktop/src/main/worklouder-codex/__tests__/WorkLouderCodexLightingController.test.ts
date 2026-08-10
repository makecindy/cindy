import { describe, expect, it, vi } from 'vitest';

import { WorkLouderCodexLightingController } from '../WorkLouderCodexLightingController.js';

describe('WorkLouderCodexLightingController', () => {
  it('deduplicates activity updates that produce the same lighting frame', () => {
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
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

    expect(activateSession).toHaveBeenCalledWith('waiting-session');
  });

  it('uses the published assignment for the current press and refreshes only later presses', async () => {
    let resolveRefresh: ((value: readonly string[]) => void) | undefined;
    const keyHandlerRef: { current: ((slot: number) => void) | null } = { current: null };
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn((handler: ((slot: number) => void) | null) => {
        keyHandlerRef.current = handler;
      }),
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

    expect(activateSession).toHaveBeenCalledWith('first');
    expect(loadSlotSessionIds).toHaveBeenCalledTimes(2);
    resolveRefresh?.(['second']);
    await vi.waitFor(() => expect(sink.update).toHaveBeenCalledTimes(1));
    keyHandlerRef.current?.(0);
    expect(activateSession).toHaveBeenLastCalledWith('second');
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

  it('delegates shutdown so the host can turn the device off', async () => {
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const controller = new WorkLouderCodexLightingController(sink, vi.fn());

    await controller.dispose();

    expect(sink.setAgentKeyPressHandler).toHaveBeenLastCalledWith(null);
    expect(sink.dispose).toHaveBeenCalledOnce();
  });
});
