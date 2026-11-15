/**
 * Per-model resolvers the engines read at session start and on model switch:
 * context limit, output cap, compaction threshold, verified window, efforts and
 * the Codex thread window. Desktop and the Node Host build them from this one
 * factory so both resolve a model the same way.
 *
 * Electron-free on purpose. The catalog and the context-provider resolver are
 * ports: the desktop passes its account-selectable catalog, the Host passes its
 * own. Each resolver reads the catalog when it is called, never at creation,
 * because the catalog changes with the account and every catalog refresh.
 */

import type { AgentDeps } from '@cindy/maker-core';
import type { Catalog } from '@cindy/model-providers';

import { readModelContextLimit, resolveModelCompactionPct } from './model-context-limit-store.js';
import {
  resolveModelDefaultContextWindow,
  resolveModelMaxOutputTokens,
  resolveVerifiedContextWindow,
} from './catalog-to-descriptors.js';
import { readCodexContextWindowInfo } from './codex-context-window.js';
import { resolveRouteModelEfforts, type ModelContextProviderResolver } from './routeModelEfforts.js';

export type { ModelContextProviderResolver };

export interface EngineModelResolverPorts {
  /** Read on every call. */
  getCatalog(): Catalog;
  resolveContextProviderId: ModelContextProviderResolver;
}

export type ClaudeModelResolvers = Required<Pick<AgentDeps,
  | 'resolveModelContextLimit'
  | 'resolveModelMaxOutputTokens'
  | 'resolveModelCompactionPct'
  | 'resolveVerifiedContextWindow'
  | 'resolveModelEfforts'
>>;

export function createClaudeModelResolvers(ports: EngineModelResolverPorts): ClaudeModelResolvers {
  const { getCatalog, resolveContextProviderId } = ports;
  return {
    resolveModelContextLimit: (providerId, modelId) => {
      const catalog = getCatalog();
      const source = resolveContextProviderId(catalog, 'claude-code', providerId, modelId);
      return source ? readModelContextLimit('claude-code', source, modelId)
        ?? resolveModelDefaultContextWindow(catalog, 'claude-code', source, modelId) : null;
    },
    resolveModelMaxOutputTokens: (providerId, modelId) => {
      const catalog = getCatalog();
      const source = resolveContextProviderId(catalog, 'claude-code', providerId, modelId);
      return resolveModelMaxOutputTokens(catalog, 'claude-code', source, modelId);
    },
    resolveModelCompactionPct: (providerId, modelId) => {
      const source = resolveContextProviderId(getCatalog(), 'claude-code', providerId, modelId);
      return resolveModelCompactionPct(getCatalog(), 'claude-code', source, modelId);
    },
    resolveVerifiedContextWindow: (providerId, modelId) =>
      resolveVerifiedContextWindow(getCatalog(), 'claude-code',
        resolveContextProviderId(getCatalog(), 'claude-code', providerId, modelId), modelId),
    resolveModelEfforts: (providerId, modelId) =>
      resolveRouteModelEfforts(resolveContextProviderId, getCatalog(), 'claude-code', providerId, modelId),
  };
}

export interface CodexModelResolverPorts extends EngineModelResolverPorts {
  /** Default Codex home for the native context-window probe. */
  getCodexHome(): string;
  getCodexBinaryPath(): string;
}

export type CodexModelResolvers = Required<Pick<AgentDeps,
  | 'resolveModelContextLimit'
  | 'resolveModelCompactionPct'
  | 'resolveVerifiedContextWindow'
  | 'resolveCodexContextWindowInfo'
  | 'resolveCodexThreadContextWindow'
>>;

export function createCodexModelResolvers(ports: CodexModelResolverPorts): CodexModelResolvers {
  const { getCatalog, resolveContextProviderId } = ports;
  return {
    // Resolve settings by the actual provider route. Model specifications never
    // overwrite a native usage report; explicit settings configure the CLI itself.
    resolveModelContextLimit: (providerId, modelId) => {
      const source = resolveContextProviderId(getCatalog(), 'codex', providerId, modelId);
      return source ? readModelContextLimit('codex', source, modelId) : null;
    },
    resolveModelCompactionPct: (providerId, modelId) => {
      const source = resolveContextProviderId(getCatalog(), 'codex', providerId, modelId);
      return resolveModelCompactionPct(getCatalog(), 'codex', source, modelId);
    },
    resolveVerifiedContextWindow: (providerId, modelId) =>
      resolveVerifiedContextWindow(getCatalog(), 'codex',
        resolveContextProviderId(getCatalog(), 'codex', providerId, modelId), modelId),
    resolveCodexContextWindowInfo: (modelId, config, reportedUsableWindow, codexHome) =>
      readCodexContextWindowInfo({ codexHome: codexHome ?? ports.getCodexHome(), binaryPath: ports.getCodexBinaryPath(), modelId, config, reportedUsableWindow }),
    resolveCodexThreadContextWindow: (providerId, modelId) => {
      const source = resolveContextProviderId(getCatalog(), 'codex', providerId, modelId);
      const override = source ? readModelContextLimit('codex', source, modelId) : null;
      return override ?? resolveModelDefaultContextWindow(
        getCatalog(), 'codex', source, modelId,
      );
    },
  };
}

export type PiModelResolvers = Required<Pick<AgentDeps, 'resolveModelContextLimit' | 'resolveModelCompactionPct'>>;

/** Pi resolves against the full active catalog with the plain route resolver, unlike Claude and Codex. */
export function createPiModelResolvers(ports: EngineModelResolverPorts): PiModelResolvers {
  const { getCatalog, resolveContextProviderId } = ports;
  return {
    resolveModelContextLimit: (providerId, modelId) => {
      const catalog = getCatalog();
      const source = resolveContextProviderId(catalog, 'pi', providerId, modelId);
      return source ? readModelContextLimit('pi', source, modelId)
        ?? resolveModelDefaultContextWindow(catalog, 'pi', source, modelId) : null;
    },
    resolveModelCompactionPct: (providerId, modelId) => {
      const source = resolveContextProviderId(getCatalog(), 'pi', providerId, modelId);
      return resolveModelCompactionPct(getCatalog(), 'pi', source, modelId);
    },
  };
}
