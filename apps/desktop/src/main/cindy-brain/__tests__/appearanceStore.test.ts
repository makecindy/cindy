import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '',
  refs: new Map<string, Set<string>>(),
}));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(mocks.root, ...parts),
}));

vi.mock('../../cindy-media/ledger.js', () => {
  const key = (refKind: string, refId: string) => `${refKind}:${refId}`;
  return {
    addRef: vi.fn(async ({ hash, refKind, refId }) => {
      const refKey = key(refKind, refId);
      const hashes = mocks.refs.get(refKey) ?? new Set<string>();
      hashes.add(hash);
      mocks.refs.set(refKey, hashes);
    }),
    hasRef: vi.fn(async ({ hash, refKind, refId }) =>
      Boolean(mocks.refs.get(key(refKind, refId))?.has(hash)),
    ),
    pinBlob: vi.fn(async () => {}),
    getBlobInfo: vi.fn(async () => ({ ext: '.png', mimeType: 'image/png', bytes: 1024 })),
    removeRefs: vi.fn(async ({ refKind, refId }) => {
      mocks.refs.delete(key(refKind, refId));
    }),
    removeRefsExceptHash: vi.fn(async ({ refKind, refId, keepHash }) => {
      const refKey = key(refKind, refId);
      const hashes = mocks.refs.get(refKey);
      if (!hashes) return;
      mocks.refs.set(refKey, new Set([...hashes].filter((hash) => hash === keepHash)));
    }),
  };
});

import {
  activateGhostAppearancePreset,
  deleteGhostAppearancePreset,
  listGhostAppearancePresets,
  readGhostAppearance,
  resetGhostAppearance,
  saveGhostAppearance,
  saveGhostAppearancePreset,
} from '../appearanceStore';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function appearance(name: string, hash = HASH_A) {
  return {
    name,
    palette: 'ocean' as const,
    background: {
      url: `cindy-media://blobs/${hash}.png`,
      focusX: 0.5,
      focusY: 0.5,
    },
    dim: 0.28,
    surfaceOpacity: 0.82,
    updatedAt: Date.now(),
  };
}

describe('appearance preset store', () => {
  beforeEach(() => {
    mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-appearance-store-'));
    mocks.refs.clear();
  });

  afterEach(() => {
    fs.rmSync(mocks.root, { recursive: true, force: true });
  });

  it('保存多套皮肤并可在覆盖当前外观后切回', async () => {
    const furina = appearance('Furina');
    const forest = { ...appearance('Forest', HASH_B), palette: 'forest' as const };
    await saveGhostAppearance(furina, { background: HASH_A }, 'skin');
    await saveGhostAppearancePreset(furina, { background: HASH_A }, 'skin');
    await saveGhostAppearance(forest, { background: HASH_B }, 'skin');
    await saveGhostAppearancePreset(forest, { background: HASH_B }, 'skin');

    expect((await listGhostAppearancePresets()).map((preset) => preset.name).sort()).toEqual([
      'Forest',
      'Furina',
    ]);
    expect((await readGhostAppearance())?.name).toBe('Forest');

    const restored = await activateGhostAppearancePreset('furina');
    expect(restored?.name).toBe('Furina');
    expect((await readGhostAppearance())?.background?.url).toContain(HASH_A);
  });

  it('更新同名皮肤而不重复新增，并保留预设媒体直到删除', async () => {
    await saveGhostAppearancePreset(appearance('Furina'), { background: HASH_A }, 'skin');
    const first = (await listGhostAppearancePresets())[0];
    await saveGhostAppearancePreset(appearance('Ｆｕｒｉｎａ', HASH_B), { background: HASH_B }, 'skin');

    const presets = await listGhostAppearancePresets();
    expect(presets).toHaveLength(1);
    expect(presets[0].id).toBe(first.id);
    expect([...mocks.refs.get(`skin-preset:${first.id}:background`)!]).toEqual([HASH_B]);

    await resetGhostAppearance();
    expect(mocks.refs.get(`skin-preset:${first.id}:background`)?.has(HASH_B)).toBe(true);
    expect(await deleteGhostAppearancePreset(first.id)).toBe(true);
    expect(mocks.refs.has(`skin-preset:${first.id}:background`)).toBe(false);
  });

  it('单条损坏的预设只被剔除,不清空整库', async () => {
    await saveGhostAppearancePreset(appearance('Furina'), { background: HASH_A }, 'skin');
    const file = path.join(mocks.root, 'appearance-skins.v1.json');
    const library = JSON.parse(fs.readFileSync(file, 'utf8')) as { presets: unknown[] };
    library.presets.push({ id: 'corrupt entry' });
    fs.writeFileSync(file, JSON.stringify(library));

    expect((await listGhostAppearancePresets()).map((preset) => preset.name)).toEqual(['Furina']);
  });

  it('写入侧拒绝会让持久层拒读的皮肤名称', async () => {
    await expect(
      saveGhostAppearancePreset(appearance('x'.repeat(49)), { background: HASH_A }, 'skin'),
    ).rejects.toThrow('1–48');
    expect(await listGhostAppearancePresets()).toEqual([]);
  });
});
