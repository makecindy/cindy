import {
  cliProxyManagementBase,
  parseCliProxyQuota,
  type CliProxyQuotaSnapshot,
} from '../../shared/cliProxyQuota.js';

const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
type Json = Record<string, unknown>;
export interface CliProxyQuotaDeps {
  fetch: typeof fetch;
  isCurrent(): boolean;
}

/** All network destinations and credential headers are chosen by Main. */
export async function fetchCliProxyQuota(
  baseUrl: string,
  managementKey: string,
  deps: CliProxyQuotaDeps,
): Promise<CliProxyQuotaSnapshot> {
  const base = cliProxyManagementBase(baseUrl);
  if (!base) throw new Error('Invalid CLI proxy address');
  const deadline = AbortSignal.timeout(60_000);
  async function request(path: string, body?: Json): Promise<Json> {
    if (!deps.isCurrent()) throw new Error('Account changed');
    const response = await deps.fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${managementKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
    });
    if (!deps.isCurrent()) throw new Error('Account changed');
    if (!response.ok) throw new Error('CLI proxy quota request failed');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid quota response');
    return value as Json;
  }
  const listing = await request('/credentials');
  if (!Array.isArray(listing.files)) throw new Error('Invalid credential list');
  const accounts: CliProxyQuotaSnapshot['accounts'] = [];
  // Bound work per refresh and isolate one account's upstream failure.
  for (const file of listing.files
    .filter((f) => f?.provider === 'antigravity' || f?.type === 'antigravity')
    .slice(0, 20)) {
    const account = {
      name: String(file.email || file.name || '').slice(0, 200),
      disabled: file.disabled === true,
      unavailable: false,
      groups: [] as CliProxyQuotaSnapshot['accounts'][number]['groups'],
    };
    accounts.push(account);
    if (account.disabled) continue;
    try {
      const authIndex = file.auth_index ?? file.authIndex;
      if (typeof authIndex !== 'string' || typeof file.name !== 'string')
        throw new Error('Missing account identity');
      // Project metadata is not always exposed by the credential listing. The
      // downloaded credential stays in Main and is never returned to Renderer.
      const credential = await request(
        `/credentials/download?name=${encodeURIComponent(file.name)}`,
      );
      const project = credential.project_id ?? credential.projectId;
      if (typeof project !== 'string' || !project) throw new Error('Missing project');
      const result = await request('/requests/api-call', {
        authIndex,
        method: 'POST',
        url: QUOTA_URL,
        header: {
          Authorization: 'Bearer $TOKEN$',
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/hub/2.23.0 darwin/arm64',
        },
        data: JSON.stringify({ project }),
      });
      if (
        typeof result.status_code !== 'number' ||
        result.status_code < 200 ||
        result.status_code >= 300
      )
        throw new Error('Upstream quota failed');
      account.groups = parseCliProxyQuota(
        typeof result.body === 'string' ? JSON.parse(result.body) : result.body,
      );
      account.unavailable = account.groups.length === 0;
    } catch {
      account.unavailable = true;
    }
  }
  if (!deps.isCurrent()) throw new Error('Account changed');
  return { configured: true, accounts, observedAt: Date.now() };
}
