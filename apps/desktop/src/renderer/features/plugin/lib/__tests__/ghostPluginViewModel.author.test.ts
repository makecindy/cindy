import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import type { InstalledGhost } from '../../../../../shared/ghost';
import { marketPresentationForInstalledGhost, toGhostPluginDetail } from '../ghostPluginViewModel';
import type { PluginMarketItem } from '../../../../../shared/pluginMarket';

const installed: InstalledGhost = {
  manifest: { schemaVersion: 3, id: 'example', name: 'Example', version: '1.0.0', kind: 'chip', entry: 'main.js', author: 'Package claim' },
  dir: path.join(os.tmpdir(), 'example'), namespace: null, namespaceState: 'confirmed', enabled: true,
  approval: { state: 'approved', revision: 'approved-content' },
};

describe('workflow-owned author presentation', () => {
  it('uses the verified public classification without inferring official status from a name', () => {
    const market = { ghostId: installed.manifest.id, namespace: null, scope: 'public',
      installState: 'installed', sourceType: 'server', version: '1.0.0', name: 'Example',
      description: '', author: 'Cindy', publisherKind: 'personal', icon: null } as PluginMarketItem;
    expect(toGhostPluginDetail(installed, marketPresentationForInstalledGhost(installed, market)).publisherKind).toBe('personal');
    expect(marketPresentationForInstalledGhost(installed, { ...market, sourceType: 'git-market' })?.publisherKind).toBeUndefined();
    expect(toGhostPluginDetail({ ...installed, namespace: 'example-org' }).publisherKind).toBeUndefined();
  });
  it('retains organization package attribution without a current market presentation', () => {
    const organization = { ...installed, namespace: 'example-org' };
    expect(toGhostPluginDetail(organization).author).toBe('Package claim');
    expect(toGhostPluginDetail({ ...organization, manifest: { ...installed.manifest, author: undefined } }).author).toBeNull();
  });
  it('does not display a public package author when verified market attribution is absent', () => {
    expect(toGhostPluginDetail({ ...installed, publishingSource: { kind: 'public-market', pluginId: 'public-1' } }).author).toBeNull();
  });
  it('preserves package attribution for local and legacy installations', () => {
    expect(toGhostPluginDetail(installed).author).toBe('Package claim');
    expect(toGhostPluginDetail({ ...installed, publishingSource: { kind: 'local', source: 'manual' } }).author).toBe('Package claim');
  });
  it('uses the market attribution and does not fall back when it is explicitly missing', () => {
    const presentation = { name: 'Example', description: '', iconDataUrl: undefined, author: 'Verified account' };
    expect(toGhostPluginDetail(installed, presentation).author).toBe('Verified account');
    expect(toGhostPluginDetail(installed, { ...presentation, author: null }).author).toBeNull();
    expect(installed.manifest.author).toBe('Package claim');
  });
  it('uses Main-verified attribution for an older version while retaining its local content', () => {
    const newer = { ghostId: installed.manifest.id, namespace: null, installState: 'update-available',
      sourceType: 'server', version: '2.0.0', name: 'New version name', description: 'New version description',
      author: 'Current name', installedAuthor: 'Current name', icon: null } as PluginMarketItem;
    expect(marketPresentationForInstalledGhost(installed, newer)).toMatchObject({
      name: installed.manifest.name, description: '', author: 'Current name',
    });
    const unverified = { ...newer, installedAuthor: undefined };
    expect(marketPresentationForInstalledGhost(installed, unverified)).toBeNull();
    expect(marketPresentationForInstalledGhost(installed, { ...newer, installState: 'conflict' })).toBeNull();
    expect(marketPresentationForInstalledGhost(installed, { ...newer, sourceType: 'git-market' })).toBeNull();
    expect(marketPresentationForInstalledGhost(installed, { ...newer, ghostId: 'other-plugin' })).toBeNull();
  });
});
