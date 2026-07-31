import { describe, expect, it } from 'vitest';

import {
  findCapabilityRouteOverride,
  findClaudeMcpCapabilityRoute,
  isCapabilitySourceExplicitlySelected,
  type CapabilityRouteOverride,
  type CapabilityRoutingPolicy,
} from './capability-routing.js';

const route: CapabilityRouteOverride = {
  capabilityId: 'feishu',
  source: {
    kind: 'harness-plugin',
    harness: 'codex',
    surface: 'mcp',
    id: 'feishu-delegate',
  },
  invocation: 'explicit-only',
  explicitSelectors: [
    '$feishu-delegate:message-feishu-coworkers',
    '/feishu-delegate:message-feishu-coworkers',
  ],
};

describe('capability route resolution', () => {
  it('recognizes exact namespaced skill selectors without unlocking on a display name', () => {
    expect(
      isCapabilitySourceExplicitlySelected(
        route,
        '请用 $feishu-delegate:message-feishu-coworkers 查一下康康',
      ),
    ).toBe(true);
    expect(
      isCapabilitySourceExplicitlySelected(
        route,
        '/feishu-delegate:message-feishu-coworkers 查一下康康',
      ),
    ).toBe(true);
    expect(
      isCapabilitySourceExplicitlySelected(
        route,
        '请用$feishu-delegate:message-feishu-coworkers查一下康康',
      ),
    ).toBe(true);
    expect(
      isCapabilitySourceExplicitlySelected(
        route,
        'prefix$feishu-delegate:message-feishu-coworkers',
      ),
    ).toBe(false);
    expect(
      isCapabilitySourceExplicitlySelected(route, '查一下我和康康的飞书消息'),
    ).toBe(false);
    expect(
      isCapabilitySourceExplicitlySelected(
        route,
        '请用 /message-feishu-coworkers 查一下康康',
      ),
    ).toBe(false);
    expect(
      isCapabilitySourceExplicitlySelected(
        route,
        '不要使用 Feishu Delegate，改用 Cindy',
      ),
    ).toBe(false);
    expect(
      isCapabilitySourceExplicitlySelected(
        { ...route, explicitSelectors: ['Feishu Delegate'] },
        '请使用 Feishu Delegate',
      ),
    ).toBe(false);
  });

  it('matches MCP routes without conflating harnesses or surfaces', () => {
    const userOwnedLookalike = {
      ...route,
      source: {
        ...route.source,
        kind: 'project-skill' as const,
      },
    };
    const policy = {
      overrides: [
        userOwnedLookalike,
        route,
        {
          ...route,
          source: {
            ...route.source,
            harness: 'claude-code',
            id: 'plugin:feishu-delegate:feishu-delegate',
          },
        },
      ],
    } satisfies CapabilityRoutingPolicy;

    expect(
      findCapabilityRouteOverride(policy, {
        harness: 'codex',
        surface: 'mcp',
        id: 'feishu-delegate',
      }),
    ).toBe(route);
    expect(
      findClaudeMcpCapabilityRoute(
        policy,
        'mcp__plugin_feishu-delegate_feishu-delegate__feishu_read_messages',
      )?.source.harness,
    ).toBe('claude-code');
    expect(
      findClaudeMcpCapabilityRoute(
        policy,
        'mcp__feishu-delegate__feishu_read_messages',
      ),
    ).toBeUndefined();
    expect(
      findClaudeMcpCapabilityRoute(policy, 'mcp__other__read'),
    ).toBeUndefined();
  });
});
