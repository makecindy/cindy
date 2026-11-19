import { beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { ApiFetchOptions } from '../../serverApiClient.js';

// DB tier: real UTC ledger and grant persistence semantics. The transport is the
// only network boundary; fixtures never leave the process.
const state = vi.hoisted(() => ({
  user: 'member',
  text: null as string | null,
  allowed: true,
  client: null as unknown,
  calls: [] as unknown[],
  fail: false,
}));
vi.mock('electron', () => ({ app: { getPath: () => '/fixture' } }));
vi.mock('../../authManager.js', () => ({
  getActiveAuthRealm: () => 'cn',
  getCurrentUserId: () => state.user,
  isLocalMode: () => false,
}));
vi.mock('../../analytics-settings-store.js', () => ({ isAnalyticsAllowed: () => state.allowed }));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpointForRealm: () => 'https://region.invalid',
}));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => state.client,
}));
vi.mock('../../utils/atomicWriteFile.js', () => ({
  readAtomicFileSync: () => state.text,
  atomicWriteFileSync: (_p: string, s: string) => {
    state.text = s;
  },
}));
vi.mock('../../serverApiClient.desktop.js', () => ({
  serverApiFetch: async (_p: string, opts: ApiFetchOptions) => {
    opts.beforeHop?.('https://region.invalid');
    state.calls.push(opts.body);
    if (state.fail) throw new Error('Offline');
    return { accepted: true };
  },
}));
import {
  reportTokenUsage,
  revokeAllTokenReporting,
  setTokenReporting,
  tokenReportingEnabled,
} from '../reporting.js';

beforeEach(() => {
  Object.assign(state, { user: 'member', text: null, allowed: true, calls: [], fail: false });
});
it('starts at consent, retries snapshots, attributes auxiliary receipts, and isolates withdrawal and account switching', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      readFileSync(
        new URL('../../../../drizzle/0154_daily_token_attribution.sql', import.meta.url),
        'utf8',
      ),
    );
    db.exec(`CREATE TABLE auxiliary_usage_receipts(recorded_at INTEGER,day TEXT,provider_id TEXT,model TEXT,
      input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_create_tokens INTEGER)`);
    const day = new Date().toISOString().slice(0, 10);
    const add = db.prepare('INSERT INTO daily_token_attribution VALUES(?,?,?,?,?,?,?,?)');
    add.run(day, 'preset:magpie', 'provider', 'gpt-6.2-sol', 100, 10, 500, 3);
    state.client = {
      userId: state.user,
      client: { query: (q: string, p: unknown[]) => db.prepare(q).all(...p) },
    };
    await reportTokenUsage();
    await setTokenReporting(true);
    await reportTokenUsage();
    expect(state.calls).toEqual([]);
    db.exec(
      'UPDATE daily_token_attribution SET input_tokens=input_tokens+3,cache_read_tokens=cache_read_tokens+50',
    );
    db.prepare('INSERT INTO auxiliary_usage_receipts VALUES(?,?,?,?,?,?,?,?)').run(
      Date.now(),
      day,
      'private-origin.invalid',
      'private-customer',
      2,
      0,
      1,
      null,
    );
    state.fail = true;
    await reportTokenUsage();
    state.fail = false;
    await reportTokenUsage();
    await reportTokenUsage();
    expect(state.calls).toHaveLength(2);
    expect(state.calls[0]).toEqual(state.calls[1]);
    expect(state.calls[0]).toMatchObject({
      cells: expect.arrayContaining([
        expect.objectContaining({
          source: 'preset:magpie',
          billing: 'provider',
          counts: [3, 0, 50, 0],
        }),
        expect.objectContaining({ source: 'other', model: 'other', counts: [2, 0, 1, 0] }),
      ]),
    });
    expect(JSON.stringify(state.calls)).not.toMatch(/private-origin|private-customer|member/);
    state.user = 'second';
    expect(tokenReportingEnabled()).toBe(false);
    await expect(setTokenReporting(true)).rejects.toThrow();
    state.user = 'member';
    revokeAllTokenReporting();
    db.exec('UPDATE daily_token_attribution SET input_tokens=input_tokens+1');
    await reportTokenUsage();
    await setTokenReporting(true);
    await reportTokenUsage();
    expect(state.calls).toHaveLength(2);
    await setTokenReporting(false);
    expect(state.text).toBe('{}');
  } finally {
    db.close();
  }
});
