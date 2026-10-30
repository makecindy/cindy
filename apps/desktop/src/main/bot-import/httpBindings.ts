import type { CompanionEnvironment } from './environment.js';
import { fingerprint } from './files.js';

export interface ImportHttpBase {
  variable: string;
  origin: string;
  pathname: string;
  authVariables: string[];
}

/** Path segments can be credentials. The planner receives only a base-scoped alias. */
export function publicImportHttpBases(bases: ImportHttpBase[]): ImportHttpBase[] {
  return bases.map(base => ({ ...base, pathname: `/__import_base_${fingerprint(base.variable).slice(0, 20)}__` }));
}

/** Resolve only this base's prefix, never substitute arbitrary credential aliases. */
export function resolveImportHttpPath(value: string, rawBase: string, alias: string): URL {
  const base = new URL(rawBase);
  if (value === alias) return base; // Includes the original query, if any.
  const suffix = value.startsWith(alias) ? value.slice(alias.length) : undefined;
  if (suffix && /^[/?#]/.test(suffix)) return new URL(`${base.pathname.replace(/\/$/, '')}${suffix}`, base);
  return new URL(value, base);
}

function httpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.hash ? url : undefined;
  } catch { return undefined; }
}

/** Source environment conventions: DATA_URL/DATA_TOKEN, OPENAI_BASE_URL/OPENAI_API_KEY. */
function serviceGroup(name: string, kind: 'base' | 'auth'): string | undefined {
  const suffix = kind === 'base' ? /(?:^|_)(?:URL|ENDPOINT|HOST)$/ : /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|KEY|SECRET|PASSWORD)$/;
  const upper = name.toUpperCase();
  if (!suffix.test(upper)) return undefined;
  return upper.replace(suffix, '').replace(/(?:^|_)(?:API|BASE|AUTH)$/, '');
}

/** Bind before consulting the planner. Presence in the same allowlist is not authority. */
export function importedHttpBases(environment: CompanionEnvironment, allowedVariables: Set<string>): ImportHttpBase[] {
  const configured = Object.entries(environment.env).flatMap(([variable, value]) => {
    const group = serviceGroup(variable, 'base');
    const url = group === undefined ? undefined : httpUrl(value);
    return url ? [{ variable, group, url }] : [];
  });
  const origins = new Map<string, Set<string>>();
  for (const [variable, value] of Object.entries(environment.env)) {
    if (!allowedVariables.has(variable) || !value) continue;
    const permitted = new Set<string>();
    const group = serviceGroup(variable, 'auth');
    const groupedOrigins = new Set(configured.filter(base => group !== undefined && base.group === group).map(base => base.url.origin));
    // Explicit source connection headers also establish an origin, including for
    // arbitrary variable names. Match resolved values, never model-supplied text.
    for (const server of environment.mcp.filter(server => server.enabled !== false && server.url)) {
      const url = httpUrl(server.url!);
      if (url && Object.values(server.headers ?? {}).some(header => ['', 'Bearer ', 'Basic ', 'token '].some(prefix => header === `${prefix}${value}`))) permitted.add(url.origin);
    }
    // Explicit auth configuration wins over naming conventions. A service group
    // with multiple origins is ambiguous; never pick one by order.
    if (!permitted.size && groupedOrigins.size === 1) permitted.add([...groupedOrigins][0]!);
    origins.set(variable, permitted);
  }
  return configured.filter(base => allowedVariables.has(base.variable)).map(({ variable, url }) => ({
    variable, origin: url.origin, pathname: url.pathname,
    authVariables: [...origins].filter(([, allowed]) => allowed.has(url.origin)).map(([name]) => name),
  }));
}
