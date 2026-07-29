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
    hasGhostOwnedRef: vi.fn(async ({ hash, refKind, refId }) =>
      Boolean(mocks.refs.get(key(refKind, refId))?.has(hash)),
    ),
    pinBlob: vi.fn(async () => {}),
    getBlobInfo: vi.fn(async () => ({ ext: '.png', mimeType: 'image/png', bytes: 1024 })),
    removeRefs: vi.fn(async ({ refKind, refId }) => {
      mocks.refs.delete(key(refKind, refId));
    }),
    removeGhostOwnedRefs: vi.fn(async () => 0),
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
  cancelGhostAppearanceRemoval,
  deleteGhostAppearancePreset,
  listGhostAppearancePresets,
  prepareGhostAppearanceRemoval,
  readGhostAppearance,
  recoverGhostAppearanceTransaction,
  removeGhostAppearanceData,
  resetGhostAppearance,
  saveGhostAppearance,
  saveGhostAppearancePreset,
  saveGhostAppearanceWithPreset,
} from '../appearanceStore';
import {
  hasRef,
  removeGhostOwnedRefs,
  removeRefs,
  removeRefsExceptHash,
} from '../../cindy-media/ledger';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function appearance(name: string, hash = HASH_A) {
  return {
    name,
    palette: 'ocean' as const,
    sourceGhostId: 'skin',
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
    vi.clearAllMocks();
    mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-appearance-store-'));
    mocks.refs.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    await saveGhostAppearancePreset(
      appearance('Ｆｕｒｉｎａ', HASH_B),
      { background: HASH_B },
      'skin',
    );

    const presets = await listGhostAppearancePresets();
    expect(presets).toHaveLength(1);
    expect(presets[0].id).toBe(first.id);
    expect([...mocks.refs.get(`skin-preset:${first.id}:background`)!]).toEqual([HASH_B]);

    await resetGhostAppearance();
    expect(mocks.refs.get(`skin-preset:${first.id}:background`)?.has(HASH_B)).toBe(true);
    expect(await deleteGhostAppearancePreset(first.id)).toBe(true);
    expect(mocks.refs.has(`skin-preset:${first.id}:background`)).toBe(false);
  });

  it('重置引用清理失败时保留可重试事务并隐藏旧皮肤', async () => {
    await saveGhostAppearance(appearance('Furina'), { background: HASH_A }, 'skin');
    vi.mocked(removeRefs).mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(resetGhostAppearance()).rejects.toThrow('ledger unavailable');

    expect(await readGhostAppearance()).toBeNull();
    expect(mocks.refs.get('skin-background:active')?.has(HASH_A)).toBe(true);
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(true);

    await expect(recoverGhostAppearanceTransaction()).resolves.toBeUndefined();
    expect(await readGhostAppearance()).toBeNull();
    expect(mocks.refs.has('skin-background:active')).toBe(false);
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(false);
  });

  it('预设引用清理失败时保留可重试的逻辑删除事务', async () => {
    await saveGhostAppearancePreset(appearance('Furina'), { background: HASH_A }, 'skin');
    const preset = (await listGhostAppearancePresets())[0];
    vi.mocked(removeRefs).mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(deleteGhostAppearancePreset(preset.id)).rejects.toThrow('ledger unavailable');

    expect((await listGhostAppearancePresets()).map((item) => item.id)).toEqual([preset.id]);
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(true);

    await expect(deleteGhostAppearancePreset(preset.id)).resolves.toBe(true);
    expect(await listGhostAppearancePresets()).toEqual([]);
    expect(mocks.refs.has(`skin-preset:${preset.id}:background`)).toBe(false);
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(false);
  });

  it('活动皮肤文件提交失败时恢复旧媒体引用', async () => {
    await saveGhostAppearance(appearance('Before'), { background: HASH_A }, 'skin');
    const rename = fs.promises.rename.bind(fs.promises);
    let renameCount = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      renameCount += 1;
      // marker 已落盘、媒体引用已建立后，让活动外观文件提交失败。
      if (renameCount === 2) throw new Error('disk full');
      return rename(...args);
    });

    await expect(
      saveGhostAppearance(appearance('After', HASH_B), { background: HASH_B }, 'skin'),
    ).rejects.toThrow('disk full');

    expect((await readGhostAppearance())?.name).toBe('Before');
    expect([...mocks.refs.get('skin-background:active')!]).toEqual([HASH_A]);
  });

  it('活动皮肤写盘与即时补偿都失败时保留事务供后续恢复', async () => {
    await saveGhostAppearance(appearance('Before'), { background: HASH_A }, 'skin');
    const rename = fs.promises.rename.bind(fs.promises);
    let renameCount = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error('disk full');
      return rename(...args);
    });
    vi.mocked(removeRefsExceptHash)
      .mockRejectedValueOnce(new Error('ledger unavailable'))
      .mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(
      saveGhostAppearance(appearance('After', HASH_B), { background: HASH_B }, 'skin'),
    ).rejects.toThrow('自动恢复未完成');

    expect((await readGhostAppearance())?.name).toBe('Before');
    expect(mocks.refs.get('skin-background:active')).toEqual(new Set([HASH_A, HASH_B]));
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(true);

    await expect(recoverGhostAppearanceTransaction()).resolves.toBeUndefined();
    expect([...mocks.refs.get('skin-background:active')!]).toEqual([HASH_A]);
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(false);
  });

  it('预设库文件提交失败时恢复旧媒体引用', async () => {
    await saveGhostAppearancePreset(appearance('Before'), { background: HASH_A }, 'skin');
    const preset = (await listGhostAppearancePresets())[0];
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk full'));

    await expect(
      saveGhostAppearancePreset(appearance('Before', HASH_B), { background: HASH_B }, 'skin'),
    ).rejects.toThrow('disk full');

    expect((await listGhostAppearancePresets())[0]).toMatchObject({
      id: preset.id,
      name: 'Before',
    });
    expect([...mocks.refs.get(`skin-preset:${preset.id}:background`)!]).toEqual([HASH_A]);
  });

  it('预设写盘失败且旧引用确认失败时保留现有引用并报告恢复失败', async () => {
    await saveGhostAppearancePreset(appearance('Before'), { background: HASH_A }, 'skin');
    const preset = (await listGhostAppearancePresets())[0];
    vi.mocked(hasRef)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('ledger unavailable'));
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk full'));

    await expect(
      saveGhostAppearancePreset(appearance('Before', HASH_B), { background: HASH_B }, 'skin'),
    ).rejects.toThrow('自动恢复未完成');

    expect((await listGhostAppearancePresets())[0]).toMatchObject({
      id: preset.id,
      name: 'Before',
    });
    expect(mocks.refs.get(`skin-preset:${preset.id}:background`)?.has(HASH_A)).toBe(true);
    expect(mocks.refs.get(`skin-preset:${preset.id}:background`)?.has(HASH_B)).toBe(true);
  });

  it('保存命名皮肤的活动文件失败时恢复旧皮肤归属', async () => {
    await saveGhostAppearance(
      { ...appearance('Before'), sourceGhostId: 'other' },
      { background: HASH_A },
      'other',
    );
    const rename = fs.promises.rename.bind(fs.promises);
    let renameCount = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      renameCount += 1;
      // 事务标记和预设已写入后，让活动文件提交失败；物理回滚可完成。
      if (renameCount === 3) throw new Error('disk full');
      return rename(...args);
    });

    await expect(
      saveGhostAppearanceWithPreset(
        appearance('After', HASH_B),
        { background: HASH_B },
        'skin',
        { dim: true, surfaceOpacity: true },
      ),
    ).rejects.toThrow('disk full');

    expect(await readGhostAppearance()).toMatchObject({
      name: 'Before',
      sourceGhostId: 'other',
    });
    expect(await listGhostAppearancePresets()).toEqual([]);
    expect([...mocks.refs.get('skin-background:active')!]).toEqual([HASH_A]);
  });

  it('预设库回滚写入也失败时保留磁盘现存预设的媒体引用', async () => {
    await saveGhostAppearance(appearance('Before'), { background: HASH_A }, 'skin');
    await saveGhostAppearancePreset(appearance('Before'), { background: HASH_A }, 'skin');
    const rename = fs.promises.rename.bind(fs.promises);
    let renameCount = 0;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      renameCount += 1;
      // 事务标记和新预设已提交后，让活动文件写入及预设库物理回滚失败。
      if (renameCount === 3 || renameCount === 5) throw new Error('disk full');
      return rename(...args);
    });

    await expect(
      saveGhostAppearanceWithPreset(
        appearance('After', HASH_B),
        { background: HASH_B },
        'skin',
        { dim: true, surfaceOpacity: true },
      ),
    ).rejects.toThrow('自动恢复未完成；预设可能已保存');

    // 事务文件仍在时，读取侧只暴露保存前的逻辑快照。
    expect((await listGhostAppearancePresets()).map((preset) => preset.name)).toEqual(['Before']);
    expect((await readGhostAppearance())?.name).toBe('Before');
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(true);

    // 磁盘恢复后，下一次 mutation 先收敛未完成事务，再执行新操作。
    renameSpy.mockRestore();
    await saveGhostAppearancePreset(appearance('Later'), { background: HASH_A }, 'skin');
    expect((await listGhostAppearancePresets()).map((preset) => preset.name).sort()).toEqual([
      'Before',
      'Later',
    ]);
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(false);
  });

  it('单条损坏的预设只被剔除,不清空整库', async () => {
    await saveGhostAppearancePreset(appearance('Furina'), { background: HASH_A }, 'skin');
    const file = path.join(mocks.root, 'appearance-skins.v1.json');
    const library = JSON.parse(fs.readFileSync(file, 'utf8')) as { presets: unknown[] };
    library.presets.push({ id: 'corrupt entry' });
    fs.writeFileSync(file, JSON.stringify(library));

    expect((await listGhostAppearancePresets()).map((preset) => preset.name)).toEqual(['Furina']);
  });

  it('持久层不会重新放行协议拒绝的 GIF 资源', async () => {
    fs.writeFileSync(
      path.join(mocks.root, 'appearance-skin.v1.json'),
      JSON.stringify({
        ...appearance('Animated'),
        background: {
          url: `cindy-media://blobs/${HASH_A}.gif`,
          focusX: 0.5,
          focusY: 0.5,
        },
      }),
    );
    expect(await readGhostAppearance()).toBeNull();
  });

  it('写入侧拒绝会让持久层拒读的皮肤名称', async () => {
    await expect(
      saveGhostAppearancePreset(appearance('x'.repeat(49)), { background: HASH_A }, 'skin'),
    ).rejects.toThrow('1–48');
    expect(await listGhostAppearancePresets()).toEqual([]);
  });

  it('插件范围的列表、激活和删除不能越过预设归属', async () => {
    await saveGhostAppearancePreset(appearance('Mine'), { background: HASH_A }, 'skin');
    await saveGhostAppearancePreset(
      { ...appearance('Other', HASH_B), sourceGhostId: 'other' },
      { background: HASH_B },
      'other',
    );

    expect((await listGhostAppearancePresets('skin')).map((preset) => preset.name)).toEqual([
      'Mine',
    ]);
    expect(await activateGhostAppearancePreset('Other', 'skin')).toBeNull();
    expect(await deleteGhostAppearancePreset('Other', 'skin')).toBe(false);
    expect((await listGhostAppearancePresets()).map((preset) => preset.name).sort()).toEqual([
      'Mine',
      'Other',
    ]);
  });

  it('卸载只清理所属插件的活动皮肤、预设与媒体引用', async () => {
    await saveGhostAppearance(appearance('Mine'), { background: HASH_A }, 'skin');
    await saveGhostAppearancePreset(appearance('Mine'), { background: HASH_A }, 'skin');
    await saveGhostAppearancePreset(
      { ...appearance('Other', HASH_B), sourceGhostId: 'other' },
      { background: HASH_B },
      'other',
    );
    const [mine] = await listGhostAppearancePresets('skin');
    const [other] = await listGhostAppearancePresets('other');

    await expect(removeGhostAppearanceData('skin')).resolves.toEqual({
      activeRemoved: true,
      presetsRemoved: 1,
    });

    expect(await readGhostAppearance()).toBeNull();
    expect(await listGhostAppearancePresets()).toEqual([
      expect.objectContaining({ id: other.id, sourceGhostId: 'other' }),
    ]);
    expect(mocks.refs.has('skin-background:active')).toBe(false);
    expect(mocks.refs.has(`skin-preset:${mine.id}:background`)).toBe(false);
    expect(mocks.refs.get(`skin-preset:${other.id}:background`)?.has(HASH_B)).toBe(true);
  });

  it('卸载按插件归属扫除预设库外的孤儿媒体引用', async () => {
    await removeGhostAppearanceData('skin');

    expect(removeGhostOwnedRefs).toHaveBeenCalledWith({
      ghostId: 'skin',
      refKinds: ['skin-preset'],
    });
  });

  it('卸载引用清理失败时隐藏旧归属，并在安装前恢复清理事务', async () => {
    await saveGhostAppearance(appearance('Mine'), { background: HASH_A }, 'skin');
    await saveGhostAppearancePreset(appearance('Mine'), { background: HASH_A }, 'skin');
    const [mine] = await listGhostAppearancePresets('skin');
    vi.mocked(removeRefs).mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(removeGhostAppearanceData('skin')).rejects.toThrow('ledger unavailable');

    expect(await readGhostAppearance()).toBeNull();
    expect(await listGhostAppearancePresets('skin')).toEqual([]);
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(true);

    await expect(recoverGhostAppearanceTransaction()).resolves.toBeUndefined();
    expect(mocks.refs.has('skin-background:active')).toBe(false);
    expect(mocks.refs.has(`skin-preset:${mine.id}:background`)).toBe(false);
    expect(fs.existsSync(path.join(mocks.root, 'appearance-transaction.v1.json'))).toBe(false);
  });

  it('卸载提交前持久化清理意图，manager 拒绝时可撤销且不改原数据', async () => {
    await saveGhostAppearance(appearance('Mine'), { background: HASH_A }, 'skin');
    await saveGhostAppearancePreset(appearance('Mine'), { background: HASH_A }, 'skin');

    await expect(prepareGhostAppearanceRemoval('skin')).resolves.toEqual({
      activeRemoved: true,
      presetsRemoved: 1,
    });
    expect(await readGhostAppearance()).toBeNull();
    expect(await listGhostAppearancePresets('skin')).toEqual([]);

    await cancelGhostAppearanceRemoval('skin');
    expect(await readGhostAppearance()).toMatchObject({ name: 'Mine', sourceGhostId: 'skin' });
    expect(await listGhostAppearancePresets('skin')).toHaveLength(1);
    expect(mocks.refs.get('skin-background:active')?.has(HASH_A)).toBe(true);
  });

  it('每插件预设数量独立计数，不能占满其他插件的额度', async () => {
    const withoutMedia = (name: string, sourceGhostId: string) => ({
      name,
      palette: 'graphite' as const,
      sourceGhostId,
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: Date.now(),
    });
    for (let index = 0; index < 50; index += 1) {
      await saveGhostAppearancePreset(withoutMedia(`Mine ${index}`, 'skin'), {}, 'skin');
    }
    await expect(
      saveGhostAppearancePreset(withoutMedia('Mine 51', 'skin'), {}, 'skin'),
    ).rejects.toThrow('每个插件最多保存 50 套皮肤');

    await expect(
      saveGhostAppearancePreset(withoutMedia('Other 1', 'other'), {}, 'other'),
    ).resolves.toMatchObject({ name: 'Other 1', sourceGhostId: 'other' });
    expect(await listGhostAppearancePresets('other')).toHaveLength(1);
  });
});
