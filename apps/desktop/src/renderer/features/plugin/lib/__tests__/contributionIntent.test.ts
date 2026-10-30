/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import type { InstalledGhost } from '../../../../../shared/ghost';
import {
  consumeContributionIntent,
  matchesContributionIntent,
  rememberContributionIntent,
} from '../contributionIntent';

const ghost: InstalledGhost = {
  manifest: {
    schemaVersion: 2,
    id: 'hello',
    name: 'Hello',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
  },
  dir: '/test-only/owner-A/hello',
  namespace: null,
  publishingSource: { kind: 'local', source: 'manual' },
  namespaceState: 'confirmed',
  enabled: true,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
};
describe('public contribution login intent', () => {
  it('does not substitute another account installation or a new approval for the same logical ID', () => {
    const nonce = rememberContributionIntent(ghost);
    const target = consumeContributionIntent(nonce)!;
    expect(matchesContributionIntent(target, ghost)).toBe(true);
    expect(matchesContributionIntent(target, { ...ghost, dir: '/test-only/owner-B/hello' })).toBe(
      false,
    );
    expect(
      matchesContributionIntent(target, {
        ...ghost,
        approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' },
      }),
    ).toBe(false);
    expect(matchesContributionIntent(target, { ...ghost, namespace: 'org' })).toBe(false);
    expect(matchesContributionIntent(target, { ...ghost, publishingSource: { kind: 'public-market', pluginId: 'other' } })).toBe(false);
    expect(matchesContributionIntent(target, { ...ghost, publishingSource: undefined })).toBe(false);
    expect(consumeContributionIntent(nonce)).toBeNull();
  });
});
