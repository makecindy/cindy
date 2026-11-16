/**
 * Host vs desktop: the auxiliary-model chain read from the same settings files (release
 * table row 4). The desktop side is the real Desktop binding (auxiliary-model-settings-store.ts
 * and resolveAuxiliaryModelChain.ts) as a cloud owner that holds the legacy-namespace claim;
 * the Host side is apps/host/src/agent/auxiliary-model-chain.ts. Each fixture is copied
 * into two owner directories, one per side. Both must resolve the same effective chain; the
 * desktop then migrates its copy to exactly what the Host keeps in memory, and the Host copy
 * stays byte for byte unchanged. The unscoped legacy voice file is the one place they differ
 * by design: the Host never reads it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: { getPath: (name: string) => { if (name === 'userData') return h.dir; throw new Error(`unexpected path ${name}`); } },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(h.dir, 'owner', ...parts),
  activeOwnerScopeKey: () => 'parity-owner',
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'parity-owner', generation: 0 }),
}));
vi.mock('../../ownerNamespaceMigration.js', () => ({
  hasExclusiveSharedLegacyUserDataAccess: () => true,
  hasLegacyOwnerNamespaceClaim: () => true,
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { __testing, readAuxiliaryModelSettings } from '../auxiliary-model-settings-store.js';
import { getEffectiveAuxiliaryModelChain } from '../resolveAuxiliaryModelChain.js';

// Real temporary profiles and settings files, for both sides.
// An explicit bound instead of the 5 s / 10 s defaults, wide enough for the loaded full desktop pool.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type HostChain = {
  settings: { readAuxiliaryModelSettings(): unknown; __testing: { flushLegacyMigration(): Promise<void> } };
  chain: { getEffectiveAuxiliaryModelChain(): unknown };
};

const PIN_A = 'cat:openai:codex:gpt-5.4-mini';
const PIN_B = 'cat:xd:claude-code:kimi-k2.5';
const CUSTOM = 'cat:xd:codex:moonshotai/kimi-k2.6-custom';
const VOICE = {
  utilityModelProvider: 'litellm-kimi-k2.6',
  utilityModel: 'moonshotai/kimi-k2.6-custom',
  utilityModelProviderChain: ['codex-gpt-5.4-mini', 'litellm-kimi-k2.6'],
  sttProvider: 'cindy-voice',
};
const SETTINGS = 'auxiliary-model-settings.json';
const VOICE_FILE = 'voice-input-models.json';
const MARKER = 'auxiliary-model-settings-migration.json';

/** Owner-directory files of each fixture; a string is written as is. */
const FIXTURES: Record<string, Record<string, unknown>> = {
  'no settings file': {},
  'current format': { [SETTINGS]: { models: [PIN_A, PIN_B] } },
  'current format, automatic': { [SETTINGS]: { models: [] } },
  'legacy title and recommendation pins': { [SETTINGS]: { sessionTitleModel: PIN_A, promptRecommendationModel: PIN_B } },
  'legacy empty pins': { [SETTINGS]: { sessionTitleModel: '', promptRecommendationModel: '' } },
  'legacy voice chain': { [VOICE_FILE]: VOICE },
  'legacy pins and a legacy voice chain': { [SETTINGS]: { sessionTitleModel: PIN_A }, [VOICE_FILE]: VOICE },
  'current format and a leftover voice chain': { [SETTINGS]: { models: [PIN_B] }, [VOICE_FILE]: VOICE },
  'legacy voice chain already migrated': { [VOICE_FILE]: VOICE, [MARKER]: { legacyVoiceMigrationCompleted: true } },
  'unreadable settings file': { [SETTINGS]: '{"models": [' },
  'settings file over 4 KB': { [SETTINGS]: JSON.stringify({ models: [PIN_A], padding: 'x'.repeat(5000) }) },
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-aux-chain-parity-'));
let createHost: (options: { userDataDir: string }) => HostChain;
let n = 0;

function layout(files: Record<string, unknown>, unscoped?: unknown): string {
  const dir = path.join(root, `case-${n++}`);
  fs.mkdirSync(path.join(dir, 'owner'), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'owner', name), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  }
  if (unscoped) fs.writeFileSync(path.join(dir, VOICE_FILE), JSON.stringify(unscoped), 'utf8');
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else out[path.relative(dir, file)] = fs.readFileSync(file).toString('base64');
    }
  };
  walk(dir);
  return out;
}

async function readDesktop(dir: string) {
  h.dir = dir;
  const result = { settings: readAuxiliaryModelSettings(), chain: getEffectiveAuxiliaryModelChain() };
  await __testing.flushLegacyMigration();
  return result;
}

/** A Host instance over this profile, as the Host builds one per runtime (userDataDir = profile). */
async function readHost(dir: string) {
  h.dir = dir;
  const host = createHost({ userDataDir: dir });
  const before = snapshot(dir);
  const result = { settings: host.settings.readAuxiliaryModelSettings(), chain: host.chain.getEffectiveAuxiliaryModelChain() };
  await host.settings.__testing.flushLegacyMigration();
  expect(snapshot(dir), 'the Host neither writes nor deletes in the profile').toEqual(before);
  return result;
}

beforeAll(async () => {
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env)) if (/^XDT_(UTILITY_MODEL|VOICE_INPUT_REFINER)/.test(key)) vi.stubEnv(key, '');
  // A non-literal specifier keeps the Host sources out of the desktop typecheck.
  const hostModule = '../../../../../host/src/agent/auxiliary-model-chain.ts';
  const { createHostAuxiliaryModelChain } = (await import(/* @vite-ignore */ hostModule)) as {
    createHostAuxiliaryModelChain(options: { userDataDir: string }): HostChain;
  };
  createHost = createHostAuxiliaryModelChain;
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the Host resolves the auxiliary-model chain the desktop resolves', () => {
  for (const [name, files] of Object.entries(FIXTURES)) {
    it(name, async () => {
      const desktop = await readDesktop(layout(files));
      const hst = await readHost(layout(files));
      expect(hst).toEqual(desktop);
      // What the desktop now has on disk is what the Host keeps in memory.
      h.dir = layout(files);
      const migrated = await readDesktop(h.dir);
      expect(migrated).toEqual(desktop);
      const settingsFile = path.join(h.dir, 'owner', SETTINGS);
      if (fs.existsSync(settingsFile)) {
        const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { models?: unknown };
        if (Array.isArray(stored.models)) expect(stored.models).toEqual((hst.settings as { models: unknown }).models);
      }
    });
  }

  it('covers a customized chain, so the comparison is not only between automatic chains', async () => {
    const hst = await readHost(layout(FIXTURES['legacy voice chain']!));
    expect(hst.chain).toEqual({ source: 'custom', refs: [CUSTOM, 'codex-gpt-5.4-mini', 'litellm-kimi-k2.6'] });
  });

  it('keeps an unreadable settings file on the Host and deletes it on the desktop', async () => {
    const desktopDir = layout(FIXTURES['unreadable settings file']!);
    await readDesktop(desktopDir);
    expect(fs.existsSync(path.join(desktopDir, 'owner', SETTINGS))).toBe(false);
    const hostDir = layout(FIXTURES['unreadable settings file']!);
    expect((await readHost(hostDir)).chain).toEqual({ source: 'auto', refs: expect.any(Array) });
    expect(fs.readFileSync(path.join(hostDir, 'owner', SETTINGS), 'utf8')).toBe('{"models": [');
  });

  it('never reads the unscoped legacy voice file on the Host', async () => {
    const unscoped = { refinerProvider: 'litellm-kimi-k2.6', refinerProviderChain: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'] };
    const desktop = await readDesktop(layout({}, unscoped));
    expect(desktop.chain).toEqual({ source: 'custom', refs: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'] });
    const hst = await readHost(layout({}, unscoped));
    expect(hst.chain).toEqual({ source: 'auto', refs: expect.any(Array) });
    // With an owner-directory value present, that value is what the Host uses.
    const withOwner = await readHost(layout({ [SETTINGS]: { models: [PIN_A] } }, unscoped));
    expect(withOwner.chain).toEqual({ source: 'custom', refs: [PIN_A] });
  });
});
