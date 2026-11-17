import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const context = vi.hoisted(() => ({ root: '', owner: 'first', generation: 1, pending: false,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('electron', () => ({ app: { getPath: () => context.root } }));
// electron-store binds its directory once per process; read the current profile file like it does in the app.
vi.mock('electron-store', async () => {
  const nodeFs = await import('node:fs'); const nodePath = await import('node:path');
  return { default: class {
    private file: string;
    constructor(options: { name: string }) { this.file = nodePath.join(context.root, `${options.name}.json`); }
    private read(): Record<string, unknown> { try { return JSON.parse(nodeFs.readFileSync(nodePath.join(context.root, nodePath.basename(this.file)), 'utf8')); } catch { return {}; } }
    get(key: string, fallback?: unknown) { return this.read()[key] ?? fallback; }
    set(key: string, value: unknown) { nodeFs.writeFileSync(nodePath.join(context.root, nodePath.basename(this.file)), JSON.stringify({ ...this.read(), [key]: value })); }
  } };
});
vi.mock('../../logger.js', () => ({ createLogger: () => context.log }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => context.log } }));
vi.mock('../../appSessionState.js', () => ({
  peekCommittedAppSession: () => ({ mode: 'cloud', dataOwnerId: context.owner, generation: context.generation }),
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: context.owner, generation: context.generation }),
  activeOwnerScopeKey: () => `${context.owner}:${context.generation}`,
  isAppSessionBoundaryPending: () => context.pending,
  dataOwnerStorageKey: (id: string) => `test-${id}`,
  ownerScopedUserDataPath: (...segments: string[]) => path.join(context.root, 'owners', `test-${context.owner}`, ...segments),
}));
// Native stores resolve the owner through the injected owner context that the real
// appSessionState installs; it is mocked above, so keep the context on the same owner.
vi.mock('../../ownerContext.js', () => ({
  configureOwnerContext: () => {},
  ownerScopedPath: (...segments: string[]) => path.join(context.root, 'owners', `test-${context.owner}`, ...segments),
  activeDataOwnerId: () => context.owner,
  hasCommittedOwner: () => true,
  isOwnerBoundaryPending: () => context.pending,
  ownerGeneration: () => context.generation,
}));
vi.mock('../../im/ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...segments: string[]) => path.join(context.root, 'owners', `test-${context.owner}`, ...segments),
}));
import { getHostSettings, updateHostSettings } from '../index.js';
import { normalizeHostSettingsChange, type HostSettingsDomain } from '../../../shared/hostSettings.js';
import { readGitSafetySettings, writeGitSafetyMode } from '../../maker-host/git-safety-settings-store.js';
import { readMemorySettings } from '../../maker-host/memory-settings-store.js';
import { readCollaborationSettings } from '../../maker-host/collaboration-settings-store.js';
import { getDefaultShellPref } from '../../terminal/terminalPrefsStore.js';
import { probeAvailableShells } from '../../terminal/shellResolver.js';
import { configureUserDataDir } from '../../userDataPath.js';
import { registerRuntimeSectionsForTest } from './settingsSectionFixture.js';

const caller = { id: 'test-session', assertCurrent() {} };
async function request(domain: HostSettingsDomain, values: { set?: Record<string, unknown>; clear?: string[] }) {
  const state = await getHostSettings(caller, domain);
  if (state.status !== 'ready' || !('operationId' in state)) throw new Error(`Not ready: ${domain}`);
  return { domain, expectedRevision: state.revision, operationId: state.operationId, ...values };
}
registerRuntimeSectionsForTest();
beforeEach(() => { context.root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-catalog-')); configureUserDataDir(context.root); context.owner = 'first'; context.generation++; context.pending = false; vi.clearAllMocks(); });
afterEach(() => fs.rmSync(context.root, { recursive: true, force: true }));

describe('expanded settings use the real native stores', () => {
  it('reads every file domain without creating files or migrating legacy settings', async () => {
    for (const domain of ['collaboration', 'agentResource', 'gitSafety', 'memory', 'claudeCompaction', 'piCompaction', 'silentEncryptedRetry', 'lsp', 'privacy', 'diagnostics', 'telegramBehavior', 'terminal'] as const) {
      expect(await getHostSettings(caller, domain)).toMatchObject({ status: 'ready', customizedKeys: [] });
    }
    // Smart Contacts live in a plugin; its retired domains stay readable as unavailable.
    for (const domain of ['contacts', 'contactsSync'] as const) {
      expect(await getHostSettings(caller, domain)).toMatchObject({ status: 'unavailable' });
    }
    expect(fs.readdirSync(context.root)).toEqual([]);
  });
  it('saves only the changed override, is consumed by the native reader, and resets only that setting', async () => {
    const first = await request('memory', { set: { maker: false } });
    expect(await updateHostSettings(caller, first)).toMatchObject({ saved: true, application: 'next_agent_start' });
    expect(readMemorySettings().maker).toBe(false);
    const file = path.join(context.root, 'owners', 'test-first', 'memory-settings.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ maker: false });
    await updateHostSettings(caller, await request('memory', { set: { codex: false } }));
    await updateHostSettings(caller, await request('memory', { clear: ['maker'] }));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ codex: false });
    expect(readMemorySettings()).toMatchObject({ maker: true, codex: false });
  });
  it('rejects stale forms and cross-owner reuse without altering native values', async () => {
    const stale = await request('collaboration', { set: { workerSoftLimit: 3 } });
    await updateHostSettings(caller, await request('collaboration', { set: { workerSoftLimit: 4 } }));
    expect(await updateHostSettings(caller, stale)).toMatchObject({ saved: false, code: 'CONFLICT' });
    expect(readCollaborationSettings().workerSoftLimit).toBe(4);
    const cross = await request('memory', { set: { codex: false } });
    context.owner = 'second'; context.generation++;
    await expect(updateHostSettings(caller, cross)).rejects.toThrow();
    expect(readMemorySettings().codex).toBe(true);
  });
  it('preserves consent records and never exposes them as editable fields', async () => {
    const file = path.join(context.root, 'analytics-settings.json');
    fs.writeFileSync(file, JSON.stringify({ privacyConsentAccepted: true, legacyConsentMigrationClosed: true }));
    const state = await getHostSettings(caller, 'privacy');
    expect(state).toMatchObject({ status: 'ready', value: { analyticsEnabled: true }, customizedKeys: [] });
    expect(JSON.stringify(state)).not.toContain('privacyConsentAccepted');
    await updateHostSettings(caller, await request('privacy', { set: { analyticsEnabled: false } }));
    await updateHostSettings(caller, await request('privacy', { clear: ['analyticsEnabled'] }));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ privacyConsentAccepted: true, legacyConsentMigrationClosed: true });
    expect(() => normalizeHostSettingsChange({ domain: 'privacy', set: { privacyConsentAccepted: true } })).toThrow();
  });
  it('does not clamp a conflicting collaboration limit into an unrequested setting', async () => {
    expect(await updateHostSettings(caller, await request('collaboration', { set: { workerHardLimit: 2 } }))).toMatchObject({ saved: false, code: 'INVALID_PARAMS' });
    expect(readCollaborationSettings()).toMatchObject({ workerSoftLimit: 5, workerHardLimit: 8 });
    expect(() => normalizeHostSettingsChange({ domain: 'agentResource', set: { maxConcurrentCommands: 65 } })).toThrow();
  });
  it('lets only one of two controllers saving a section from the same revision succeed', async () => {
    // Both read the same revision before either write lands.
    const first = await request('memory', { set: { maker: false } });
    const second = await request('memory', { set: { codex: false } });
    expect(second.expectedRevision).toBe(first.expectedRevision);
    const receipts = await Promise.all([updateHostSettings(caller, first), updateHostSettings(caller, second)]);
    expect(receipts.filter(receipt => receipt.saved)).toHaveLength(1);
    expect(receipts.find(receipt => !receipt.saved)).toMatchObject({ status: 'rejected', code: 'CONFLICT' });
    expect(readMemorySettings()).toMatchObject({ maker: false, codex: true });
  });
  it('terminal writes are seen by existing native consumers and reset clears the override', async () => {
    // Only a shell present on this host is accepted (`sh` does not exist on Windows).
    const shell = probeAvailableShells()[0]!.id;
    await updateHostSettings(caller, await request('terminal', { set: { defaultShellPref: shell } }));
    expect(getDefaultShellPref()).toBe(shell);
    await updateHostSettings(caller, await request('terminal', { clear: ['defaultShellPref'] }));
    expect(getDefaultShellPref()).toBe('auto');
    expect(fs.existsSync(path.join(context.root, 'terminal-prefs.json'))).toBe(false);
  });
});

it('keeps the legacy cloud Git switch compatible with all native modes and stale form checks', async () => {
  for (const mode of ['off', 'existing-git', 'all-projects'] as const) {
    writeGitSafetyMode(mode);
    expect(await getHostSettings(caller, 'gitSafety')).toMatchObject({ value: { autoSnapshotEnabled: mode !== 'off' } });
  }
  const stale = await request('gitSafety', { set: { autoSnapshotEnabled: false } });
  writeGitSafetyMode('existing-git');
  expect(await updateHostSettings(caller, stale)).toMatchObject({ saved: false, code: 'CONFLICT' });
  expect(readGitSafetySettings().mode).toBe('existing-git');
  for (const enabled of [false, true]) {
    expect(await updateHostSettings(caller, await request('gitSafety', { set: { autoSnapshotEnabled: enabled } }))).toMatchObject({ saved: true });
    expect(readGitSafetySettings().mode).toBe(enabled ? 'all-projects' : 'off');
  }
  expect(await updateHostSettings(caller, await request('gitSafety', { clear: ['autoSnapshotEnabled'] }))).toMatchObject({ saved: true });
  expect(readGitSafetySettings().mode).toBe('existing-git');
  expect(await getHostSettings(caller, 'gitSafety')).toMatchObject({ customizedKeys: [] });
});
