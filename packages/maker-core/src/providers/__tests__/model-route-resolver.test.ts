import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeBaseUrl, resolveModelRoute } from '../model-route-resolver.js';

describe('model-route-resolver', () => {
  it('normalizes base URLs to include /v1 without trailing slash', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:1234/')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1');
  });

  it('returns null for empty, undefined, or hermes-default sentinel', () => {
    expect(resolveModelRoute(undefined)).toBeNull();
    expect(resolveModelRoute('')).toBeNull();
    expect(resolveModelRoute('hermes-default')).toBeNull();
  });

  it('resolves a route name and model defined in routing.yaml and providers.yaml', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-route-test-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'providers.yaml'),
        `providers:
  - id: lmstudio-local
    kind: lmstudio
    baseUrl: http://127.0.0.1:1234
`,
      );
      fs.writeFileSync(
        path.join(tmpDir, 'routing.yaml'),
        `routes:
  local-small: { provider: lmstudio-local, model: qwen3-8b }
rules:
  title: local-small
`,
      );

      // Resolve by route name
      const routeByName = resolveModelRoute('local-small', { harnessDir: tmpDir });
      expect(routeByName).toEqual({
        model: 'qwen3-8b',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1234/v1',
        providerId: 'lmstudio-local',
      });

      // Resolve by model name matching the route
      const routeByModel = resolveModelRoute('qwen3-8b', { harnessDir: tmpDir });
      expect(routeByModel).toEqual({
        model: 'qwen3-8b',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1234/v1',
        providerId: 'lmstudio-local',
      });

      // Resolve by provider/model prefix (including slash in model name)
      const routeByPrefix = resolveModelRoute('lmstudio-local/other-model', { harnessDir: tmpDir });
      expect(routeByPrefix).toEqual({
        model: 'other-model',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1234/v1',
        providerId: 'lmstudio-local',
      });

      const routeWithSlashInModel = resolveModelRoute('lmstudio-local/google/gemma-4-26b-a4b-qat', { harnessDir: tmpDir });
      expect(routeWithSlashInModel).toEqual({
        model: 'google/gemma-4-26b-a4b-qat',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1234/v1',
        providerId: 'lmstudio-local',
      });

      // Resolve by discovered endpoint models without provider prefix
      const routeByDiscovery = resolveModelRoute('google/gemma-4-26b-a4b-qat', {
        harnessDir: tmpDir,
        endpointModels: new Map([['lmstudio-local', ['google/gemma-4-26b-a4b-qat']]]),
      });
      expect(routeByDiscovery).toEqual({
        model: 'google/gemma-4-26b-a4b-qat',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1234/v1',
        providerId: 'lmstudio-local',
      });

      // Unmatched model returns null (home default)
      expect(resolveModelRoute('deepseek-flash', { harnessDir: tmpDir })).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
