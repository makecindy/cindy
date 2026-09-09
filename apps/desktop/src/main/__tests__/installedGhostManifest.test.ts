import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseInstalledGhostManifest,
  readInstalledGhostManifest,
  readInstalledGhostManifestDigestFormats,
  readInstalledGhostManifestSnapshot,
} from '../installedGhostManifest.js';
import { ghostManifestDigest } from '../plugin-market/ledger.js';

const roots: string[] = [];

function manifest(id = 'legacy-plugin'): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: 'Legacy plugin',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'run', description: 'Run the plugin' }],
  };
}

function legacyBrokerManifest(): Record<string, unknown> {
  return {
    ...manifest('legacy-broker'),
    slots: ['network'],
    tools: undefined,
    settingsHtml: 'settings.html',
    network: {
      hosts: ['accounts.example.com'],
      secrets: [
        {
          key: 'account',
          label: 'Account',
          source: 'oauth',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
          oauth: {
            authorizeUrl: 'https://accounts.example.com/authorize',
            tokenUrl: 'https://accounts.example.com/token',
            clientId: 'builtin-client-id',
            tokenBroker: 'jira',
          },
        },
      ],
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('installed ghost manifest compatibility', () => {
  it('keeps valid Manual manifests while normalizing legacy slots', () => {
    const raw = {
      ...manifest(),
      manual: {
        items: [{ dir: 'manual/guide', name: 'guide', description: 'How to use it' }],
      },
    };

    const parsed = parseInstalledGhostManifest(raw);

    expect(parsed).toEqual({
      ok: true,
      manifest: {
        schemaVersion: 2,
        id: 'legacy-plugin',
        name: 'Legacy plugin',
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        tools: [{ name: 'run', description: 'Run the plugin' }],
        manual: raw.manual,
      },
      legacyManualIgnored: false,
    });
  });

  it.each([
    ['string', 'sensitive legacy notes'],
    ['object', { arbitrary: 'sensitive legacy metadata' }],
  ])('ignores a legacy top-level manual %s while preserving the manifest', (_kind, manual) => {
    const parsed = parseInstalledGhostManifest({ ...manifest(), manual });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.legacyManualIgnored).toBe(true);
    expect(parsed.manifest).not.toHaveProperty('manual');
    expect(JSON.stringify(parsed)).not.toContain('sensitive');
  });

  it('does not hide invalid fields unrelated to legacy manual', () => {
    const parsed = parseInstalledGhostManifest({
      ...manifest(),
      name: 42,
      manual: 'legacy notes',
    });

    expect(parsed.ok).toBe(false);
  });

  it('keeps an installed legacy broker manifest readable when redirectPort was never declared', () => {
    const parsed = parseInstalledGhostManifest(legacyBrokerManifest());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.network?.secrets?.[0]?.oauth).toMatchObject({
      tokenBroker: 'jira',
    });
    expect(parsed.manifest.network?.secrets?.[0]?.oauth?.redirectPort).toBeUndefined();
  });

  it('reads an installed ghost.json through the bounded compatibility path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-manifest-'));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, 'ghost.json'),
      JSON.stringify({ ...manifest(), manual: { marker: 'legacy metadata' } }),
    );

    const parsed = readInstalledGhostManifest(root, 64 * 1024);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.id).toBe('legacy-plugin');
    expect(parsed.manifest).not.toHaveProperty('manual');
  });

  it('hashes the exact bytes read instead of a normalized serialization', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-manifest-sha-'));
    roots.push(root);
    const bytes = Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'ghost.json'), bytes);

    const result = readInstalledGhostManifestSnapshot(root, 64 * 1024);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.rawManifestSha256).toBe(
      crypto.createHash('sha256').update(bytes).digest('hex'),
    );
    expect(result.snapshot.rawManifestSha256).not.toBe(
      crypto.createHash('sha256').update(JSON.stringify(result.snapshot.manifest)).digest('hex'),
    );
  });

  it('keeps semantic equality separate from raw-byte identity', () => {
    const rootsForFormats = [
      fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-format-a-')),
      fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-format-b-')),
    ];
    roots.push(...rootsForFormats);
    fs.writeFileSync(path.join(rootsForFormats[0], 'ghost.json'), JSON.stringify(manifest()));
    fs.writeFileSync(path.join(rootsForFormats[1], 'ghost.json'), JSON.stringify(manifest(), null, 2));

    const first = readInstalledGhostManifestSnapshot(rootsForFormats[0], 64 * 1024);
    const second = readInstalledGhostManifestSnapshot(rootsForFormats[1], 64 * 1024);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.snapshot.manifest).toEqual(second.snapshot.manifest);
    expect(first.snapshot.rawManifestSha256).not.toBe(second.snapshot.rawManifestSha256);
  });

  it('keeps the upgrade-time v2 digest candidate in the original slot order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-v2-digest-'));
    roots.push(root);
    const raw = {
      ...legacyBrokerManifest(),
      slots: ['notify', 'network'],
    };
    fs.writeFileSync(path.join(root, 'ghost.json'), JSON.stringify(raw));

    const parsed = parseInstalledGhostManifest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const legacy = { ...parsed.manifest, slots: ['notify', 'network'] };
    delete legacy.notify;

    const digestCandidates = readInstalledGhostManifestDigestFormats(root, 64 * 1024).map(
      ghostManifestDigest,
    );
    expect(digestCandidates).toContain(ghostManifestDigest(legacy));
    expect(parsed.manifest).toMatchObject({ notify: true });
  });

  it.each([
    ['omitted', undefined],
    ['empty', {}],
    ['explicit false', { externalLinks: false }],
  ])('reproduces the v0.1.61 card projection when card is %s', (_label, card) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-v2-card-shape-'));
    roots.push(root);
    const raw = {
      schemaVersion: 2 as const,
      id: 'cindy-card-shape',
      name: 'Card Shape',
      version: '1.0.0',
      kind: 'chip' as const,
      entry: 'main.js',
      slots: ['card'],
      ...(card === undefined ? {} : { card }),
    };
    fs.writeFileSync(path.join(root, 'ghost.json'), JSON.stringify(raw));

    const result = readInstalledGhostManifestSnapshot(root, 64 * 1024);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.releasedLegacyDigestFormat).not.toHaveProperty('card');
  });

  it('keeps only released true-valued card and agent detail fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-installed-v2-detail-shape-'));
    roots.push(root);
    const raw = {
      schemaVersion: 2 as const,
      id: 'cindy-detail-shape',
      name: 'Detail Shape',
      version: '1.0.0',
      kind: 'chip' as const,
      entry: 'main.js',
      slots: ['card', 'agent'],
      card: { externalLinks: true },
      agent: { background: true, errand: false },
    };
    fs.writeFileSync(path.join(root, 'ghost.json'), JSON.stringify(raw));

    const result = readInstalledGhostManifestSnapshot(root, 64 * 1024);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.releasedLegacyDigestFormat).toMatchObject({
      card: { externalLinks: true },
      agent: { background: true },
    });
    expect(
      (result.snapshot.releasedLegacyDigestFormat as { agent: Record<string, unknown> }).agent,
    ).not.toHaveProperty('errand');
  });
});
