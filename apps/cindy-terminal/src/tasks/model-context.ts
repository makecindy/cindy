import path from 'node:path';
import type { AgentKind, Logger, Maker } from '@cindy/maker-core';
import { readCodexContextWindowInfo } from '@cindy/app-runtime/codexContextWindow';
import { prepareCodexCustomContextCatalog } from '@cindy/app-runtime/codexCustomContextCatalog';
import { registerModelContextHandlers } from '@cindy/app-runtime/modelContextHandlers';
import { createModelPreferenceTargets, createModelPreferenceQueue } from '@cindy/app-runtime/modelPreferenceTargets';
import { createProviderOwnerGuards, type ProviderOwnerSession } from '@cindy/app-runtime/providerOwnerGuards';
import type { IpcHandler } from '@cindy/app-runtime/ipcHandlerRegistry';
import type { ModelPriceOverrideTarget } from '@cindy/app-runtime/modelPriceOverride';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '@cindy/model-providers/llamaCpp';
import type { TerminalModelConfig } from '../models/config.js';
/** Node platform binding for the original model preference handlers and store. */
export function createTerminalModelContext(host: {
  models: TerminalModelConfig; profileDir: string; log: Logger;
  currentOwnerSession(): ProviderOwnerSession;
  binaryPath(kind: AgentKind): string | undefined;
  maker: Pick<Maker, 'getSession'>;
  guard(): void;
  refresh(targets?: readonly ModelPriceOverrideTarget[]): Promise<void>;
}) {
  const {models} = host;
  const handlers = new Map<string, IpcHandler>();
  const store = models.contextLimits;
  const catalogHome = path.join(host.profileDir, 'engines', 'codex', 'context-catalogs');
  registerModelContextHandlers({handle: (channel, handler) => {handlers.set(channel, handler);}}, {
    readModelContextLimit: target => ({
      limit: store.readModelContextLimit(target.agent, target.providerId, target.modelId),
      isCustomized: store.isModelContextLimitCustomized(target.agent, target.providerId, target.modelId),
    }),
    readCodexContextWindowInfo: async (target, id) => {
      const session = id ? host.maker.getSession(id) : undefined;
      if (session) return session.agentKind === 'codex' ? session.getCodexContextWindowInfo() : null;
      const configured = await readCodexContextWindowInfo({codexHome: id ? path.join(host.profileDir, 'engines', 'codex', id) : catalogHome,
        binaryPath: host.binaryPath('codex'), modelId: target.modelId,
        contextWindowOverride: models.nativeContextLimit('codex', target.providerId, target.modelId, true)});
      host.guard();
      return configured && id ? {...configured, pendingApply: true} : configured;
    },
    validateModelContextLimit: async (targets, limit) => {
      const local = targets.filter(target => target.providerId === MANAGED_LLAMACPP_PROVIDER_ID);
      if (local.length) await models.validateLocalContext(local, limit);
      for (const target of targets.filter(target => target.agent === 'codex')) {
        const binaryPath = host.binaryPath('codex');
        if (!binaryPath) throw new Error('Codex runtime is unavailable');
        await prepareCodexCustomContextCatalog({binaryPath, codexHome: catalogHome, modelId: target.modelId, contextWindow: limit});
      }
      host.guard();
    },
    writeModelContextLimit: async (targets, limit) => {
      const write = () => store.writeModelContextLimitsWithRefresh(targets, limit,
        () => host.refresh(targets), () => host.refresh());
      if (targets.some(target => target.providerId === MANAGED_LLAMACPP_PROVIDER_ID)) await models.configureLocalContext(write);
      else await write();
    },
  }, {
    ...createModelPreferenceTargets({listProviders: () => models.views()}),
    ...createProviderOwnerGuards({currentOwnerSession: host.currentOwnerSession}),
    log: host.log, assertTrustedProviderMutationSender: () => host.guard(),
    enqueuePriceMutation: createModelPreferenceQueue(),
    withProviderConfigMutation: (id, run) => models.serializeSettings(id, run),
  });
  return async (channel: string, args: unknown[]) => {
    host.guard();
    const handler = handlers.get(channel);
    if (!handler) throw new Error('Model context handler is unavailable');
    return handler(undefined, ...args);
  };
}
