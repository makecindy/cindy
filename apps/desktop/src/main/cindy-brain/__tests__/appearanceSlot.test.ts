import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostAppearanceSlot } from '../appearanceSlot';

const HASH = 'a'.repeat(64);

function ghost(slots: string[] = ['tool', 'appearance']): InstalledGhost {
  return {
    enabled: true,
    dir: '/plugins/skin',
    manifest: {
      schemaVersion: 2,
      id: 'skin',
      name: 'Skin',
      description: 'Skin plugin',
      whenToUse: 'When changing appearance',
      version: '1.0.0',
      author: 'Test',
      kind: 'chip',
      entry: 'main.js',
      slots: slots as never,
      tools: [],
    },
  };
}

function harness(overrides: Partial<ConstructorParameters<typeof GhostAppearanceSlot>[0]> = {}) {
  const save = vi.fn(async () => {});
  const savePreset = vi.fn(async (appearance) => ({
    id: 'preset-1',
    name: appearance.name ?? 'Saved',
    palette: appearance.palette,
    hasBackground: Boolean(appearance.background),
    hasBrandIcon: Boolean(appearance.brand?.icon),
    hasBrandLogo: Boolean(appearance.brand?.logo),
    updatedAt: appearance.updatedAt,
  }));
  const reset = vi.fn(async () => {});
  const broadcast = vi.fn();
  return {
    save,
    savePreset,
    reset,
    broadcast,
    slot: new GhostAppearanceSlot({
      getGhost: () => ghost(),
      getCurrent: async () => null,
      canReadImage: async () => true,
      resolveImage: async () => ({
        url: `cindy-media://blobs/${HASH}.png`,
        mimeType: 'image/png',
        bytes: 1024,
      }),
      validateImage: async () => {},
      removeWhiteLogoBackground: async () => ({
        hash: HASH,
        url: `cindy-media://blobs/${HASH}.png`,
        mimeType: 'image/png',
      }),
      save,
      savePreset,
      saveWithPreset: async (appearance, mediaHashes, ghostId, customized) => {
        await save(appearance, mediaHashes, ghostId, customized);
        return savePreset(appearance, mediaHashes, ghostId);
      },
      listPresets: async () => [],
      activatePreset: async () => null,
      deletePreset: async () => false,
      reset,
      broadcast,
      now: () => 123,
      ...overrides,
    }),
  };
}

describe('GhostAppearanceSlot', () => {
  it('应用固定 palette 和插件名下图片并广播', async () => {
    const h = harness();
    const result = await h.slot.handleRequest('skin', {
      type: 'appearance-request',
      operation: 'apply',
      name: 'Rain',
      palette: 'ocean',
      background: { hash: HASH, focusX: 0.2, focusY: 0.7 },
      dim: 0.3,
      surfaceOpacity: 0.88,
    });
    expect(result.ok).toBe(true);
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        palette: 'ocean',
        background: expect.objectContaining({ focusX: 0.2, focusY: 0.7 }),
        updatedAt: 123,
      }),
      { background: HASH },
      'skin',
      { dim: true, surfaceOpacity: true },
    );
    expect(h.broadcast).toHaveBeenCalledOnce();
    expect(h.savePreset).toHaveBeenCalledOnce();
  });

  it('校验并应用首页头像与 Logo 图片资源', async () => {
    const removeWhiteLogoBackground = vi.fn(async () => ({
      hash: HASH,
      url: `cindy-media://blobs/${HASH}.png`,
      mimeType: 'image/png',
    }));
    const h = harness({ removeWhiteLogoBackground });
    const result = await h.slot.handleRequest('skin', {
      type: 'appearance-request',
      operation: 'apply',
      name: 'Branded',
      palette: 'violet',
      brand: {
        icon: { hash: HASH },
        logo: { hash: HASH, removeWhiteBackground: true },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      appearance: {
        brand: {
          icon: { url: `cindy-media://blobs/${HASH}.png` },
          logo: { url: `cindy-media://blobs/${HASH}.png` },
        },
      },
    });
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: expect.objectContaining({
          icon: expect.any(Object),
          logo: expect.any(Object),
        }),
      }),
      { brandIcon: HASH, brandLogo: HASH },
      'skin',
      { dim: false, surfaceOpacity: false },
    );
    expect(removeWhiteLogoBackground).toHaveBeenCalledWith(HASH);
  });

  it('拒绝未声明 slot、任意 palette、越界参数和不归属图片', async () => {
    expect(
      await harness({ getGhost: () => ghost(['tool']) }).slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'reset',
      }),
    ).toMatchObject({ ok: false });
    expect(
      await harness().slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'apply',
        palette: 'hotpink-custom',
      }),
    ).toMatchObject({ ok: false });
    expect(
      await harness().slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'apply',
        palette: 'rose',
        dim: 1,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await harness({ canReadImage: async () => false }).slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'apply',
        palette: 'rose',
        background: { hash: HASH },
      }),
    ).toMatchObject({ ok: false });
  });

  it('拒绝超长或含控制字符的皮肤名称(超限名字会让持久层拒读整份快照)', async () => {
    expect(
      await harness().slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'apply',
        palette: 'rose',
        name: 'x'.repeat(49),
      }),
    ).toMatchObject({ ok: false });
    const current = {
      palette: 'ocean' as const,
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: 100,
    };
    const h = harness({ getCurrent: async () => current });
    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'save-current',
        name: 'x'.repeat(49),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'save-current',
        name: 'bad\u0007name',
      }),
    ).toMatchObject({ ok: false });
    expect(h.savePreset).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('reset 清理持久状态并广播 null', async () => {
    const h = harness();
    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'reset',
      }),
    ).toEqual({ ok: true, appearance: null });
    expect(h.reset).toHaveBeenCalledOnce();
    expect(h.broadcast).toHaveBeenCalledWith(null);
  });

  it('微调头像时保留当前背景、Logo、配色和透明度', async () => {
    const current = {
      palette: 'ocean' as const,
      name: 'Furina',
      background: {
        url: `cindy-media://blobs/${'b'.repeat(64)}.png`,
        focusX: 0.2,
        focusY: 0.4,
      },
      brand: {
        icon: { url: `cindy-media://blobs/${'c'.repeat(64)}.png` },
        logo: { url: `cindy-media://blobs/${'d'.repeat(64)}.png` },
      },
      dim: 0.35,
      surfaceOpacity: 0.74,
      updatedAt: 100,
    };
    const h = harness({ getCurrent: async () => current });
    const result = await h.slot.handleRequest('skin', {
      type: 'appearance-request',
      operation: 'patch',
      brand: { icon: { hash: HASH } },
    });
    expect(result).toMatchObject({
      ok: true,
      appearance: {
        palette: 'ocean',
        name: 'Furina',
        background: current.background,
        brand: {
          icon: { url: `cindy-media://blobs/${HASH}.png` },
          logo: current.brand.logo,
        },
        dim: 0.35,
        surfaceOpacity: 0.74,
      },
    });
    expect(h.save).toHaveBeenCalledWith(
      expect.any(Object),
      {
        background: 'b'.repeat(64),
        brandIcon: HASH,
        brandLogo: 'd'.repeat(64),
      },
      'skin',
      { dim: true, surfaceOpacity: true },
    );
    expect(h.savePreset).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Furina' }),
      expect.any(Object),
      'skin',
    );
  });

  it('列出、切换和删除已保存皮肤', async () => {
    const saved = {
      palette: 'forest' as const,
      name: 'Forest',
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: 456,
    };
    const preset = {
      id: 'preset-forest',
      name: 'Forest',
      palette: 'forest' as const,
      hasBackground: false,
      hasBrandIcon: false,
      hasBrandLogo: false,
      updatedAt: 456,
    };
    const activatePreset = vi.fn(async () => saved);
    const deletePreset = vi.fn(async () => true);
    const h = harness({
      getCurrent: async () => saved,
      listPresets: async () => [preset],
      activatePreset,
      deletePreset,
    });

    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'list-presets',
      }),
    ).toEqual({ ok: true, appearance: saved, presets: [preset] });
    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'activate-preset',
        preset: 'Forest',
      }),
    ).toEqual({ ok: true, appearance: saved });
    expect(activatePreset).toHaveBeenCalledWith('Forest');
    expect(h.broadcast).toHaveBeenCalledWith(saved);
    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'delete-preset',
        preset: 'Forest',
      }),
    ).toEqual({ ok: true, appearance: saved, presets: [preset] });
    expect(deletePreset).toHaveBeenCalledWith('Forest');
  });

  it('可把当前未命名皮肤另存为预设', async () => {
    const current = {
      palette: 'ocean' as const,
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: 100,
    };
    const h = harness({ getCurrent: async () => current });
    const result = await h.slot.handleRequest('skin', {
      type: 'appearance-request',
      operation: 'save-current',
      name: 'Furina',
    });
    expect(result).toMatchObject({
      ok: true,
      appearance: { name: 'Furina', updatedAt: 123 },
      preset: { name: 'Furina' },
    });
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.savePreset).toHaveBeenCalledOnce();
  });

  it('升级后首次覆盖前自动收存旧版当前命名皮肤', async () => {
    const legacy = {
      palette: 'ocean' as const,
      name: 'Furina',
      background: {
        url: `cindy-media://blobs/${'b'.repeat(64)}.png`,
        focusX: 0.5,
        focusY: 0.5,
      },
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: 100,
    };
    const h = harness({ getCurrent: async () => legacy });
    await h.slot.handleRequest('skin', {
      type: 'appearance-request',
      operation: 'apply',
      name: 'Forest',
      palette: 'forest',
    });
    expect(h.savePreset).toHaveBeenNthCalledWith(
      1,
      legacy,
      { background: 'b'.repeat(64), brandIcon: undefined, brandLogo: undefined },
    );
    expect(h.savePreset).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'Forest' }),
      {},
      'skin',
    );
  });
});
