import { describe, expect, it } from 'vitest';

import type { CapabilityRoutingPolicy } from '../../types/capability-routing.js';
import { buildCodexCapabilityConfigOverrides } from './capability-routing.js';

describe('buildCodexCapabilityConfigOverrides', () => {
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
      'plugins."feishu-delegate@personal".mcp_servers."feishu-delegate".enabled': false,
      'plugins."feishu-delegate@personal".mcp_servers."cindy-routed-feishu-delegate".default_tools_approval_mode':
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
