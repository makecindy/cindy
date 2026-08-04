import { describe, expect, it } from 'vitest';

import type { CapabilityRoutingPolicy } from '../../types/capability-routing.js';
import {
  buildCodexCapabilityConfigOverrides,
  buildCodexCapabilitySkillConfigOverrides,
  buildCodexSessionCapabilityRoutingPolicy,
  requiresCodexCapabilitySkillDiscovery,
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

  it('does not widen unsupported or unrelated directives', () => {
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
      'plugins."feishu-delegate@personal".mcp_servers.feishu-delegate.enabled': false,
      'plugins."feishu-delegate@personal".mcp_servers.cindy-routed-feishu-delegate.default_tools_approval_mode':
        'prompt',
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

    expect(
      buildCodexCapabilityConfigOverrides(policy, {
        isolatedPluginOverlays: false,
      }),
    ).toEqual({
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

    expect(() =>
      buildCodexCapabilityConfigOverrides(policy, {
        isolatedPluginOverlays: false,
      }),
    ).toThrowError(/source\.containerId is required/);
  });
});

describe('buildCodexCapabilitySkillConfigOverrides', () => {
  const disabledPluginPolicy = {
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
      },
    ],
  } as const satisfies CapabilityRoutingPolicy;

  const disabledSkillPolicy = {
    overrides: [
      {
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
      },
    ],
  } as const satisfies CapabilityRoutingPolicy;

  it('disables matching plugin Skills and preserves existing disabled Skills', () => {
    expect(requiresCodexCapabilitySkillDiscovery(disabledPluginPolicy)).toBe(true);
    expect(buildCodexCapabilitySkillConfigOverrides(disabledPluginPolicy, [
      {
        path: '/Users/dash/.codex/plugins/cache/openai-bundled/computer-use/1.0.0/skills/computer-use/SKILL.md',
        enabled: true,
      },
      {
        path: '/Users/dash/.codex/skills/already-disabled/SKILL.md',
        enabled: false,
      },
      {
        path: '/Users/dash/.codex/plugins/cache/openai-bundled/browser/1.0.0/skills/browser/SKILL.md',
        enabled: true,
      },
    ])).toEqual({
      'skills.config': [
        {
          path: '/Users/dash/.codex/plugins/cache/openai-bundled/computer-use/1.0.0/skills/computer-use/SKILL.md',
          enabled: false,
        },
        {
          path: '/Users/dash/.codex/skills/already-disabled/SKILL.md',
          enabled: false,
        },
      ],
    });
  });

  it('matches remote Windows plugin cache paths without disabling namesakes', () => {
    expect(buildCodexCapabilitySkillConfigOverrides(disabledPluginPolicy, [
      {
        path: 'C:\\Users\\dash\\.codex\\plugins\\cache\\openai-bundled\\computer-use\\1.0.0\\skills\\computer-use\\SKILL.md',
        enabled: true,
      },
      {
        path: 'C:\\Users\\dash\\.codex\\skills\\computer-use\\SKILL.md',
        enabled: true,
      },
    ])).toEqual({
      'skills.config': [{
        path: 'C:\\Users\\dash\\.codex\\plugins\\cache\\openai-bundled\\computer-use\\1.0.0\\skills\\computer-use\\SKILL.md',
        enabled: false,
      }],
    });
  });

  it('matches bundled marketplace snapshots without disabling namesakes', () => {
    const macSnapshotPath =
      '/Users/dash/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/computer-use/skills/computer-use/SKILL.md';
    const windowsSnapshotPath =
      'C:\\Users\\dash\\.codex\\.tmp\\bundled-marketplaces\\openai-bundled.staging-123\\plugins\\computer-use\\skills\\computer-use\\SKILL.md';
    expect(buildCodexCapabilitySkillConfigOverrides(disabledSkillPolicy, [
      { path: macSnapshotPath, enabled: true },
      { path: windowsSnapshotPath, enabled: true },
      {
        path: '/Users/dash/.codex/skills/computer-use/SKILL.md',
        enabled: true,
      },
    ])).toEqual({
      'skills.config': [
        { path: macSnapshotPath, enabled: false },
        { path: windowsSnapshotPath, enabled: false },
      ],
    });
  });

  it('disables only the selected incompatible Skill without disabling its plugin', () => {
    expect(requiresCodexCapabilitySkillDiscovery(disabledSkillPolicy)).toBe(true);
    expect(buildCodexCapabilityConfigOverrides(disabledSkillPolicy)).toEqual({});
    expect(buildCodexCapabilitySkillConfigOverrides(disabledSkillPolicy, [
      {
        path: '/Users/dash/.codex/plugins/cache/openai-bundled/computer-use/1.0.0/skills/computer-use/SKILL.md',
        enabled: true,
      },
      {
        path: '/Users/dash/.codex/plugins/cache/openai-bundled/computer-use/1.0.0/skills/setup/SKILL.md',
        enabled: true,
      },
      {
        path: '/Users/dash/.codex/skills/computer-use/SKILL.md',
        enabled: true,
      },
    ])).toEqual({
      'skills.config': [{
        path: '/Users/dash/.codex/plugins/cache/openai-bundled/computer-use/1.0.0/skills/computer-use/SKILL.md',
        enabled: false,
      }],
    });
  });

  it('does not replace the base skills config when the plugin contributes no Skills', () => {
    expect(buildCodexCapabilitySkillConfigOverrides(disabledPluginPolicy, [{
      path: '/Users/dash/.codex/skills/already-disabled/SKILL.md',
      enabled: false,
    }])).toEqual({});
  });

  it('fails closed when a disabled plugin id has no marketplace provenance', () => {
    const invalidPolicy = {
      overrides: [{
        capabilityId: 'example',
        source: {
          kind: 'harness-plugin',
          harness: 'codex',
          surface: 'plugin',
          id: 'plugin-without-marketplace',
        },
        invocation: 'disabled',
      }],
    } as const satisfies CapabilityRoutingPolicy;

    expect(() => buildCodexCapabilitySkillConfigOverrides(invalidPolicy, []))
      .toThrowError(/expected plugin id in <name>@<marketplace> form/);
  });

  it('identifies a missing plugin source id in the error', () => {
    const invalidPolicy = {
      overrides: [{
        capabilityId: 'example',
        source: {
          kind: 'harness-plugin',
          harness: 'codex',
          surface: 'plugin',
          id: '',
        },
        invocation: 'disabled',
      }],
    } as const satisfies CapabilityRoutingPolicy;

    expect(() => buildCodexCapabilitySkillConfigOverrides(invalidPolicy, []))
      .toThrowError(/source\.id is required/);
  });

  it('fails closed when a disabled Skill lacks precise plugin provenance', () => {
    const noContainer = {
      overrides: [{
        capabilityId: 'example',
        source: {
          kind: 'harness-plugin',
          harness: 'codex',
          surface: 'skill',
          id: 'example:skill',
          artifactId: 'skill',
        },
        invocation: 'disabled',
      }],
    } as const satisfies CapabilityRoutingPolicy;
    const noArtifact = {
      overrides: [{
        capabilityId: 'example',
        source: {
          kind: 'harness-plugin',
          harness: 'codex',
          surface: 'skill',
          id: 'example:skill',
          containerId: 'example@marketplace',
        },
        invocation: 'disabled',
      }],
    } as const satisfies CapabilityRoutingPolicy;

    expect(() => buildCodexCapabilitySkillConfigOverrides(noContainer, []))
      .toThrowError(/source\.containerId is required/);
    expect(() => buildCodexCapabilitySkillConfigOverrides(noArtifact, []))
      .toThrowError(/source\.artifactId is required/);
  });

  it('skips discovery for unrelated routing policies', () => {
    const unrelatedPolicy = {
      overrides: [{
        capabilityId: 'computer-use',
        source: {
          kind: 'harness-plugin',
          harness: 'claude-code',
          surface: 'plugin',
          id: 'computer-use@openai-bundled',
        },
        invocation: 'disabled',
      }],
    } as const satisfies CapabilityRoutingPolicy;

    expect(requiresCodexCapabilitySkillDiscovery(unrelatedPolicy)).toBe(false);
    expect(buildCodexCapabilitySkillConfigOverrides(unrelatedPolicy, []))
      .toEqual({});
  });
});
