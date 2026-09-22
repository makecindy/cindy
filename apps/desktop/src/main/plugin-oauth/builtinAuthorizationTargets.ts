/**
 * Narrow legacy provider contracts. New generic integrations use their installed
 * declaration; these restrictions cannot be overridden by plugin/CLI output.
 */
export const builtinAuthorizationTargets: Readonly<Record<string, (url: URL) => boolean>> =
  Object.freeze({
    'cindy-github': (url) =>
      url.origin === 'https://github.com' &&
      url.pathname === '/login/device' &&
      !url.search &&
      !url.hash,
    'taptap-maker': (url) =>
      url.origin === 'https://maker.taptap.cn' &&
      url.pathname === '/pat-tokens' &&
      !url.hash &&
      [...url.searchParams.keys()].join(',') === 'code' &&
      /^[A-Za-z0-9_-]{32}$/.test(url.searchParams.get('code') ?? ''),
  });
