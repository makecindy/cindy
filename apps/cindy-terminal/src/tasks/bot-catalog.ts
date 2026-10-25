import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { MakerMemoryManager, McpProvider, RemoteAgentFileOps } from '@cindy/maker-core';
import type { DbClient } from '@cindy/runtime-db';
import { createBotRuntimeCatalog, listBotTeammates } from '@cindy/app-runtime/botRuntimeCatalog';
import { buildBotMcpCatalog } from '@cindy/app-runtime/botMcpCatalog';
import { isBotToolsetProviderAvailable } from '@cindy/app-runtime/botToolsetAvailability';
import { botProfileDir, ensureBotContentDirs, readBotProfileFolder } from '@cindy/app-runtime/botProfileFolder';
import type { BotCapabilityServiceDeps } from '@cindy/app-runtime/botCapabilityService';
import type { BotProfileRuntimeDeps } from '@cindy/app-runtime/botProfileRuntime';
import type { TerminalCapabilities } from './capabilities.js';
import type { TerminalMcpApps } from './mcp-apps.js';
import type { TerminalBotServices } from './bot-services.js';

/** Platform ports for the original Bot discovery contract. No task or native
 * model request is created by reading the MCP/toolset catalog. */
export function createTerminalBotCatalog(host: {
  root: string;
  memory: MakerMemoryManager;
  getDbClient(): DbClient;
  getMaker: BotCapabilityServiceDeps['getMaker'];
  getPluginRegistry: BotCapabilityServiceDeps['getPluginRegistry'];
  resolveBotAgentKind: BotCapabilityServiceDeps['resolveBotAgentKind'];
  builtinProviders(): McpProvider[];
  capabilities: TerminalCapabilities;
  mcpApps: TerminalMcpApps;
  services(): TerminalBotServices;
  listBotImChannels: NonNullable<BotProfileRuntimeDeps['listBotImChannels']>;
  remoteFiles(id: string): RemoteAgentFileOps;
  assertCurrent(): void;
}) {
  const current = async <T>(work: () => Promise<T>): Promise<T> => {
    host.assertCurrent(); const result = await work(); host.assertCurrent(); return result;
  };
  const capabilityDeps: BotCapabilityServiceDeps = {
    getMaker: host.getMaker,
    getPluginRegistry: host.getPluginRegistry,
    resolveBotAgentKind: host.resolveBotAgentKind,
    isBotToolsetAvailable: input => {
      host.assertCurrent();
      return isBotToolsetProviderAvailable(host.builtinProviders(), input);
    },
    listMcpServers: input => current(async () => {
      await host.capabilities.ready;
      const workingDir = input.remoteHostId ? input.workingDir : await realpath(input.workingDir);
      const builtin = host.builtinProviders();
      return buildBotMcpCatalog({
        ...input, providers: [...builtin, ...host.capabilities.mcpProviders({ ...input, workingDir })],
        builtinNames: builtin.map(provider => provider.name),
        customServers: await (await host.mcpApps.configuration()).listCustomMcpRuntimeGenerations(),
      });
    }),
  };
  const runtimeDeps = createBotRuntimeCatalog({
    ...capabilityDeps,
    listBotImChannels: input => { host.assertCurrent(); return host.listBotImChannels(input); },
    listOwnSkills: ({ botId }) => current(() => host.services().skills.collectBotOwnSkillMounts(botId)),
    listTeammates: input => current(() => listBotTeammates(host.getDbClient(), input)),
    readMemoryIndex: scope => current(async () => (await host.memory.getStore(scope)).getIndex()),
    readProfileFolder: ({ botId }) => current(async () => {
      const contentWritableDirs = await ensureBotContentDirs(host.root, botId);
      const folder = await readBotProfileFolder(host.root, botId);
      return { homeDir: botProfileDir(host.root, botId), contentWritableDirs, systemPromptOverride: folder.systemPromptOverride };
    }),
    readSkillSource: ({ path, remoteHostId }) => current(() => remoteHostId ? host.remoteFiles(remoteHostId).readFile(path) : readFile(path, 'utf8')),
    fingerprintSkillSource: ({ path, remoteHostId }) => current(async () => {
      if (remoteHostId) return host.remoteFiles(remoteHostId).sha256File(path);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest('hex');
    }),
  });
  return { capabilityDeps, runtimeDeps };
}
