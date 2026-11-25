import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unit: the database warning store with the cloud settings commit added. Ordinary writes keep
// their ordinary semantics while the app session moves on (an account switch mid-write); the cloud
// commit stops when its caller reports another owner and leaves the file as it was.
const state = vi.hoisted(() => ({ dir: '', generation: 0 }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../appSessionState.js', () => ({
  peekCommittedAppSession: () => ({ mode: 'cloud', dataOwnerId: 'owner', generation: ++state.generation }),
}));
import {
  commitDatabaseSizeWarningSettings,
  readDatabaseSizeWarningSettings,
  writeDatabaseSizeWarningSettings,
} from '../database-size-warning-settings';

beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-warning-cloud-'));
});
afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }));

it('saves an ordinary write while the app session changes', async () => {
  await writeDatabaseSizeWarningSettings({ thresholdGiB: 12 });
  expect(readDatabaseSizeWarningSettings()).toMatchObject({ thresholdGiB: 12 });
});

it('stops a cloud commit that its caller reports as stale, without writing', async () => {
  await writeDatabaseSizeWarningSettings({ thresholdGiB: 12 });
  let calls = 0;
  await expect(
    commitDatabaseSizeWarningSettings({ set: { thresholdGiB: 30 } }, {
      assertCurrent: () => {
        if (++calls > 1) throw new Error('OWNER_CHANGED');
      },
    }),
  ).rejects.toThrow('OWNER_CHANGED');
  expect(readDatabaseSizeWarningSettings()).toMatchObject({ thresholdGiB: 12 });
  const saved = await commitDatabaseSizeWarningSettings({ set: { thresholdGiB: 30 } }, { assertCurrent: () => {} });
  expect(saved).toMatchObject({ status: 'ready', value: { thresholdGiB: 30 } });
});
