import { getPluginToolUi } from '@cindy/plugin-protocol';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { pluginUiDomains } from '@cindy/plugin-protocol';
import { hasGhostUiPermission, getApprovedGhostHostUi, type InstalledGhost } from '../../shared/ghost.js';
import type { GhostHostUi } from '@cindy/plugin-protocol';
import { deliveryNamespaceFields, installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { resolveGhostContentPathSync } from '../cindy-brain/ghostContentTree.js';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';
import { MCP_APPS_MAX_BYTES } from '../mcp-apps/protocol.js';
import { createPluginAppTransport } from '../mcp-apps/pluginServer.js';
import type { PluginPageCall } from '../mcp-apps/pluginPageCall.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppServerConfig } from '../mcp-apps/connection.js';
import { pluginAppServerId } from './pluginAppIdentity.js';

export function createPluginAppRegistry(replacePluginAppServers: (configs: Map<string, () => AppServerConfig>) => void) {
let runPageTool:
  | ((
      grant: PluginPageCall,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<CallToolResult>)
  | undefined;
function setPluginPageToolRunner(runner: NonNullable<typeof runPageTool>): void {
  runPageTool = runner;
}
/** Cold-path projection rebuilt by the existing plugin lifecycle, never per message. */
const hostEntries = new Map<string, { ghost: InstalledGhost; host: GhostHostUi; config: AppServerConfig; owner: string; fingerprint: string }>();
function readPluginHostUi(instance: string) { return hostEntries.get(instance); }
function listPluginHostUi() { return hostEntries.values(); }
/** Registry belongs only to the App host, never to an Agent's MCP providers. */
function refreshPluginApps(
  ghosts: InstalledGhost[],
  deps: {
    find(instance: string): InstalledGhost | null;
    evidence(instance: string): { packageSha256: string | null } | null;
    available(): boolean;
  },
): void {
  const configs = new Map<string, () => AppServerConfig>();
  const previousHostEntries = new Map(hostEntries);
  hostEntries.clear();
  for (const ghost of ghosts) {
    const approvedHost = getApprovedGhostHostUi(ghost);
    const hasUi = hasGhostUiPermission(ghost);
    const settingsOnly = ghost.enabled && !!approvedHost?.settings?.length;
    const host = hasUi ? approvedHost : settingsOnly ? { settings: approvedHost!.settings } : undefined;
    if ((!hasUi && !settingsOnly) || !deps.available() || ghost.approval.state !== 'approved')
      continue;
    const instance = installedGhostStoragePart(ghost),
      revision = ghost.approval.revision;
    const directory = path.resolve(ghost.dir);
    const packageSha256 = deps.evidence(instance)?.packageSha256;
    if (!packageSha256) continue;
    const owner = activeOwnerScopeKey();
    const assertCurrent = () => {
      const latest = deps.find(instance);
      if (
        owner !== activeOwnerScopeKey() ||
        !deps.available() ||
        !latest ||
        (hasUi ? !hasGhostUiPermission(latest) : !(latest.enabled && getApprovedGhostHostUi(latest)?.settings?.length)) ||
        latest.approval.state !== 'approved' ||
        latest.approval.revision !== revision ||
        path.resolve(latest.dir) !== directory ||
        deps.evidence(instance)?.packageSha256 !== packageSha256
      )
        throw new Error('MCP_APP_SERVER_CHANGED');
    };
    const config: AppServerConfig = {
      id: pluginAppServerId(ghost),
      url: '',
      transport: 'in-process',
      plugin: {
        ghostId: ghost.manifest.id,
        ...(ghost.namespaceState === 'pending' ? {} : deliveryNamespaceFields(ghost)),
        instance,
        revision,
        packageSha256,
        directory,
        title: ghost.manifest.name,
        trust: ghost.trust?.level ?? 'unverified',
        domains: pluginUiDomains(ghost.manifest),
        assertCurrent,
        createTransport: () =>
          createPluginAppTransport({
            instance,
            revision,
            tools: ghost.manifest.tools ?? [],
            ui: getPluginToolUi(ghost.manifest) ?? { resources: [], tools: {} },
            hosts: ghost.manifest.network?.hosts,
            assertCurrent,
            readHtml: (html) => {
              assertCurrent();
              const file = resolveGhostContentPathSync(directory, html, {
                expect: 'file',
                label: 'plugin App HTML',
              });
              const bytes = readBoundedFileNoFollowSync(file, MCP_APPS_MAX_BYTES, {
                containWithin: realpathSync(directory),
              });
              if (!bytes) throw new Error('MCP_APP_RESOURCE_UNAVAILABLE');
              return bytes.toString('utf8');
            },
            call: async (grant, args, signal) => {
              assertCurrent();
              if (!runPageTool) throw new Error('MCP_APP_HOST_NOT_READY');
              const result = await runPageTool(grant, args, signal);
              assertCurrent();
              return result;
            },
          }),
      },
    };
    if (hasUi) configs.set(config.id, () => {
      assertCurrent();
      return config;
    });
    if (host) {
      const fingerprint = JSON.stringify([revision, packageSha256, directory, ghost.approvedHostUi, hasUi]);
      const previous = previousHostEntries.get(instance);
      hostEntries.set(instance, previous?.owner === owner && previous.fingerprint === fingerprint
        ? previous : { ghost, host, config, owner, fingerprint });
    }
  }
  replacePluginAppServers(configs);
}

return { setPluginPageToolRunner, refreshPluginApps, readPluginHostUi, listPluginHostUi };
}
