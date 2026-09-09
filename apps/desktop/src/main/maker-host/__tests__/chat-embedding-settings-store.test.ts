import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  root: '',
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  ownerId: 'owner-a' as string | null,
  generation: 1,
  boundaryPending: false,
  exclusive: true,
}));

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? harness.root : os.tmpdir()) },
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${harness.mode}:${harness.ownerId ?? 'none'}:${harness.generation}`,
  dataOwnerStorageKey: (ownerId: string) => `key-${ownerId}`,
  getActiveAppSession: () => ({
    mode: harness.mode,
    dataOwnerId: harness.ownerId,
    generation: harness.generation,
  }),
  isAppSessionBoundaryPending: () => harness.boundaryPending,
  ownerScopedUserDataPath: (...parts: string[]) =>
    harness.ownerId
      ? path.join(harness.root, 'owners', `key-${harness.ownerId}`, ...parts)
      : path.join(harness.root, 'no-session', ...parts),
}));

vi.mock('../../ownerNamespaceMigration.js', () => ({
  hasExclusiveSharedLegacyUserDataAccess: () => harness.exclusive,
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

async function loadStore() {
  return import('../chat-embedding-settings-store.js');
}

const orgContext = {
  mode: 'cloud' as const,
  isAuthenticated: true,
  userId: 'owner-a',
  membershipKind: 'org' as const,
};
const personalContext = {
  mode: 'cloud' as const,
  isAuthenticated: true,
  userId: 'owner-a',
  membershipKind: 'personal' as const,
};

beforeEach(() => {
  vi.resetModules();
  harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-chat-embedding-settings-'));
  harness.mode = 'cloud';
  harness.ownerId = 'owner-a';
  harness.generation = 1;
  harness.boundaryPending = false;
  harness.exclusive = true;
});

afterEach(() => {
  fs.rmSync(harness.root, { recursive: true, force: true });
});

describe('chat embedding account defaults', () => {
  it('enables only an authenticated organization cloud membership by default', async () => {
    const { resolveChatEmbeddingDefault } = await loadStore();

    expect(resolveChatEmbeddingDefault(orgContext)).toBe(true);
    expect(resolveChatEmbeddingDefault(personalContext)).toBe(false);
    expect(
      resolveChatEmbeddingDefault({
        mode: 'cloud',
        isAuthenticated: false,
        userId: null,
        membershipKind: 'org',
      }),
    ).toBe(false);
    expect(
      resolveChatEmbeddingDefault({
        mode: 'local',
        isAuthenticated: false,
        userId: null,
        membershipKind: null,
      }),
    ).toBe(false);
    expect(
      resolveChatEmbeddingDefault({
        mode: 'signed-out',
        isAuthenticated: false,
        userId: null,
        membershipKind: null,
      }),
    ).toBe(false);
  });

  it('keeps explicit choices isolated per owner and reset follows the current account default', async () => {
    const {
      readChatEmbeddingSettingsState,
      resetChatEmbeddingSettings,
      writeChatEmbeddingEnabled,
    } = await loadStore();

    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: true },
      defaults: { enabled: true },
      isCustomized: false,
    });
    await writeChatEmbeddingEnabled(false, orgContext);
    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: false },
      isCustomized: true,
    });

    harness.ownerId = 'owner-b';
    harness.generation += 1;
    const ownerBContext = { ...personalContext, userId: 'owner-b' };
    expect(readChatEmbeddingSettingsState(ownerBContext)).toMatchObject({
      value: { enabled: false },
      defaults: { enabled: false },
      isCustomized: false,
    });
    await writeChatEmbeddingEnabled(true, ownerBContext);
    expect(readChatEmbeddingSettingsState(ownerBContext)).toMatchObject({
      value: { enabled: true },
      isCustomized: true,
    });

    harness.ownerId = 'owner-a';
    harness.generation += 1;
    expect(readChatEmbeddingSettingsState(orgContext).value.enabled).toBe(false);
    await resetChatEmbeddingSettings(orgContext);
    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: true },
      isCustomized: false,
    });
  });

  it('persists a user choice even when it equals the organization default', async () => {
    const { readChatEmbeddingSettingsState, writeChatEmbeddingEnabled } = await loadStore();

    await writeChatEmbeddingEnabled(true, orgContext);
    expect(readChatEmbeddingSettingsState(orgContext).isCustomized).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(harness.root, 'owners', 'key-owner-a', 'chat-embedding-settings.json'),
          'utf-8',
        ),
      ),
    ).toEqual({ enabled: true });
  });

  it('rejects a cloud context that no longer matches the active owner', async () => {
    const { writeChatEmbeddingEnabled } = await loadStore();
    harness.ownerId = 'owner-b';
    harness.generation += 1;

    await expect(writeChatEmbeddingEnabled(true, orgContext)).rejects.toThrow(/stable data owner/);
    expect(
      fs.existsSync(
        path.join(harness.root, 'owners', 'key-owner-b', 'chat-embedding-settings.json'),
      ),
    ).toBe(false);
  });

  it('reloads an owner override written by another process', async () => {
    const { readChatEmbeddingSettingsState } = await loadStore();
    const ownerDir = path.join(harness.root, 'owners', 'key-owner-a');
    const file = path.join(ownerDir, 'chat-embedding-settings.json');

    expect(readChatEmbeddingSettingsState(orgContext).value.enabled).toBe(true);
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ enabled: false }), 'utf-8');
    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: false },
      isCustomized: true,
    });

    fs.writeFileSync(file, JSON.stringify({ enabled: true }), 'utf-8');
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(file, future, future);
    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: true },
      isCustomized: true,
    });
  });
});

describe('legacy machine-wide setting migration', () => {
  it('moves the recognizable legacy opt-out to the first stable cloud owner only', async () => {
    fs.writeFileSync(
      path.join(harness.root, 'chat-embedding-settings.json'),
      JSON.stringify({ enabled: false }),
      'utf-8',
    );
    const { readChatEmbeddingSettingsState, resetChatEmbeddingSettings } = await loadStore();

    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: false },
      isCustomized: true,
    });
    expect(fs.existsSync(path.join(harness.root, 'chat-embedding-settings.json'))).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(harness.root, 'owners', 'key-owner-a', 'chat-embedding-settings.json'),
          'utf-8',
        ),
      ),
    ).toEqual({ enabled: false });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(harness.root, '.chat-embedding-settings-owner-claim-v1.json'),
          'utf-8',
        ),
      ),
    ).toEqual({ version: 1, ownerKey: 'key-owner-a', complete: true });

    await resetChatEmbeddingSettings(orgContext);
    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: true },
      isCustomized: false,
    });

    harness.ownerId = 'owner-b';
    harness.generation += 1;
    expect(readChatEmbeddingSettingsState({ ...orgContext, userId: 'owner-b' })).toMatchObject({
      value: { enabled: true },
      isCustomized: false,
    });
  });

  it('does not let local mode claim a setting that was never exposed there', async () => {
    fs.writeFileSync(
      path.join(harness.root, 'chat-embedding-settings.json'),
      JSON.stringify({ enabled: false }),
      'utf-8',
    );
    harness.mode = 'local';
    harness.ownerId = 'local-v1';
    const { readChatEmbeddingSettingsState } = await loadStore();

    expect(
      readChatEmbeddingSettingsState({
        mode: 'local',
        isAuthenticated: false,
        userId: null,
        membershipKind: null,
      }),
    ).toMatchObject({ value: { enabled: false }, isCustomized: false });
    expect(fs.existsSync(path.join(harness.root, 'chat-embedding-settings.json'))).toBe(true);
    expect(
      fs.existsSync(path.join(harness.root, '.chat-embedding-settings-owner-claim-v1.json')),
    ).toBe(false);
  });

  it('temporarily honors a legacy opt-out when exclusive migration is unavailable', async () => {
    fs.writeFileSync(
      path.join(harness.root, 'chat-embedding-settings.json'),
      JSON.stringify({ enabled: false }),
      'utf-8',
    );
    harness.exclusive = false;
    const { readChatEmbeddingSettingsState, resetChatEmbeddingSettings } = await loadStore();

    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: false },
      isCustomized: true,
    });
    await expect(resetChatEmbeddingSettings(orgContext)).rejects.toThrow(
      /migration is still pending/,
    );
    expect(fs.existsSync(path.join(harness.root, 'chat-embedding-settings.json'))).toBe(true);
  });

  it('defers an incomplete same-owner claim without exclusivity and resumes it later', async () => {
    fs.writeFileSync(
      path.join(harness.root, 'chat-embedding-settings.json'),
      JSON.stringify({ enabled: false }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(harness.root, '.chat-embedding-settings-owner-claim-v1.json'),
      JSON.stringify({ version: 1, ownerKey: 'key-owner-a', complete: false }),
      'utf-8',
    );
    harness.exclusive = false;
    const { readChatEmbeddingSettingsState } = await loadStore();

    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: false },
      isCustomized: true,
    });
    expect(
      fs.existsSync(
        path.join(harness.root, 'owners', 'key-owner-a', 'chat-embedding-settings.json'),
      ),
    ).toBe(false);

    harness.exclusive = true;
    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: false },
      isCustomized: true,
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(harness.root, '.chat-embedding-settings-owner-claim-v1.json'),
          'utf-8',
        ),
      ),
    ).toEqual({ version: 1, ownerKey: 'key-owner-a', complete: true });
  });

  it('fails closed on a blocked legacy setting until explicit reset acknowledges it', async () => {
    fs.writeFileSync(path.join(harness.root, 'chat-embedding-settings.json'), '{broken', 'utf-8');
    const { readChatEmbeddingSettingsState, resetChatEmbeddingSettings } = await loadStore();

    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: false },
      isCustomized: true,
    });
    await resetChatEmbeddingSettings(orgContext);
    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: true },
      isCustomized: false,
    });
  });

  it('fails closed on an unreadable owner override and allows explicit reset recovery', async () => {
    const ownerDir = path.join(harness.root, 'owners', 'key-owner-a');
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.writeFileSync(path.join(ownerDir, 'chat-embedding-settings.json'), '{broken', 'utf-8');
    const { readChatEmbeddingSettingsState, resetChatEmbeddingSettings } = await loadStore();

    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: false },
      isCustomized: true,
    });
    await resetChatEmbeddingSettings(orgContext);
    expect(readChatEmbeddingSettingsState(orgContext)).toMatchObject({
      value: { enabled: true },
      isCustomized: false,
    });
  });
});
