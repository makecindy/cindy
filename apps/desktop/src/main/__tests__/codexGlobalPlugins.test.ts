import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import yaml from 'js-yaml';
import type { CapabilityRoutingPolicy } from '@cindy/maker-core';

import {
  codexGlobalPluginsPaths,
  prepareCodexGlobalPluginsBridge,
  writeFileAtomicIfUnchanged,
} from '../maker-host/codex-global-plugins';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-plugins-'));
  tmpDirs.push(dir);
  return dir;
}

/** 造一个 marketplace 缓存目录: <cache>/<marketplace>/<plugin>/<version>/plugin.json */
async function writePluginCache(
  cacheDir: string,
  marketplace: string,
  plugin: string,
  version = '1.0.0',
): Promise<void> {
  const dir = path.join(cacheDir, marketplace, plugin, version);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'plugin.json'), `{"name":"${plugin}"}`, 'utf8');
}

async function writePluginEnabledState(
  configFile: string,
  plugin: string,
  marketplace: string,
  enabled: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(
    configFile,
    `[plugins."${plugin}@${marketplace}"]\nenabled = ${enabled}\n`,
    'utf8',
  );
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(ra) === normalize(rb);
}

function pluginsTableOf(tomlText: string): Record<string, unknown> {
  const parsed = parseToml(tomlText) as Record<string, unknown>;
  return (parsed['plugins'] as Record<string, unknown> | undefined) ?? {};
}

interface SetupResult {
  homeDir: string;
  codexHome: string;
  paths: ReturnType<typeof codexGlobalPluginsPaths>;
}

function explicitOnlySkillPolicy(
  plugin = 'feishu-delegate',
  marketplace = 'personal',
  skill = 'message-feishu-coworkers',
): CapabilityRoutingPolicy {
  return {
    overrides: [
      {
        capabilityId: 'feishu',
        source: {
          kind: 'harness-plugin',
          harness: 'codex',
          surface: 'skill',
          id: `${plugin}:${skill}`,
          artifactId: skill,
          containerId: `${plugin}@${marketplace}`,
        },
        invocation: 'explicit-only',
        replacement: {
          kind: 'cindy-plugin',
          id: 'xd-feishu',
        },
      },
    ],
  };
}

function isolatedFeishuPolicy(): CapabilityRoutingPolicy {
  return {
    overrides: [
      ...explicitOnlySkillPolicy().overrides,
      {
        capabilityId: 'feishu',
        source: {
          kind: 'harness-plugin',
          harness: 'codex',
          surface: 'mcp',
          id: 'cindy-routed-feishu-delegate',
          artifactId: 'feishu-delegate',
          containerId: 'feishu-delegate@personal',
        },
        invocation: 'explicit-only',
        replacement: {
          kind: 'cindy-plugin',
          id: 'xd-feishu',
        },
      },
    ],
  };
}

async function setup(): Promise<SetupResult> {
  const root = await makeTmpDir();
  const homeDir = path.join(root, 'home');
  const codexHome = path.join(root, 'xdt-codex-home');
  await fs.mkdir(homeDir, { recursive: true });
  return { homeDir, codexHome, paths: codexGlobalPluginsPaths(codexHome, homeDir) };
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareCodexGlobalPluginsBridge', () => {
  it('makes a colliding plugin skill explicit-only inside Cindy without changing the user cache', async () => {
    const { homeDir, codexHome, paths } = await setup();
    const marketplace = 'personal';
    const plugin = 'feishu-delegate';
    const version = '0.1.0';
    const skill = 'message-feishu-coworkers';
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, version);
    await writePluginCache(paths.sourceCacheDir, marketplace, 'unrelated-plugin', version);
    const sourceSkillDir = path.join(
      paths.sourceCacheDir,
      marketplace,
      plugin,
      version,
      'skills',
      skill,
    );
    await fs.mkdir(sourceSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceSkillDir, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: Feishu\n---\n`,
      'utf8',
    );
    await fs.writeFile(
      paths.sourceConfigFile,
      `[plugins."${plugin}@${marketplace}"]\nenabled = true\n`,
      'utf8',
    );
    const capabilityRouting = explicitOnlySkillPolicy(plugin, marketplace, skill);

    const first = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting,
    });

    expect(first.changed).toBe(true);
    expect(first.warnings).toEqual([]);
    expect(first.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'linked' }),
    ]);
    const isolatedMarketplace = path.join(paths.cacheDir, marketplace);
    expect((await fs.lstat(isolatedMarketplace)).isSymbolicLink()).toBe(false);
    const isolatedMetadata = path.join(
      isolatedMarketplace,
      plugin,
      version,
      'skills',
      skill,
      'agents',
      'openai.yaml',
    );
    const metadata = yaml.load(await fs.readFile(isolatedMetadata, 'utf8')) as {
      policy?: { allow_implicit_invocation?: boolean };
    };
    expect(metadata.policy?.allow_implicit_invocation).toBe(false);
    await expect(
      fs.lstat(path.join(sourceSkillDir, 'agents', 'openai.yaml')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await sameRealPath(
        path.join(isolatedMarketplace, 'unrelated-plugin'),
        path.join(paths.sourceCacheDir, marketplace, 'unrelated-plugin'),
      ),
    ).toBe(true);

    const second = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting,
    });
    expect(second.changed).toBe(false);
    expect(second.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'kept' }),
    ]);

    await fs.writeFile(
      isolatedMetadata,
      'policy:\n  allow_implicit_invocation: true\n',
      'utf8',
    );
    const repaired = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting,
    });
    expect(repaired.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'linked' }),
    ]);
    const repairedMetadata = yaml.load(
      await fs.readFile(isolatedMetadata, 'utf8'),
    ) as { policy?: { allow_implicit_invocation?: boolean } };
    expect(repairedMetadata.policy?.allow_implicit_invocation).toBe(false);

    const restored = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });
    expect(restored.changed).toBe(true);
    expect(
      await sameRealPath(
        path.join(paths.cacheDir, marketplace),
        path.join(paths.sourceCacheDir, marketplace),
      ),
    ).toBe(true);
  });

  it('gives a plugin MCP a Cindy-only runtime id without changing the user cache', async () => {
    const { homeDir, codexHome, paths } = await setup();
    const marketplace = 'personal';
    const plugin = 'feishu-delegate';
    const version = '0.1.0';
    const pluginDir = path.join(paths.sourceCacheDir, marketplace, plugin, version);
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, version);
    await fs.mkdir(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: plugin,
        skills: './skills/',
        mcpServers: './.mcp.json',
      }),
      'utf8',
    );
    await fs.mkdir(path.join(pluginDir, 'skills', 'message-feishu-coworkers'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'feishu-delegate': {
            command: 'node',
            args: ['./mcp/server.mjs'],
            default_tools_approval_mode: 'approve',
            tools: {
              feishu_read_messages: {
                approval_mode: 'approve',
              },
            },
          },
        },
      }),
      'utf8',
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting: isolatedFeishuPolicy(),
    });

    expect(result.routingFailures).toEqual([]);
    const isolatedMcpFile = path.join(
      paths.cacheDir,
      marketplace,
      plugin,
      version,
      '.mcp.json',
    );
    const isolatedMcp = JSON.parse(
      await fs.readFile(isolatedMcpFile, 'utf8'),
    ) as {
      mcpServers: Record<
        string,
        {
          default_tools_approval_mode?: string;
          tools?: Record<string, { approval_mode?: string }>;
        }
      >;
    };
    expect(isolatedMcp.mcpServers).toHaveProperty('cindy-routed-feishu-delegate');
    expect(isolatedMcp.mcpServers).not.toHaveProperty('feishu-delegate');
    expect(
      isolatedMcp.mcpServers['cindy-routed-feishu-delegate']?.default_tools_approval_mode,
    ).toBe('prompt');
    expect(
      isolatedMcp.mcpServers['cindy-routed-feishu-delegate']?.tools
        ?.feishu_read_messages?.approval_mode,
    ).toBe('prompt');

    const userMcp = JSON.parse(await fs.readFile(path.join(pluginDir, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<
        string,
        {
          default_tools_approval_mode?: string;
          tools?: Record<string, { approval_mode?: string }>;
        }
      >;
    };
    expect(userMcp.mcpServers).toHaveProperty('feishu-delegate');
    expect(userMcp.mcpServers).not.toHaveProperty('cindy-routed-feishu-delegate');
    expect(userMcp.mcpServers['feishu-delegate']?.default_tools_approval_mode).toBe('approve');
    expect(
      userMcp.mcpServers['feishu-delegate']?.tools?.feishu_read_messages?.approval_mode,
    ).toBe('approve');

    await fs.writeFile(
      isolatedMcpFile,
      JSON.stringify({
        mcpServers: {
          'feishu-delegate': {
            command: 'node',
            default_tools_approval_mode: 'approve',
          },
        },
      }),
      'utf8',
    );
    const repaired = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting: isolatedFeishuPolicy(),
    });
    expect(repaired.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'linked' }),
    ]);
    const repairedMcp = JSON.parse(
      await fs.readFile(isolatedMcpFile, 'utf8'),
    ) as { mcpServers: Record<string, unknown> };
    expect(repairedMcp.mcpServers).toHaveProperty(
      'cindy-routed-feishu-delegate',
    );
    expect(repairedMcp.mcpServers).not.toHaveProperty('feishu-delegate');
  });

  it('rebuilds the isolated overlay when the source plugin changes', async () => {
    const { homeDir, codexHome, paths } = await setup();
    const marketplace = 'personal';
    const plugin = 'feishu-delegate';
    const version = '0.1.0';
    const skill = 'message-feishu-coworkers';
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, version);
    const sourceSkillDir = path.join(
      paths.sourceCacheDir,
      marketplace,
      plugin,
      version,
      'skills',
      skill,
    );
    await fs.mkdir(sourceSkillDir, { recursive: true });
    await fs.writeFile(path.join(sourceSkillDir, 'SKILL.md'), 'initial', 'utf8');
    const capabilityRouting = explicitOnlySkillPolicy(plugin, marketplace, skill);

    await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting,
    });
    await fs.writeFile(path.join(sourceSkillDir, 'reference.md'), 'new source content', 'utf8');
    const rebuilt = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting,
    });

    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'linked' }),
    ]);
    await expect(
      fs.readFile(
        path.join(paths.cacheDir, marketplace, plugin, version, 'skills', skill, 'reference.md'),
        'utf8',
      ),
    ).resolves.toBe('new source content');
  });

  it('skips cached plugin versions that predate the routed Skill and MCP', async () => {
    const { homeDir, codexHome, paths } = await setup();
    const marketplace = 'personal';
    const plugin = 'feishu-delegate';
    const oldVersion = '0.1.0';
    const currentVersion = '0.2.0';
    const skill = 'message-feishu-coworkers';
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, oldVersion);
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, currentVersion);
    const currentPluginDir = path.join(
      paths.sourceCacheDir,
      marketplace,
      plugin,
      currentVersion,
    );
    await fs.mkdir(path.join(currentPluginDir, 'skills', skill), { recursive: true });
    await fs.writeFile(
      path.join(currentPluginDir, 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\n---\n`,
      'utf8',
    );
    await fs.mkdir(path.join(currentPluginDir, '.codex-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(currentPluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: plugin,
        skills: './skills/',
        mcpServers: './.mcp.json',
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(currentPluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'feishu-delegate': { command: 'node', args: ['./mcp/server.mjs'] },
        },
      }),
      'utf8',
    );
    await writePluginEnabledState(
      paths.sourceConfigFile,
      plugin,
      marketplace,
      true,
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting: isolatedFeishuPolicy(),
    });

    expect(result.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'linked' }),
    ]);
    expect(result.routingFailures).toEqual([]);
    expect(result.warnings).toEqual([]);
    await expect(
      fs.readFile(
        path.join(paths.cacheDir, marketplace, plugin, oldVersion, 'plugin.json'),
        'utf8',
      ),
    ).resolves.toContain(plugin);
    const metadata = yaml.load(
      await fs.readFile(
        path.join(
          paths.cacheDir,
          marketplace,
          plugin,
          currentVersion,
          'skills',
          skill,
          'agents',
          'openai.yaml',
        ),
        'utf8',
      ),
    ) as { policy?: { allow_implicit_invocation?: boolean } };
    expect(metadata.policy?.allow_implicit_invocation).toBe(false);
    const isolatedMcp = JSON.parse(
      await fs.readFile(
        path.join(paths.cacheDir, marketplace, plugin, currentVersion, '.mcp.json'),
        'utf8',
      ),
    ) as { mcpServers: Record<string, unknown> };
    expect(isolatedMcp.mcpServers).toHaveProperty('cindy-routed-feishu-delegate');
    expect(isolatedMcp.mcpServers).not.toHaveProperty('feishu-delegate');
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed instead of following symlinks out of a protected plugin',
    async () => {
      const { homeDir, codexHome, paths } = await setup();
      const pluginDir = path.join(
        paths.sourceCacheDir,
        'personal',
        'feishu-delegate',
        '1.0.0',
      );
      const outsideSkill = path.join(homeDir, 'outside-skill');
      await fs.mkdir(path.join(pluginDir, 'skills'), { recursive: true });
      await fs.mkdir(outsideSkill, { recursive: true });
      await fs.writeFile(
        path.join(outsideSkill, 'SKILL.md'),
        '---\nname: message-feishu-coworkers\n---\n',
        'utf8',
      );
      await fs.symlink(
        outsideSkill,
        path.join(pluginDir, 'skills', 'message-feishu-coworkers'),
        'dir',
      );
      await writePluginEnabledState(
        paths.sourceConfigFile,
        'feishu-delegate',
        'personal',
        true,
      );

      const result = await prepareCodexGlobalPluginsBridge(codexHome, {
        homeDir,
        capabilityRouting: explicitOnlySkillPolicy(),
      });

      expect(result.routingFailures).toEqual([
        expect.stringContaining('feishu-delegate@personal'),
      ]);
      await expect(
        fs.lstat(path.join(outsideSkill, 'agents', 'openai.yaml')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails closed when the protected plugin root itself is a symlink',
    async () => {
      const { homeDir, codexHome, paths } = await setup();
      const marketplaceDir = path.join(paths.sourceCacheDir, 'personal');
      const realPluginDir = path.join(homeDir, 'real-feishu-plugin');
      const realSkillDir = path.join(
        realPluginDir,
        '1.0.0',
        'skills',
        'message-feishu-coworkers',
      );
      await fs.mkdir(realSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(realSkillDir, 'SKILL.md'),
        '---\nname: message-feishu-coworkers\n---\n',
        'utf8',
      );
      await fs.mkdir(marketplaceDir, { recursive: true });
      await fs.symlink(
        realPluginDir,
        path.join(marketplaceDir, 'feishu-delegate'),
        'dir',
      );
      await writePluginEnabledState(
        paths.sourceConfigFile,
        'feishu-delegate',
        'personal',
        true,
      );

      const result = await prepareCodexGlobalPluginsBridge(codexHome, {
        homeDir,
        capabilityRouting: explicitOnlySkillPolicy(),
      });

      expect(result.routingFailures).toEqual([
        expect.stringContaining('feishu-delegate@personal'),
      ]);
      expect(result.warnings).toEqual([
        expect.stringContaining(
          'protected plugin root is an unsupported symlink',
        ),
      ]);
      await expect(
        fs.lstat(path.join(realSkillDir, 'agents', 'openai.yaml')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('never replaces a real marketplace directory that was not created by Cindy routing', async () => {
    const { homeDir, codexHome, paths } = await setup();
    const marketplace = 'personal';
    const plugin = 'feishu-delegate';
    const version = '0.1.0';
    const skill = 'message-feishu-coworkers';
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, version);
    const sourceSkillDir = path.join(
      paths.sourceCacheDir,
      marketplace,
      plugin,
      version,
      'skills',
      skill,
    );
    await fs.mkdir(sourceSkillDir, { recursive: true });
    const isolatedMarketplace = path.join(paths.cacheDir, marketplace);
    await fs.mkdir(isolatedMarketplace, { recursive: true });
    await fs.writeFile(path.join(isolatedMarketplace, 'keep.txt'), 'unmanaged', 'utf8');

    const result = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting: explicitOnlySkillPolicy(plugin, marketplace, skill),
    });

    expect(result.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'conflict' }),
    ]);
    expect(result.routingFailures).toEqual([]);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(path.join(isolatedMarketplace, 'keep.txt'), 'utf8')).resolves.toBe(
      'unmanaged',
    );
  });

  it('reports a routing failure when an unmanaged marketplace contains the protected plugin', async () => {
    const { homeDir, codexHome, paths } = await setup();
    const marketplace = 'personal';
    const plugin = 'feishu-delegate';
    const version = '0.1.0';
    const skill = 'message-feishu-coworkers';
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, version);
    await fs.mkdir(
      path.join(paths.sourceCacheDir, marketplace, plugin, version, 'skills', skill),
      { recursive: true },
    );
    await fs.mkdir(path.join(paths.cacheDir, marketplace, plugin, version), {
      recursive: true,
    });
    await writePluginEnabledState(
      paths.sourceConfigFile,
      plugin,
      marketplace,
      true,
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting: explicitOnlySkillPolicy(plugin, marketplace, skill),
    });

    expect(result.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'conflict' }),
    ]);
    expect(result.routingFailures).toEqual([
      expect.stringContaining(`installed Codex plugin ${plugin}@${marketplace}`),
    ]);
  });

  it('does not fail routing for a protected plugin that exists only in cache', async () => {
    const { homeDir, codexHome, paths } = await setup();
    const marketplace = 'personal';
    const plugin = 'feishu-delegate';
    const version = '0.1.0';
    const skill = 'message-feishu-coworkers';
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, version);
    await fs.mkdir(
      path.join(paths.sourceCacheDir, marketplace, plugin, version, 'skills', skill),
      { recursive: true },
    );
    await fs.mkdir(path.join(paths.cacheDir, marketplace, plugin, version), {
      recursive: true,
    });

    const result = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting: explicitOnlySkillPolicy(plugin, marketplace, skill),
    });

    expect(result.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'conflict' }),
    ]);
    expect(result.routingFailures).toEqual([]);
  });

  it('does not fail routing when the isolated config keeps the plugin disabled', async () => {
    const { homeDir, codexHome, paths } = await setup();
    const marketplace = 'personal';
    const plugin = 'feishu-delegate';
    const version = '0.1.0';
    const skill = 'message-feishu-coworkers';
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, version);
    await fs.mkdir(
      path.join(paths.sourceCacheDir, marketplace, plugin, version, 'skills', skill),
      { recursive: true },
    );
    await fs.mkdir(path.join(paths.cacheDir, marketplace, plugin, version), {
      recursive: true,
    });
    await writePluginEnabledState(
      paths.sourceConfigFile,
      plugin,
      marketplace,
      true,
    );
    await writePluginEnabledState(
      paths.configFile,
      plugin,
      marketplace,
      false,
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting: explicitOnlySkillPolicy(plugin, marketplace, skill),
    });

    expect(result.marketplaces).toEqual([
      expect.objectContaining({ name: marketplace, status: 'conflict' }),
    ]);
    expect(result.addedPluginEntries).toEqual([]);
    expect(result.routingFailures).toEqual([]);
    expect(
      pluginsTableOf(await fs.readFile(paths.configFile, 'utf8'))[
        `${plugin}@${marketplace}`
      ],
    ).toEqual({ enabled: false });
  });

  it.skipIf(process.platform === 'win32')(
    'does not block Codex when a disabled protected plugin cannot be snapshotted',
    async () => {
      const { homeDir, codexHome, paths } = await setup();
      const unreadableDir = path.join(
        paths.sourceCacheDir,
        'personal',
        'feishu-delegate',
        '1.0.0',
        'unreadable',
      );
      await writePluginCache(
        paths.sourceCacheDir,
        'personal',
        'feishu-delegate',
      );
      await fs.mkdir(unreadableDir, { recursive: true });
      await fs.chmod(unreadableDir, 0o000);
      await writePluginEnabledState(
        paths.configFile,
        'feishu-delegate',
        'personal',
        false,
      );

      let result: Awaited<ReturnType<typeof prepareCodexGlobalPluginsBridge>>;
      try {
        result = await prepareCodexGlobalPluginsBridge(codexHome, {
          homeDir,
          capabilityRouting: explicitOnlySkillPolicy(),
        });
      } finally {
        await fs.chmod(unreadableDir, 0o700);
      }

      expect(result.marketplaces).toEqual([
        expect.objectContaining({ name: 'personal', status: 'error' }),
      ]);
      expect(result.routingFailures).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining('cannot snapshot Codex capability-routing source'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails closed when an enabled protected plugin cannot be snapshotted',
    async () => {
      const { homeDir, codexHome, paths } = await setup();
      const unreadableDir = path.join(
        paths.sourceCacheDir,
        'personal',
        'feishu-delegate',
        '1.0.0',
        'unreadable',
      );
      await writePluginCache(
        paths.sourceCacheDir,
        'personal',
        'feishu-delegate',
      );
      await fs.mkdir(unreadableDir, { recursive: true });
      await fs.chmod(unreadableDir, 0o000);
      await writePluginEnabledState(
        paths.sourceConfigFile,
        'feishu-delegate',
        'personal',
        true,
      );

      let result: Awaited<ReturnType<typeof prepareCodexGlobalPluginsBridge>>;
      try {
        result = await prepareCodexGlobalPluginsBridge(codexHome, {
          homeDir,
          capabilityRouting: explicitOnlySkillPolicy(),
        });
      } finally {
        await fs.chmod(unreadableDir, 0o700);
      }

      expect(result.marketplaces).toEqual([
        expect.objectContaining({ name: 'personal', status: 'error' }),
      ]);
      expect(result.routingFailures).toEqual([
        expect.stringContaining('feishu-delegate@personal'),
      ]);
    },
  );

  it('fails closed when enablement is unknown and a protected plugin is uncontrolled', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(
      paths.sourceCacheDir,
      'personal',
      'feishu-delegate',
    );
    await fs.mkdir(
      path.join(paths.cacheDir, 'personal', 'feishu-delegate', '1.0.0'),
      { recursive: true },
    );
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(paths.configFile, '[plugins."broken\n', 'utf8');

    const result = await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting: explicitOnlySkillPolicy(),
    });

    expect(result.marketplaces).toEqual([
      expect.objectContaining({ name: 'personal', status: 'conflict' }),
    ]);
    expect(result.routingFailures).toEqual([
      expect.stringContaining('feishu-delegate@personal'),
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining('cannot confirm enabled plugins'),
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'gates unreadable cache inventories by the isolated plugin enablement',
    async () => {
      const prepare = async (
        unreadable: 'source' | 'isolated',
        enabled: boolean,
      ) => {
        const { homeDir, codexHome, paths } = await setup();
        const cacheRoot =
          unreadable === 'source' ? paths.sourceCacheDir : paths.cacheDir;
        await writePluginCache(
          cacheRoot,
          'personal',
          'feishu-delegate',
        );
        await writePluginEnabledState(
          paths.configFile,
          'feishu-delegate',
          'personal',
          enabled,
        );
        await fs.chmod(cacheRoot, 0o000);
        try {
          return await prepareCodexGlobalPluginsBridge(codexHome, {
            homeDir,
            capabilityRouting: explicitOnlySkillPolicy(),
          });
        } finally {
          await fs.chmod(cacheRoot, 0o700);
        }
      };

      for (const unreadable of ['source', 'isolated'] as const) {
        const disabled = await prepare(unreadable, false);
        expect(disabled.routingFailures).toEqual([]);
        expect(disabled.warnings).toEqual([
          expect.stringContaining(`cannot inspect ${unreadable === 'source' ? 'user' : 'isolated'} Codex plugin cache`),
        ]);

        const enabled = await prepare(unreadable, true);
        expect(enabled.routingFailures).toEqual([
          expect.stringContaining('feishu-delegate@personal'),
        ]);
      }
    },
  );

  it('links marketplace cache dirs and appends missing [plugins] entries', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await writePluginCache(paths.sourceCacheDir, 'team-mkt', 'team-plugin');
    await fs.writeFile(
      paths.sourceConfigFile,
      [
        'model = "gpt-5.5"',
        '',
        '[plugins."superpowers@superpowers-dev"]',
        'enabled = true',
        '',
        '[plugins."team-plugin@team-mkt"]',
        'enabled = false',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.addedPluginEntries.sort()).toEqual([
      'superpowers@superpowers-dev',
      'team-plugin@team-mkt',
    ]);
    expect(
      await sameRealPath(
        path.join(paths.cacheDir, 'superpowers-dev'),
        path.join(paths.sourceCacheDir, 'superpowers-dev'),
      ),
    ).toBe(true);

    const destText = await fs.readFile(paths.configFile, 'utf8');
    // 新建的 config 不应以空行开头(与 codex 原生写出的格式一致)
    expect(destText.startsWith('\n')).toBe(false);
    const plugins = pluginsTableOf(destText);
    expect(plugins['superpowers@superpowers-dev']).toEqual({ enabled: true });
    expect(plugins['team-plugin@team-mkt']).toEqual({ enabled: false });
  });

  it('is idempotent: second run changes nothing and appends no duplicates', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = true\n',
      'utf8',
    );

    await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });
    const firstText = await fs.readFile(paths.configFile, 'utf8');
    const second = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(second.changed).toBe(false);
    expect(second.addedPluginEntries).toEqual([]);
    await expect(fs.readFile(paths.configFile, 'utf8')).resolves.toBe(firstText);
  });

  it('never overwrites an existing entry in the isolated config', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = true\n',
      'utf8',
    );
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      paths.configFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = false\n',
      'utf8',
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.addedPluginEntries).toEqual([]);
    const plugins = pluginsTableOf(await fs.readFile(paths.configFile, 'utf8'));
    expect(plugins['superpowers@superpowers-dev']).toEqual({ enabled: false });
  });

  it('preserves existing isolated config content when appending', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = true\n',
      'utf8',
    );
    await fs.mkdir(codexHome, { recursive: true });
    const existing = '[projects.\'D:\\workspace\\demo\']\ntrust_level = "trusted"\n';
    await fs.writeFile(paths.configFile, existing, 'utf8');

    await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    const destText = await fs.readFile(paths.configFile, 'utf8');
    expect(destText.startsWith(existing)).toBe(true);
    const parsed = parseToml(destText) as Record<string, unknown>;
    expect(parsed['projects']).toBeDefined();
    expect(pluginsTableOf(destText)['superpowers@superpowers-dev']).toEqual({ enabled: true });
  });

  it('keeps a real (codex-managed) marketplace dir intact as an expected conflict', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'openai-curated-remote', 'atlassian-rovo');
    const realDir = path.join(paths.cacheDir, 'openai-curated-remote');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, 'keep.txt'), 'do not remove', 'utf8');

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    const entry = result.marketplaces.find((m) => m.name === 'openai-curated-remote');
    expect(entry?.status).toBe('conflict');
    // conflict 是稳态,不应该刷 warning
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(path.join(realDir, 'keep.txt'), 'utf8')).resolves.toBe(
      'do not remove',
    );
  });

  it('removes a dangling managed link when its source marketplace disappears', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');

    await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });
    const link = path.join(paths.cacheDir, 'superpowers-dev');
    expect(await sameRealPath(link, path.join(paths.sourceCacheDir, 'superpowers-dev'))).toBe(true);

    await fs.rm(path.join(paths.sourceCacheDir, 'superpowers-dev'), {
      recursive: true,
      force: true,
    });
    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.changed).toBe(true);
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a Cindy-managed overlay when its source marketplace disappears', async () => {
    const { homeDir, codexHome, paths } = await setup();
    const marketplace = 'personal';
    const plugin = 'feishu-delegate';
    const version = '0.1.0';
    const skill = 'message-feishu-coworkers';
    await writePluginCache(paths.sourceCacheDir, marketplace, plugin, version);
    await fs.mkdir(path.join(paths.sourceCacheDir, marketplace, plugin, version, 'skills', skill), {
      recursive: true,
    });
    await prepareCodexGlobalPluginsBridge(codexHome, {
      homeDir,
      capabilityRouting: explicitOnlySkillPolicy(plugin, marketplace, skill),
    });
    const overlay = path.join(paths.cacheDir, marketplace);
    expect((await fs.lstat(overlay)).isDirectory()).toBe(true);

    await fs.rm(path.join(paths.sourceCacheDir, marketplace), {
      recursive: true,
      force: true,
    });
    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.changed).toBe(true);
    await expect(fs.lstat(overlay)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips plugin entries whose marketplace has no cache dir', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      [
        '[plugins."superpowers@superpowers-dev"]',
        'enabled = true',
        '',
        // openai-bundled 的缓存不在 plugins/cache 下(bundled snapshot 随 home 自愈),不桥接
        '[plugins."sites@openai-bundled"]',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.addedPluginEntries).toEqual(['superpowers@superpowers-dev']);
    const plugins = pluginsTableOf(await fs.readFile(paths.configFile, 'utf8'));
    expect(plugins['sites@openai-bundled']).toBeUndefined();
  });

  it('is a no-op when the user has no ~/.codex plugins at all', async () => {
    const { homeDir, codexHome, paths } = await setup();

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.changed).toBe(false);
    expect(result.marketplaces).toEqual([]);
    expect(result.addedPluginEntries).toEqual([]);
    expect(result.warnings).toEqual([]);
    await expect(fs.lstat(paths.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still links caches but skips entry sync when the user config is unparsable', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(paths.sourceConfigFile, '[plugins."broken\n= oops', 'utf8');

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(
      await sameRealPath(
        path.join(paths.cacheDir, 'superpowers-dev'),
        path.join(paths.sourceCacheDir, 'superpowers-dev'),
      ),
    ).toBe(true);
    expect(result.addedPluginEntries).toEqual([]);
    expect(result.warnings.some((w) => w.includes('cannot read user codex config'))).toBe(true);
  });

  it('refuses to clobber a config modified after the merge snapshot (concurrent writer)', async () => {
    const root = await makeTmpDir();
    const file = path.join(root, 'config.toml');
    await fs.writeFile(file, 'model = "a"\n', 'utf8');
    // 快照(expectedText)是旧内容,但文件已被"并发写入者"改成新内容
    const snapshot = 'model = "a"\n';
    await fs.writeFile(file, 'model = "a"\n\n[projects.x]\ntrust_level = "trusted"\n', 'utf8');

    const applied = await writeFileAtomicIfUnchanged(
      file,
      `${snapshot}\n[plugins."p@m"]\nenabled = true\n`,
      snapshot,
    );

    expect(applied).toBe(false);
    // 并发写入者的内容原样保留,tmp 文件不残留
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(
      'model = "a"\n\n[projects.x]\ntrust_level = "trusted"\n',
    );
    const leftovers = (await fs.readdir(root)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('applies the write when the config still matches the merge snapshot', async () => {
    const root = await makeTmpDir();
    const file = path.join(root, 'config.toml');
    const snapshot = 'model = "a"\n';
    await fs.writeFile(file, snapshot, 'utf8');

    const next = `${snapshot}\n[plugins."p@m"]\nenabled = true\n`;
    const applied = await writeFileAtomicIfUnchanged(file, next, snapshot);

    expect(applied).toBe(true);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(next);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a restrictive file mode across the atomic replace (POSIX)',
    async () => {
      const root = await makeTmpDir();
      const file = path.join(root, 'config.toml');
      const snapshot = 'model = "a"\n';
      await fs.writeFile(file, snapshot, 'utf8');
      await fs.chmod(file, 0o600);

      const applied = await writeFileAtomicIfUnchanged(file, `${snapshot}x = 1\n`, snapshot);

      expect(applied).toBe(true);
      const mode = (await fs.stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it('never appends when the isolated config itself is unparsable', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = true\n',
      'utf8',
    );
    await fs.mkdir(codexHome, { recursive: true });
    const broken = '[plugins."half\n';
    await fs.writeFile(paths.configFile, broken, 'utf8');

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.addedPluginEntries).toEqual([]);
    expect(result.warnings.some((w) => w.includes('cannot parse isolated codex config'))).toBe(
      true,
    );
    await expect(fs.readFile(paths.configFile, 'utf8')).resolves.toBe(broken);
  });
});
