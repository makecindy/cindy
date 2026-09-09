import { createHash } from 'node:crypto';

import type {
  Catalog,
  CustomProviderConfig,
  Provider,
  RoutingDescriptor,
} from '@cindy/model-providers';
import { buildUserProvider, storedCustomProviderId } from '@cindy/model-providers';

import {
  CODEX_GATEWAY_ENV_KEY,
  CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY,
  type CodexProxySpawnAuthMode,
} from './codex-gateway-config.js';
import { getProviderRouteCredentialRevision } from './provider-route.js';

export const CODEX_IMAGE_GENERATION_ACTOR_HEADER = 'x-openai-actor-authorization';
export const CODEX_IMAGE_GENERATION_ACTOR_VALUE = 'local-image-extension';
export const CODEX_CUSTOM_PROVIDER_ROUTE_ROOT = '/_cindy/custom-provider';
// The capability-specific prototype shipped only on the closed feature branch. Claim it solely to
// fail closed if a locally retained thread races this refactor; it is never emitted as a route.
const RETIRED_IMAGE_GENERATION_ROUTE_ROOT = '/_cindy/imagegen';
const RETIRED_IMAGE_GENERATION_PROVIDER_PREFIX = 'cindy_imagegen_';

export interface CodexCustomProviderCapabilities {
  readonly imageGeneration?: boolean;
  /** Future provider-level capabilities share this provider identity and route snapshot. */
  readonly [capability: string]: boolean | undefined;
}

export interface CodexCustomProviderRoute {
  /** Runtime catalog id (legacy xAI rows may be projected as custom:xai). */
  providerId: string;
  /** Stable, non-sensitive handle derived only from the stored custom Provider id. */
  routeId: string;
  modelProviderId: string;
  /** Provider-level capabilities frozen into this Host generation. */
  capabilities: CodexCustomProviderCapabilities;
  /** Models that can use this generic Responses identity. This is not a capability list. */
  responseModels: readonly string[];
  /** Host-spawn snapshot used only inside Desktop's loopback routing boundary. */
  routing: RoutingDescriptor;
  /** Per-model Responses routes frozen with the same Host snapshot. */
  responseRoutingByModel: Readonly<Record<string, RoutingDescriptor>>;
  /** Non-sensitive route/capability/credential dispatch generation frozen with this Host snapshot. */
  credentialRevision: number;
}

/** Routes actually frozen into the currently running local Codex Host. */
let appliedCustomProviderRoutes: readonly CodexCustomProviderRoute[] = [];

export function setCodexAppliedCustomProviderRoutes(
  routes: readonly CodexCustomProviderRoute[],
): void {
  appliedCustomProviderRoutes = [...routes];
}

export function findCodexAppliedCustomProviderRoute(
  routeId: string,
): CodexCustomProviderRoute | undefined {
  return appliedCustomProviderRoutes.find((route) => route.routeId === routeId);
}

export function hasCodexAppliedCustomProviderCapability(
  providerId: string,
  capability: keyof CodexCustomProviderCapabilities,
): boolean {
  const storedProviderId = storedCustomProviderId(providerId);
  return appliedCustomProviderRoutes.some(
    (route) =>
      storedCustomProviderId(route.providerId) === storedProviderId &&
      route.capabilities[capability] === true,
  );
}

function stableRouteId(providerId: string): string {
  return createHash('sha256').update(providerId, 'utf8').digest('hex').slice(0, 20);
}

function effectiveModelWireProtocol(
  model: { route?: { wireProtocol: string } },
  routing: RoutingDescriptor,
): string {
  return model.route?.wireProtocol ?? routing.wireProtocol ?? 'openai-responses';
}

function frozenRoutingDescriptor(routing: RoutingDescriptor): RoutingDescriptor {
  const frozen = { ...routing };
  // Custom headers are credentials. Keep them out of the Host snapshot; values are read at request
  // time behind provider-route's credential generation gate.
  delete frozen.headerOverride;
  // Capabilities have one structured source in this snapshot, separate from transport routing.
  delete frozen.supportsImageGeneration;
  // Model discovery is not part of request routing or the Codex provider table.
  delete frozen.modelsUrl;
  return frozen;
}

function routeForProvider(provider: Provider): CodexCustomProviderRoute | null {
  if (provider.source !== 'user' || !provider.agents.includes('codex')) return null;
  const routing = provider.routing.codex;
  if (!routing || routing.disabled) return null;
  const capabilities: CodexCustomProviderCapabilities = {
    imageGeneration: routing.supportsImageGeneration === true,
  };
  if (!Object.values(capabilities).some((enabled) => enabled === true)) return null;
  const responseModels = (provider.models.codex ?? []).filter(
    (model) => effectiveModelWireProtocol(model, routing) === 'openai-responses',
  );
  const responseModelIds = responseModels.map((model) => model.id);
  if (responseModelIds.length === 0) return null;
  const routeId = stableRouteId(storedCustomProviderId(provider.id));
  const frozenRouting = frozenRoutingDescriptor(routing);
  return {
    providerId: provider.id,
    routeId,
    modelProviderId: `cindy_custom_${routeId}`,
    capabilities,
    responseModels: responseModelIds,
    credentialRevision: getProviderRouteCredentialRevision(provider.id),
    routing: frozenRouting,
    responseRoutingByModel: Object.fromEntries(
      responseModels.map((model) => {
        if (!model.route) return [model.id, { ...frozenRouting }];
        const inherited = { ...frozenRouting };
        delete inherited.requestPath;
        return [
          model.id,
          {
            ...inherited,
            upstream: model.route.baseUrl,
            wireProtocol: model.route.wireProtocol,
            ...(model.route.requestPath ? { requestPath: model.route.requestPath } : {}),
          },
        ];
      }),
    ),
  };
}

/**
 * Non-sensitive spawn-config signature for one stored custom Provider. Credential generations are
 * handled separately by the Main mutation transaction; header values are stripped by routeForProvider.
 */
export function codexCustomProviderConfigSignature(config: CustomProviderConfig): string {
  const route = routeForProvider(buildUserProvider(config));
  if (!route) return '';
  return createHash('sha256')
    .update(
      JSON.stringify({
        providerId: route.providerId,
        modelProviderId: route.modelProviderId,
        capabilities: Object.fromEntries(
          Object.entries(route.capabilities).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
        responseModels: [...route.responseModels].sort(),
        routing: route.routing,
        responseRoutingByModel: Object.fromEntries(
          Object.entries(route.responseRoutingByModel).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      }),
      'utf8',
    )
    .digest('hex');
}

/** Strip Desktop-only routing data before the snapshot crosses into maker-core. */
export function toCodexCustomProviderHostRoutes(
  routes: readonly CodexCustomProviderRoute[],
): Array<
  Pick<
    CodexCustomProviderRoute,
    'providerId' | 'modelProviderId' | 'capabilities' | 'responseModels'
  >
> {
  return routes.map(({ providerId, modelProviderId, capabilities, responseModels }) => ({
    providerId,
    modelProviderId,
    capabilities: { ...capabilities },
    responseModels: [...responseModels],
  }));
}

export function deriveCodexCustomProviderRoutes(catalog: Catalog): CodexCustomProviderRoute[] {
  return catalog.providers.flatMap((provider) => {
    const route = routeForProvider(provider);
    return route ? [route] : [];
  });
}

export function codexCustomProviderRoutesSignature(
  routes: readonly CodexCustomProviderRoute[],
): string {
  const snapshot = routes
    .map((route) => ({
      providerId: route.providerId,
      modelProviderId: route.modelProviderId,
      capabilities: Object.fromEntries(
        Object.entries(route.capabilities).sort(([left], [right]) => left.localeCompare(right)),
      ),
      responseModels: [...route.responseModels].sort(),
      routing: route.routing,
      responseRoutingByModel: route.responseRoutingByModel,
      credentialRevision: route.credentialRevision,
    }))
    .sort((left, right) => left.modelProviderId.localeCompare(right.modelProviderId));
  return snapshot.length === 0
    ? ''
    : createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

export function codexCustomProviderRouteSignature(catalog: Catalog): string {
  return codexCustomProviderRoutesSignature(deriveCodexCustomProviderRoutes(catalog));
}

export function resolveCodexCustomProviderModelProviderId(
  routes: readonly CodexCustomProviderRoute[],
  providerId: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (!providerId || !model) return null;
  const route = routes.find((candidate) => candidate.providerId === providerId);
  return route?.responseModels.includes(model) ? route.modelProviderId : null;
}

export interface CodexAppliedCustomProviderIdentityInput {
  agentKind: string;
  remoteHostId?: string | null;
  currentCodexProxyActive?: boolean | null;
  currentThreadModelProviderId?: string | null;
  targetProviderId?: string | null;
  targetModel?: string | null;
}

/**
 * Whether a local Codex thread would cross the custom Provider identity frozen into its Host.
 * Membership in the applied snapshot is the authority: do not infer private identities from ids.
 */
export function crossesCodexAppliedCustomProviderIdentity(
  input: CodexAppliedCustomProviderIdentityInput,
): boolean {
  if (input.agentKind !== 'codex' || input.remoteHostId || input.currentCodexProxyActive !== true) {
    return false;
  }

  const actual = input.currentThreadModelProviderId?.trim() || null;
  const target = resolveCodexCustomProviderModelProviderId(
    appliedCustomProviderRoutes,
    input.targetProviderId?.trim() || null,
    input.targetModel?.trim() || null,
  );
  const actualIsAppliedCustomProviderIdentity = appliedCustomProviderRoutes.some(
    (route) => route.modelProviderId === actual,
  );
  const actualIsRetiredPrototypeIdentity =
    actual?.startsWith(RETIRED_IMAGE_GENERATION_PROVIDER_PREFIX) === true;

  return target !== null
    ? actual !== target
    : actualIsAppliedCustomProviderIdentity || actualIsRetiredPrototypeIdentity;
}

export function buildCodexCustomProviderArgs(
  proxyEndpoint: string,
  authMode: CodexProxySpawnAuthMode,
  routes: readonly CodexCustomProviderRoute[],
): { extraArgs: string[]; extraEnv: Record<string, string> } {
  const endpoint = proxyEndpoint.replace(/\/+$/, '');
  const extraArgs: string[] = [];
  for (const route of routes) {
    const baseUrl = `${endpoint}${CODEX_CUSTOM_PROVIDER_ROUTE_ROOT}/${route.routeId}`;
    const p = route.modelProviderId;
    extraArgs.push(
      '-c',
      `model_providers.${p}.name="Cindy Custom Provider"`,
      '-c',
      `model_providers.${p}.base_url="${baseUrl}"`,
      '-c',
      `model_providers.${p}.wire_api="responses"`,
      '-c',
      `model_providers.${p}.env_key="${CODEX_GATEWAY_ENV_KEY}"`,
      '-c',
      `model_providers.${p}.supports_websockets=false`,
    );
    if (route.capabilities.imageGeneration === true) {
      extraArgs.push(
        '-c',
        `model_providers.${p}.http_headers={ ${CODEX_IMAGE_GENERATION_ACTOR_HEADER} = "${CODEX_IMAGE_GENERATION_ACTOR_VALUE}" }`,
      );
    }
  }
  return {
    extraArgs,
    // OAuth hosts normally do not need the gateway env key. Dynamic custom identities do:
    // the value is only a loopback placeholder and is replaced by the Provider route boundary.
    extraEnv:
      authMode === 'oauth-bearer'
        ? { [CODEX_GATEWAY_ENV_KEY]: CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY }
        : {},
  };
}

export type ParsedCodexCustomProviderPath =
  | { kind: 'not-custom-provider-route' }
  | { kind: 'invalid' }
  | { kind: 'route'; routeId: string; upstreamPath: string; pathKind: 'responses' | 'images' };

interface RawRequestTarget {
  pathname: string;
  search: string;
  hasFragment: boolean;
}

/** Split origin-form or absolute-form HTTP request targets without URL normalization/decoding. */
function splitRawRequestTarget(rawUrl: string): RawRequestTarget | null {
  let target = rawUrl;
  const absoluteMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(target);
  if (absoluteMatch) {
    const authorityStart = absoluteMatch[0].length;
    const pathStart = target.slice(authorityStart).search(/[/?#\\]/);
    if (pathStart < 0) return { pathname: '/', search: '', hasFragment: false };
    target = target.slice(authorityStart + pathStart);
    if (!target.startsWith('/')) target = `/${target}`;
  }
  if (!target.startsWith('/')) return null;
  const fragmentIndex = target.indexOf('#');
  const beforeFragment = fragmentIndex < 0 ? target : target.slice(0, fragmentIndex);
  const queryIndex = beforeFragment.indexOf('?');
  return {
    pathname: queryIndex < 0 ? beforeFragment : beforeFragment.slice(0, queryIndex),
    search: queryIndex < 0 ? '' : beforeFragment.slice(queryIndex),
    hasFragment: fragmentIndex >= 0,
  };
}

function decodePercentBytesForOwnership(pathname: string): string {
  return pathname.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function beginsWithCustomProviderNamespace(segments: readonly string[]): boolean {
  return (
    segments[0] === '_cindy' &&
    (segments[1] === 'custom-provider' ||
      segments[1] === RETIRED_IMAGE_GENERATION_ROUTE_ROOT.slice('/_cindy/'.length))
  );
}

/**
 * Match ownership of the private loopback namespace before content-type parsing.
 * Encoded slashes deliberately count as owned-but-invalid so they can never fall through to the
 * default Gateway/ChatGPT route.
 */
export function isCodexCustomProviderNamespacePath(rawUrl: string): boolean {
  const target = splitRawRequestTarget(rawUrl);
  if (!target) return false;
  const decoded = decodePercentBytesForOwnership(target.pathname).replace(/\\/g, '/').toLowerCase();
  const lexicalSegments = decoded.split('/').filter((segment) => segment && segment !== '.');
  if (beginsWithCustomProviderNamespace(lexicalSegments)) return true;

  const semanticSegments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') semanticSegments.pop();
    else semanticSegments.push(segment);
  }
  return beginsWithCustomProviderNamespace(semanticSegments);
}

export function parseCodexCustomProviderPath(rawUrl: string): ParsedCodexCustomProviderPath {
  const owned = isCodexCustomProviderNamespacePath(rawUrl);
  const target = splitRawRequestTarget(rawUrl);
  if (!target || target.hasFragment) {
    return owned ? { kind: 'invalid' } : { kind: 'not-custom-provider-route' };
  }
  const { pathname, search } = target;
  if (!pathname.startsWith(`${CODEX_CUSTOM_PROVIDER_ROUTE_ROOT}/`)) {
    return isCodexCustomProviderNamespacePath(rawUrl)
      ? { kind: 'invalid' }
      : { kind: 'not-custom-provider-route' };
  }
  const rest = pathname.slice(CODEX_CUSTOM_PROVIDER_ROUTE_ROOT.length + 1);
  const slash = rest.indexOf('/');
  if (slash <= 0) return { kind: 'invalid' };
  const routeId = rest.slice(0, slash);
  const upstreamPath = rest.slice(slash);
  if (!/^[a-f0-9]{20}$/.test(routeId)) return { kind: 'invalid' };
  const pathKind =
    upstreamPath === '/responses'
      ? 'responses'
      : upstreamPath === '/images/generations' || upstreamPath === '/images/edits'
        ? 'images'
        : null;
  if (!pathKind) return { kind: 'invalid' };
  return { kind: 'route', routeId, upstreamPath: `${upstreamPath}${search}`, pathKind };
}

/** Convert an absolute Provider requestPath into a path relative to its upstream base. */
export function relativeProviderRequestPath(upstream: string, requestPath: string): string | null {
  let basePath: string;
  try {
    basePath = new URL(upstream).pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
  const queryIndex = requestPath.indexOf('?');
  const pathname = queryIndex >= 0 ? requestPath.slice(0, queryIndex) : requestPath;
  const query = queryIndex >= 0 ? requestPath.slice(queryIndex) : '';
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return null;
  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
    return `${pathname.slice(basePath.length) || '/'}${query}`;
  }
  return requestPath;
}
