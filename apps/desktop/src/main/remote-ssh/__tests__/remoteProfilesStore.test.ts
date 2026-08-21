import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  userDataPath: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataPath,
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function profilesPath(): string {
  return path.join(testState.userDataPath, 'remote-profiles.json');
}

beforeEach(() => {
  testState.userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-remote-profiles-'));
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(testState.userDataPath, { recursive: true, force: true });
});

describe('remote-profiles-store', () => {
  it('round-trips a versioned Cindy-local profile without touching SSH config', async () => {
    const store = await import('../remote-profiles-store.js');
    const added = store.addRemoteProfile({
      displayName: 'Build box',
      hostname: '192.0.2.10',
      port: 2222,
      user: 'developer',
      authMethod: 'agent',
      identityFile: '/keys/work.key',
      autoConnect: false,
    });

    const persisted = JSON.parse(fs.readFileSync(profilesPath(), 'utf8')) as {
      schemaVersion: number;
      profiles: Array<{ profileId: string }>;
    };
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.profiles).toEqual([expect.objectContaining({ profileId: added.profileId })]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(profilesPath()).mode & 0o777).toBe(0o600);
    }

    vi.resetModules();
    const reloaded = await import('../remote-profiles-store.js');
    expect(reloaded.readRemoteProfiles()).toEqual({ profiles: [added], error: null });
    expect(reloaded.remoteProfileToHostConfig(added)).toMatchObject({
      id: `cindy:${added.profileId}`,
      displayName: 'Build box',
      hostname: '192.0.2.10',
      source: 'manual',
      editable: true,
      deletable: true,
    });
  });

  it('keeps the last valid snapshot and refuses to overwrite a malformed file', async () => {
    const store = await import('../remote-profiles-store.js');
    const added = store.addRemoteProfile({
      displayName: 'Build box',
      hostname: '192.0.2.10',
      port: 22,
      user: 'developer',
      authMethod: 'agent',
      autoConnect: false,
    });
    expect(store.readRemoteProfiles().error).toBeNull();

    fs.writeFileSync(profilesPath(), '{ malformed');
    const failedRead = store.readRemoteProfiles();
    expect(failedRead.profiles).toEqual([added]);
    expect(failedRead.error?.kind).toBe('syntax');

    expect(() => store.updateRemoteProfile({ ...added, displayName: 'Do not write' }))
      .toThrow('refusing to overwrite user data');
    expect(fs.readFileSync(profilesPath(), 'utf8')).toBe('{ malformed');
  });

  it('keeps the previous file and cache when atomic replacement fails', async () => {
    const store = await import('../remote-profiles-store.js');
    const added = store.addRemoteProfile({
      displayName: 'Build box',
      hostname: '192.0.2.10',
      port: 22,
      user: 'developer',
      authMethod: 'agent',
      autoConnect: false,
    });
    const before = fs.readFileSync(profilesPath(), 'utf8');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('read-only destination'), { code: 'EACCES' });
    });

    expect(() => store.updateRemoteProfile({ ...added, displayName: 'Do not publish' }))
      .toThrow('read-only destination');
    rename.mockRestore();

    expect(fs.readFileSync(profilesPath(), 'utf8')).toBe(before);
    expect(store.readRemoteProfiles()).toEqual({ profiles: [added], error: null });
  });

  it('rejects invalid agent-proxy data as a schema error', async () => {
    fs.writeFileSync(profilesPath(), JSON.stringify({
      schemaVersion: 1,
      profiles: [{
        profileId: 'p1',
        displayName: 'Build box',
        hostname: '192.0.2.10',
        port: 22,
        user: 'developer',
        authMethod: 'agent',
        autoConnect: false,
        agentProxy: {
          enabled: true,
          mode: 'tunnel',
          localHost: 'bad host',
          localPort: 7890,
          remotePort: 17893,
        },
      }],
    }));

    const store = await import('../remote-profiles-store.js');
    const result = store.readRemoteProfiles();
    expect(result.profiles).toEqual([]);
    expect(result.error?.kind).toBe('schema');
  });

  it('resolves hand-edited relative and home key paths without using process.cwd()', async () => {
    const store = await import('../remote-profiles-store.js');
    const base = {
      profileId: 'p1',
      displayName: 'Build box',
      hostname: '192.0.2.10',
      port: 22,
      user: 'developer',
      authMethod: 'agent' as const,
      autoConnect: false,
    };
    expect(store.remoteProfileToHostConfig({ ...base, identityFile: 'work.key' }).identityFile)
      .toBe(path.join(os.homedir(), '.ssh', 'work.key'));
    expect(store.remoteProfileToHostConfig({ ...base, identityFile: '~/.ssh/work.key' }).identityFile)
      .toBe(path.join(os.homedir(), '.ssh', 'work.key'));
  });
});
