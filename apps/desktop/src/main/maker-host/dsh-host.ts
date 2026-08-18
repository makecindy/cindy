/** Desktop-only construction for the optional DeepSeek Harness adapter. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { DshAgent, type AgentDeps, type DshVendorOptions } from '@cindy/maker-core';
import type { RemoteHost } from '@cindy/maker-remote-ssh';
import {
  type AgentKind,
  type Catalog,
  type CatalogModel,
  type Provider,
} from '@cindy/model-providers';
import { app } from 'electron';

import { desktopClaudeAuthAdapter } from './auth-adapters.js';
import { getActiveCatalog } from './active-catalog.js';
import { createDesktopLocalDshTransport } from './dsh-local-transport.js';
import { readDshProviderApiKey } from './dsh-provider-key.js';
import { buildDesktopClaudeRuntimeConfig } from './runtime-configs.js';
import { createSshDshTransport } from './dsh-remote-transport.js';

const require = createRequire(import.meta.url);

function resolveDshLauncher(): string | null {
  const override = process.env.CINDY_DSH_BIN?.trim();
  if (override) return path.isAbsolute(override) && fs.existsSync(override) ? override : null;
  try {
    // packaged-bin resolves the plugin graph from the installed DSH runtime,
    // rather than from the per-session temporary config directory.
    return require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin');
  } catch {
    return null;
  }
}

/**
 * DSH ships with the desktop package. A developer-only path override remains
 * available for isolated protocol debugging.
 */
export function buildDshAgent(
  logger: AgentDeps['logger'],
  createRemoteDshTransport?: AgentDeps['createRemoteDshTransport'],
  capabilityAdditions?: AgentDeps['capabilityAdditions'],
): DshAgent | null {
  const binPath = resolveDshLauncher();
  if (!binPath) return null;
  return new DshAgent({
    auth: desktopClaudeAuthAdapter,
    runtimeConfig: buildDesktopClaudeRuntimeConfig(() => 'https://api.deepseek.com'),
    binaryPath: binPath,
    logger,
    createLocalDshTransport: (input) => createDesktopLocalDshTransport({ ...input, logger }),
    createRemoteDshTransport,
    capabilityAdditions,
  });
}

type DshRuntimeProvider = Pick<Provider, 'id' | 'source' | 'auth' | 'routing' | 'models'>;

function dshModels(models: readonly CatalogModel[] | undefined): NonNullable<DshVendorOptions['dshModels']> {
  return (models ?? []).map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    ...(model.maxOutput !== undefined ? { maxTokens: model.maxOutput } : {}),
  }));
}

function resolveDshProvider(
  catalog: Catalog,
  providerId: string | null | undefined,
  modelId: string,
): DshRuntimeProvider | null {
  const id = providerId?.trim();
  const exact = id ? catalog.providers.find((provider) => provider.id === id) : undefined;
  if (exact?.source === 'user') return exact;

  // One faulty build briefly persisted the parallel built-in id (`deepseek`) and an earlier
  // collision projection used `custom:deepseek`. Recover those inbound session ids only when
  // exactly one real user provider can serve the selected DSH model; never publish an alias.
  if (id && id !== 'deepseek' && id !== 'custom:deepseek') return exact ?? null;
  const candidates = catalog.providers.filter(
    (provider) =>
      provider.source === 'user' &&
      provider.auth.method === 'apiKey' &&
      !!provider.routing.dsh &&
      !provider.routing.dsh.disabled &&
      !!provider.models.dsh?.some((model) => model.id === modelId),
  );
  if (candidates.length > 1) {
    throw new Error('DSH provider selection is ambiguous; select the original provider again');
  }
  return candidates[0] ?? null;
}

export interface ResolveDshVendorOptionsInput {
  providerId?: string | null;
  modelId: string;
  catalog?: Catalog;
  readCustomKey?: (providerId: string, agent: AgentKind) => string | null;
}

/**
 * Resolve only the DSH-specific trusted inputs for one selected user provider/model.
 */
export function resolveDshVendorOptions(
  input: ResolveDshVendorOptionsInput,
): Pick<DshVendorOptions, 'dshApiKey' | 'dshBaseUrl' | 'dshModels' | 'dshReasoningEffort'> {
  const catalog = input.catalog ?? getActiveCatalog();
  const provider = resolveDshProvider(catalog, input.providerId, input.modelId);
  if (!provider || !provider.routing.dsh || provider.routing.dsh.disabled) {
    throw new Error('DSH selected provider is not configured');
  }
  const models = provider.models.dsh ?? [];
  const selectedModel = models.find((model) => model.id === input.modelId);
  if (!selectedModel) {
    throw new Error('DSH selected model is not configured for this provider');
  }

  if (provider.source !== 'user' || provider.auth.method !== 'apiKey') {
    throw new Error('DSH selected provider must be the configured API key provider');
  }
  const apiKey = readDshProviderApiKey(provider, input.readCustomKey);
  if (!apiKey) throw new Error('DSH API key is not configured for the selected provider');
  return {
    dshApiKey: apiKey,
    dshBaseUrl: provider.routing.dsh.upstream,
    dshModels: dshModels(models),
    dshReasoningEffort: selectedModel.dshReasoningEffort ?? 'high',
  };
}

/** Main-process-only values supplied immediately before the child is started. */
export function prepareDshVendorOptions(input: {
  providerId?: string | null;
  modelId: string;
  remoteHostId?: string;
}): DshVendorOptions {
  const resolved = resolveDshVendorOptions(input);
  return {
    ...resolved,
    // $HOME is expanded by the fixed remote launcher, never by this Windows/macOS host.
    dshSessionRoot: input.remoteHostId
      ? '$HOME/.xdt-server/v1/dsh-sessions'
      : path.join(app.getPath('userData'), 'dsh-sessions'),
  };
}

export function createDesktopRemoteDshTransport(
  remoteHost: RemoteHost,
  input: Parameters<NonNullable<AgentDeps['createRemoteDshTransport']>>[0],
  logger: AgentDeps['logger'],
) {
  return createSshDshTransport({
    remoteHost,
    workingDir: input.workingDir,
    configYaml: input.configYaml,
    bridgeSource: input.bridgeSource,
    apiKey: input.apiKey,
    sessionRoot: input.sessionRoot,
    logger,
  });
}
