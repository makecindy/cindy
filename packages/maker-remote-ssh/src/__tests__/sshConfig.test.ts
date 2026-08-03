/**
 * Tests for sshConfig — read/write `~/.ssh/config` blocks.
 *
 * Why these tests matter:
 *   sshConfig is the persistence layer for every host the user adds. A
 *   regression in the round-trip silently corrupts `~/.ssh/config` and
 *   takes down the user's normal terminal SSH too — not just ours.
 *
 *   The separator regression is the load-bearing one: an earlier version
 *   synthesised new directive nodes without a `separator` field, and
 *   ssh-config's `toString()` emitted `IdentityFileundefined/path` which
 *   was unparseable. The bug touched real user files. The
 *   `updateHostFields inserts a new IdentityFile cleanly` test pins
 *   that fix so it can't silently come back.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readSshConfig,
  removeHost,
  updateHostFields,
  upsertHost,
} from '../sshConfig.js';
import type { HostConfig } from '../types.js';

// ── per-test scratch file ────────────────────────────────────────────────────

let scratchDir: string;
let scratchFile: string;

beforeEach(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshconfig-test-'));
  scratchFile = path.join(scratchDir, 'config');
});

afterEach(async () => {
  await fs.rm(scratchDir, { recursive: true, force: true });
});

function host(over: Partial<HostConfig> & Pick<HostConfig, 'id'>): HostConfig {
  return {
    hostname: 'example.com',
    port: 22,
    user: 'me',
    authMethod: 'agent',
    source: 'ssh-config',
    ...over,
  };
}

// ── readSshConfig ────────────────────────────────────────────────────────────

describe('readSshConfig', () => {
  it('returns empty array when the file does not exist', async () => {
    expect(await readSshConfig(scratchFile)).toEqual([]);
  });

  it('recognizes Host directives case-insensitively', async () => {
    await fs.writeFile(scratchFile, [
      'host lowercase',
      '  hostname 10.0.0.1',
      '  user alice',
      '',
      'hOsT mixedcase',
      '  HoStNaMe 10.0.0.2',
      '  UsEr bob',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts).toMatchObject([
      { id: 'lowercase', hostname: '10.0.0.1', user: 'alice' },
      { id: 'mixedcase', hostname: '10.0.0.2', user: 'bob' },
    ]);
  });

  it('skips wildcard / pattern / negated host entries', async () => {
    await fs.writeFile(scratchFile, [
      'Host *',
      '  ServerAliveInterval 60',
      '',
      'Host concrete',
      '  HostName 10.0.0.1',
      '  User alice',
      '',
      'Host has?wildcard',
      '  HostName 10.0.0.2',
      '',
      'Host !excluded',
      '  HostName 10.0.0.3',
      '',
    ].join('\n'));
    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map(h => h.id)).toEqual(['concrete']);
  });
});

// ── upsertHost + readSshConfig round-trip ────────────────────────────────────

describe('upsertHost round-trip', () => {
  it('replaces an existing lowercase host block when alias collides', async () => {
    await fs.writeFile(scratchFile, [
      'host foo',
      '  hostname old',
      '  user me',
      '  ProxyJump bastion',
      '',
    ].join('\n'));

    await upsertHost(host({ id: 'foo', hostname: 'new', user: 'me' }), scratchFile);

    const raw = await fs.readFile(scratchFile, 'utf8');
    expect(raw).not.toMatch(/hostname old/i);
    expect(raw).toMatch(/Host foo/);
    expect(raw).toMatch(/HostName new/);
    expect(raw).not.toMatch(/ProxyJump bastion/);
    expect(await readSshConfig(scratchFile)).toMatchObject([
      { id: 'foo', hostname: 'new' },
    ]);
  });

  it('round-trips an agent-only host (no IdentityFile)', async () => {
    const h = host({ id: 'foo', hostname: '10.0.0.1', user: 'alice', authMethod: 'agent' });
    await upsertHost(h, scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      id: 'foo',
      hostname: '10.0.0.1',
      user: 'alice',
      port: 22,
      authMethod: 'agent',
      identityFile: undefined,
    });
  });

  it('round-trips a key-file host (authMethod=key)', async () => {
    const h = host({
      id: 'bar',
      hostname: '10.0.0.2',
      user: 'bob',
      port: 2222,
      authMethod: 'key',
      identityFile: '/home/bob/.ssh/id_ed25519',
    });
    await upsertHost(h, scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      id: 'bar',
      hostname: '10.0.0.2',
      user: 'bob',
      port: 2222,
      authMethod: 'key',
      identityFile: '/home/bob/.ssh/id_ed25519',
    });
  });

  it('round-trips an agent + pinned key host (authMethod=agent, identityFile set)', async () => {
    const h = host({
      id: 'baz',
      hostname: '10.0.0.3',
      user: 'carol',
      authMethod: 'agent',
      identityFile: '/home/carol/.ssh/id_ed25519.pub',
    });
    await upsertHost(h, scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back).toHaveLength(1);
    expect(back[0].authMethod).toBe('agent');
    expect(back[0].identityFile).toBe('/home/carol/.ssh/id_ed25519.pub');
  });

  it('replaces an existing host block when alias collides', async () => {
    await upsertHost(host({ id: 'foo', hostname: 'old', user: 'me' }), scratchFile);
    await upsertHost(host({ id: 'foo', hostname: 'new', user: 'me' }), scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back).toHaveLength(1);
    expect(back[0].hostname).toBe('new');
  });
});

// ── updateHostFields — the separator regression test ────────────────────────

describe('updateHostFields', () => {
  it('inserts a new IdentityFile directive with a separator so the file is re-readable', async () => {
    // Set up: agent-only host on disk, no IdentityFile.
    await upsertHost(host({ id: 'foo', hostname: '10.0.0.1', user: 'alice', authMethod: 'agent' }), scratchFile);

    // Switch it to key-file mode → updateHostFields must INSERT a new
    // IdentityFile directive (separator must be set, else serializer
    // emits 'IdentityFileundefined/path/key' which is unparseable).
    await updateHostFields(host({
      id: 'foo',
      hostname: '10.0.0.1',
      user: 'alice',
      authMethod: 'key',
      identityFile: '/home/alice/.ssh/id_ed25519',
    }), scratchFile);

    // Regression assert #1: raw file contents have no `IdentityFileundefined`.
    const raw = await fs.readFile(scratchFile, 'utf8');
    expect(raw).not.toContain('undefined');
    expect(raw).toMatch(/IdentityFile\s+\/home\/alice\/\.ssh\/id_ed25519/);

    // Regression assert #2: the file is re-parseable and yields the expected host.
    const back = await readSshConfig(scratchFile);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      id: 'foo',
      authMethod: 'key',
      identityFile: '/home/alice/.ssh/id_ed25519',
    });
  });

  it('removes IdentityFile + IdentitiesOnly when switching back to agent', async () => {
    await upsertHost(host({
      id: 'foo',
      hostname: '10.0.0.1',
      user: 'alice',
      authMethod: 'key',
      identityFile: '/home/alice/.ssh/id_ed25519',
    }), scratchFile);

    await updateHostFields(host({
      id: 'foo',
      hostname: '10.0.0.1',
      user: 'alice',
      authMethod: 'agent',
    }), scratchFile);

    const raw = await fs.readFile(scratchFile, 'utf8');
    expect(raw).not.toMatch(/IdentityFile/);
    expect(raw).not.toMatch(/IdentitiesOnly/);

    const back = await readSshConfig(scratchFile);
    expect(back[0].authMethod).toBe('agent');
    expect(back[0].identityFile).toBeUndefined();
  });

  it('preserves hand-written directives the user added (ProxyJump, ServerAliveInterval)', async () => {
    // Seed: a host with extra directives the user manually wrote.
    await fs.writeFile(scratchFile, [
      'Host foo',
      '  HostName 10.0.0.1',
      '  User alice',
      '  ProxyJump bastion',
      '  ServerAliveInterval 60',
      '',
    ].join('\n'));

    // Surgical update — change port only.
    await updateHostFields(host({
      id: 'foo',
      hostname: '10.0.0.1',
      user: 'alice',
      port: 2222,
      authMethod: 'agent',
    }), scratchFile);

    const raw = await fs.readFile(scratchFile, 'utf8');
    expect(raw).toMatch(/ProxyJump\s+bastion/);
    expect(raw).toMatch(/ServerAliveInterval\s+60/);
    expect(raw).toMatch(/Port\s+2222/);
  });

  it('updates a lowercase host block without replacing hand-written directives', async () => {
    await fs.writeFile(scratchFile, [
      'host foo',
      '  hostname 10.0.0.1',
      '  user alice',
      '  ProxyJump bastion',
      '',
    ].join('\n'));

    await updateHostFields(host({
      id: 'foo',
      hostname: '10.0.0.2',
      user: 'bob',
      port: 2222,
      authMethod: 'agent',
    }), scratchFile);

    const raw = await fs.readFile(scratchFile, 'utf8');
    expect(raw).toMatch(/^host foo/m);
    expect(raw).toMatch(/HostName\s+10\.0\.0\.2/i);
    expect(raw).toMatch(/User\s+bob/i);
    expect(raw).toMatch(/Port\s+2222/i);
    expect(raw).toMatch(/ProxyJump\s+bastion/);

    const back = await readSshConfig(scratchFile);
    expect(back).toMatchObject([
      { id: 'foo', hostname: '10.0.0.2', user: 'bob', port: 2222 },
    ]);
  });

  it('upserts when the host block does not exist on disk', async () => {
    // Empty file → updateHostFields should fall back to upsertHost rather than throw.
    await fs.writeFile(scratchFile, '');
    await updateHostFields(host({ id: 'fresh', hostname: '10.0.0.9', user: 'me' }), scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe('fresh');
  });

  it('toggles the auth marker so agent-pinned vs key is recoverable on re-read', async () => {
    // First write as agent + pinned key.
    await upsertHost(host({
      id: 'foo',
      hostname: '10.0.0.1',
      user: 'alice',
      authMethod: 'agent',
      identityFile: '/home/alice/.ssh/id_ed25519.pub',
    }), scratchFile);
    let back = await readSshConfig(scratchFile);
    expect(back[0].authMethod).toBe('agent');

    // Toggle to key mode (same identityFile path on disk).
    await updateHostFields(host({
      id: 'foo',
      hostname: '10.0.0.1',
      user: 'alice',
      authMethod: 'key',
      identityFile: '/home/alice/.ssh/id_ed25519',
    }), scratchFile);
    back = await readSshConfig(scratchFile);
    expect(back[0].authMethod).toBe('key');
  });
});

// ── removeHost ───────────────────────────────────────────────────────────────

describe('removeHost', () => {
  it('removes a lowercase host block', async () => {
    await fs.writeFile(scratchFile, [
      'hOsT foo',
      '  HoStNaMe 10.0.0.1',
      '  User alice',
      '',
      'Host bar',
      '  HostName 10.0.0.2',
      '  User bob',
      '',
    ].join('\n'));

    await removeHost('foo', scratchFile);

    expect(await readSshConfig(scratchFile)).toMatchObject([
      { id: 'bar', hostname: '10.0.0.2', user: 'bob' },
    ]);
  });

  it('drops the named host block', async () => {
    await upsertHost(host({ id: 'a' }), scratchFile);
    await upsertHost(host({ id: 'b' }), scratchFile);
    await removeHost('a', scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back.map(h => h.id)).toEqual(['b']);
  });

  it('is a no-op when the host is absent', async () => {
    await upsertHost(host({ id: 'a' }), scratchFile);
    await removeHost('nonexistent', scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back.map(h => h.id)).toEqual(['a']);
  });

  it('is a no-op when the file is missing entirely', async () => {
    // No setup — file doesn't exist.
    await expect(removeHost('any', scratchFile)).resolves.not.toThrow();
  });
});
