import type { HostToolRuntime, LiziMcpProvider, LiziMcpSessionContext, XdtHelperMcpDeps } from '@cindy/mcps';
import { declaredGhostHostToolGroups, GHOST_HOST_TOOL_GROUPS, type GhostHostToolGroup } from '@cindy/plugin-protocol';
import type { InstalledGhost } from '../../shared/ghost.js';
import type { PluginHostToolCaller } from '../mcp-integrations/hostToolCaller.js';
import { hasPluginHostToolGroupApproval } from './taskCapability.js';

const SERVERS: Record<GhostHostToolGroup, string> = {
  history: 'cindy_helper', control: 'cindy_helper', handoff: 'cindy_helper', settings: 'cindy_helper',
  scheduler: 'cindy_scheduler', terminal: 'cindy_helper', files: 'cindy_helper', storage: 'cindy_helper',
  browser: 'cindy_browser', computer: 'cindy_computer', ssh: 'cindy_ssh', docs: 'cindy_docs', discovery: 'cindy_helper',
};

/** A projection of the existing providers. It owns no plugins, credentials or service resources. */
export class HostServiceCatalog {
  private providers: readonly LiziMcpProvider[] = [];
  private supplied = new Map<string, string[]>();
  private snapshot?: string;
  private dirty = true;
  private readonly context: LiziMcpSessionContext = { agentKind: 'claude-code', workingDir: '', getSessionContext: () => this.context };

  replace(providers: readonly LiziMcpProvider[]): boolean {
    this.providers = providers;
    this.dirty = true;
    // No consumer: registration only records references. In particular do not
    // construct/close MCP runtimes or probe enablement on the startup path.
    if (this.snapshot === undefined) return false;
    this.materialize();
    const snapshot = JSON.stringify(this.project(this.context));
    const changed = snapshot !== this.snapshot;
    this.snapshot = snapshot;
    return changed;
  }

  private materialize(): void {
    if (!this.dirty) return;
    this.supplied = new Map();
    // A detached, explicit context prevents inspection from inheriting an Agent
    // task or closing a plugin's native computer connection.
    for (const provider of this.providers) {
      if (!provider.toHostTools || !Object.values(SERVERS).includes(provider.name)) continue;
      let runtime: HostToolRuntime | undefined;
      try {
        runtime = provider.toHostTools(this.context);
        const tools = runtime.list?.() ?? [];
        for (const group of GHOST_HOST_TOOL_GROUPS) {
          if (SERVERS[group] !== provider.name) continue;
          const members = provider.name === 'cindy_helper' || provider.name === 'cindy_scheduler'
            ? tools.filter(tool => tool.category === group) : tools;
          if (members.length) this.supplied.set(group, members.map(tool => tool.name));
        }
      } finally { void runtime?.close().catch(() => {}); }
    }
    this.dirty = false;
  }

  list(context: LiziMcpSessionContext) {
    this.materialize();
    this.snapshot ??= JSON.stringify(this.project(this.context));
    return this.project(context);
  }

  private project(context: LiziMcpSessionContext) {
    return GHOST_HOST_TOOL_GROUPS.map(group => {
      const server = SERVERS[group], provider = this.providers.find(item => item.name === server);
      const tools = this.supplied.get(group) ?? [];
      const entry = { group, server, tools: [...tools], ...(tools[0] ? { entryTool: tools[0] } : {}) };
      if (!tools.length || !provider) return { ...entry, available: false, reason: 'unsupported' as const };
      try {
        return provider.isEnabled?.(context) === false
          ? { ...entry, available: false, reason: 'disabled' as const }
          : { ...entry, available: true };
      } catch { return { ...entry, available: false, reason: 'unavailable' as const }; }
    });
  }

  available(group: string, context: LiziMcpSessionContext): boolean {
    return this.list(context).some(service => service.group === group && service.available);
  }
}

export function createHostServiceToolExecutor(catalog: HostServiceCatalog, ports: {
  pluginCall(): PluginHostToolCaller | undefined;
  getGhost(id: string): InstalledGhost | null;
  supportsPluginServer?(server: string): boolean;
}): NonNullable<XdtHelperMcpDeps['hostServices']> {
  return { list(context) {
    const caller = context.hostCaller;
    if (!caller) return { scope: 'local', services: catalog.list(context) };
    const plugin = ports.pluginCall();
    if (!plugin || context.sessionId !== undefined || plugin.caller.pluginId !== caller.pluginId ||
        plugin.caller.dataOwnerId !== caller.dataOwnerId || plugin.caller.ownerGeneration !== caller.ownerGeneration)
      throw new Error('PERMISSION_DENIED');
    plugin.assertCurrent();
    const ghost = ports.getGhost(caller.pluginId);
    if (!hasPluginHostToolGroupApproval(ghost, 'discovery')) throw new Error('PERMISSION_DENIED');
    const declared = declaredGhostHostToolGroups(ghost!.manifest);
    return { scope: 'local', services: catalog.list(context).map(service => ({ ...service,
      ...(ports.supportsPluginServer?.(service.server) === false
        ? { available: false, reason: 'unsupported' as const, tools: [], entryTool: undefined } : {}),
      declared: declared.includes(service.group), approved: hasPluginHostToolGroupApproval(ghost, service.group),
    })) };
  } };
}
