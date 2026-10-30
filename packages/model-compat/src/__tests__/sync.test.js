import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractProviderProfiles } from '../../scripts/provider-profiles.mjs';

function fixture(source, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-profile-test-'));
  try {
    fs.mkdirSync(path.join(root, 'src/providers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/providers/registry.ts'), source);
    return run(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
describe('upstream synchronization contract', () => {
  it('extracts compatibility data deterministically without evaluating upstream side effects', () => {
    const source = `throw new Error('must never execute');
      const IDS = ['reasoner'];
      export const PROVIDER_REGISTRY = [{ id: 'test', adapter: 'openai-chat', baseUrl: 'https://provider.example',
        noTemperatureModels: IDS, modelReasoningEffortMap: Object.fromEntries(IDS.map(id => [id, { high: 'enabled' }])),
        credentials: process.env.SECRET }];`;
    fixture(source, root => {
      const first = extractProviderProfiles(root);
      expect(first).toEqual(extractProviderProfiles(root));
      expect(first.profiles).toEqual([{ id: 'test', adapter: 'openai-chat', baseUrl: 'https://provider.example', noTemperatureModels: ['reasoner'], modelReasoningEffortMap: { reasoner: { high: 'enabled' } } }]);
    });
  });
  it('fails instead of silently losing a new dynamic compatibility expression', () => {
    fixture(`export const PROVIDER_REGISTRY = [{ id: 'test', baseUrl: 'https://provider.example', noTemperatureModels: unknownNewHelper() }];`, root => {
      expect(() => extractProviderProfiles(root)).toThrow(/Unresolved compatibility expression/);
    });
  });
  it('rejects registry structure changes that need a human port review', () => {
    fixture(`export const PROVIDER_REGISTRY = buildRegistry();`, root => {
      expect(() => extractProviderProfiles(root)).toThrow(/registry shape changed/);
    });
  });
});
