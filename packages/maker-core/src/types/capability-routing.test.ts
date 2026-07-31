import { describe, expect, it } from 'vitest';

import {
  capabilitySelectionAddedByPlanEdit,
  findCapabilityRouteOverride,
  findClaudeMcpCapabilityRoute,
  isCapabilitySourceExplicitlySelected,
  type CapabilityRouteOverride,
  type CapabilityRoutingPolicy,
  type CapabilitySourceSelector,
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
  it('requires harness provenance only for harness-owned sources', () => {
    // @ts-expect-error Harness-owned selectors must identify their adapter.
    const missingHarness: CapabilitySourceSelector = {
      kind: 'harness-plugin',
      surface: 'mcp',
      id: 'feishu-delegate',
    };
    // @ts-expect-error User-owned selectors cannot masquerade as harness sources.
    const userSourceWithHarness: CapabilitySourceSelector = {
      kind: 'user-skill',
      harness: 'codex',
      surface: 'skill',
      id: 'user-skill',
    };

    expect(missingHarness.kind).toBe('harness-plugin');
    expect(userSourceWithHarness.kind).toBe('user-skill');
  });

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
        kind: 'project-skill' as const,
        surface: route.source.surface,
        id: route.source.id,
      },
    };
    const policy = {
      overrides: [
        userOwnedLookalike,
        route,
        {
          ...route,
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
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
      findClaudeMcpCapabilityRoute(
        policy,
        'mcp__plugin_feishu-delegate_feishu-delegate__feishu_read_messages',
        new Set(['plugin_feishu-delegate_feishu-delegate']),
      ),
    ).toBeUndefined();
    expect(
      findClaudeMcpCapabilityRoute(
        policy,
        'mcp__plugin_feishu-delegate_feishu-delegate__feishu_read_messages',
        new Set(['plugin:feishu-delegate:feishu-delegate']),
      ),
    ).toBeUndefined();
    expect(
      findClaudeMcpCapabilityRoute(policy, 'mcp__other__read'),
    ).toBeUndefined();
  });

  it('accepts only selectors newly introduced by a user plan edit', () => {
    const policy = { overrides: [route] } satisfies CapabilityRoutingPolicy;
    expect(
      capabilitySelectionAddedByPlanEdit(
        policy,
        'codex',
        '1. 查询消息',
        '1. 用 $feishu-delegate:message-feishu-coworkers 查询消息',
      ),
    ).toBe('$feishu-delegate:message-feishu-coworkers');
    expect(
      capabilitySelectionAddedByPlanEdit(
        policy,
        'codex',
        '1. 用 $feishu-delegate:message-feishu-coworkers 查询消息',
        '1. 用 $feishu-delegate:message-feishu-coworkers 查询最近消息',
      ),
    ).toBe('');
    expect(
      capabilitySelectionAddedByPlanEdit(
        policy,
        'codex',
        '1. 用 $feishu-delegate:message-feishu-coworkers 查询消息',
        '1. 改用 /feishu-delegate:message-feishu-coworkers 查询消息',
      ),
    ).toBe('/feishu-delegate:message-feishu-coworkers');
  });
});
