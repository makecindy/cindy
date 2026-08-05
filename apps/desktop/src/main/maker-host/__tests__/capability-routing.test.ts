import { describe, expect, it } from 'vitest';

import { buildDesktopCapabilityRoutingPolicy } from '../capability-routing.js';

function codexPluginRoutes(cindyBrowserEnabled: boolean, codexBrowserUseAvailable = true) {
  return buildDesktopCapabilityRoutingPolicy({
    cindyBrowserEnabled,
    codexBrowserUseAvailable,
  }).overrides.filter(
    (override) =>
      override.source.kind === 'harness-plugin'
      && override.source.harness === 'codex'
      && override.source.surface === 'plugin',
  );
}

describe('buildDesktopCapabilityRoutingPolicy', () => {
  it('disables both official Codex browser surfaces when Cindy Browser is enabled', () => {
    const routes = codexPluginRoutes(true);

    expect(routes.map((route) => route.source.id)).toEqual([
      'computer-use@openai-bundled',
      'browser@openai-bundled',
      'chrome@openai-bundled',
    ]);
    expect(routes.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invocation: 'disabled',
          replacement: { kind: 'cindy-plugin', id: 'browser' },
        }),
      ]),
    );
  });

  it('leaves Chrome available while disabling the unsupported in-app Browser', () => {
    const routes = codexPluginRoutes(false, true);

    expect(routes.map((route) => route.source.id)).toEqual([
      'computer-use@openai-bundled',
      'browser@openai-bundled',
    ]);
  });

  it('also disables the privileged Browser MCP surface when Cindy Browser owns the capability', () => {
    const routes = buildDesktopCapabilityRoutingPolicy({
      cindyBrowserEnabled: true,
      codexBrowserUseAvailable: true,
      codexBrowserUseProvisioned: true,
    }).overrides;

    expect(routes).toContainEqual(expect.objectContaining({
      invocation: 'disabled',
      source: expect.objectContaining({ surface: 'mcp', id: 'node_repl' }),
      replacement: { kind: 'cindy-plugin', id: 'browser' },
    }));
  });

  it('keeps the node_repl disable when the provisioned companion fails its readiness probe', () => {
    // Spawn supplied a full node_repl transport (provisioned), then the
    // session-time Chrome readiness probe failed. The per-thread disable
    // merges onto the real transport and is required — dropping it would
    // leave the privileged node_repl surface enabled.
    const policy = buildDesktopCapabilityRoutingPolicy({
      cindyBrowserEnabled: false,
      codexBrowserUseAvailable: false,
      codexBrowserUseProvisioned: true,
    });

    const nodeReplRoute = policy.overrides.find(
      (route) => route.source.surface === 'mcp' && route.source.id === 'node_repl',
    );
    expect(nodeReplRoute).toMatchObject({ invocation: 'disabled' });
    expect(nodeReplRoute?.replacement).toBeUndefined();
  });

  it('fails closed without claiming a replacement when neither browser runtime is available', () => {
    const policy = buildDesktopCapabilityRoutingPolicy({
      cindyBrowserEnabled: false,
      codexBrowserUseAvailable: false,
      codexBrowserUseProvisioned: false,
    });
    const routes = policy.overrides.filter(
      (route) =>
        route.source.id !== 'computer-use@openai-bundled' && route.source.surface === 'plugin',
    );

    expect(routes.map((route) => route.source.id)).toEqual([
      'browser@openai-bundled',
      'chrome@openai-bundled',
    ]);
    expect(routes.every((route) => route.replacement === undefined)).toBe(true);
    // The unprovisioned spawn config has no node_repl entry; a per-thread
    // `mcp_servers.node_repl.enabled=false` on codex 0.145.0 would synthesize
    // a transport-less entry and fail every thread/start with "invalid
    // transport" (-32600). The route must be absent, not merely unreplaced.
    expect(policy.overrides.some(
      (route) => route.source.surface === 'mcp' && route.source.id === 'node_repl',
    )).toBe(false);
  });

  it('drops the node_repl MCP route when Cindy Browser owns the capability but the companion was not provisioned', () => {
    const policy = buildDesktopCapabilityRoutingPolicy({
      cindyBrowserEnabled: true,
      codexBrowserUseAvailable: false,
      codexBrowserUseProvisioned: false,
    });

    expect(policy.overrides.some(
      (route) => route.source.surface === 'mcp' && route.source.id === 'node_repl',
    )).toBe(false);
    // The plugin-wide disable does not synthesize an mcp_servers entry and
    // must stay in force.
    expect(policy.overrides).toContainEqual(expect.objectContaining({
      invocation: 'disabled',
      source: expect.objectContaining({ surface: 'plugin', id: 'chrome@openai-bundled' }),
    }));
  });

  it('keeps remote Chrome available without claiming the local Cindy Browser replacement', () => {
    const policy = buildDesktopCapabilityRoutingPolicy({
      cindyComputerAvailable: false,
      cindyBrowserEnabled: true,
      codexBrowserUseAvailable: true,
      remoteHostId: 'remote-browser-host',
    });
    const browserRoutes = policy.overrides.filter(
      (route) => route.capabilityId === 'browser-use',
    );

    expect(browserRoutes).toEqual([
      expect.objectContaining({
        invocation: 'disabled',
        source: expect.objectContaining({
          surface: 'plugin',
          id: 'browser@openai-bundled',
        }),
      }),
    ]);
    expect(browserRoutes[0]?.replacement).toBeUndefined();
  });
});
