import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({ userDataPath: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => testState.userDataPath },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function prefsPath(): string {
  return path.join(testState.userDataPath, 'ssh-host-prefs.json');
}

beforeEach(() => {
  testState.userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ssh-host-prefs-'));
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(testState.userDataPath, { recursive: true, force: true });
});

describe('ssh-host-prefs-store HostRef compatibility', () => {
  it('prefers the canonical HostRef over a legacy bare-alias key', async () => {
    fs.writeFileSync(prefsPath(), JSON.stringify({
      'ci.example': { displayName: 'Legacy name', autoConnect: true },
      'ssh-config:ci.example': { displayName: 'Canonical name', autoConnect: false },
    }));

    const prefs = await import('../ssh-host-prefs-store.js');
    expect(prefs.getSshHostDisplayName('ssh-config:ci.example', 'ci.example')).toBe('Canonical name');
    expect(prefs.getSshHostAutoConnect('ssh-config:ci.example')).toBe(false);

    prefs.setSshHostDisplayName('ssh-config:ci.example', 'ci.example', 'Renamed');
    const persisted = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as Record<string, unknown>;
    expect(persisted['ci.example']).toBeUndefined();
    expect(persisted['ssh-config:ci.example']).toMatchObject({ displayName: 'Renamed' });
  });

  it('falls back to a legacy bare alias until that host preference is next written', async () => {
    fs.writeFileSync(prefsPath(), JSON.stringify({
      'ci.example': { displayName: 'Legacy name', autoConnect: true },
    }));

    const prefs = await import('../ssh-host-prefs-store.js');
    expect(prefs.getSshHostDisplayName('ssh-config:ci.example', 'ci.example')).toBe('Legacy name');
    expect(prefs.getSshHostAutoConnect('ssh-config:ci.example')).toBe(true);
  });

  it('moves a legacy auto-connect preference to its canonical HostRef on write', async () => {
    fs.writeFileSync(prefsPath(), JSON.stringify({
      'ci.example': { autoConnect: true },
    }));

    const prefs = await import('../ssh-host-prefs-store.js');
    prefs.setSshHostAutoConnect('ssh-config:ci.example', false);

    const persisted = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as Record<string, unknown>;
    expect(persisted['ci.example']).toBeUndefined();
    expect(persisted['ssh-config:ci.example']).toEqual({ autoConnect: false });
  });

  it('updates display name and agent proxy in one canonical preference record', async () => {
    fs.writeFileSync(prefsPath(), JSON.stringify({
      'ci.example': { autoConnect: true },
    }));

    const prefs = await import('../ssh-host-prefs-store.js');
    prefs.updateSshHostPreferences('ssh-config:ci.example', 'ci.example', {
      displayName: 'Build server',
      agentProxy: {
        enabled: true,
        mode: 'tunnel',
        localHost: '127.0.0.1',
        localPort: 7890,
        remotePort: 47990,
      },
    });

    const persisted = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as Record<string, unknown>;
    expect(persisted['ci.example']).toBeUndefined();
    expect(persisted['ssh-config:ci.example']).toEqual({
      displayName: 'Build server',
      autoConnect: true,
      agentProxy: {
        enabled: true,
        mode: 'tunnel',
        localHost: '127.0.0.1',
        localPort: 7890,
        remotePort: 47990,
      },
    });
  });

  it('fails closed without replacing malformed preference data', async () => {
    const malformed = Buffer.from('{"ssh-config:ci.example":');
    fs.writeFileSync(prefsPath(), malformed);

    const prefs = await import('../ssh-host-prefs-store.js');
    expect(prefs.readSshHostPrefs()).toEqual({});
    expect(() => prefs.setSshHostAutoConnect('ssh-config:ci.example', true))
      .toThrow(/refusing to overwrite user data/);
    expect(fs.readFileSync(prefsPath())).toEqual(malformed);
  });

  it('does not use a canonical host key as legacy prefs for an alias containing a namespace', async () => {
    fs.writeFileSync(prefsPath(), JSON.stringify({
      'ssh-config:foo': { displayName: 'Ordinary foo', autoConnect: true },
      'cindy:foo': { displayName: 'Unrelated Cindy host', autoConnect: true },
    }));

    const prefs = await import('../ssh-host-prefs-store.js');
    expect(prefs.getSshHostDisplayName('ssh-config:ssh-config:foo', 'ssh-config:foo'))
      .toBe('ssh-config:foo');
    expect(prefs.getSshHostAutoConnect('ssh-config:ssh-config:foo')).toBe(false);
    expect(prefs.getSshHostAutoConnect('ssh-config:cindy:foo')).toBe(false);

    prefs.setSshHostDisplayName(
      'ssh-config:ssh-config:foo',
      'ssh-config:foo',
      'Namespaced alias',
    );
    const persisted = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as Record<string, unknown>;
    expect(persisted['ssh-config:foo']).toEqual({ displayName: 'Ordinary foo', autoConnect: true });
    expect(persisted['cindy:foo']).toEqual({ displayName: 'Unrelated Cindy host', autoConnect: true });
    expect(persisted['ssh-config:ssh-config:foo']).toMatchObject({ displayName: 'Namespaced alias' });
  });

  it('reads a reserved-prefix legacy preference only for an active matching alias', async () => {
    fs.writeFileSync(prefsPath(), JSON.stringify({
      'cindy:build': { displayName: 'Old build', autoConnect: true },
    }));

    const prefs = await import('../ssh-host-prefs-store.js');
    prefs.setActiveSshHostAliases(new Map([['ssh-config:cindy:build', 'cindy:build']]));
    expect(prefs.getSshHostDisplayName('ssh-config:cindy:build', 'cindy:build')).toBe('Old build');
    expect(prefs.getSshHostAutoConnect('ssh-config:cindy:build', 'cindy:build')).toBe(true);

    prefs.setSshHostAutoConnect('ssh-config:cindy:build', false, 'cindy:build');
    const persisted = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as Record<string, unknown>;
    expect(persisted['cindy:build']).toBeUndefined();
    expect(persisted['ssh-config:cindy:build']).toEqual({
      displayName: 'Old build',
      autoConnect: false,
    });
  });
});
