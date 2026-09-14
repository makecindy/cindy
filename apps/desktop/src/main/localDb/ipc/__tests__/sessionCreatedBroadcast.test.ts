import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tap: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: h.send } },
    ],
  },
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  tapWindowBroadcast: h.tap,
}));

import {
  buildSessionListFlightKey,
  resetSessionListSingleFlightForTests,
} from '../sessionListSingleFlight';
import { emitSessionCreated } from '../sessionCreatedBroadcast';

afterEach(() => {
  resetSessionListSingleFlightForTests();
  h.tap.mockClear();
  h.send.mockClear();
});

const listParams = {
  userId: 'u1',
  clientEpoch: 1,
  cap: 200,
  statusFilter: 'active' as const,
  includePinned: true,
};

describe('emitSessionCreated', () => {
  it('notifies windows and device-link without owning write generation', () => {
    const before = buildSessionListFlightKey(listParams);
    emitSessionCreated('s1');
    expect(buildSessionListFlightKey(listParams)).toBe(before);
    expect(h.tap).toHaveBeenCalledWith('local-db:sessions:created', { sessionId: 's1' });
    expect(h.send).toHaveBeenCalledWith('local-db:sessions:created', { sessionId: 's1' });
  });
});

describe('sessions:created 唯一出口', () => {
  it('main 侧 created 广播只留在 emitSessionCreated', () => {
    const mainRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const helper = readFileSync(join(mainRoot, 'localDb/ipc/sessionCreatedBroadcast.ts'), 'utf8');
    expect(helper).toContain("tapWindowBroadcast('local-db:sessions:created'");
    expect(helper).toContain("win.webContents.send('local-db:sessions:created'");
    expect(helper).not.toContain('bumpSessionListWriteGeneration()');

    const callers = [
      'maker-ipc/register.ts',
      'maker-ipc/fork.ts',
      'hook-control/session-runner.ts',
      'learn-host/index.ts',
      'im/shared/sessionBroadcast.ts',
    ];
    for (const rel of callers) {
      const src = readFileSync(join(mainRoot, rel), 'utf8');
      expect(src, rel).toContain('emitSessionCreated');
      expect(src, rel).not.toContain("tapWindowBroadcast('local-db:sessions:created'");
      expect(src, rel).not.toContain("webContents.send('local-db:sessions:created'");
    }
  });
});
