import type { ByokCache } from './byokCache.js';
import { BYOK_PROVIDERS_PATH, BYOK_CREDENTIALS_PATH, isByokImageMode, type ByokProvider, type Provider } from '@cindy/model-providers';
import {
  setByokCredentialReader,
  setByokEndpointReader,
  setByokManagedProviderReader,
} from './byokCredentials.js';
import { isDeepStrictEqual } from 'node:util';
import { setManagedProviders } from '../maker-host/active-catalog.js';
import { beginProviderRouteMutation } from '../maker-host/provider-route.js';
import { serverApiFetch } from '../serverApiClient.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createByokSync, type ByokConnection } from './byokSync.js';
import { buildByokProvider } from './byokProvider.js';
import { buildByokPricing, setByokPricing } from './byokPricing.js';
import { createLogger } from '../logger.js';

const log = createLogger('byokRuntime');
// Only service-defined codes may leave the sensitive response boundary.
const BYOK_ERROR_CODES = [
  'ORG_AI_GATEWAY_ERROR',
  'BYOK_UNAVAILABLE',
  'ORG_AI_MANAGEMENT_DISABLED',
  'ORG_AI_NOT_ENABLED',
  'ORG_AI_UNSUPPORTED',
  'ORG_NOT_SUPPORTED',
  'ORGANIZATION_BASELINE_NOT_READY',
  'ORGANIZATION_SEAT_REQUIRED',
  'MEMBERSHIP_INACTIVE',
  'INVALID_PARAMS',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'INVALID_TOKEN',
  'ACCOUNT_UNAVAILABLE',
  'FORBIDDEN',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

// Only Codex freezes this generation. Pi/Claude/Art read live configuration;
// their model changes still take the mutation lock, but must not expire an
// unchanged Codex snapshot. Credentials and provider identity remain shared.
function credentialRevisionState(state: ReturnType<typeof dispatchState>[number] | undefined) {
  if (!state) return undefined;
  return {
    providerId: state.providerId,
    credential: state.credential,
    responseModels: state.chatModels.filter((model) => model.agents.includes('codex')).map((model) => model.id),
    imageBinding: state.imageBinding,
  };
}

function dispatchState(entries: readonly ByokProvider[], ready: readonly ByokConnection[]) {
  return entries
    .map((provider) => {
      const connection = ready.find((entry) => entry.provider.id === provider.id);
      const chatModels = provider.models
        .filter((model) => !isByokImageMode(model.mode))
        .map((model) => {
          const agents = [...(model.agents ?? [])].sort();
          return {
            id: model.id,
            agents,
            protocols: Object.fromEntries(
              agents.map((agent) => [agent, model.perAgent[agent]?.wireProtocol]),
            ),
          };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
      const imageModels = provider.models
        .filter((model) => isByokImageMode(model.mode))
        .map((model) => model.id)
        .sort();
      return {
        providerId: provider.id,
        credential: connection
          ? {
              connectionRevision: connection.credential.connectionRevision,
              endpoint: connection.credential.endpoint.replace(/\/+$/, '').replace(/\/v1$/, ''),
              apiKey: connection.credential.apiKey,
            }
          : null,
        chatModels,
        imageModels,
        imageBinding: provider.imageBinding
          ? {
              wireModel: provider.imageBinding.wireModel,
              litellmModel: provider.imageBinding.litellmModel,
              supportsEdit: provider.imageBinding.supportsEdit,
            }
          : null,
      };
    })
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
}

/** Secrets stay in Main; an optional encrypted identity-scoped snapshot supports cold starts. */
export function createByokRuntime(
  onPricingChanged?: () => void,
  cache?: ByokCache,
  onCodexRoutesChanged?: () => void,
) {
  let installed: readonly ByokConnection[] = [];
  let installedDirectory: readonly ByokProvider[] = [];
  setByokCredentialReader((providerId, agent) => {
    const connection = installed.find((entry) => entry.provider.id === providerId);
    if (!connection) return null;
    if (agent === 'image') {
      return connection.provider.models.some((model) => isByokImageMode(model.mode))
        ? connection.credential.apiKey
        : null;
    }
    if (agent !== 'pi' && agent !== 'codex' && agent !== 'claude-code') return null;
    return connection.provider.models.some((model) => model.agents?.includes(agent))
      ? connection.credential.apiKey
      : null;
  });
  setByokEndpointReader((providerId) => {
    const connection = installed.find((entry) => entry.provider.id === providerId);
    return connection?.credential.endpoint ?? null;
  });
  setByokManagedProviderReader((providerId) =>
    installedDirectory.some((provider) => provider.id === providerId),
  );
  const project = (
    entries: readonly ByokProvider[],
    ready: readonly ByokConnection[],
  ): Provider[] =>
    entries.map((provider) => {
      const connection = ready.find((entry) => entry.provider.id === provider.id);
      return connection
        ? buildByokProvider(connection)
        : {
            id: provider.id,
            name: provider.name,
            source: 'organization',
            auth: { method: 'managed' },
            access: { kind: 'managed' },
            agents: [],
            routing: {},
            models: {},
          };
    });
  const codexHostState = (entries: readonly ByokProvider[], ready: readonly ByokConnection[]) =>
    dispatchState(entries, ready).flatMap((provider) => {
      const responseModels = provider.chatModels
        .filter((model) => model.agents.includes('codex'))
        .map((model) => model.id);
      if (!provider.credential || !provider.imageBinding || responseModels.length === 0) return [];
      return [
        {
          providerId: provider.providerId,
          credential: provider.credential,
          responseModels,
          imageBinding: provider.imageBinding,
        },
      ];
    });
  return createByokSync({
    cache,
    fetch: async (path, options) => {
      const logLabel = path === BYOK_PROVIDERS_PATH
        ? '/api/model-access/byok/providers'
        : path === BYOK_CREDENTIALS_PATH
          ? '/api/model-access/byok/credentials'
          : '/api/model-access/byok';
      const startedAt = Date.now();
      const response = await serverApiFetch(path, {
        ...options,
        baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
        redactErrorDetails: true,
        logLabel,
        allowedRedactedErrorCodes: BYOK_ERROR_CODES,
        // 与 byokSync 的 TIMEOUT_MS=20s 对齐：deadline 只赛跑不中止，这里让底层请求在同样时限真正 abort，不留悬挂连接
        timeoutMs: 20_000,
      });
      log.debug('byok.sync.request_succeeded', 'path=' + logLabel, 'elapsedMs=' + (Date.now() - startedAt));
      return response;
    },
    replace: (_owner, connections, directory = connections.map((entry) => entry.provider)) => {
      if (
        isDeepStrictEqual(installed, connections) &&
        isDeepStrictEqual(installedDirectory, directory)
      )
        return;
      const previousDispatchState = dispatchState(installedDirectory, installed);
      const nextDispatchState = dispatchState(directory, connections);
      const previousCodexState = codexHostState(installedDirectory, installed);
      const nextProviders = project(directory, connections);
      const nextPricing = buildByokPricing(directory);

      const previousDispatchById = new Map(
        previousDispatchState.map((state) => [state.providerId, state]),
      );
      const nextDispatchById = new Map(nextDispatchState.map((state) => [state.providerId, state]));
      const ids = new Set([...previousDispatchById.keys(), ...nextDispatchById.keys()]);
      const changedIds = [...ids].filter(
        (id) => !isDeepStrictEqual(previousDispatchById.get(id), nextDispatchById.get(id)),
      );
      const gates = changedIds.map(beginProviderRouteMutation);
      const previous = installed;

      try {
        installed = structuredClone(connections);
        installedDirectory = structuredClone(directory);
        setByokPricing(nextPricing);
        setManagedProviders(nextProviders);
        for (const [index, gate] of gates.entries()) {
          const id = changedIds[index]!;
          if (!isDeepStrictEqual(
            credentialRevisionState(previousDispatchById.get(id)),
            credentialRevisionState(nextDispatchById.get(id)),
          )) gate.commit();
        }
      } catch (error) {
        if (directory.length === 0 && connections.length === 0) {
          // Logout and a successfully empty directory must never resurrect secrets
          // merely because a catalog listener failed while notifying a renderer.
          installed = [];
          installedDirectory = [];
          setByokPricing({});
          for (const gate of gates) gate.commit();
          log.warn('cleared credentials despite a catalog notification failure');
        } else {
          // Retain only wholly unchanged connections. A revoked or rotated key
          // must not be resurrected as part of rolling back a display failure.
          installed = previous.filter((entry) =>
            connections.some((next) => isDeepStrictEqual(entry, next)),
          );
          installedDirectory = structuredClone(directory);
          setByokPricing(nextPricing);
          for (const gate of gates) gate.commit();
          setManagedProviders(project(directory, installed));
          throw error;
        }
      } finally {
        for (const gate of gates) gate();
        if (!isDeepStrictEqual(previousCodexState, codexHostState(installedDirectory, installed))) {
          try {
            onCodexRoutesChanged?.();
          } catch {
            log.warn('Codex Host refresh notification failed');
          }
        }
      }
      // A closed renderer must not roll back an already installed credential generation.
      try {
        onPricingChanged?.();
      } catch {
        log.warn('reference price notification failed');
      }
    },
  });
}
