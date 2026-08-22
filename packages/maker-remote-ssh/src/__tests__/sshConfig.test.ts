/**
 * Tests for sshConfig — read/write `~/.ssh/config` blocks.
 *
 * Why these tests matter:
 *   Discovery feeds every SSH-config host Cindy can connect to. Legacy write
 *   helpers remain exported for compatibility/tests, so their round-trip must
 *   still never corrupt `~/.ssh/config` even though Desktop no longer calls
 *   them from the host-management product path.
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
  expandHome,
  readSshConfig,
  readSshConfigDetailed,
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
      { id: 'ssh-config:lowercase', hostname: '10.0.0.1', user: 'alice' },
      { id: 'ssh-config:mixedcase', hostname: '10.0.0.2', user: 'bob' },
    ]);
  });

  it('enumerates every alias from a multi-value Host directive', async () => {
    await fs.writeFile(scratchFile, [
      'Host first.example second.example',
      '  HostName 192.0.2.6',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((item) => item.id)).toEqual([
      'ssh-config:first.example',
      'ssh-config:second.example',
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
    expect(hosts.map(h => h.id)).toEqual(['ssh-config:concrete']);
  });

  it('skips bracket character-class Host patterns', async () => {
    await fs.writeFile(scratchFile, [
      'Host web[0-9]',
      '  HostName 192.0.2.10',
      '',
      'Host concrete-web',
      '  HostName 192.0.2.11',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((h) => h.alias)).toEqual(['concrete-web']);
  });

  it('expands top-level Include files and computes their effective HostName', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, 'Include config.d/*\n');
    await fs.writeFile(path.join(configDir, 'work.conf'), [
      'Host ci.example',
      '  HostName 192.0.2.7',
      '  User developer',
      '  IdentityFile ~/.ssh/work.key',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts).toMatchObject([
      {
        id: 'ssh-config:ci.example',
        hostname: '192.0.2.7',
        user: 'developer',
        authMethod: 'agent',
        configOrigin: 'include',
      },
    ]);
    expect(hosts[0]?.identityFile).toBe(path.join(os.homedir(), '.ssh', 'work.key'));
  });

  it('returns canonical HostRefs while preserving the original SSH alias', async () => {
    await fs.writeFile(scratchFile, 'Host cindy:build\n  HostName 192.0.2.40\n');

    const hosts = await readSshConfig(scratchFile);
    expect(hosts[0]).toMatchObject({
      id: 'ssh-config:cindy:build',
      alias: 'cindy:build',
      hostname: '192.0.2.40',
    });
  });

  it('supports Key=Value syntax for Include and included Host directives', async () => {
    await fs.writeFile(scratchFile, 'Include=config.d/work.conf\n');
    await fs.mkdir(path.join(scratchDir, 'config.d'));
    await fs.writeFile(path.join(scratchDir, 'config.d', 'work.conf'), [
      'Host=ci.equals.example',
      'HostName=192.0.2.41',
      'IdentityFile=work.key',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts).toMatchObject([{
      id: 'ssh-config:ci.equals.example',
      alias: 'ci.equals.example',
      configOrigin: 'include',
      authMethod: 'agent',
      identityFile: path.join(scratchDir, 'work.key'),
    }]);
  });

  it('keeps quoted Host aliases owned by Include files', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, 'Include config.d/work.conf\n');
    await fs.writeFile(path.join(configDir, 'work.conf'), [
      'Host "ci.example"',
      '  HostName 192.0.2.17',
      '  IdentityFile work.key',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts).toMatchObject([{
      id: 'ssh-config:ci.example',
      hostname: '192.0.2.17',
      configOrigin: 'include',
      authMethod: 'agent',
    }]);
  });

  it('keeps Include content separate when an included file has no trailing newline', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, [
      'Include config.d/work.conf',
      'Host root.example',
      '  HostName 192.0.2.9',
      '',
    ].join('\n'));
    await fs.writeFile(
      path.join(configDir, 'work.conf'),
      'Host included.example\n  HostName 192.0.2.8',
    );

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((item) => [item.id, item.hostname])).toEqual([
      ['ssh-config:included.example', '192.0.2.8'],
      ['ssh-config:root.example', '192.0.2.9'],
    ]);
  });

  it('keeps a main-file host after an Include on the legacy key auth policy', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, [
      'Include config.d/work.conf',
      '',
      'Host root.example',
      '  HostName 192.0.2.9',
      '  IdentityFile root.key',
      '',
    ].join('\n'));
    await fs.writeFile(
      path.join(configDir, 'work.conf'),
      'Host included.example\n  HostName 192.0.2.8\n',
    );

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.find((item) => item.id === 'ssh-config:root.example')).toMatchObject({
      configOrigin: 'main',
      authMethod: 'key',
      identityFile: path.join(scratchDir, 'root.key'),
    });
  });

  it('honors OpenSSH first-value-wins for Host * without listing the wildcard', async () => {
    await fs.writeFile(scratchFile, [
      'Host *',
      '  User root',
      '',
      'Host ci.example',
      '  User developer',
      '  HostName 192.0.2.7',
      '',
    ].join('\n'));

    await expect(readSshConfig(scratchFile)).resolves.toMatchObject([
      { id: 'ssh-config:ci.example', user: 'root', hostname: '192.0.2.7' },
    ]);
  });

  it('does not chain-compute HostName when it names another alias', async () => {
    await fs.writeFile(scratchFile, [
      'Host short-name',
      '  HostName ci.example',
      '',
      'Host ci.example',
      '  HostName 192.0.2.7',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.find((h) => h.id === 'ssh-config:short-name')?.hostname).toBe('ci.example');
    expect(hosts.find((h) => h.id === 'ssh-config:ci.example')?.hostname).toBe('192.0.2.7');
  });

  it('does not evaluate or apply unsupported Match blocks', async () => {
    await fs.writeFile(scratchFile, [
      'Host ci.example',
      '  HostName 192.0.2.7',
      '',
      'Match exec "exit 0"',
      '  User from-exec',
      '',
      'Match all',
      '  Port 2222',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts).toMatchObject([{
      id: 'ssh-config:ci.example',
      user: os.userInfo().username,
      port: 22,
    }]);
  });

  it('honors an auth marker found in a later matching Host block', async () => {
    await fs.writeFile(scratchFile, [
      'Host duplicate.example',
      '  HostName 192.0.2.40',
      '  IdentityFile work.key',
      '',
      'Host duplicate.example',
      '  # xdt-maker:auth=agent',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts).toMatchObject([{ id: 'ssh-config:duplicate.example', authMethod: 'agent' }]);
  });

  it('uses conservative agent pinning when one alias is declared in main and Include files', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, [
      'Include config.d/work.conf',
      'Host duplicate.example',
      '  HostName 192.0.2.41',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(configDir, 'work.conf'), [
      'Host duplicate.example',
      '  IdentityFile work.key',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts).toMatchObject([{
      id: 'ssh-config:duplicate.example',
      authMethod: 'agent',
      configOrigin: 'include',
    }]);
  });

  it('uses the first matching wildcard block to determine config origin and auth', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, [
      'Include config.d/work.conf',
      'Host ci.example',
      '  HostName 192.0.2.42',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(configDir, 'work.conf'), [
      'Host *.example',
      '  IdentityFile work.key',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts).toMatchObject([{
      id: 'ssh-config:ci.example',
      hostname: '192.0.2.42',
      authMethod: 'agent',
      configOrigin: 'include',
    }]);
  });

  it('ignores unquoted Include comments but preserves a quoted hash in a path', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, [
      'Include config.d/work.conf # managed by the user',
      'Include "config.d/#special.conf" # quoted hash is part of the path',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(configDir, 'work.conf'), 'Host work.example\n');
    await fs.writeFile(path.join(configDir, '#special.conf'), 'Host special.example\n');
    await fs.writeFile(path.join(scratchDir, 'managed'), 'Host comment-token.example\n');
    await fs.writeFile(path.join(scratchDir, 'by'), 'Host another-comment-token.example\n');

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((host) => host.id)).toEqual([
      'ssh-config:work.example',
      'ssh-config:special.example',
    ]);
  });

  it('skips missing Includes and reports Include cycles without throwing', async () => {
    await fs.writeFile(scratchFile, 'Include missing.d\nInclude loop-a\n');
    await fs.writeFile(path.join(scratchDir, 'loop-a'), 'Include loop-b\nHost loop-a\n  HostName 192.0.2.8\n');
    await fs.writeFile(path.join(scratchDir, 'loop-b'), 'Include loop-a\nHost loop-b\n  HostName 192.0.2.9\n');

    const result = await readSshConfigDetailed(scratchFile);
    expect(result.diagnostic).toBeNull();
    expect(result.hosts.map((h) => h.id)).toEqual(['ssh-config:loop-b', 'ssh-config:loop-a']);
  });

  it('reports excessive Include depth instead of returning a partial list', async () => {
    await fs.writeFile(scratchFile, 'Include level-1.conf\n');
    for (let level = 1; level <= 17; level += 1) {
      await fs.writeFile(
        path.join(scratchDir, `level-${level}.conf`),
        level === 17 ? 'Host too-deep.example\n' : `Include level-${level + 1}.conf\n`,
      );
    }

    const result = await readSshConfigDetailed(scratchFile);
    expect(result.hosts).toEqual([]);
    expect(result.diagnostic).toMatchObject({ kind: 'limit' });
    expect(result.diagnostic?.message).toContain('16');
  });

  it('reports excessive Include file count instead of returning a partial list', async () => {
    const configDir = path.join(scratchDir, 'many');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, 'Include many/*.conf\n');
    for (let index = 0; index < 64; index += 1) {
      await fs.writeFile(
        path.join(configDir, `${String(index).padStart(2, '0')}.conf`),
        `Host host-${index}.example\n`,
      );
    }

    const result = await readSshConfigDetailed(scratchFile);
    expect(result.hosts).toEqual([]);
    expect(result.diagnostic).toMatchObject({ kind: 'limit' });
    expect(result.diagnostic?.message).toContain('64');
  });

  it('reports excessive expanded byte size instead of returning a partial list', async () => {
    await fs.writeFile(scratchFile, `# ${'x'.repeat(1024 * 1024)}\nHost oversized.example\n`);

    const result = await readSshConfigDetailed(scratchFile);
    expect(result.hosts).toEqual([]);
    expect(result.diagnostic).toMatchObject({ kind: 'limit' });
    expect(result.diagnostic?.message).toContain(String(1024 * 1024));
  });

  it('does not let a wildcard Include match hidden files', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, 'Include config.d/*\n');
    await fs.writeFile(path.join(configDir, '.hidden'), 'Host hidden.example\n');
    await fs.writeFile(path.join(configDir, 'visible'), 'Host visible.example\n');

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((item) => item.id)).toEqual(['ssh-config:visible.example']);
  });

  it('skips directories matched by an Include glob', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.mkdir(path.join(configDir, 'nested'));
    await fs.writeFile(scratchFile, 'Include config.d/*\n');
    await fs.writeFile(path.join(configDir, 'visible.conf'), 'Host visible-dir.example\n');

    const result = await readSshConfigDetailed(scratchFile);
    expect(result.diagnostic).toBeNull();
    expect(result.hosts.map((item) => item.alias)).toEqual(['visible-dir.example']);
  });

  it('implements glob character classes without treating ! as a literal', async () => {
    const configDir = path.join(scratchDir, 'classes');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, 'Include classes/[!a]* classes/[0-9]*\n');
    await fs.writeFile(path.join(configDir, 'a.conf'), 'Host excluded-a.example\n');
    await fs.writeFile(path.join(configDir, 'b.conf'), 'Host included-b.example\n');
    await fs.writeFile(path.join(configDir, '1.conf'), 'Host included-1.example\n');

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((item) => item.alias)).toEqual([
      'included-1.example',
      'included-b.example',
    ]);
  });

  it('does not execute hostname canonicalization DNS during config discovery', async () => {
    const binDir = path.join(scratchDir, 'bin');
    const marker = path.join(scratchDir, 'nslookup-ran');
    await fs.mkdir(binDir);
    const nslookup = path.join(binDir, 'nslookup');
    await fs.writeFile(nslookup, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    await fs.chmod(nslookup, 0o755);
    await fs.writeFile(scratchFile, [
      'Host canonical.example',
      '  CanonicalizeHostname yes',
      '  CanonicalDomains example.test',
      '',
    ].join('\n'));
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
    try {
      const hosts = await readSshConfig(scratchFile);
      expect(hosts[0]?.hostname).toBe('canonical.example');
      await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('resolves nested relative Includes and IdentityFile paths from the root config directory', async () => {
    const configDir = path.join(scratchDir, 'config.d');
    await fs.mkdir(configDir);
    await fs.writeFile(scratchFile, 'Include config.d/entry.conf\n');
    await fs.writeFile(path.join(configDir, 'entry.conf'), 'Include nested.conf\n');
    await fs.writeFile(path.join(scratchDir, 'nested.conf'), [
      'Host nested.example',
      '  HostName 192.0.2.20',
      '  IdentityFile keys/work.key',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts).toMatchObject([
      {
        id: 'ssh-config:nested.example',
        hostname: '192.0.2.20',
        identityFile: path.join(scratchDir, 'keys', 'work.key'),
      },
    ]);
  });

  it('does not expand conditional Includes inside Host blocks', async () => {
    await fs.writeFile(scratchFile, [
      'Host outer.example',
      '  HostName 192.0.2.30',
      '  Include conditional.conf',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'conditional.conf'), [
      'Host hidden.example',
      '  HostName 192.0.2.31',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((host) => host.id)).toEqual(['ssh-config:outer.example']);
  });

  it('expands a top-level Include between Host blocks', async () => {
    await fs.writeFile(scratchFile, [
      'Host a.example',
      '  HostName 192.0.2.1',
      'Include extra.conf',
      'Host b.example',
      '  HostName 192.0.2.2',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'extra.conf'), [
      'Host included.example',
      '  HostName 192.0.2.3',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((host) => host.id)).toEqual([
      'ssh-config:a.example',
      'ssh-config:included.example',
      'ssh-config:b.example',
    ]);
    expect(hosts.find((host) => host.alias === 'included.example')).toMatchObject({
      hostname: '192.0.2.3',
      configOrigin: 'include',
    });
  });

  it('does not expand an indented Include between later Host blocks', async () => {
    await fs.writeFile(scratchFile, [
      'Host a.example',
      '  HostName 192.0.2.1',
      '  Include extra.conf',
      'Host b.example',
      '  HostName 192.0.2.2',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'extra.conf'), [
      'Host hidden.example',
      '  HostName 192.0.2.3',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((host) => host.id)).toEqual([
      'ssh-config:a.example',
      'ssh-config:b.example',
    ]);
  });

  it('does not expand an indented Include inside a Match block', async () => {
    await fs.writeFile(scratchFile, [
      'Match host match.example',
      '  Include extra.conf',
      'Host visible.example',
      '  HostName 192.0.2.4',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'extra.conf'), [
      'Host hidden.example',
      '  HostName 192.0.2.5',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(scratchFile);
    expect(hosts.map((host) => host.id)).toEqual(['ssh-config:visible.example']);
  });

  it('reports unreadable Include directories instead of returning a truncated list', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const lockedDir = path.join(scratchDir, 'locked');
    await fs.mkdir(lockedDir);
    await fs.writeFile(path.join(lockedDir, 'host.conf'), 'Host hidden.example\n');
    await fs.chmod(lockedDir, 0o000);
    try {
      await fs.writeFile(scratchFile, 'Include locked/*\n');
      const result = await readSshConfigDetailed(scratchFile);
      expect(result.hosts).toEqual([]);
      expect(result.diagnostic?.kind).toBe('io');
    } finally {
      await fs.chmod(lockedDir, 0o700);
    }
  });
});

// ── expandHome — Windows 路径形态 ─────────────────────────────────────────────

describe('expandHome', () => {
  const home = os.homedir();

  it('expands a bare tilde', () => {
    expect(expandHome('~')).toBe(home);
  });

  it('expands POSIX-style ~/ prefix', () => {
    expect(expandHome('~/.ssh/id_ed25519')).toBe(path.join(home, '.ssh', 'id_ed25519'));
  });

  it('expands Windows-style ~\\ prefix', () => {
    expect(expandHome('~\\.ssh\\id_ed25519')).toBe(path.join(home, '.ssh', 'id_ed25519'));
  });

  it('leaves an already-absolute Windows drive path untouched (backslashes preserved)', () => {
    const p = String.raw`C:\Users\foo\.ssh\id_ed25519`;
    expect(expandHome(p)).toBe(p);
  });

  it('leaves forward-slash absolute paths untouched', () => {
    const p = 'C:/Users/foo/.ssh/id_ed25519';
    expect(expandHome(p)).toBe(p);
  });

  it('leaves UNC paths untouched', () => {
    const p = String.raw`\\nas\share\keys\id_ed25519`;
    expect(expandHome(p)).toBe(p);
  });

  it('leaves paths with spaces untouched', () => {
    const p = String.raw`C:\Users\my name\.ssh\id_ed25519`;
    expect(expandHome(p)).toBe(p);
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
      { id: 'ssh-config:foo', hostname: 'new' },
    ]);
  });

  it('round-trips an agent-only host (no IdentityFile)', async () => {
    const h = host({ id: 'foo', hostname: '10.0.0.1', user: 'alice', authMethod: 'agent' });
    await upsertHost(h, scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      id: 'ssh-config:foo',
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
      id: 'ssh-config:bar',
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
      id: 'ssh-config:foo',
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
      { id: 'ssh-config:foo', hostname: '10.0.0.2', user: 'bob', port: 2222 },
    ]);
  });

  it('upserts when the host block does not exist on disk', async () => {
    // Empty file → updateHostFields should fall back to upsertHost rather than throw.
    await fs.writeFile(scratchFile, '');
    await updateHostFields(host({ id: 'fresh', hostname: '10.0.0.9', user: 'me' }), scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe('ssh-config:fresh');
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
      { id: 'ssh-config:bar', hostname: '10.0.0.2', user: 'bob' },
    ]);
  });

  it('drops the named host block', async () => {
    await upsertHost(host({ id: 'a' }), scratchFile);
    await upsertHost(host({ id: 'b' }), scratchFile);
    await removeHost('a', scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back.map(h => h.id)).toEqual(['ssh-config:b']);
  });

  it('is a no-op when the host is absent', async () => {
    await upsertHost(host({ id: 'a' }), scratchFile);
    await removeHost('nonexistent', scratchFile);
    const back = await readSshConfig(scratchFile);
    expect(back.map(h => h.id)).toEqual(['ssh-config:a']);
  });

  it('is a no-op when the file is missing entirely', async () => {
    // No setup — file doesn't exist.
    await expect(removeHost('any', scratchFile)).resolves.not.toThrow();
  });
});
