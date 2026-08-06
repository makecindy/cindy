import type {
  AgentKind,
  Catalog,
  Provider,
  ProviderDefaults,
} from './types.js';

/** Cold-start model selection scenarios carried by catalog defaults. */
export type DefaultModelScenario = 'session' | 'title' | 'oneShot';

const DEFAULT_FIELD_BY_SCENARIO = {
  session: 'sessionModel',
  title: 'titleModel',
  oneShot: 'oneShotModel',
} as const satisfies Record<DefaultModelScenario, keyof ProviderDefaults>;

/** Catalog or provider-view input accepted by the pure defaults resolver. */
export type DefaultsCatalogView = Pick<Catalog, 'providers' | 'defaults'> | readonly Provider[];

function providersAndDefaults(input: DefaultsCatalogView): {
  providers: readonly Provider[];
  defaults: Catalog['defaults'];
} {
  if (Array.isArray(input)) return { providers: input, defaults: undefined };
  const catalog = input as Pick<Catalog, 'providers' | 'defaults'>;
  return { providers: catalog.providers, defaults: catalog.defaults };
}

/**
 * Resolve a cold-start model without IO.
 *
 * Priority is catalog-wide defaults, then the first provider-level default in catalog order,
 * then the caller-owned final fallback. Empty strings are treated as missing metadata.
 */
export function resolveDefaultModel(
  input: DefaultsCatalogView,
  agent: AgentKind,
  scenario: DefaultModelScenario,
  fallback: string,
): string {
  const { providers, defaults } = providersAndDefaults(input);
  const field = DEFAULT_FIELD_BY_SCENARIO[scenario];
  const catalogDefault = defaults?.[agent]?.[field]?.trim();
  if (catalogDefault) return catalogDefault;

  for (const provider of providers) {
    if (!provider.agents.includes(agent)) continue;
    const providerDefault = provider.defaults?.[agent]?.[field]?.trim();
    if (providerDefault) return providerDefault;
  }
  return fallback;
}
