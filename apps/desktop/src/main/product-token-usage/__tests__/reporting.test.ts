import { beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { writeModelUsage } from '../../localDb/worker/opHandlers/modelUsageTx.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ApiFetchOptions } from '../../serverApiClient.js';

const require = createRequire(import.meta.url);
const migrateHarness = require('../../../../drizzle/scripts/0165_token_usage_harness.ts') as {
  run: (db: Database.Database) => void;
};

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
import { captureModelChoice, reportTokenUsage, revokeAllTokenReporting } from '../reporting.js';
import { publicModel } from '../ledger.js';

beforeEach(() => {
  Object.assign(state, { user: 'member', text: null, allowed: true, calls: [], fail: false });
});
it('starts at consent, retries snapshots, attributes harness and auxiliary receipts, and isolates withdrawal and account switching', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      readFileSync(
        new URL('../../../../drizzle/0154_daily_token_attribution.sql', import.meta.url),
        'utf8',
      ),
    );
    db.exec(
      readFileSync(
        new URL('../../../../drizzle/0155_account_usage_first_day.sql', import.meta.url),
        'utf8',
      ),
    );
    db.exec(`CREATE TABLE daily_model_usage(day TEXT,agent_kind TEXT,model TEXT,cost_currency TEXT,cost_amount REAL,
      cost_is_approximate INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_create_tokens INTEGER,
      updated_at INTEGER, PRIMARY KEY(day,agent_kind,model,cost_currency))`);
    db.exec(`CREATE TABLE auxiliary_usage_receipts(recorded_at INTEGER,day TEXT,provider_id TEXT,model TEXT,
      input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_create_tokens INTEGER)`);
    const day = new Date().toISOString().slice(0, 10);
    // Pre-migration historical rows must migrate to harness='unknown' and preserve legacy 5-tuple cell keys.
    const addLegacy = db.prepare('INSERT INTO daily_token_attribution VALUES(?,?,?,?,?,?,?,?)');
    addLegacy.run(day, 'preset:magpie', 'provider', 'gpt-6.2-sol', 100, 10, 500, 3);
    migrateHarness.run(db);
    state.client = {
      userId: state.user,
      client: {
        query: (q: string, p: unknown[]) => db.prepare(q).all(...p),
        exec: async (q: string, p: unknown[] = []) => db.prepare(q).run(...p),
      },
    };
    await reportTokenUsage();
    // Simulate an existing aggregate-only installation whose baseline/acknowledged used legacy 5-tuple keys.
    const previous = JSON.parse(state.text!);
    const owner = Object.keys(previous)[0];
    delete previous[owner].account;
    previous[owner].baseline = {};
    state.text = JSON.stringify(previous);
    await reportTokenUsage();
    expect(state.calls).toMatchObject([
      {
        version: 1,
        cells: [expect.objectContaining({ source: 'preset:magpie', billing: 'provider', harness: 'unknown', counts: [100, 10, 500, 3] })],
      },
    ]);
    // Re-running without new usage must not replay migrated 'unknown' rows.
    state.calls = [];
    await reportTokenUsage();
    expect(state.calls).toHaveLength(0);
    await captureModelChoice('gpt-6.2-sol', 'codex')?.();
    await captureModelChoice('gpt-6.2-sol', 'claude-code')?.();
    await captureModelChoice('auto')?.();
    await captureModelChoice('gpt-6.2-sol', 'codex')?.();
    const record = (recordedAt: number, inputTokens: number, cacheReadTokens: number) =>
      writeModelUsage(db, {
        day,
        agentKind: 'codex',
        model: 'gpt-6.2-sol',
        currency: 'USD',
        amount: 0,
        approximate: false,
        recordedAt,
        inputTokens,
        outputTokens: 0,
        cacheReadTokens,
        cacheCreateTokens: 0,
        attribution: { provider: 'preset:magpie', billingSource: 'provider' },
      });
    const start: number = JSON.parse(state.text!)[owner].account.startsAt;
    record(start - 1, 1000, 0); // Late receipt from before enrollment, on the same UTC day.
    record(start, 3, 50);
    db.prepare(
      'INSERT INTO auxiliary_usage_receipts(recorded_at,day,provider_id,model,harness,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(Date.now(), day, 'private-origin.invalid', 'private-customer', 'auxiliary', 2, 0, 1, null);
    state.fail = true;
    await reportTokenUsage();
    state.fail = false;
    await reportTokenUsage();
    await reportTokenUsage();
    expect(state.calls).toHaveLength(3);
    expect(state.calls[0]).toEqual(state.calls[1]);
    expect(state.calls[0]).toMatchObject({ version: 1 });
    expect(state.calls[2]).toMatchObject({
      version: 2,
      choices: [
        { day, model: 'openai/gpt-6.2-sol', harness: 'codex' },
        { day, model: 'openai/gpt-6.2-sol', harness: 'claude-code' },
        { day, model: 'auto', harness: 'unknown' },
      ],
      cells: expect.arrayContaining([
        expect.objectContaining({
          source: 'preset:magpie',
          billing: 'provider',
          harness: 'codex',
          counts: [3, 0, 50, 0],
        }),
        expect.objectContaining({
          source: 'other',
          model: 'other',
          harness: 'auxiliary',
          counts: [2, 0, 1, 0],
        }),
      ]),
    });
    expect(JSON.stringify(state.calls)).not.toMatch(/private-origin|private-customer|member/);
    const lateChoice = captureModelChoice('unknown', 'pi');
    state.user = 'second';
    await lateChoice?.();
    await reportTokenUsage();
    expect(state.calls).toHaveLength(3);
    state.user = 'member';
    state.allowed = false;
    revokeAllTokenReporting();
    db.exec('UPDATE daily_token_attribution SET input_tokens=input_tokens+1');
    await reportTokenUsage();
    await reportTokenUsage();
    expect(state.calls).toHaveLength(3);
    expect(state.text).toBe('{}');
    state.allowed = true;
    await reportTokenUsage();
    expect(state.calls).toHaveLength(3);
  } finally {
    db.close();
  }
});

it('retains bundled preset models in publicModel instead of erasing them to other', () => {
  expect(publicModel('glm-5.4')).toBe('glm-5.4');
  expect(publicModel('glm-5.4[1m]')).toBe('glm-5.4');
  expect(publicModel('k3.1-pro')).toBe('moonshotai/kimi-k3.1-pro');
  expect(publicModel('qwen3-coder-next')).toBe('qwen3-coder-next');
  expect(publicModel('ark-code-latest')).toBe('ark-code-latest');
  expect(publicModel('LongCat-2.0')).toBe('LongCat-2.0');
  expect(publicModel('private-custom-model')).toBe('other');
  expect(publicModel('unknown')).toBe('unknown');
});
