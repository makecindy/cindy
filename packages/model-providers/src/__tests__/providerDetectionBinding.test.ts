import { it, expect } from 'vitest';
import { BUNDLED_CATALOG } from '../builtin.js';
import { matchOfficialProviders, bindDetectedProvider, classifyProviderAddress } from '../providerDetection.js';
const presets = BUNDLED_CATALOG.presets ?? [];
const cases = presets.filter(p => classifyProviderAddress(p) === 'resource-template').flatMap(p => Object.values(p.runtimes).flatMap(rt => rt ? [{p, input: rt.baseUrl.replace(/\{([^}]+)\}/g, (_, key) => key === 'location' ? 'us-central1' : 'reviewaccount')}] : []));
it.each(cases)('matched template binds after URL normalization: $p.id $input', ({p,input}) => {
 for (const variant of [input, input.replace('https://', 'HTTPS://'), input.replace(/^(https:\/\/)([^/]+)/, (_, scheme, host) => scheme + host.toUpperCase()), input.replace(/^(https:\/\/)([^/]+)/, '$1$2:443')]) {
  expect(matchOfficialProviders(variant, [p]).map(row => row.id), variant).toContain(p.id);
  const bound = Object.keys(p.runtimes).map(a => bindDetectedProvider(p, a as keyof typeof p.runtimes, variant));
  expect(bound.every(Boolean), variant).toBe(true);
  for (const result of bound) for (const runtime of Object.values(result!.runtimes)) {
    expect(runtime!.baseUrl).not.toMatch(/[{}]/);
    if (p.id !== 'google-vertex') expect(runtime!.baseUrl).toContain('reviewaccount');
  }
 }
});

const official = presets.filter(p => classifyProviderAddress(p) === 'official').flatMap(p =>
  [...new Set(Object.values(p.runtimes).flatMap(rt => rt ? [rt.baseUrl] : []))].map(input => ({ p, input })));
it.each(official)('official address boundaries: $p.id $input', ({ p, input }) => {
  const parsed = new URL(input);
  if (parsed.search) return; // query-bound presets intentionally do not auto-identify
  for (const value of [input, input + '/', input.replace(/^(https?:\/\/)([^/]+)/, (_, scheme, host) => scheme.toUpperCase() + host.toUpperCase())]) {
    expect(matchOfficialProviders(value, [p]).map(row => row.id)).toContain(p.id);
    for (const agent of Object.keys(p.runtimes) as (keyof typeof p.runtimes)[]) expect(bindDetectedProvider(p, agent, value)).toBeDefined();
  }
  for (const mutate of [
    (u: URL) => { u.hostname += '.evil.example'; },
    (u: URL) => { u.pathname += '/unregistered'; },
    (u: URL) => { u.port = u.port === '9443' ? '9444' : '9443'; },
    (u: URL) => { u.search = '?token=fake'; },
    (u: URL) => { u.hash = '#fake'; },
    (u: URL) => { u.username = 'fake'; },
  ]) {
    const value = new URL(input); mutate(value);
    expect(matchOfficialProviders(value.toString(), [p]), value.toString()).toEqual([]);
  }
});

it.each(['https://localhost:1234/v1', 'https://127.0.0.1:1234/v1', 'http://127.1:1234/v1', 'https://[::1]:1234/v1', 'HTTP://LOCALHOST:1234/v1'])('never assigns a brand from a loopback catalog URL: %s', baseUrl => {
  const preset = { id: 'local-custom-brand', name: 'Local custom', runtimes: { pi: { baseUrl, models: [] } } };
  expect(matchOfficialProviders(baseUrl, [preset])).toEqual([]);
});
