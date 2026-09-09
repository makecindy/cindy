import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SSHConfig from 'ssh-config';

import {
  addManagedHost,
  addManagedHostWithInclude,
  ensureManagedConfigInclude,
  expandHome,
  MANAGED_CONFIG_MARKER,
  readSshConfig,
  readSshConfigDetailed,
  removeManagedHost,
  updateManagedHostFields,
} from '../sshConfig.js';
import type { HostConfig } from '../types.js';
import type { ManagedConfigWriteToken } from '../sshConfig.js';

let scratchDir: string;
let mainConfig: string;
let managedConfig: string;
const TEST_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPFqmiBYVCrZsGBJy/djBu4yIr1lYkTuOXI0A9vPN/lD cindy-test\n';
const TEST_PUBLIC_KEY_2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIkv84ni34F924G7htx9qVI7CcGG5xYDJQoabgKUbMiv cindy-test-2\n';

beforeEach(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-ssh-config-'));
  mainConfig = path.join(scratchDir, 'config');
  managedConfig = path.join(scratchDir, 'cindy.conf');
});

afterEach(async () => {
  await fs.rm(scratchDir, { recursive: true, force: true });
});

function host(overrides: Partial<HostConfig> & Pick<HostConfig, 'id'>): HostConfig {
  return {
    hostname: '192.0.2.10',
    port: 22,
    user: 'developer',
    authMethod: 'agent',
    source: 'ssh-config',
    managedByCindy: true,
    ...overrides,
  };
}

async function managedWriteToken(): Promise<ManagedConfigWriteToken> {
  await fs.writeFile(mainConfig, `Include ${managedConfig}\n`);
  const result = await readSshConfigDetailed(mainConfig, { managedConfigPath: managedConfig });
  expect(result.managedConfigWriteToken).toBeDefined();
  return result.managedConfigWriteToken!;
}

function parsedIncludeEntries(raw: string): Array<{ value: string; before: string }> {
  type ParsedNode = {
    param?: string;
    value?: string;
    before?: string;
    config?: ParsedNode[];
  };
  const entries: Array<{ value: string; before: string }> = [];
  const visit = (nodes: ParsedNode[]): void => {
    for (const node of nodes) {
      if (node.param?.toLowerCase() === 'include') {
        // ssh-config preserves escaped Windows backslashes in `value`; decode
        // the serializer's one level of escaping before comparing path meaning.
        entries.push({
          value: path.normalize((node.value ?? '').replaceAll('\\\\', '\\')),
          before: node.before ?? '',
        });
      }
      if (node.config) visit(node.config);
    }
  };
  visit(SSHConfig.parse(raw) as unknown as ParsedNode[]);
  return entries;
}

describe('OpenSSH config discovery', () => {
  it('returns an empty list for a missing main config', async () => {
    await expect(readSshConfig(mainConfig)).resolves.toEqual([]);
  });

  it('warns when the main config is missing but an unmanaged Cindy file exists', async () => {
    await fs.writeFile(managedConfig, 'Host unreachable\n');
    const result = await readSshConfigDetailed(mainConfig, { managedConfigPath: managedConfig });
    expect(result.hosts).toEqual([]);
    expect(result.warnings[0]).toContain('not reachable');
  });

  it('uses bare aliases and excludes wildcard, negated, and character-class patterns', async () => {
    await fs.writeFile(mainConfig, [
      'Host *',
      '  User root',
      'Host exact',
      '  HostName 192.0.2.1',
      'Host foo? web[0-9] !blocked',
      '  HostName 192.0.2.2',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([
      { id: 'exact', hostname: '192.0.2.1', user: 'root', managedByCindy: false },
    ]);
  });

  it('requires OpenSSH ? patterns to match exactly one character', async () => {
    await fs.writeFile(mainConfig, [
      'Host foo',
      '  HostName right.example',
      'Host foo?',
      '  User should-not-apply',
      '  Port 2200',
      'Host fooa',
      '  HostName one-character.example',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(mainConfig);
    expect(hosts.find((item) => item.id === 'foo')).toMatchObject({
      hostname: 'right.example',
      port: 22,
    });
    expect(hosts.find((item) => item.id === 'foo')?.user).not.toBe('should-not-apply');
    expect(hosts.find((item) => item.id === 'fooa')).toMatchObject({
      hostname: 'one-character.example',
      user: 'should-not-apply',
      port: 2200,
    });
  });

  it('matches OpenSSH Host patterns case-sensitively', async () => {
    await fs.writeFile(mainConfig, [
      'Host F*',
      '  User uppercase-pattern',
      'Host * !Foo',
      '  User not-excluded',
      'Host Foo',
      '  HostName 192.0.2.44',
      'Host foo',
      '  HostName 192.0.2.45',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'Foo',
      hostname: '192.0.2.44',
      user: 'uppercase-pattern',
    }, {
      id: 'foo',
      hostname: '192.0.2.45',
      user: 'not-excluded',
    }]);
  });

  it('keeps token-internal hashes in aliases and IdentityFile values', async () => {
    await fs.writeFile(mainConfig, [
      'Host foo#bar # alias comment',
      '  HostName 192.0.2.2',
      '  IdentityFile keys/id#deploy # path comment',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'foo#bar',
      hostname: '192.0.2.2',
      authMethod: 'agent',
      identityFile: undefined,
    }]);
  });

  it('expands root Include recursively, relative to the main config directory', async () => {
    await fs.mkdir(path.join(scratchDir, 'config.d'));
    await fs.writeFile(mainConfig, 'Include config.d/entry.conf\n');
    await fs.writeFile(path.join(scratchDir, 'config.d', 'entry.conf'), 'Include nested.conf\n');
    await fs.writeFile(path.join(scratchDir, 'nested.conf'), [
      'Host nested',
      '  HostName 192.0.2.3',
      '  IdentityFile keys/nested.key',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'nested',
      hostname: '192.0.2.3',
      authMethod: 'agent',
      identityFile: undefined,
    }]);
  });

  it('expands environment variables in Include paths', async () => {
    const includeDir = path.join(scratchDir, 'environment-config.d');
    await fs.mkdir(includeDir);
    await fs.writeFile(mainConfig, 'Include ${CINDY_TEST_SSH_CONF_DIR}/*.conf\n');
    await fs.writeFile(path.join(includeDir, 'environment.conf'), [
      'Host environment-include',
      '  HostName 192.0.2.31',
      '',
    ].join('\n'));
    const previous = process.env.CINDY_TEST_SSH_CONF_DIR;
    process.env.CINDY_TEST_SSH_CONF_DIR = includeDir;

    try {
      await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
        id: 'environment-include',
        hostname: '192.0.2.31',
      }]);
    } finally {
      if (previous === undefined) delete process.env.CINDY_TEST_SSH_CONF_DIR;
      else process.env.CINDY_TEST_SSH_CONF_DIR = previous;
    }
  });

  it('expands the current user name in Include home-directory paths', async () => {
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(scratchDir);
    try {
      const includeDir = path.join(scratchDir, '.ssh', 'named-user-config.d');
      await fs.mkdir(includeDir, { recursive: true });
      await fs.writeFile(
        mainConfig,
        `Include ~${os.userInfo().username}/.ssh/named-user-config.d/*.conf\n`,
      );
      await fs.writeFile(path.join(includeDir, 'named-user.conf'), [
        'Host named-user-include',
        '  HostName 192.0.2.32',
        '',
      ].join('\n'));

      await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
        id: 'named-user-include',
        hostname: '192.0.2.32',
      }]);
    } finally {
      homeSpy.mockRestore();
    }
  });

  it.each([
    ['an unset environment variable', 'Include ${CINDY_TEST_MISSING_SSH_DIR}/*.conf', 'is not set'],
    ['another user home', 'Include ~cindy-review-user-that-does-not-exist/.ssh/*.conf', 'cannot be resolved'],
    ['a malformed environment expression', 'Include ${CINDY_TEST_SSH_DIR/*.conf', 'malformed'],
  ])('warns and fails closed after Include with %s', async (_label, includeLine, warning) => {
    delete process.env.CINDY_TEST_MISSING_SSH_DIR;
    await fs.writeFile(mainConfig, `${includeLine}\nHost usable\n  HostName 192.0.2.33\n`);

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts).toMatchObject([{
      id: 'usable',
      hostname: '192.0.2.33',
      sshAuthentication: {
        unsupportedReason: expect.stringContaining('unconditional Include'),
      },
    }]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(warning),
    ]));
  });

  it.each(['Include config.d/*', '  Include config.d/*'])(
    'expands Include inside a pure Host * block regardless of indentation: %s',
    async (includeLine) => {
      await fs.mkdir(path.join(scratchDir, 'config.d'));
      await fs.writeFile(mainConfig, ['Host *', includeLine, ''].join('\n'));
      await fs.writeFile(path.join(scratchDir, 'config.d', 'lab.conf'), [
        'Host lab',
        '  HostName 192.0.2.4',
        '',
      ].join('\n'));

      await expect(readSshConfig(mainConfig)).resolves.toMatchObject([
        { id: 'lab', hostname: '192.0.2.4' },
      ]);
    },
  );

  it('treats a supported Include glob with no matches as an empty operation', async () => {
    await fs.writeFile(mainConfig, [
      'Include missing.d/*.conf',
      'Host usable',
      '  HostName 192.0.2.34',
      '',
    ].join('\n'));

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts[0]).toMatchObject({ id: 'usable', hostname: '192.0.2.34' });
    expect(result.hosts[0]?.sshAuthentication?.unsupportedReason).toBeUndefined();
  });

  it('fails closed when one operand of a supported Include cannot expand', async () => {
    await fs.writeFile(path.join(scratchDir, 'valid.conf'), 'Host included\n');
    await fs.writeFile(mainConfig, [
      'Include valid.conf ${CINDY_TEST_MISSING_SSH_DIR}/missing.conf',
      'Host usable',
      '',
    ].join('\n'));
    delete process.env.CINDY_TEST_MISSING_SSH_DIR;

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts.map((item) => item.id)).toEqual(['included', 'usable']);
    for (const item of result.hosts) {
      expect(item.sshAuthentication?.unsupportedReason).toContain('unconditional Include');
    }
  });

  it('fails closed when a concrete Host block depends on a conditional Include', async () => {
    await fs.writeFile(mainConfig, [
      'Host prod',
      '  Include conditional.conf',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'conditional.conf'), [
      'HostName 192.0.2.55',
      'User deploy',
      'Port 2205',
      '',
    ].join('\n'));

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts).toMatchObject([{
      id: 'prod',
      // Ignored conditional values must never become a usable default endpoint.
      hostname: 'prod',
      user: os.userInfo().username,
      port: 22,
      sshAuthentication: {
        unsupportedReason: expect.stringContaining('conditional Include'),
      },
    }]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('conditional Include was not expanded'),
    ]));
  });

  it('fails closed only for aliases matched by a conditional Host scope', async () => {
    await fs.writeFile(mainConfig, [
      'Host * !safe',
      '  Include conditional.conf',
      'Host safe',
      '  HostName safe.example.com',
      'Host risky',
      '  HostName risky.example.com',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'conditional.conf'), 'Port 2205\n');

    const hosts = await readSshConfig(mainConfig);
    const safe = hosts.find((host) => host.id === 'safe');
    const risky = hosts.find((host) => host.id === 'risky');
    expect(safe).toMatchObject({
      hostname: 'safe.example.com',
    });
    expect(safe?.sshAuthentication?.unsupportedReason).toBeUndefined();
    expect(risky).toMatchObject({
      hostname: 'risky.example.com',
      sshAuthentication: {
        unsupportedReason: expect.stringContaining('conditional Include'),
      },
    });
  });

  it('does not evaluate Match blocks or Match exec', async () => {
    await fs.writeFile(mainConfig, [
      'Host target',
      '  HostName 192.0.2.5',
      'Match exec "touch should-not-run"',
      '  User attacker',
      'Match all',
      '  Port 2222',
      '',
    ].join('\n'));

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts).toMatchObject([{
      id: 'target',
      user: os.userInfo().username,
      port: 22,
      sshAuthentication: {
        unsupportedReason: expect.stringContaining('does not evaluate a Match block'),
      },
    }]);
    expect(result.warnings.filter((warning) => warning.includes('Match is not evaluated')))
      .toHaveLength(2);
  });

  it('fails closed when an applicable Match block may override the endpoint', async () => {
    await fs.writeFile(mainConfig, [
      'Host target',
      'Match originalhost target',
      '  HostName 192.0.2.55',
      '  User remote-user',
      '  Port 2205',
      '',
    ].join('\n'));

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts).toMatchObject([{
      id: 'target',
      // The ignored Match values must never become a usable default endpoint.
      hostname: 'target',
      port: 22,
      user: os.userInfo().username,
      sshAuthentication: {
        unsupportedReason: expect.stringContaining('does not evaluate a Match block'),
      },
    }]);
  });

  it('does not reject an alias definitely excluded by Match originalhost', async () => {
    await fs.writeFile(mainConfig, [
      'Host target',
      '  HostName 192.0.2.5',
      'Match originalhost other-host',
      '  HostName 192.0.2.55',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(mainConfig);
    expect(hosts).toMatchObject([{
      id: 'target',
      hostname: '192.0.2.5',
    }]);
    expect(hosts[0]?.sshAuthentication?.unsupportedReason).toBeUndefined();
  });

  it('fails closed only when effective CanonicalizeHostname enables canonicalization', async () => {
    await fs.writeFile(mainConfig, [
      'CanonicalDomains corp.example',
      'Host safe',
      '  CanonicalizeHostname no',
      '  CanonicalizeHostname yes',
      'Host enabled',
      '  CanonicalizeHostname always',
      'Host invalid',
      '  CanonicalizeHostname maybe',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(mainConfig);
    expect(hosts.find((item) => item.id === 'safe')?.sshAuthentication?.unsupportedReason)
      .toBeUndefined();
    expect(hosts.find((item) => item.id === 'enabled')?.sshAuthentication?.unsupportedReason)
      .toContain('canonicalization');
    expect(hosts.find((item) => item.id === 'invalid')?.sshAuthentication?.unsupportedReason)
      .toContain('CanonicalizeHostname value');
  });

  it('restores the parent Host * scope after an included file returns', async () => {
    await fs.writeFile(mainConfig, [
      'Host *',
      '  User ubuntu',
      '  Include extra.conf',
      '  Port 2222',
      'Host foo',
      '  HostName 192.0.2.6',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'extra.conf'), [
      'Host included',
      '  HostName 192.0.2.7',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(mainConfig);
    expect(hosts.find((item) => item.id === 'foo')).toMatchObject({
      user: 'ubuntu',
      port: 2222,
    });
  });

  it('restores the root scope after an included file ends in a Host block', async () => {
    await fs.writeFile(mainConfig, [
      'Include extra.conf',
      'Port 2200',
      'Host bar',
      '  HostName 192.0.2.8',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'extra.conf'), [
      'Host foo',
      '  HostName 192.0.2.7',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(mainConfig);
    expect(hosts.find((item) => item.id === 'bar')).toMatchObject({ port: 2200 });
  });

  it('deduplicates cycles and repeated physical Include files', async () => {
    await fs.writeFile(mainConfig, 'Include a.conf a.conf\n');
    await fs.writeFile(path.join(scratchDir, 'a.conf'), [
      'Include b.conf',
      'Host a',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'b.conf'), [
      'Include a.conf',
      'Host b',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([
      { id: 'b' },
      { id: 'a' },
    ]);
  });

  it('applies first-value-wins to HostName/User/Port and does not chain HostName aliases', async () => {
    await fs.writeFile(mainConfig, [
      'Host *',
      '  User root',
      '  Port 2200',
      'Host short',
      '  HostName long',
      '  User developer',
      '  Port 2222',
      'Host long',
      '  HostName 192.0.2.8',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(mainConfig);
    expect(hosts.find((item) => item.id === 'short')).toMatchObject({
      hostname: 'long',
      user: 'root',
      port: 2200,
    });
  });

  it('expands the OpenSSH tokens supported by HostName exactly once', async () => {
    await fs.writeFile(mainConfig, [
      'Host tokenized',
      '  HostName %h.%h.example.com',
      'Host literal-percent',
      '  HostName edge%%node.example.com',
      'Host alias%segment',
      '  HostName %h.example.com',
      'Host literal%alias',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(mainConfig);
    expect(hosts.find((item) => item.id === 'tokenized')?.hostname)
      .toBe('tokenized.tokenized.example.com');
    expect(hosts.find((item) => item.id === 'literal-percent')?.hostname)
      .toBe('edge%node.example.com');
    expect(hosts.find((item) => item.id === 'alias%segment')?.hostname)
      .toBe('alias%segment.example.com');
    expect(hosts.find((item) => item.id === 'literal%alias')?.hostname)
      .toBe('literal%alias');
  });

  it.each([
    ['an unsupported token', '%n.example.com', '%n'],
    ['a trailing percent', 'example.com%', '%'],
  ])('keeps but rejects a host whose HostName contains %s', async (_label, hostname, token) => {
    await fs.writeFile(mainConfig, [
      'Host unsupported',
      `  HostName ${hostname}`,
      'Host usable',
      '  HostName usable.example.com',
      '',
    ].join('\n'));

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts.find((item) => item.id === 'unsupported')).toMatchObject({
      id: 'unsupported',
      hostname: 'unsupported',
      sshAuthentication: {
        unsupportedReason: expect.stringContaining(`HostName token: ${token}`),
      },
    });
    expect(result.warnings).toContain(
      `SSH host "unsupported" remains listed but unsupported because HostName uses token "${token}".`,
    );
  });

  it('keeps ordinary IdentityFile entries as agent metadata regardless of scope', async () => {
    await fs.writeFile(mainConfig, [
      'Host *',
      '  IdentityFile ~/.ssh/id_ed25519',
      'Host lab',
      '  HostName 192.0.2.9',
      '  IdentityFile ~/.ssh/lab.key',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'lab',
      authMethod: 'agent',
      identityFile: undefined,
      sshAuthentication: {
        configuredIdentityFiles: [
          path.join(os.homedir(), '.ssh', 'id_ed25519'),
          path.join(os.homedir(), '.ssh', 'lab.key'),
        ],
      },
    }]);
  });

  it('keeps agent auth when IdentityFile is inherited only from Host *', async () => {
    await fs.writeFile(mainConfig, [
      'Host foo',
      '  HostName 192.0.2.10',
      'Host *',
      '  IdentityFile ~/.ssh/id_ed25519',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'foo',
      authMethod: 'agent',
      identityFile: undefined,
    }]);
  });

  it('uses the same Agent-first policy for concrete IdentityFile in an Include', async () => {
    await fs.mkdir(path.join(scratchDir, 'config.d'));
    await fs.writeFile(mainConfig, [
      'Host *',
      '  IdentityFile ~/.ssh/id_ed25519',
      'Include config.d/*',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'config.d', 'lab.conf'), [
      'Host lab',
      '  HostName 192.0.2.11',
      '  IdentityFile ~/.ssh/lab.key',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'lab',
      authMethod: 'agent',
      identityFile: undefined,
    }]);
  });

  it('does not let a later duplicate Host block change agent auth classification', async () => {
    await fs.writeFile(mainConfig, [
      'Host duplicate',
      '  HostName 192.0.2.12',
      'Host duplicate',
      '  IdentityFile ~/.ssh/later.key',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'duplicate',
      authMethod: 'agent',
      identityFile: undefined,
    }]);
  });

  it('honors a marker in a read-only main-config host', async () => {
    await fs.writeFile(mainConfig, [
      'Host marked',
      '  # xdt-maker:auth=agent',
      '  IdentityFile ~/.ssh/marked.key',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig, { managedConfigPath: managedConfig }))
      .resolves.toMatchObject([{
        id: 'marked',
        authMethod: 'agent',
        identityFile: path.join(os.homedir(), '.ssh', 'marked.key'),
        managedByCindy: false,
      }]);
  });

  it('takes the auth marker only from the first concrete declaration introducing an alias', async () => {
    await fs.writeFile(mainConfig, [
      'Host duplicate',
      '  # xdt-maker:auth=key',
      '  IdentityFile first.key',
      'Host duplicate',
      '  # xdt-maker:auth=agent',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'duplicate',
      authMethod: 'key',
      identityFile: path.resolve(process.cwd(), 'first.key'),
    }]);
  });

  it('resolves relative IdentityFile values from the SSH process cwd, not the config directory', async () => {
    await fs.writeFile(mainConfig, [
      'Host relative-key',
      '  # xdt-maker:auth=key',
      '  IdentityFile keys/id_ed25519',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'relative-key',
      identityFile: path.resolve(process.cwd(), 'keys/id_ed25519'),
    }]);
  });

  it('expands IdentityFile tokens from the effective host context before resolving keys', async () => {
    const expandedIdentity = path.join(
      scratchDir,
      'resolved.example-deployer-2222-%-token-identity',
    );
    await fs.writeFile(`${expandedIdentity}.pub`, TEST_PUBLIC_KEY);
    await fs.writeFile(mainConfig, [
      'Host token-identity',
      '  HostName resolved.example',
      '  User deployer',
      '  Port 2222',
      '  IdentitiesOnly yes',
      `  IdentityFile ${path.join(scratchDir, '%h-%r-%p-%%-%n')}`,
      '',
    ].join('\n'));

    const [hostConfig] = await readSshConfig(mainConfig);
    expect(hostConfig).toMatchObject({
      id: 'token-identity',
      sshAuthentication: {
        identitiesOnly: true,
        configuredIdentityFiles: [expandedIdentity],
      },
    });
    expect(hostConfig?.sshAuthentication?.allowedAgentFingerprints).toHaveLength(1);
    expect(hostConfig?.sshAuthentication?.unsupportedReason).toBeUndefined();
  });

  it('keeps but rejects a host whose IdentityFile contains an unsupported token', async () => {
    await fs.writeFile(mainConfig, [
      'Host unsupported-identity-token',
      '  IdentitiesOnly yes',
      '  IdentityFile ~/.ssh/id_%f',
      'Host usable',
      '',
    ].join('\n'));

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts.map((hostConfig) => hostConfig.id))
      .toEqual(['unsupported-identity-token', 'usable']);
    expect(result.hosts[0]?.sshAuthentication?.unsupportedReason)
      .toContain('IdentityFile token: %f');
    expect(result.warnings).toContain(
      'SSH host "unsupported-identity-token" remains listed but unsupported because IdentityFile uses token "%f".',
    );
  });

  it('keeps a no-marker IdentityFile host on unfiltered Agent without guessing .pub', async () => {
    const labKey = path.join(scratchDir, 'lab.key');
    await fs.writeFile(labKey, 'invalid-identity-fixture');
    await fs.writeFile(path.join(scratchDir, 'lab.pub'), TEST_PUBLIC_KEY);
    await fs.writeFile(mainConfig, [
      'Host lab',
      `  IdentityFile ${labKey}`,
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'lab',
      authMethod: 'agent',
      identityFile: undefined,
      sshAuthentication: {
        identitiesOnly: false,
        configuredIdentityFiles: [labKey],
      },
    }]);
  });

  it('does not infer a custom lab.pub sibling for lab.key when IdentitiesOnly is yes', async () => {
    const labKey = path.join(scratchDir, 'lab.key');
    await fs.writeFile(labKey, 'invalid-identity-fixture');
    await fs.writeFile(path.join(scratchDir, 'lab.pub'), TEST_PUBLIC_KEY);
    await fs.writeFile(mainConfig, [
      'Host lab-strict',
      '  IdentitiesOnly yes',
      `  IdentityFile ${labKey}`,
      '',
    ].join('\n'));

    const [hostConfig] = await readSshConfig(mainConfig);
    expect(hostConfig).toMatchObject({
      id: 'lab-strict',
      authMethod: 'agent',
      identityFile: undefined,
      sshAuthentication: {
        configuredIdentityFiles: [labKey],
        identitiesOnly: true,
      },
    });
    expect(hostConfig?.sshAuthentication?.allowedAgentFingerprints).toBeUndefined();
    expect(hostConfig?.sshAuthentication?.unsupportedReason).toContain(labKey);
  });

  it('pins every explicit identity in order for IdentitiesOnly yes', async () => {
    const first = path.join(scratchDir, 'first.key');
    const second = path.join(scratchDir, 'second.pub');
    await fs.writeFile(`${first}.pub`, TEST_PUBLIC_KEY);
    await fs.writeFile(second, TEST_PUBLIC_KEY_2);
    await fs.writeFile(mainConfig, [
      'Host pinned',
      '  IdentitiesOnly yes',
      `  IdentityFile ${first}`,
      '  IdentityFile none',
      `  IdentityFile ${second}`,
      '',
    ].join('\n'));

    const [pinned] = await readSshConfig(mainConfig);
    expect(pinned).toMatchObject({
      id: 'pinned',
      authMethod: 'agent',
      identityFile: undefined,
      sshAuthentication: {
        identitiesOnly: true,
        configuredIdentityFiles: [first, second],
        identityFileDirectiveSeen: true,
        identityFileNoneSeen: true,
      },
    });
    expect(pinned?.sshAuthentication?.allowedAgentFingerprints).toHaveLength(2);
    expect(pinned?.sshAuthentication?.unsupportedReason).toBeUndefined();
  });

  it('fails closed when any explicit IdentitiesOnly identity has no public key', async () => {
    const valid = path.join(scratchDir, 'valid.key');
    const missing = path.join(scratchDir, 'missing.key');
    await fs.writeFile(`${valid}.pub`, TEST_PUBLIC_KEY);
    await fs.writeFile(mainConfig, [
      'Host incomplete',
      '  IdentitiesOnly yes',
      `  IdentityFile ${valid}`,
      `  IdentityFile ${missing}`,
      '',
    ].join('\n'));

    const [hostConfig] = await readSshConfig(mainConfig);
    expect(hostConfig?.sshAuthentication?.allowedAgentFingerprints).toBeUndefined();
    expect(hostConfig?.sshAuthentication?.unsupportedReason).toContain(missing);
  });

  it('treats IdentityFile none as a sentinel without clearing explicit entries', async () => {
    const first = path.join(scratchDir, 'a.key');
    const second = path.join(scratchDir, 'b.key');
    await fs.writeFile(mainConfig, [
      'Host sentinel',
      `  IdentityFile ${first}`,
      '  IdentityFile NONE',
      `  IdentityFile ${second}`,
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'sentinel',
      authMethod: 'agent',
      sshAuthentication: {
        identitiesOnly: false,
        configuredIdentityFiles: [first, second],
        identityFileNoneSeen: true,
      },
    }]);
  });

  it('rejects IdentitiesOnly yes with only IdentityFile none', async () => {
    await fs.writeFile(mainConfig, [
      'Host empty-pin',
      '  IdentitiesOnly yes',
      '  IdentityFile none',
      '',
    ].join('\n'));

    const [hostConfig] = await readSshConfig(mainConfig);
    expect(hostConfig?.sshAuthentication?.configuredIdentityFiles).toEqual([]);
    expect(hostConfig?.sshAuthentication?.unsupportedReason).toContain('no identity');
  });

  it('uses first-value-wins for IdentitiesOnly across Host * and exact blocks', async () => {
    await fs.writeFile(mainConfig, [
      'Host *',
      '  IdentitiesOnly yes',
      '  IdentityFile none',
      'Host inherited-yes',
      '  IdentitiesOnly no',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'inherited-yes',
      sshAuthentication: {
        identitiesOnly: true,
        unsupportedReason: expect.any(String),
      },
    }]);
  });

  it('keeps an earlier exact IdentitiesOnly no ahead of a later Host * yes', async () => {
    await fs.writeFile(mainConfig, [
      'Host exact-no',
      '  IdentitiesOnly no',
      'Host *',
      '  IdentitiesOnly yes',
      '  IdentityFile none',
      '',
    ].join('\n'));

    await expect(readSshConfig(mainConfig)).resolves.toMatchObject([{
      id: 'exact-no',
      sshAuthentication: {
        identitiesOnly: false,
      },
    }]);
  });

  it('fails closed when a present default identity has no resolvable public key', async () => {
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(scratchDir);
    try {
      const sshDir = path.join(scratchDir, '.ssh');
      await fs.mkdir(sshDir);
      await fs.writeFile(
        path.join(sshDir, 'id_ed25519'),
        'invalid-identity-fixture',
      );
      await fs.writeFile(mainConfig, 'Host defaults\n  IdentitiesOnly yes\n');

      const [hostConfig] = await readSshConfig(mainConfig);
      expect(hostConfig?.sshAuthentication?.unsupportedReason).toContain('id_ed25519');
      expect(hostConfig?.sshAuthentication?.allowedAgentFingerprints).toBeUndefined();
    } finally {
      homeSpy.mockRestore();
    }
  });

  it('pins a present default identity when its .pub sibling is valid', async () => {
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(scratchDir);
    try {
      const sshDir = path.join(scratchDir, '.ssh');
      await fs.mkdir(sshDir);
      await fs.writeFile(path.join(sshDir, 'id_ed25519.pub'), TEST_PUBLIC_KEY);
      await fs.writeFile(mainConfig, 'Host defaults\n  IdentitiesOnly yes\n');

      const [hostConfig] = await readSshConfig(mainConfig);
      expect(hostConfig?.sshAuthentication?.allowedAgentFingerprints).toHaveLength(1);
      expect(hostConfig?.sshAuthentication?.unsupportedReason).toBeUndefined();
    } finally {
      homeSpy.mockRestore();
    }
  });

  it('warns for unsupported agent directives and rejects them with IdentitiesOnly yes', async () => {
    const key = path.join(scratchDir, 'cert.key');
    await fs.writeFile(`${key}.pub`, TEST_PUBLIC_KEY);
    await fs.writeFile(mainConfig, [
      'Host warning-only',
      '  PKCS11Provider /tmp/provider.so',
      'Host strict-cert',
      '  IdentitiesOnly yes',
      `  IdentityFile ${key}`,
      '  CertificateFile cert.pub',
      '',
    ].join('\n'));

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.warnings.join('\n')).toContain('pkcs11provider');
    expect(result.hosts.find((hostConfig) => hostConfig.id === 'strict-cert')
      ?.sshAuthentication?.unsupportedReason).toContain('CertificateFile'.toLowerCase());
  });

  it('lists each alias in Host foo bar but keeps both read-only', async () => {
    await fs.writeFile(mainConfig, `Include ${managedConfig}\n`);
    await fs.writeFile(managedConfig, [
      'Host foo bar',
      '  HostName 192.0.2.11',
      '',
    ].join('\n'));

    const hosts = await readSshConfig(mainConfig, { managedConfigPath: managedConfig });
    expect(hosts).toMatchObject([
      { id: 'foo', managedByCindy: false },
      { id: 'bar', managedByCindy: false },
    ]);
  });

  it('reports Include limits as diagnostics instead of partial host lists', async () => {
    await fs.writeFile(mainConfig, 'Include level-1.conf\n');
    for (let level = 1; level <= 17; level += 1) {
      await fs.writeFile(
        path.join(scratchDir, `level-${level}.conf`),
        level === 17 ? 'Host too-deep\n' : `Include level-${level + 1}.conf\n`,
      );
    }

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts).toEqual([]);
    expect(result.diagnostic).toMatchObject({ kind: 'limit' });
  });
});

describe('managed ownership', () => {
  it('marks only a unique single-alias declaration in the supplied managed file', async () => {
    await fs.writeFile(mainConfig, `Include ${managedConfig}\n`);
    await fs.writeFile(managedConfig, `${MANAGED_CONFIG_MARKER}\nHost managed\n  HostName 192.0.2.20\n`);

    const result = await readSshConfigDetailed(mainConfig, { managedConfigPath: managedConfig });
    expect(result.hosts).toMatchObject([
      { id: 'managed', source: 'ssh-config', managedByCindy: true },
    ]);
    expect(result.managedConfigWriteToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not treat a host-block comment as a managed-file ownership marker', async () => {
    await fs.writeFile(mainConfig, `Include ${managedConfig}\n`);
    await fs.writeFile(managedConfig, 'Host user-owned\n  # xdt-maker:managed=v1\n');

    const result = await readSshConfigDetailed(mainConfig, { managedConfigPath: managedConfig });
    expect(result.hosts).toMatchObject([{ id: 'user-owned', managedByCindy: false }]);
    expect(result.managedConfigWriteToken).toBeUndefined();
  });

  it('keeps managed aliases read-only when duplicated in any other file', async () => {
    await fs.writeFile(mainConfig, [
      `Include ${managedConfig}`,
      'Include external.conf',
      '',
    ].join('\n'));
    await fs.writeFile(managedConfig, 'Host duplicate\n  HostName 192.0.2.21\n');
    await fs.writeFile(path.join(scratchDir, 'external.conf'), 'Host duplicate\n');

    await expect(readSshConfig(mainConfig, { managedConfigPath: managedConfig }))
      .resolves.toMatchObject([{ id: 'duplicate', managedByCindy: false }]);
  });

  it('marks every host read-only when managedConfigPath is omitted', async () => {
    await fs.writeFile(mainConfig, `Include ${managedConfig}\n`);
    await fs.writeFile(managedConfig, 'Host managed\n');

    const result = await readSshConfigDetailed(mainConfig);
    expect(result.hosts).toMatchObject([{ id: 'managed', managedByCindy: false }]);
    expect(result.managedConfigWriteToken).toBeUndefined();
  });

  it('warns without discovering an existing managed file that is not Included', async () => {
    await fs.writeFile(mainConfig, 'Host external\n');
    await fs.writeFile(managedConfig, 'Host unreachable\n');

    const result = await readSshConfigDetailed(mainConfig, { managedConfigPath: managedConfig });
    expect(result.hosts.map((item) => item.id)).toEqual(['external']);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('not reachable'),
    ]));
  });

  it('warns when a later Include glob reaches the managed file again', async () => {
    await fs.writeFile(mainConfig, [
      `Include ${managedConfig}`,
      `Include ${path.join(scratchDir, '*.conf')}`,
      '',
    ].join('\n'));
    await fs.writeFile(managedConfig, 'Host managed\n');

    const result = await readSshConfigDetailed(mainConfig, { managedConfigPath: managedConfig });
    expect(result.hosts.map((item) => item.id)).toEqual(['managed']);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('already loaded'),
    ]));
  });
});

describe('managed config writers', () => {
  it('inserts one canonical Include after leading comments/blanks and before Host *', async () => {
    await fs.writeFile(mainConfig, [
      '# user comment',
      '',
      'Host *',
      '  User ubuntu',
      `  Include="${managedConfig}"`,
      `Include ${path.join(scratchDir, '*.conf')}`,
      '',
    ].join('\n'));

    await ensureManagedConfigInclude(mainConfig, managedConfig);
    const raw = await fs.readFile(mainConfig, 'utf8');
    expect(raw).toContain('# user comment');
    expect(raw).toContain('Host *');
    expect(parsedIncludeEntries(raw)).toEqual(expect.arrayContaining([
      { value: path.normalize(managedConfig), before: '' },
      { value: path.normalize(path.join(scratchDir, '*.conf')), before: '' },
    ]));
  });

  it('recognizes equivalent exact Include forms, deduplicates them, and preserves comments', async () => {
    await fs.writeFile(mainConfig, [
      '# header',
      'Include=cindy.conf # keep relative note',
      `Include "${managedConfig}" # keep duplicate note`,
      'Host foo',
      '',
    ].join('\n'));

    await ensureManagedConfigInclude(mainConfig, managedConfig);
    const raw = await fs.readFile(mainConfig, 'utf8');
    expect(parsedIncludeEntries(raw)).toEqual([
      { value: path.normalize(managedConfig), before: '' },
    ]);
    expect(raw).toContain('# keep relative note');
    expect(raw).toContain('# keep duplicate note');
    expect(raw).toContain('Host foo');
  });

  it('does not move an exact Include from Host foo and adds a root Include', async () => {
    await fs.writeFile(mainConfig, [
      'Host foo',
      `  Include ${managedConfig}`,
      '',
    ].join('\n'));

    await ensureManagedConfigInclude(mainConfig, managedConfig);
    const raw = await fs.readFile(mainConfig, 'utf8');
    expect(parsedIncludeEntries(raw)).toEqual([
      { value: path.normalize(managedConfig), before: '' },
      { value: path.normalize(managedConfig), before: '  ' },
    ]);
    expect(raw).toContain('Host foo');
  });

  it('preserves CRLF and file permissions in the main config', async () => {
    await fs.writeFile(mainConfig, '# comment\r\nHost foo\r\n', { mode: 0o640 });
    await fs.chmod(mainConfig, 0o640);
    const modeBefore = (await fs.stat(mainConfig)).mode & 0o777;

    await ensureManagedConfigInclude(mainConfig, managedConfig);
    const raw = await fs.readFile(mainConfig, 'utf8');
    expect(parsedIncludeEntries(raw)).toEqual([
      { value: path.normalize(managedConfig), before: '' },
    ]);
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
    if (modeBefore === 0o640) {
      expect((await fs.stat(mainConfig)).mode & 0o777).toBe(modeBefore);
    }
  });

  it('does not overwrite a concurrent edit while publishing the managed Include', async () => {
    const original = '# original\nHost existing\n';
    const concurrent = '# edited externally\nHost existing\n  User external\n';
    await fs.writeFile(mainConfig, original);
    const writeFile = fs.writeFile.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      const result = await writeFile(file, data, options);
      if (String(file).includes('.config.cindy-')) {
        await writeFile(mainConfig, concurrent);
      }
      return result;
    });

    try {
      await expect(ensureManagedConfigInclude(mainConfig, managedConfig))
        .rejects.toMatchObject({ code: 'SSH_CONFIG_CONCURRENT_MODIFICATION' });
      await expect(fs.readFile(mainConfig, 'utf8')).resolves.toBe(concurrent);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('writes through an existing symlink without replacing the link', async ({ skip }) => {
    const target = path.join(scratchDir, 'real-config');
    await fs.writeFile(target, 'Host foo\n');
    try {
      await fs.symlink(target, mainConfig);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return skip();
      throw error;
    }

    await ensureManagedConfigInclude(mainConfig, managedConfig);
    expect((await fs.lstat(mainConfig)).isSymbolicLink()).toBe(true);
    const raw = await fs.readFile(target, 'utf8');
    expect(parsedIncludeEntries(raw)).toEqual([
      { value: path.normalize(managedConfig), before: '' },
    ]);
  });

  it('rejects a broken symlink instead of replacing it', async ({ skip }) => {
    try {
      await fs.symlink(path.join(scratchDir, 'missing-target'), mainConfig);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return skip();
      throw error;
    }
    await expect(ensureManagedConfigInclude(mainConfig, managedConfig)).rejects.toThrow();
    expect((await fs.lstat(mainConfig)).isSymbolicLink()).toBe(true);
  });

  it('adds a marked host, rereads it as managed, and removes it', async () => {
    await fs.writeFile(mainConfig, `Include ${managedConfig}\n`);
    await addManagedHost(host({
      id: 'new-host',
      authMethod: 'agent',
      identityFile: '/tmp/id_ed25519.pub',
    }), managedConfig);

    const raw = await fs.readFile(managedConfig, 'utf8');
    expect(raw).toContain('# xdt-maker:auth=agent');
    await expect(readSshConfig(mainConfig, { managedConfigPath: managedConfig }))
      .resolves.toMatchObject([{
        id: 'new-host',
        source: 'ssh-config',
        managedByCindy: true,
        authMethod: 'agent',
      }]);

    await removeManagedHost('new-host', managedConfig, await managedWriteToken());
    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toBe(`${MANAGED_CONFIG_MARKER}\n`);
  });

  it('quotes managed IdentityFile values without losing spaces, hashes, quotes, or backslashes', async () => {
    const identityFile = path.join(scratchDir, 'My Keys', 'id#deploy"copy\\final');
    await fs.writeFile(mainConfig, `Include ${managedConfig}\n`);
    await addManagedHost(host({
      id: 'special#alias',
      authMethod: 'key',
      identityFile,
    }), managedConfig);

    const raw = await fs.readFile(managedConfig, 'utf8');
    expect(raw).toContain('IdentityFile "');
    await expect(readSshConfig(mainConfig, { managedConfigPath: managedConfig }))
      .resolves.toMatchObject([{
        id: 'special#alias',
        authMethod: 'key',
        identityFile,
      }]);
  });

  it('does not publish an Include for a malformed pre-existing managed file', async () => {
    const originalMain = 'Host external\n  HostName 192.0.2.50\n';
    await fs.writeFile(mainConfig, originalMain);
    await fs.writeFile(managedConfig, `${MANAGED_CONFIG_MARKER}\nHost broken\n  IdentityFile "unterminated\n`);

    await expect(addManagedHostWithInclude(host({ id: 'new-host' }), mainConfig, managedConfig))
      .rejects.toThrow();
    await expect(fs.readFile(mainConfig, 'utf8')).resolves.toBe(originalMain);
  });

  it('does not claim a non-empty unmarked managed path', async () => {
    const originalMain = 'Host external\n  HostName 192.0.2.50\n';
    const unownedManaged = 'Host user-owned\n  HostName 192.0.2.51\n';
    await fs.writeFile(mainConfig, originalMain);
    await fs.writeFile(managedConfig, unownedManaged);

    await expect(addManagedHostWithInclude(host({ id: 'new-host' }), mainConfig, managedConfig))
      .rejects.toMatchObject({ code: 'SSH_CONFIG_OWNERSHIP_REQUIRED' });
    await expect(fs.readFile(mainConfig, 'utf8')).resolves.toBe(originalMain);
    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toBe(unownedManaged);
  });

  it('stamps a newly created managed file with its ownership marker', async () => {
    await fs.writeFile(mainConfig, '');

    await addManagedHostWithInclude(host({ id: 'new-host' }), mainConfig, managedConfig);

    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toMatch(/^# xdt-maker:managed=v1\n/);
  });

  it('restores managed bytes when publishing the Include fails', async ({ skip }) => {
    const originalManaged = `${MANAGED_CONFIG_MARKER}\nHost existing\n  HostName 192.0.2.60\n`;
    await fs.writeFile(managedConfig, originalManaged);
    try {
      await fs.symlink(path.join(scratchDir, 'missing-main-target'), mainConfig);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return skip();
      throw error;
    }

    await expect(addManagedHostWithInclude(host({ id: 'new-host' }), mainConfig, managedConfig))
      .rejects.toThrow();
    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toBe(originalManaged);
    expect((await fs.lstat(mainConfig)).isSymbolicLink()).toBe(true);
  });

  it('returns a conditional rollback receipt for a published managed host', async () => {
    const originalManaged = `${MANAGED_CONFIG_MARKER}\nHost existing\n  HostName 192.0.2.60\n`;
    await fs.writeFile(mainConfig, '');
    await fs.writeFile(managedConfig, originalManaged);

    const receipt = await addManagedHostWithInclude(
      host({ id: 'new-host' }),
      mainConfig,
      managedConfig,
    );
    expect(await fs.readFile(managedConfig, 'utf8')).not.toBe(originalManaged);
    await expect(receipt.rollback()).resolves.toBe(true);
    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toBe(originalManaged);
  });

  it('does not roll back over an external managed-file edit', async () => {
    const originalManaged = `${MANAGED_CONFIG_MARKER}\nHost existing\n  HostName 192.0.2.60\n`;
    await fs.writeFile(mainConfig, '');
    await fs.writeFile(managedConfig, originalManaged);

    const receipt = await addManagedHostWithInclude(
      host({ id: 'new-host' }),
      mainConfig,
      managedConfig,
    );
    await fs.appendFile(managedConfig, '# external edit\n');

    await expect(receipt.rollback()).resolves.toBe(false);
    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toContain('# external edit');
    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toContain('Host new-host');
  });

  it('keeps an unpinned managed agent host as agent when Host * supplies a key', async () => {
    await fs.writeFile(mainConfig, [
      'Host *',
      '  IdentityFile ~/.ssh/id_ed25519',
      `Include ${managedConfig}`,
      '',
    ].join('\n'));
    await addManagedHost(host({
      id: 'agent-host',
      authMethod: 'agent',
      identityFile: undefined,
    }), managedConfig);

    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toContain('# xdt-maker:auth=agent');
    await expect(readSshConfig(mainConfig, { managedConfigPath: managedConfig }))
      .resolves.toMatchObject([{
        id: 'agent-host',
        authMethod: 'agent',
        identityFile: undefined,
        managedByCindy: true,
      }]);
  });

  it.each(['ProxyJump bastion', 'ProxyCommand ssh -W %h:%p bastion'])
    ('marks an unsupported SSH transport directive as unsupported: %s', async (directive) => {
      await fs.writeFile(mainConfig, [
        `Host proxied-${directive.startsWith('ProxyJump') ? 'jump' : 'command'}`,
        `  ${directive}`,
        '',
      ].join('\n'));

      const [hostConfig] = await readSshConfig(mainConfig);
      expect(hostConfig?.sshAuthentication?.unsupportedReason).toContain('transport');
    });

  it('treats ProxyJump/ProxyCommand none as disabled transport directives', async () => {
    await fs.writeFile(mainConfig, [
      'Host direct',
      '  ProxyJump none',
      '  ProxyCommand none',
      '',
    ].join('\n'));

    const [hostConfig] = await readSshConfig(mainConfig);
    expect(hostConfig?.id).toBe('direct');
    expect(hostConfig?.sshAuthentication?.unsupportedReason).toBeUndefined();
  });

  it('fails closed when a wildcard scope supplies an unsupported proxy transport', async () => {
    await fs.mkdir(path.join(scratchDir, 'config.d'));
    await fs.writeFile(mainConfig, [
      'Host *',
      '  ProxyJump bastion',
      'Include config.d/*',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(scratchDir, 'config.d', 'remote.conf'), [
      'Host remote',
      '  HostName 192.0.2.80',
      '',
    ].join('\n'));

    const [hostConfig] = await readSshConfig(mainConfig);
    expect(hostConfig?.id).toBe('remote');
    expect(hostConfig?.sshAuthentication?.unsupportedReason).toContain('proxyjump');
  });

  it('surgically updates owned fields without deleting ProxyJump or other directives', async () => {
    await fs.writeFile(managedConfig, [
      MANAGED_CONFIG_MARKER,
      'Host lab',
      '  HostName 192.0.2.30',
      '  User alice',
      '  ProxyJump bastion',
      '  ServerAliveInterval 60',
      '',
    ].join('\n'));

    const token = await managedWriteToken();
    await updateManagedHostFields(host({
      id: 'lab',
      hostname: '192.0.2.31',
      user: 'bob',
      port: 2222,
      authMethod: 'key',
      identityFile: '/tmp/lab.key',
    }), managedConfig, token);

    const raw = await fs.readFile(managedConfig, 'utf8');
    expect(raw).toContain('ProxyJump bastion');
    expect(raw).toContain('ServerAliveInterval 60');
    expect(raw).toContain('HostName 192.0.2.31');
    expect(raw).toContain('Port 2222');
    expect(raw).toContain('# xdt-maker:auth=key');
  });

  it('preserves CRLF and permissions while updating a managed host', async () => {
    await fs.writeFile(managedConfig, [
      MANAGED_CONFIG_MARKER,
      'Host lab',
      '  HostName 192.0.2.40',
      '  User alice',
      '',
    ].join('\r\n'), { mode: 0o640 });
    await fs.chmod(managedConfig, 0o640);
    const modeBefore = (await fs.stat(managedConfig)).mode & 0o777;

    const token = await managedWriteToken();
    await updateManagedHostFields(host({
      id: 'lab',
      hostname: '192.0.2.41',
      user: 'bob',
      port: 2222,
    }), managedConfig, token);

    const raw = await fs.readFile(managedConfig, 'utf8');
    expect(raw).toContain('HostName 192.0.2.41\r\n');
    expect(raw).toContain('Port 2222\r\n');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
    if (modeBefore === 0o640) {
      expect((await fs.stat(managedConfig)).mode & 0o777).toBe(modeBefore);
    }
  });

  it('rejects update when the managed file changed after preflight', async () => {
    await fs.writeFile(managedConfig, [
      MANAGED_CONFIG_MARKER,
      'Host lab',
      '  HostName 192.0.2.40',
      '',
    ].join('\n'));
    const token = await managedWriteToken();
    const external = `${await fs.readFile(managedConfig, 'utf8')}# external edit\n`;
    await fs.writeFile(managedConfig, external);

    await expect(updateManagedHostFields(host({ id: 'lab' }), managedConfig, token))
      .rejects.toMatchObject({ code: 'SSH_CONFIG_CONCURRENT_MODIFICATION' });
    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toBe(external);
  });

  it('rejects remove when the managed file changed after preflight', async () => {
    await fs.writeFile(managedConfig, [
      MANAGED_CONFIG_MARKER,
      'Host lab',
      '  HostName 192.0.2.40',
      '',
    ].join('\n'));
    const token = await managedWriteToken();
    const external = `${await fs.readFile(managedConfig, 'utf8')}# external edit\n`;
    await fs.writeFile(managedConfig, external);

    await expect(removeManagedHost('lab', managedConfig, token))
      .rejects.toMatchObject({ code: 'SSH_CONFIG_CONCURRENT_MODIFICATION' });
    await expect(fs.readFile(managedConfig, 'utf8')).resolves.toBe(external);
  });

  it('treats a missing managed write token as an internal package contract error', async () => {
    await fs.writeFile(managedConfig, `${MANAGED_CONFIG_MARKER}\nHost lab\n`);
    await expect(removeManagedHost(
      'lab',
      managedConfig,
      undefined as unknown as ManagedConfigWriteToken,
    )).rejects.toMatchObject({ code: 'SSH_CONFIG_WRITE_TOKEN_REQUIRED' });
  });
});

describe('expandHome', () => {
  it('expands POSIX and Windows tilde forms', () => {
    expect(expandHome('~/.ssh/id_ed25519')).toBe(path.join(os.homedir(), '.ssh', 'id_ed25519'));
    expect(expandHome('~\\.ssh\\id_ed25519')).toBe(path.join(os.homedir(), '.ssh', 'id_ed25519'));
  });
});
