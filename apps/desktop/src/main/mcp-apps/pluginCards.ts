import { getPluginToolUi } from '@cindy/plugin-protocol';
import { randomUUID } from 'node:crypto';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pluginAppTool } from './pluginServer.js';
import { getMcpAppsHost, readAppServer } from './runtime.js';
import { pluginAppServerId } from '../mcp-integrations/plugin-app-registry.js';
import { hasGhostUiPermission, type GhostHandoffFile, type InstalledGhost } from '../../shared/ghost.js';
import type { McpAppRecord } from '../../shared/mcpApps.js';

export function pluginAppResult(result: unknown): CallToolResult {
  if (
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    Array.isArray((result as CallToolResult).content) &&
    CallToolResultSchema.safeParse(result).success
  )
    return result as CallToolResult;
  return {
    content: [
      { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) },
    ],
  };
}
export function pluginModelResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const { _meta, ...visible } = result as Record<string, unknown>;
  void _meta;
  return visible;
}
/** This publishes an already-completed ghost_call; it never executes a tool a second time. */
export async function publishPluginAppResult(
  ghost: InstalledGhost,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  attachmentHashes: readonly string[] = [],
  handoffFiles: readonly GhostHandoffFile[] = [],
): Promise<void> {
  const declared = ghost.manifest.tools?.find((tool) => tool.name === name);
  if (!declared || !getPluginToolUi(ghost.manifest)?.tools[name]?.resourceUri) return;
  if (!hasGhostUiPermission(ghost)) return;
  const config = readAppServer(pluginAppServerId(ghost));
  if (
    !config?.plugin ||
    ghost.approval.state !== 'approved' ||
    config.plugin.revision !== ghost.approval.revision
  )
    return;
  config.plugin.assertCurrent(sessionId);
  const host = getMcpAppsHost(),
    owner = host.captureOwner();
  const tool = pluginAppTool(config.plugin.instance, declared, getPluginToolUi(ghost.manifest)!);
  tool.title = config.plugin.title;
  tool._meta = {
    ...tool._meta,
    'cindy/plugin': { name: config.plugin.title, trust: config.plugin.trust },
  };
  if (attachmentHashes.length || handoffFiles.length) {
    const { getBlobInfo, ghostCanRead } = await import('../cindy-media/ledger.js');
    const attachments = [];
    for (const hash of attachmentHashes) {
      if (!/^[a-f0-9]{64}$/.test(hash) || !await ghostCanRead(hash, config.plugin.instance)) continue;
      const info = await getBlobInfo(hash);
      if (info) attachments.push({ type: 'resource_link', name: `${hash.slice(0, 12)}${info.ext}`,
        uri: `cindy-media://blobs/${hash}${info.ext}`, mimeType: info.mimeType, size: info.bytes });
    }
    // Handoff copies are references only; the View signs a read URL while the copy is live.
    for (const file of handoffFiles)
      attachments.push({ type: 'resource_link', name: file.name, uri: file.ref, mimeType: file.mimeType, size: file.size });
    config.plugin.assertCurrent(sessionId);
    tool._meta['cindy/attachments'] = attachments;
  }
  const record: McpAppRecord = {
    version: 1,
    serverId: config.id,
    serverRevision: host.serverRevision(config),
    resourceUri: (tool._meta!.ui as { resourceUri: string }).resourceUri,
    tool,
    arguments: args,
  };
  const clientId = `mcp-app:${randomUUID()}`;
  await host.updateResult(sessionId, clientId, record, owner);
  config.plugin.assertCurrent(sessionId);
  await host.updateResult(
    sessionId,
    clientId,
    { ...record, result: pluginAppResult(result) },
    owner,
  );
}
