/**
 * Codex capability routing, shared by the desktop and the Node Host. Bodies moved
 * verbatim from the desktop Codex construction site (maker-host/index.ts); the
 * MCP bridge's server names and the disabled runtime plugins are ports, read on
 * every call. Keep `capabilityRouting` behind a getter at each construction site:
 * spreading it would evaluate the policy once.
 */

import type { AgentDeps } from '@cindy/maker-core';

import { buildDesktopCapabilityRoutingPolicy } from './capability-routing.js';
import { readDisabledBuiltinPluginIds } from '../mcp-integrations/codexBuiltinToolPolicy.js';

export interface CodexCapabilityRoutingPorts {
  getBridgeServerNames(): string[] | null;
  getDisabledRuntimePluginIds(workingDir: string | undefined): string[];
}

export function createCodexCapabilityRouting(ports: CodexCapabilityRoutingPorts) {
  // Evaluate after app-server startup prepared (or reused) the MCP bridge.
  // The bridge snapshot is the applied capability surface; the preference
  // alone can be ahead of it while a busy Codex turn defers refresh.
  const capabilityRouting = () => buildDesktopCapabilityRoutingPolicy({
    cindyComputerAvailable:
      ports.getBridgeServerNames()?.includes('cindy_computer') === true,
  });
  const resolveCapabilityRouting: NonNullable<AgentDeps['resolveCapabilityRouting']> = async ({
    workingDir,
    remoteHostId,
    vendorOptions,
    codexBrowserUseProvisioned,
    ensureCodexBrowserUseReady,
  }) => {
    const disabledPluginIds =
      readDisabledBuiltinPluginIds(vendorOptions) ??
      ports.getDisabledRuntimePluginIds(workingDir);
    const cindyBrowserEnabled = !disabledPluginIds.includes('browser');
    let connectedCodexBrowserUse = codexBrowserUseProvisioned;
    if (!remoteHostId && !cindyBrowserEnabled && connectedCodexBrowserUse) {
      connectedCodexBrowserUse = await ensureCodexBrowserUseReady();
    }
    return buildDesktopCapabilityRoutingPolicy({
      cindyComputerAvailable:
        ports.getBridgeServerNames()?.includes('cindy_computer') === true,
      cindyBrowserEnabled,
      codexBrowserUseAvailable: connectedCodexBrowserUse,
      codexBrowserUseProvisioned,
      remoteHostId,
    });
  };
  return { capabilityRouting, resolveCapabilityRouting };
}
