import { describe, expect, it, vi } from 'vitest';

import { WorkLouderCodexLightingController } from '../WorkLouderCodexLightingController.js';

describe('WorkLouderCodexLightingController', () => {
  it('deduplicates activity updates that produce the same lighting frame', () => {
    const sink = { update: vi.fn(), dispose: vi.fn(async () => undefined) };
    const controller = new WorkLouderCodexLightingController(sink);
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

  it('delegates shutdown so the host can turn the device off', async () => {
    const sink = { update: vi.fn(), dispose: vi.fn(async () => undefined) };
    const controller = new WorkLouderCodexLightingController(sink);

    await controller.dispose();

    expect(sink.dispose).toHaveBeenCalledOnce();
  });
});
