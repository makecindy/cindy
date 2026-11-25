/**
 * The effective auxiliary-model chain, shared by Desktop and the Node Host. Moved verbatim
 * from resolveAuxiliaryModelChain.ts, which now builds the Desktop instance. Only the
 * settings read arrives as a port (Desktop: auxiliary-model-settings-store.ts).
 */

import {
  AUTO_AUXILIARY_MODEL_CHAIN,
  auxiliaryRouteRefId,
  parseAuxiliaryModelRef,
  type ParsedAuxiliaryModelRef,
} from '../../shared/auxiliaryModelChain.js';
import { encodeCatalogModelPin } from '../../shared/catalogModelPin.js';
import {
  DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
  getUtilityModelProfile,
  resolveUtilityModelProviderKindAlias,
  utilityTransportLabel,
} from '../../shared/utilityModelProfiles.js';
import type { AuxiliaryModelSettings } from '../../shared/auxiliaryModelSettings.js';

export type AuxiliaryModelChainSource = 'custom' | 'auto' | 'env';

export type EffectiveAuxiliaryModelChain = {
  source: AuxiliaryModelChainSource;
  refs: string[];
};

/** The settings read, resolved by each launcher. */
export interface AuxiliaryModelChainResolverPorts {
  readAuxiliaryModelSettings(): AuxiliaryModelSettings;
  /**
   * 一格选的是智能路由时，换成这条路由里本机能用的具体模型(目录钉)，路由此刻会选的排在最前。
   * 不提供(Node Host 没有智能路由)或路由已不存在时为空：这一格跳过，与选中的模型已不可用一样。
   */
  expandRouteRef?(routeId: string): string[];
}

/** One resolver per launcher, reading that launcher's auxiliary-model settings. */
export function createAuxiliaryModelChainResolver(ports: AuxiliaryModelChainResolverPorts) {
const { readAuxiliaryModelSettings, expandRouteRef } = ports;

/** 用户选的几格展开成具体模型：路由换成它的成员，去掉重复(先出现的位置为准)。 */
function expandCustomRefs(custom: readonly string[]): string[] {
  const refs: string[] = [];
  for (const ref of custom) {
    const routeId = auxiliaryRouteRefId(ref);
    for (const item of routeId ? (expandRouteRef?.(routeId) ?? []) : [ref]) {
      if (!refs.includes(item)) refs.push(item);
    }
  }
  return refs;
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function resolveEnvHeadRef(providerRaw: string | undefined, modelRaw: string | undefined): string | null {
  // Preserve the exact model identity when migrating a legacy provider/model
  // override. The resulting catalog pin remains subject to active-catalog
  // membership at dispatch; unknown models fail closed instead of becoming an
  // unlisted profile override. Do not introduce a second persisted ref format.
  const provider = resolveUtilityModelProviderKindAlias(providerRaw ?? '')
    ?? resolveUtilityModelProviderKindAlias('');
  if (!provider) return null;
  const profile = getUtilityModelProfile(provider);
  const model = modelRaw?.trim();
  if (!model || model === profile.model) return provider;
  const modelAlias = resolveUtilityModelProviderKindAlias(model);
  if (
    modelAlias
    && getUtilityModelProfile(modelAlias).transport === profile.transport
  ) {
    return modelAlias;
  }
  return encodeCatalogModelPin({
    providerId: profile.transport === 'codex-responses' ? 'openai' : 'xd',
    agentKind: 'codex',
    model,
  });
}

function readEnvUtilityChain(): string[] | null {
  // Keep both generations of the escape hatch alive. Utility names take
  // precedence when both are set, matching the legacy utility selection.
  const chainRaw = firstNonBlank(
    process.env.XDT_UTILITY_MODEL_PROVIDER_CHAIN,
    process.env.XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN,
  );
  const headRaw = firstNonBlank(
    process.env.XDT_UTILITY_MODEL_PROVIDER,
    process.env.XDT_VOICE_INPUT_REFINER_PROVIDER,
  );
  const modelRaw = firstNonBlank(
    process.env.XDT_UTILITY_MODEL,
    process.env.XDT_VOICE_INPUT_REFINER_MODEL,
  );
  const entries: string[] = [];
  if (typeof chainRaw === 'string' && chainRaw.trim()) {
    for (const part of chainRaw.split(',')) {
      const resolved = resolveUtilityModelProviderKindAlias(part.trim());
      if (resolved && !entries.includes(resolved)) entries.push(resolved);
    }
  }
  const hasHeadOrModelOverride = Boolean(headRaw || modelRaw);
  if (hasHeadOrModelOverride) {
    const headRef = resolveEnvHeadRef(headRaw, modelRaw);
    if (headRef) {
      const headProvider = resolveUtilityModelProviderKindAlias(headRaw ?? '')
        ?? resolveUtilityModelProviderKindAlias('');
      const rest = entries.filter((entry) => entry !== headProvider && entry !== headRef);
      return [headRef, ...rest];
    }
  }
  if (entries.length > 0) {
    // `UtilityModelSelection` has always treated a provider-chain-only
    // configuration as a fallback tail behind the implicit default provider.
    // Keep that legacy ordering when migrating the escape hatch into the
    // shared auxiliary chain; otherwise the first configured fallback would
    // silently become the primary route.
    return [
      DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
      ...entries.filter((entry) => entry !== DEFAULT_UTILITY_MODEL_PROVIDER_KIND),
    ];
  }
  return null;
}

function getEffectiveAuxiliaryModelChain(custom: readonly string[] = readAuxiliaryModelSettings().models): EffectiveAuxiliaryModelChain {
  if (custom.length > 0) {
    // 选了路由的格子在这里换成具体模型：后面所有用这条链的地方(发请求、健康记录、快照比对)只见到具体模型。
    return { source: 'custom', refs: expandCustomRefs(custom) };
  }
  const envChain = readEnvUtilityChain();
  if (envChain) {
    return { source: 'env', refs: envChain };
  }
  return { source: 'auto', refs: [...AUTO_AUXILIARY_MODEL_CHAIN] };
}

/**
 * Stable request-time identity for the effective auxiliary chain.
 * Async callers capture this before resolving credentials or readiness, then
 * fail closed if the user changes the routing decision while work is in flight.
 */
function getEffectiveAuxiliaryModelChainSnapshot(): string {
  const chain = getEffectiveAuxiliaryModelChain();
  return JSON.stringify({ source: chain.source, refs: chain.refs });
}

function getEffectiveAuxiliaryModelRefs(): string[] {
  return getEffectiveAuxiliaryModelChain().refs;
}

function formatAuxiliaryModelRefLabel(ref: string): string {
  const parsed = parseAuxiliaryModelRef(ref);
  if (!parsed) return ref;
  if (parsed.kind === 'profile') {
    const profile = getUtilityModelProfile(parsed.id);
    return `${profile.model} · ${utilityTransportLabel(profile.transport)}`;
  }
  if (parsed.route.providerId === 'xd') {
    return `${parsed.route.model} · Cindy AI`;
  }
  const agent = parsed.route.agentKind === 'claude-code'
    ? 'Claude'
    : parsed.route.agentKind === 'pi' ? 'Pi' : 'Codex';
  const provider = parsed.route.providerId === 'anthropic' || parsed.route.providerId === 'openai'
    ? agent
    : parsed.route.providerId;
  return `${parsed.route.model} · ${provider}`;
}

function parsedAuxiliaryModelRefs(refs: readonly string[]): ParsedAuxiliaryModelRef[] {
  const parsed: ParsedAuxiliaryModelRef[] = [];
  for (const ref of refs) {
    const item = parseAuxiliaryModelRef(ref);
    if (item && !(item.kind === 'catalog' && item.route.agentDeviceId)) parsed.push(item);
  }
  return parsed;
}

/** Label the same local candidate chain used by plugin execution, not a retained remote head. */
function getEffectiveAuxiliaryModelLabel(): string | null {
  const first = parsedAuxiliaryModelRefs(getEffectiveAuxiliaryModelChain().refs)[0];
  if (!first) return null;
  return formatAuxiliaryModelRefLabel(first.kind === 'profile' ? first.id : encodeCatalogModelPin(first.route));
}

return { getEffectiveAuxiliaryModelChain, getEffectiveAuxiliaryModelChainSnapshot, getEffectiveAuxiliaryModelRefs, getEffectiveAuxiliaryModelLabel, formatAuxiliaryModelRefLabel, parsedAuxiliaryModelRefs };
}
