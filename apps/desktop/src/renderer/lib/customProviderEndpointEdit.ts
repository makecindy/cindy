import type { ProviderRuntimeModelConfig } from '@cindy/model-providers';

/**
 * Rebase saved model routes when editing their connection endpoint. Routes that
 * used the connection base follow its full URL; independent paths keep their
 * protocol/path overrides on the new origin. Always compare with the saved base,
 * not intermediate keystrokes, so clearing/retyping or reverting is lossless.
 * Unrelated or invalid routes remain subject to Main's existing validation.
 */
export function modelsAfterProviderEndpointEdit(
  models: ProviderRuntimeModelConfig[],
  previousBaseUrl: string | undefined,
  nextBaseUrl: string,
): ProviderRuntimeModelConfig[] {
  if (!previousBaseUrl) return models;
  const parse = (value: string): URL | undefined => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? url : undefined;
    } catch { return undefined; }
  };
  const previous = parse(previousBaseUrl);
  const next = parse(nextBaseUrl);
  if (!previous || !next || previous.href === next.href) return models;
  const sameBase = (left: URL, right: URL) => left.origin === right.origin
    && left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '')
    && left.search === right.search && left.hash === right.hash;
  return models.map(model => {
    if (!model.route) return model;
    const route = parse(model.route.baseUrl);
    if (!route || route.origin !== previous.origin) return model;
    const baseUrl = sameBase(route, previous)
      ? nextBaseUrl.trim()
      : next.origin + route.pathname + route.search + route.hash;
    if (baseUrl === model.route.baseUrl) return model;
    return { ...model, route: { ...model.route, baseUrl } };
  });
}
