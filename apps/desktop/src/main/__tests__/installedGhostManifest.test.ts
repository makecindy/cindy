import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseInstalledGhostManifest,
  readInstalledGhostManifest,
} from '../installedGhostManifest.js';

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

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('installed ghost manifest compatibility', () => {
  it('keeps valid Manual manifests strict and does not strip them', () => {
    const raw = {
      ...manifest(),
      manual: {
        items: [{ dir: 'manual/guide', name: 'guide', description: 'How to use it' }],
      },
    };

    const parsed = parseInstalledGhostManifest(raw);

    expect(parsed).toEqual({ ok: true, manifest: raw, legacyManualIgnored: false });
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
});
