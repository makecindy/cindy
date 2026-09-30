import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  startLearn: vi.fn(async () => ({ runId: 'learn-run-1' })),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../../device-link/broadcast-tap', () => ({
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('../../skillhub/activationPreferences', () => ({
  isCindyLearnSkillEnabled: () => h.enabled,
}));

vi.mock('../index', () => ({
  getLearnController: () => ({ startLearn: h.startLearn }),
}));

import { LEARN_CHANNELS, registerLearnIpc } from '../registerIpc';

beforeAll(() => {
  registerLearnIpc();
});

beforeEach(() => {
  h.enabled = true;
  h.startLearn.mockClear();
});

function startLearn(input: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get(LEARN_CHANNELS.START);
  if (!handler) throw new Error('learn:start handler was not registered');
  return Promise.resolve(handler({}, input));
}

describe('learn:start IPC activation gate', () => {
  it('rejects local and Device Link calls after Learn is disabled on this host', async () => {
    h.enabled = false;

    await expect(startLearn({ input: '', sourceKind: 'session' })).rejects.toThrow(
      /\[PERMISSION_DENIED\].*disabled in Local Skills/,
    );
    expect(h.startLearn).not.toHaveBeenCalled();
  });

  it('delegates to the Learn controller while the built-in Skill is enabled', async () => {
    const request = { input: '', sourceKind: 'session' };

    await expect(startLearn(request)).resolves.toEqual({ runId: 'learn-run-1' });
    expect(h.startLearn).toHaveBeenCalledWith(request);
  });
});
