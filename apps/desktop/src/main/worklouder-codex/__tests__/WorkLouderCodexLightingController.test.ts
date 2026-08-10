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

  it('activates the task assigned to the pressed Agent key', () => {
    const keyHandlerRef: { current: ((slot: number) => void) | null } = { current: null };
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn((handler: ((slot: number) => void) | null) => {
        keyHandlerRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const activateSession = vi.fn();
    const controller = new WorkLouderCodexLightingController(sink, activateSession);

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

  it('updates key targets even when reordered tasks produce the same lighting frame', () => {
    const keyHandlerRef: { current: ((slot: number) => void) | null } = { current: null };
    const sink = {
      update: vi.fn(),
      setAgentKeyPressHandler: vi.fn((handler: ((slot: number) => void) | null) => {
        keyHandlerRef.current = handler;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const activateSession = vi.fn();
    const controller = new WorkLouderCodexLightingController(sink, activateSession);
    const running = (sessionId: string) => ({
      sessionId,
      phase: 'running' as const,
      compactDetail: '',
      attention: false,
    });

    controller.updateSessionActivity([running('first'), running('second')]);
    controller.updateSessionActivity([running('second'), running('first')]);
    keyHandlerRef.current?.(0);

    expect(sink.update).toHaveBeenCalledTimes(1);
    expect(activateSession).toHaveBeenCalledWith('second');
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
