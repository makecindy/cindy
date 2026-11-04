import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../appSessionState.js', () => ({ ownerScopedUserDataPath: () => { throw new Error('fixture must select its own root'); } }));
import { createAssistantSamplingSettlementStore } from '../assistantSamplingSettlement.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// Production recovery store, real isolated filesystem: a rejected DB patch is
// still replayable after process-local state is lost and account owners change.
it('recovers immutable accepted/failed intents across restart without crossing owners or losing concurrent entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sampling-settlements-'));
  roots.push(root);
  let owner = 'a';
  const directory = () => path.join(root, owner);
  const store = createAssistantSamplingSettlementStore(directory);
  const accepted = store.put({ sessionId: 's', persistId: 'accepted', patch: { samplingAttemptPending: false } });
  const failed = store.put({ sessionId: 's', persistId: 'failed', patch: { samplingAttemptPending: false, failedSamplingAttempt: { itemId: 'failed' } } });
  const restarted = createAssistantSamplingSettlementStore(directory);
  owner = 'b';
  expect(restarted.list('s')).toEqual([]);
  const other = restarted.put({ sessionId: 's', persistId: 'other-owner', patch: { samplingAttemptPending: false } });
  owner = 'a';
  expect(restarted.list('s').map(entry => entry.persistId).sort()).toEqual(['accepted', 'failed']);
  // Acknowledge only a known durable DB update, keeping unrelated intents intact.
  restarted.acknowledge(accepted);
  expect(restarted.list('s')).toEqual([failed]);
  restarted.acknowledge(failed);
  expect(restarted.list('s')).toEqual([]);
  owner = 'b';
  expect(restarted.list('s')).toEqual([other]);
});
