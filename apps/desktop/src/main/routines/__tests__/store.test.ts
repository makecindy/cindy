import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { RoutineFileStore } from '../store.js';
import type { RoutineState } from '@cindy/maker-scheduler';

describe('Routine durable storage', () => {
  it('persists receipts and queued events across restart without crossing owner roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-routines-'));
    try {
      const ownerA = new RoutineFileStore(path.join(root, 'owner-a'));
      const state: RoutineState = {
        version: 1,
        routines: [],
        receipts: { delivery: 100 },
        next: {},
        runs: [
          {
            id: 'run',
            routineId: 'routine',
            revision: 1,
            triggerIds: ['event'],
            events: [
              {
                sourceId: 'mail',
                event: {
                  id: 'delivery',
                  type: 'mail',
                  occurredAt: 100,
                  data: { messageId: 'mail-1' },
                },
              },
            ],
            status: 'queued',
            createdAt: 100,
          },
        ],
      };
      await ownerA.save(state);
      expect(await new RoutineFileStore(path.join(root, 'owner-a')).load()).toEqual(state);
      expect(await new RoutineFileStore(path.join(root, 'owner-b')).load()).toBeNull();
      await ownerA.save({ ...state, receipts: { ...state.receipts, next: 200 } });
      expect((await ownerA.load())?.receipts.next).toBe(200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
