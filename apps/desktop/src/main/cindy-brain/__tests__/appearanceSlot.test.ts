import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostAppearanceSlot, type AppearanceSlotDeps } from '../appearanceSlot';

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
  const save = vi.fn<AppearanceSlotDeps['save']>(async () => {});
  const savePreset = vi.fn<AppearanceSlotDeps['savePreset']>(async (appearance) => ({
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

  it('持久化恢复也失败时提示刷新确认可能已保存的预设', async () => {
    const recoveryError = new Error(
      '皮肤保存失败且自动恢复未完成；预设可能已保存，请刷新外观列表确认',
    );
    recoveryError.name = 'GhostAppearanceRecoveryError';
    const h = harness({
      saveWithPreset: async () => {
        throw recoveryError;
      },
    });

    await expect(
      h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'apply',
        name: 'Rain',
        palette: 'ocean',
      }),
    ).resolves.toEqual({
      ok: false,
      message: recoveryError.message,
    });
    expect(h.broadcast).not.toHaveBeenCalled();
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
      sourceGhostId: 'skin',
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

  it('reset 不能停用其他插件或无归属的活动皮肤', async () => {
    for (const sourceGhostId of ['other-plugin', undefined]) {
      const h = harness({
        getCurrent: async () => ({
          palette: 'ocean' as const,
          ...(sourceGhostId ? { sourceGhostId } : {}),
          dim: 0.28,
          surfaceOpacity: 0.82,
          updatedAt: 100,
        }),
      });
      await expect(
        h.slot.handleRequest('skin', {
          type: 'appearance-request',
          operation: 'reset',
        }),
      ).resolves.toMatchObject({ ok: false });
      expect(h.reset).not.toHaveBeenCalled();
      expect(h.broadcast).not.toHaveBeenCalled();
    }
  });

  it('微调头像时保留当前背景、Logo、配色和透明度', async () => {
    const current = {
      palette: 'ocean' as const,
      sourceGhostId: 'skin',
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
      sourceGhostId: 'skin',
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
    expect(activatePreset).toHaveBeenCalledWith('Forest', 'skin');
    expect(h.broadcast).toHaveBeenCalledWith(saved);
    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'delete-preset',
        preset: 'Forest',
      }),
    ).toEqual({ ok: true, appearance: saved, presets: [preset] });
    expect(deletePreset).toHaveBeenCalledWith('Forest', 'skin');
    expect(h.broadcast).toHaveBeenLastCalledWith(saved);
  });

  it('可把当前未命名皮肤另存为预设', async () => {
    const current = {
      palette: 'ocean' as const,
      sourceGhostId: 'skin',
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

  it('另存当前皮肤时隐藏存储路径但保留稳定的配额提示', async () => {
    const current = {
      name: 'Current',
      palette: 'ocean' as const,
      sourceGhostId: 'skin',
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: 100,
    };
    const storageFailure = harness({
      getCurrent: async () => current,
      saveWithPreset: async () => {
        throw new Error('EACCES: /Users/private/appearance-skins.v1.json');
      },
    });
    await expect(
      storageFailure.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'save-current',
      }),
    ).resolves.toEqual({ ok: false, message: '保存皮肤失败，请稍后重试' });

    const quotaFailure = harness({
      getCurrent: async () => current,
      saveWithPreset: async () => {
        throw new Error('每个插件最多保存 50 套皮肤');
      },
    });
    await expect(
      quotaFailure.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'save-current',
      }),
    ).resolves.toEqual({ ok: false, message: '每个插件最多保存 50 套皮肤' });
  });

  it('图片校验与去背景失败时不向插件泄露本机路径', async () => {
    const validation = harness({
      validateImage: async () => {
        throw new Error('ENOENT: /Users/private/cindy-media/blob.png');
      },
    });
    await expect(
      validation.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'apply',
        palette: 'rose',
        background: { hash: HASH },
      }),
    ).resolves.toEqual({ ok: false, message: '背景图片无效，请重新选择' });

    const logo = harness({
      removeWhiteLogoBackground: async () => {
        throw new Error('EACCES: /Users/private/cindy-media/logo.png');
      },
    });
    await expect(
      logo.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'apply',
        palette: 'rose',
        brand: {
          logo: { hash: HASH, removeWhiteBackground: true },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'Logo 去背景失败，请换用纯白底文字图片',
    });
  });

  it('不能读取、微调或另存其他插件的活动皮肤', async () => {
    const current = {
      palette: 'ocean' as const,
      sourceGhostId: 'other-plugin',
      name: 'Other',
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: 100,
    };
    const h = harness({
      getCurrent: async () => current,
      listPresets: async () => [],
    });
    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'list-presets',
      }),
    ).toEqual({ ok: true, appearance: null, presets: [] });
    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'patch',
        palette: 'forest',
      }),
    ).toMatchObject({ ok: false });
    expect(
      await h.slot.handleRequest('skin', {
        type: 'appearance-request',
        operation: 'save-current',
        name: 'Copied',
      }),
    ).toMatchObject({ ok: false });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.savePreset).not.toHaveBeenCalled();
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
    expect(h.savePreset).toHaveBeenNthCalledWith(1, legacy, {
      background: 'b'.repeat(64),
      brandIcon: undefined,
      brandLogo: undefined,
    });
    expect(h.savePreset).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'Forest' }),
      {},
      'skin',
    );
  });

  it('首次 apply 不会把其他插件的活动皮肤迁成无归属预设', async () => {
    const other = {
      palette: 'ocean' as const,
      sourceGhostId: 'other-plugin',
      name: 'Other',
      dim: 0.28,
      surfaceOpacity: 0.82,
      updatedAt: 100,
    };
    const h = harness({ getCurrent: async () => other });
    await h.slot.handleRequest('skin', {
      type: 'appearance-request',
      operation: 'apply',
      name: 'Mine',
      palette: 'forest',
    });

    expect(h.savePreset).toHaveBeenCalledOnce();
    expect(h.savePreset).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Mine', sourceGhostId: 'skin' }),
      {},
      'skin',
    );
  });
});
