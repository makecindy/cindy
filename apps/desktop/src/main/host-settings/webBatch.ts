import { SETTINGS_WEB_MAX_BYTES, settingsWebReadResultSchema, type SettingsWebCommand, type SettingsWebReadResult } from '../../shared/settingsWeb.js';

type Domains = Extract<SettingsWebCommand, { kind: 'readBatch' }>['domains'];

/** One transport request, many local reads. Each field retains its own CAS revision;
 * this is not a transaction spanning all settings files. Never truncate a domain. */
export async function readSettingsBatch(domains: Domains, read: (domain: Domains[number]) => Promise<unknown>, assertCurrent: () => void) {
  const entries: Array<{ domain: Domains[number]; result: SettingsWebReadResult }> = [];
  const started = Date.now();
  const response = (remainingDomains: Domains) => ({ ok: true as const, entries, remainingDomains });
  const fits = (remaining: Domains) => Buffer.byteLength(JSON.stringify(response(remaining)), 'utf8') <= SETTINGS_WEB_MAX_BYTES - 512;
  for (const [index, domain] of domains.entries()) {
    assertCurrent();
    // Yield between complete domains before consuming the command's entire lease.
    if (entries.length && Date.now() - started >= 5_000) return response(domains.slice(index));
    let result: SettingsWebReadResult;
    try { result = settingsWebReadResultSchema.parse(await read(domain)); }
    catch { result = { ok: false, code: 'SETTINGS_REQUEST_FAILED' }; }
    assertCurrent();
    if (result.ok && result.settings.domain !== domain) result = { ok: false, code: 'SETTINGS_REQUEST_FAILED' };
    entries.push({ domain, result });
    const remaining = domains.slice(index + 1);
    if (!fits(remaining)) {
      entries.pop();
      if (entries.length) return response(domains.slice(index));
      // A single domain too large for the unchanged envelope is an explicit error.
      entries.push({ domain, result: { ok: false, code: 'SETTINGS_RESPONSE_TOO_LARGE' } });
    }
  }
  return response([]);
}
