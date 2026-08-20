import { describe, expect, it } from 'vitest';

import type { CapabilityRoutingPolicy } from '../../types/capability-routing.js';
import {
  buildCodexCapabilityConfigOverrides,
  buildCodexPluginIsolationConfig,
  buildCodexSessionCapabilityRoutingPolicy,
} from './capability-routing.js';

describe('buildCodexSessionCapabilityRoutingPolicy', () => {
  const compatibilityRoute = {
    capabilityId: 'computer-use',
    source: {
      kind: 'harness-plugin',
      harness: 'codex',
      surface: 'skill',
      id: 'computer-use:computer-use',
      artifactId: 'computer-use',
      containerId: 'computer-use@openai-bundled',
    },
    invocation: 'disabled',
  } as const;
  const localReplacementRoute = {
    capabilityId: 'computer-use',
    source: {
      kind: 'harness-plugin',
      harness: 'codex',
      surface: 'plugin',
      id: 'computer-use@openai-bundled',
    },
    invocation: 'disabled',
    replacement: { kind: 'cindy-host', id: 'cindy_computer' },
  } as const;
  const pluginReplacementRoute = {
    capabilityId: 'example',
    source: {
      kind: 'harness-plugin',
      harness: 'codex',
      surface: 'plugin',
      id: 'example@personal',
    },
    invocation: 'disabled',
    replacement: { kind: 'cindy-plugin', id: 'example' },
  } as const;
  const policy = {
    overrides: [
      compatibilityRoute,
      localReplacementRoute,
      pluginReplacementRoute,
    ],
  } as const satisfies CapabilityRoutingPolicy;

  it('preserves local-host replacement arbitration for local Codex', () => {
    expect(buildCodexSessionCapabilityRoutingPolicy(policy, {
      cindyHostReplacementsAvailable: true,
    })).toBe(policy);
  });

  it('removes only unavailable Cindy-host replacements for remote Codex', () => {
    expect(buildCodexSessionCapabilityRoutingPolicy(policy, {
      cindyHostReplacementsAvailable: false,
    })).toEqual({
      overrides: [compatibilityRoute, pluginReplacementRoute],
    });
  });
});

describe('buildCodexCapabilityConfigOverrides', () => {
  it('can fail closed a host MCP server for one thread', () => {
    const policy = {
      overrides: [{
        capabilityId: 'browser-use',
        source: {
          kind: 'harness-plugin' as const,
          harness: 'codex',
          surface: 'mcp' as const,
          id: 'node_repl',
        },
        invocation: 'disabled' as const,
      }],
    };

    expect(buildCodexCapabilityConfigOverrides(policy)).toEqual({
      'mcp_servers.node_repl.enabled': false,
    });
  });

  it('disables the selected Codex plugin with a per-thread config override', () => {
    const policy = {
      overrides: [
        {
          capabilityId: 'computer-use',
          source: {
            kind: 'harness-plugin',
            harness: 'codex',
            surface: 'plugin',
            id: 'computer-use@openai-bundled',
          },
          invocation: 'disabled',
          replacement: {
            kind: 'cindy-host',
            id: 'cindy_computer',
          },
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;

    expect(buildCodexCapabilityConfigOverrides(policy)).toEqual({
      'plugins."computer-use@openai-bundled".enabled': false,
    });
  });

  it('fails closed explicit-only plugin routes and ignores unrelated directives', () => {
    const policy = {
      overrides: [
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
        },
        {
          capabilityId: 'computer-use',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'plugin',
            id: 'computer-use',
          },
          invocation: 'disabled',
        },
        {
          capabilityId: 'computer-use',
          source: {
            kind: 'harness-builtin',
            harness: 'codex',
            surface: 'tool',
            id: 'computer',
          },
          invocation: 'disabled',
        },
        {
          capabilityId: 'computer-use',
          source: {
            kind: 'harness-plugin',
            harness: 'codex',
            surface: 'plugin',
            id: 'computer-use@openai-bundled',
          },
          invocation: 'auto',
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;

    expect(buildCodexCapabilityConfigOverrides(policy)).toEqual({
      'plugins."feishu-delegate@personal".enabled': false,
    });
  });

  it('quotes plugin ids as safe TOML path segments', () => {
    const policy = {
      overrides: [
        {
          capabilityId: 'example',
          source: {
            kind: 'harness-plugin',
            harness: 'codex',
            surface: 'plugin',
            id: 'plugin\\"quoted',
          },
          invocation: 'disabled',
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;

    expect(buildCodexCapabilityConfigOverrides(policy)).toEqual({
      'plugins."plugin\\\\\\"quoted".enabled': false,
    });
  });

  it('fails closed for explicit-only plugins when the Codex home has no isolated overlay', () => {
    const policy = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'codex',
            surface: 'skill',
            id: 'feishu-delegate:message-feishu-coworkers',
            artifactId: 'message-feishu-coworkers',
            containerId: 'feishu-delegate@personal',
          },
          invocation: 'explicit-only',
        },
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
        },
        {
          capabilityId: 'computer-use',
          source: {
            kind: 'harness-plugin',
            harness: 'codex',
            surface: 'plugin',
            id: 'computer-use@openai-bundled',
          },
          invocation: 'disabled',
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;

    expect(buildCodexCapabilityConfigOverrides(policy)).toEqual({
      'plugins."feishu-delegate@personal".enabled': false,
      'plugins."computer-use@openai-bundled".enabled': false,
    });
  });

  it('fails closed when a remote explicit-only route has no owning plugin id', () => {
    const policy = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'codex',
            surface: 'skill',
            id: 'feishu-delegate:message-feishu-coworkers',
          },
          invocation: 'explicit-only',
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;

    expect(() => buildCodexCapabilityConfigOverrides(policy))
      .toThrowError(/source\.containerId is required/);
  });
});

describe('buildCodexPluginIsolationConfig', () => {
  it('disables configured plugins, plugin MCP servers, and plugin Skills', () => {
    const pluginSkill =
      '/Users/dash/.codex/plugins/cache/personal/example/1.0.0/skills/run/SKILL.md';
    const disabledStandaloneSkill =
      '/Users/dash/.codex/skills/already-disabled/SKILL.md';
    const similarStandaloneSkill =
      '/Users/dash/repo/plugins/cache/personal/example/SKILL.md';

    expect(buildCodexPluginIsolationConfig({
      'example@personal': {
        enabled: true,
        mcp_servers: {
          example_server: { command: 'node', args: ['server.js'] },
          metadata_only: { enabled: true },
        },
      },
    }, [
      { path: pluginSkill, enabled: true },
      { path: disabledStandaloneSkill, enabled: false },
      { path: '/Users/dash/.codex/skills/standalone/SKILL.md', enabled: true },
      { path: similarStandaloneSkill, enabled: true },
    ])).toEqual({
      'features.apps': false,
      'features.remote_plugin': false,
      'skills.config': [
        { path: pluginSkill, enabled: false },
        { path: disabledStandaloneSkill, enabled: false },
      ],
      'plugins."example@personal".enabled': false,
      'plugins."example@personal".mcp_servers.example_server.enabled': false,
    });
  });

  it('derives plugin ids from Windows caches and bundled marketplace snapshots', () => {
    const bundledSkill =
      '/Users/dash/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/browser/skills/browser/SKILL.md';
    const windowsSkill =
      'C:\\Users\\dash\\.codex\\plugins\\cache\\personal\\example\\1.0.0\\skills\\run\\SKILL.md';

    expect(buildCodexPluginIsolationConfig({}, [
      { path: windowsSkill, enabled: true },
      { path: bundledSkill, enabled: true },
    ])).toEqual({
      'features.apps': false,
      'features.remote_plugin': false,
      'skills.config': [
        { path: bundledSkill, enabled: false },
        { path: windowsSkill, enabled: false },
      ],
      'plugins."browser@openai-bundled".enabled': false,
      'plugins."example@personal".enabled': false,
    });
  });

  it('keeps plugin features disabled when no installed plugin is present', () => {
    expect(buildCodexPluginIsolationConfig({}, [{
      path: '/Users/dash/.codex/skills/already-disabled/SKILL.md',
      enabled: false,
    }])).toEqual({
      'features.apps': false,
      'features.remote_plugin': false,
    });
  });
});
