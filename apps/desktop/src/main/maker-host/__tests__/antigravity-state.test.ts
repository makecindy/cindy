import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as appSessionState from '../../appSessionState';
import { buildAntigravityAgent, getAntigravityAccounts } from '../antigravity-host';
import { createMakerLogger } from '../logger-adapter';
import { createAntigravityUsageReader, parseAntigravityQuota } from '../antigravity-usage';
import { antigravityProvider, setAntigravityState } from '../antigravity-state';
import { ANTIGRAVITY_ACCOUNT_BUSY } from '../../../shared/antigravityAccounts';
import { supportsAntigravityRuntime } from '../antigravity-runtime';

afterEach(() => setAntigravityState(null));
describe('native Google subscription metadata', () => {
  it('preserves model-specific tiers and fixed effort instead of flattening everything to unsupported', () => {
    setAntigravityState({ connected: true, tier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, models: [
      { id: 'gemini-4-hydrogen', name: 'Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', effortDisplayNames: { xhigh: 'Extra' } },
      { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator', efforts: [], defaultEffort: null },
    ] });
    const provider = antigravityProvider()!;
    expect(provider.models.antigravity?.[0]).toMatchObject({ efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', effortDisplayNames: { xhigh: 'Extra' }, supportsFastMode: false });
    expect(provider.models.antigravity?.[1]).toMatchObject({ efforts: [], defaultEffort: null });
    expect(provider.access?.kind).toBe('subscription'); expect(provider.routing.antigravity?.transport).toBe('acp');
  });
  it('does not publish another owner or an unconfigured engine into the existing catalog', () => {
    expect(antigravityProvider()).toBeNull();
    setAntigravityState({ connected: true, isCurrent: () => false, models: [] });
    expect(antigravityProvider()).toBeNull();
  });
  it('keeps Claude and GPT-OSS on the Google OAuth provider with native effort metadata', () => {
    setAntigravityState({ connected: true, tier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', efforts: [], defaultEffort: null },
    ] });
    const provider = antigravityProvider()!;
    expect(provider).toMatchObject({ id: 'google-antigravity-subscription', agents: ['antigravity'], auth: { method: 'oauth' }, access: { kind: 'subscription' } });
    expect(provider.models.antigravity?.map(model => [model.id, model.efforts, model.defaultEffort])).toEqual([
      ['claude-opus-5-5', ['low', 'medium', 'high'], 'medium'], ['claude-sonnet-5-5', ['low', 'medium', 'high'], 'medium'], ['gpt-oss-120b-medium', [], null],
    ]);
  });
});

// Unit: Google omits zero and sometimes labels a bucket by text. The catalog
// tests above cannot catch a spent subscription being displayed as available.
describe('Google quota projection', () => {
  it('preserves model-group windows and treats an omitted spent fraction as zero remaining', () => {
    const timestamp = '2026-11-18T10:00:00Z';
    const result = parseAntigravityQuota({ groups: [
      { displayName: 'Gemini Models', buckets: [
        { displayName: '5-hour limit', remainingFraction: 0.75, resetTime: timestamp },
        { window: 'weekly', resetTime: timestamp },
      ] },
      { displayName: 'Claude and GPT models', buckets: [
        { window: 'weekly', remainingFraction: 0, disabled: true },
        { window: 'weekly', remainingFraction: 0.2, resetTime: timestamp },
      ] },
    ] }, 42);
    expect(result).toMatchObject([
      { limitName: 'Gemini Models', updatedAt: 42,
        primary: { usedPercent: 25, windowMinutes: 300, resetsAt: Date.parse(timestamp) / 1000 },
        secondary: { usedPercent: 100, windowMinutes: 10_080 } },
      { limitName: 'Claude and GPT models', primary: null, secondary: { usedPercent: 80 } },
    ]);
  });

  // Unit: a missing project was observed with an otherwise current token.
  // Exercise the actual reader to prevent an unauthorized follow-up or false zero.
  it('queries quota for the project returned by Google and stops when Google returns no project', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cindy-test-google-quota-'));
    const tokenPath = join(directory, 'antigravity-oauth-token');
    try {
      writeFileSync(tokenPath, JSON.stringify({
        token: { access_token: 'invalid-test-token', expiry: new Date(Date.now() + 600_000).toISOString() },
      }), { mode: 0o600 });
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ cloudaicompanionProject: 'test-project' }))
        .mockResolvedValueOnce(Response.json({ groups: [{
          displayName: 'Gemini Models', buckets: [{ window: 'session', remainingFraction: 0.75 }],
        }] }))
        .mockResolvedValueOnce(Response.json({ allowedTiers: [] }));
      const signal = new AbortController().signal;
      const read = createAntigravityUsageReader(fetcher);
      const scope = () => undefined;
      const [first, second] = await Promise.all([read(tokenPath, 1, signal, scope), read(tokenPath, 1, signal, scope)]);
      expect(first).toMatchObject([{ limitName: 'Gemini Models', primary: { usedPercent: 25, windowMinutes: 300 } }]);
      expect(second).toEqual(first);
      expect(fetcher).toHaveBeenNthCalledWith(2,
        'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        expect.objectContaining({ body: JSON.stringify({ project: 'test-project' }) }));
      await expect(read(tokenPath, 2, signal, scope)).resolves.toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// Unit regression from the installed arm64 app: an unconfigured connection
// must still register its agent and publish a disconnected Settings entry.
// The older snapshot-only test never invoked the real BaseAgent constructor.
it.runIf(supportsAntigravityRuntime())('offers Google setup before a runtime has been configured', async () => {
  const owner = vi.spyOn(appSessionState, 'getActiveAppSession')
    .mockReturnValue({ mode: 'local', dataOwnerId: 'test-owner', generation: 1 });
  try {
    const agent = buildAntigravityAgent(join(tmpdir(), 'cindy-unconfigured-antigravity-test'), createMakerLogger('test'));
    expect(agent?.kind).toBe('antigravity');
    expect(antigravityProvider()).toMatchObject({ id: 'google-antigravity-subscription', models: { antigravity: [] } });
    expect(getAntigravityAccounts()?.read()).toMatchObject({ configured: false, connected: false, accounts: [] });
    await expect(agent?.getAuthState()).resolves.toMatchObject({ authenticated: false });
  } finally { owner.mockRestore(); }
});

// Unit: legacy and independent profiles share a catalog but have different
// storage ownership. Use real temporary directories, without a native CLI.
it.runIf(supportsAntigravityRuntime())('retires idle tasks before active removal and only deletes the selected profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cindy-google-profiles-'));
  const owner = vi.spyOn(appSessionState, 'getActiveAppSession')
    .mockReturnValue({ mode: 'local', dataOwnerId: 'test-owner', generation: 1 });
  const root = join(directory, 'google-subscription', createHash('sha256').update('test-owner').digest('hex').slice(0, 24));
  const active = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const spare = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const activeDirectory = join(root, 'profiles', active);
  const spareDirectory = join(root, 'profiles', spare);
  const legacyDirectory = join(root, '.gemini');
  const configPath = join(root, 'connection.json');
  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));
  try {
    mkdirSync(activeDirectory, { recursive: true });
    mkdirSync(legacyDirectory);
    symlinkSync(legacyDirectory, spareDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(configPath, JSON.stringify({
      enabled: true, binaryPath: join(directory, 'fake-official-agy'),
      profiles: ['default', active, spare], activeProfile: active, disconnectedProfiles: [spare],
      profileIdentities: { [active]: 'fixture-digest' },
    }));
    const retire = vi.fn(async () => {}).mockRejectedValueOnce(new Error(ANTIGRAVITY_ACCOUNT_BUSY));
    buildAntigravityAgent(directory, createMakerLogger('test'), undefined, retire);
    const accounts = getAntigravityAccounts()!;
    await expect(accounts.remove(spare)).rejects.toThrow('ANTIGRAVITY_PROFILE_PATH_INVALID');
    expect(retire).not.toHaveBeenCalled();
    expect(existsSync(legacyDirectory)).toBe(true);
    await expect(accounts.remove(active)).rejects.toThrow(ANTIGRAVITY_ACCOUNT_BUSY);
    expect(existsSync(activeDirectory)).toBe(true);
    expect(readConfig().activeProfile).toBe(active);
    await expect(accounts.remove(active)).resolves.toMatchObject({ activeId: 'default' });
    expect(existsSync(activeDirectory)).toBe(false);
    expect(readConfig().profileIdentities).toEqual({});
    expect(existsSync(spareDirectory)).toBe(true);
    rmSync(spareDirectory); // Remove the test's own link so the empty profile can be removed.
    await expect(accounts.remove(spare)).resolves.toMatchObject({ activeId: 'default' });
    await expect(accounts.remove('default')).resolves.toMatchObject({ activeId: null, connected: false, accounts: [] });
    await expect(accounts.usage()).resolves.toMatchObject({ activeId: null, usage: [] });
    expect(existsSync(legacyDirectory)).toBe(true);
  } finally {
    owner.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

// Unit: clicking Add again after cancelling uses the selected blank profile.
it.runIf(supportsAntigravityRuntime())('reuses a tokenless sign-in draft without replacing an existing credential file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cindy-google-draft-'));
  const owner = vi.spyOn(appSessionState, 'getActiveAppSession')
    .mockReturnValue({ mode: 'local', dataOwnerId: 'test-owner', generation: 1 });
  const root = join(directory, 'google-subscription', createHash('sha256').update('test-owner').digest('hex').slice(0, 24));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'connection.json'), JSON.stringify({ enabled: true, binaryPath: join(directory, 'fake-official-agy') }));
    buildAntigravityAgent(directory, createMakerLogger('test'));
    const accounts = getAntigravityAccounts()!;
    const first = await accounts.add();
    expect(first.accounts).toHaveLength(2);
    await expect(accounts.add()).resolves.toMatchObject({ activeId: first.activeId, accounts: first.accounts });
    const storage = join(root, 'profiles', first.activeId!, '.gemini', 'antigravity-cli');
    mkdirSync(storage, { recursive: true });
    writeFileSync(join(storage, 'antigravity-oauth-token'), '{}', { mode: 0o600 });
    const fresh = await accounts.add();
    expect(fresh.accounts).toHaveLength(3);
    expect(fresh.activeId).not.toBe(first.activeId);
    expect(readFileSync(join(storage, 'antigravity-oauth-token'), 'utf8')).toBe('{}');
  } finally {
    owner.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
