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
    }).overrides;

    expect(routes).toContainEqual(expect.objectContaining({
      invocation: 'disabled',
      source: expect.objectContaining({ surface: 'mcp', id: 'node_repl' }),
      replacement: { kind: 'cindy-plugin', id: 'browser' },
    }));
  });

  it('fails closed without claiming a replacement when neither browser runtime is available', () => {
    const routes = codexPluginRoutes(false, false).filter(
      (route) => route.source.id !== 'computer-use@openai-bundled',
    );

    expect(routes.map((route) => route.source.id)).toEqual([
      'browser@openai-bundled',
      'chrome@openai-bundled',
    ]);
    expect(routes.every((route) => route.replacement === undefined)).toBe(true);
  });
});
