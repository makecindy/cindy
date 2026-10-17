import { describe, expect, it } from 'vitest';

import type {
  CapabilityInvocationPolicy,
  CapabilityRouteOverride,
  CapabilitySurface,
} from '../../types/capability-routing.js';
import { findUnenforcedCapabilityRoutes } from '../capability-route-support.js';
import {
  buildClaudeDeniedMcpServers,
  buildClaudeDisallowedTools,
  buildClaudeRemoteToolGuards,
  buildClaudeSkillOverrides,
} from '../claude-code/capability-routing.js';
import {
  buildCodexCapabilityConfigOverrides,
  buildCodexCapabilitySkillConfigOverrides,
} from '../codex/capability-routing.js';

const SURFACES: CapabilitySurface[] = ['skill', 'plugin', 'mcp', 'app', 'tool'];
const INVOCATIONS: CapabilityInvocationPolicy[] = ['auto', 'explicit-only', 'disabled'];
const IDENTITIES = [
  { id: 'visualize@openai-bundled' },
  { id: 'Artifact' },
  { id: 'server', containerId: 'tools@market' },
  { id: 'server', containerId: 'tools@market', artifactId: 'server' },
  { id: 'routed-server', containerId: 'tools@market', artifactId: 'server' },
  { id: 'tools:skill', containerId: 'not-a-plugin-id', artifactId: 'skill' },
];

function candidateRoutes(): CapabilityRouteOverride[] {
  return ['claude-code', 'codex', 'pi'].flatMap((harness) =>
    (['harness-builtin', 'harness-plugin'] as const).flatMap((kind) =>
      SURFACES.flatMap((surface) =>
        INVOCATIONS.flatMap((invocation) =>
          IDENTITIES.map((identity) => ({
            capabilityId: 'contract',
            source: { kind, harness, surface, ...identity },
            invocation,
          })),
        ),
      ),
    ),
  );
}

function hasClaudeEffect(route: CapabilityRouteOverride): boolean {
  const policy = { overrides: [route] };
  return (
    Object.keys(buildClaudeSkillOverrides(policy)).length > 0 ||
    buildClaudeDisallowedTools(policy).length > 0 ||
    buildClaudeDeniedMcpServers(policy).length > 0 ||
    buildClaudeRemoteToolGuards(policy).length > 0
  );
}

/** Codex must apply the route without throwing, locally and remotely. */
function hasCodexEffect(route: CapabilityRouteOverride): boolean {
  const policy = { overrides: [route] };
  try {
    const remote = buildCodexCapabilityConfigOverrides(policy, { isolatedPluginOverlays: false });
    const local = buildCodexCapabilityConfigOverrides(policy, { isolatedPluginOverlays: true });
    const pluginId = route.source.surface === 'plugin' ? route.source.id : route.source.containerId;
    const [name, marketplace] = (pluginId ?? 'x@y').split('@');
    const skills = buildCodexCapabilitySkillConfigOverrides(policy, [{
      path: `/codex/plugins/cache/${marketplace}/${name}/1.0.0/skills/${route.source.artifactId ?? 'skill'}/SKILL.md`,
      enabled: true,
    }]);
    if (route.invocation === 'explicit-only') {
      // Local explicit-only sources are narrowed by the desktop plugin overlay.
      return Object.keys(remote).length > 0;
    }
    // A disabled Skill is hidden through Skill config; plugins and MCP servers
    // through thread config, in both runtimes.
    if (route.source.surface === 'skill') return Object.keys(skills).length > 0;
    return Object.keys(remote).length > 0 && Object.keys(local).length > 0;
  } catch {
    return false;
  }
}

describe('findUnenforcedCapabilityRoutes', () => {
  it('accepts a route only when its harness adapter produces a control for it', () => {
    for (const route of candidateRoutes()) {
      const accepted = findUnenforcedCapabilityRoutes({ overrides: [route] }).length === 0;
      if (!accepted) continue;
      const effect = route.source.harness === 'claude-code'
        ? hasClaudeEffect(route)
        : route.source.harness === 'codex'
          ? hasCodexEffect(route)
          : false;
      expect({ route, effect }).toEqual({ route, effect: true });
    }
  });

  it('rejects a disabled route whenever its adapter would ignore or reject it', () => {
    for (const route of candidateRoutes().filter((r) => r.invocation === 'disabled')) {
      const accepted = findUnenforcedCapabilityRoutes({ overrides: [route] }).length === 0;
      const effect = route.source.harness === 'claude-code'
        ? hasClaudeEffect(route)
        : route.source.harness === 'codex'
          ? hasCodexEffect(route)
          : false;
      expect({ route, accepted }).toEqual({ route, accepted: effect });
    }
  });

  it('rejects the wrong source kind, missing identity fields, Pi and unknown harnesses', () => {
    const rejected: CapabilityRouteOverride[] = [
      {
        capabilityId: 'output-delivery',
        source: { kind: 'harness-builtin', harness: 'codex', surface: 'plugin', id: 'visualize@openai-bundled' },
        invocation: 'disabled',
      },
      {
        capabilityId: 'computer-use',
        source: { kind: 'harness-plugin', harness: 'codex', surface: 'skill', id: 'computer-use:computer-use', artifactId: 'computer-use' },
        invocation: 'disabled',
      },
      {
        capabilityId: 'output-delivery',
        source: { kind: 'harness-plugin', harness: 'claude-code', surface: 'tool', id: 'Artifact' },
        invocation: 'disabled',
      },
      {
        capabilityId: 'output-delivery',
        source: { kind: 'harness-builtin', harness: 'claude-code', surface: 'tool', id: 'Artifact' },
        invocation: 'explicit-only',
      },
      {
        capabilityId: 'output-delivery',
        source: { kind: 'harness-builtin', harness: 'pi', surface: 'tool', id: 'write' },
        invocation: 'disabled',
      },
      {
        capabilityId: 'output-delivery',
        source: { kind: 'harness-builtin', harness: 'future-harness', surface: 'tool', id: 'x' },
        invocation: 'disabled',
      },
      {
        capabilityId: 'output-delivery',
        source: { kind: 'user-skill', surface: 'skill', id: 'design' },
        invocation: 'disabled',
      },
    ];

    expect(findUnenforcedCapabilityRoutes({ overrides: rejected })).toEqual(rejected);
  });
});
