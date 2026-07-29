/**
 * appearanceSlot.ts — 插件请求修改 Cindy 外观的唯一授权边界。
 *
 * 插件只能选宿主预置 palette，并交付自己名下的图片指纹。CSS、DOM、URL、
 * 颜色值和本机路径都不进入协议。
 */
import {
  GHOST_APPEARANCE_PALETTES,
  GHOST_APPEARANCE_DEFAULT_DIM,
  GHOST_APPEARANCE_DEFAULT_SURFACE_OPACITY,
  type GhostAppearancePalette,
  type GhostAppearancePresetSummary,
  type GhostAppearanceSnapshot,
  type GhostPipeAppearanceResult,
  type InstalledGhost,
} from '../../shared/ghost.js';

const HASH_RE = /^[0-9a-f]{64}$/;
const MEDIA_URL_HASH_RE = /[0-9a-f]{64}/;
const PALETTES = new Set<string>(GHOST_APPEARANCE_PALETTES);
const MAX_SKIN_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_STATIC_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** 与 appearanceStore 持久层的 isSnapshot 同限:超限名字会让整份快照在重启后读不回来。 */
const SKIN_NAME_MAX_CHARS = 48;

/** 皮肤名统一校验:所有会被持久化的名字(apply / patch / save-current)必须走这里。 */
function normalizeSkinName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > SKIN_NAME_MAX_CHARS ||
    // eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function hashFromMediaUrl(url: string | undefined): string | undefined {
  return url?.match(MEDIA_URL_HASH_RE)?.[0];
}

export interface AppearanceSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  getCurrent(): Promise<GhostAppearanceSnapshot | null>;
  canReadImage(hash: string, ghostId: string): Promise<boolean>;
  resolveImage(hash: string): Promise<{ url: string; mimeType: string; bytes: number } | null>;
  validateImage(hash: string): Promise<void>;
  removeWhiteLogoBackground(hash: string): Promise<{ hash: string; url: string; mimeType: string }>;
  save(
    appearance: GhostAppearanceSnapshot,
    mediaHashes: {
      background?: string;
      brandIcon?: string;
      brandLogo?: string;
    },
    ghostId: string,
    customized: { dim: boolean; surfaceOpacity: boolean },
  ): Promise<void>;
  savePreset(
    appearance: GhostAppearanceSnapshot,
    mediaHashes: {
      background?: string;
      brandIcon?: string;
      brandLogo?: string;
    },
    ghostId?: string,
  ): Promise<GhostAppearancePresetSummary>;
  saveWithPreset(
    appearance: GhostAppearanceSnapshot,
    mediaHashes: {
      background?: string;
      brandIcon?: string;
      brandLogo?: string;
    },
    ghostId: string,
    customized: { dim: boolean; surfaceOpacity: boolean },
  ): Promise<GhostAppearancePresetSummary>;
  listPresets(ghostId: string): Promise<GhostAppearancePresetSummary[]>;
  activatePreset(preset: string, ghostId: string): Promise<GhostAppearanceSnapshot | null>;
  deletePreset(preset: string, ghostId: string): Promise<boolean>;
  reset(): Promise<void>;
  broadcast(appearance: GhostAppearanceSnapshot | null): void;
  now?: () => number;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}

function finiteInRange(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

export class GhostAppearanceSlot {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AppearanceSlotDeps) {}

  async handleRequest(ghostId: string, raw: unknown): Promise<GhostPipeAppearanceResult> {
    const run = this.mutationTail.then(() => this.handleRequestUnsafe(ghostId, raw));
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async handleRequestUnsafe(
    ghostId: string,
    raw: unknown,
  ): Promise<GhostPipeAppearanceResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('appearance')) {
      return { ok: false, message: '插件未声明或未启用 appearance 能力' };
    }
    if (!raw || typeof raw !== 'object') return { ok: false, message: '外观请求格式不正确' };
    const request = raw as Record<string, unknown>;
    if (request.type !== 'appearance-request') {
      return { ok: false, message: '外观请求类型不正确' };
    }
    const presetKey = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
    };
    if (request.operation === 'list-presets') {
      try {
        const current = await this.deps.getCurrent();
        return {
          ok: true,
          appearance: current?.sourceGhostId === ghostId ? current : null,
          presets: await this.deps.listPresets(ghostId),
        };
      } catch {
        return { ok: false, message: '皮肤库暂时不可用' };
      }
    }
    if (request.operation === 'activate-preset') {
      const preset = presetKey(request.preset);
      if (!preset) return { ok: false, message: '请选择要切换的皮肤' };
      try {
        const appearance = await this.deps.activatePreset(preset, ghostId);
        if (!appearance) return { ok: false, message: `没有找到皮肤「${preset}」` };
        this.deps.broadcast(appearance);
        return { ok: true, appearance };
      } catch (error) {
        this.deps.log?.warn('ghost appearance preset activation failed', {
          ghostId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, message: '切换皮肤失败，请稍后重试' };
      }
    }
    if (request.operation === 'delete-preset') {
      const preset = presetKey(request.preset);
      if (!preset) return { ok: false, message: '请选择要删除的皮肤' };
      try {
        if (!(await this.deps.deletePreset(preset, ghostId))) {
          return { ok: false, message: `没有找到皮肤「${preset}」` };
        }
        const current = await this.deps.getCurrent();
        this.deps.broadcast(current);
        return {
          ok: true,
          appearance: current?.sourceGhostId === ghostId ? current : null,
          presets: await this.deps.listPresets(ghostId),
        };
      } catch (error) {
        this.deps.log?.warn('ghost appearance preset deletion failed', {
          ghostId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, message: '删除皮肤失败，请稍后重试' };
      }
    }
    if (request.operation === 'save-current') {
      let current: GhostAppearanceSnapshot | null;
      try {
        current = await this.deps.getCurrent();
      } catch {
        return { ok: false, message: '皮肤库暂时不可用' };
      }
      if (!current) return { ok: false, message: '当前没有可保存的皮肤' };
      if (current.sourceGhostId !== ghostId) {
        return { ok: false, message: '当前皮肤不属于此插件，不能另存或修改' };
      }
      let requestedName = current.name;
      if (request.name !== undefined) {
        const normalized = normalizeSkinName(request.name);
        if (!normalized) return { ok: false, message: '皮肤名称须为 1–48 个可见字符' };
        requestedName = normalized;
      }
      if (!requestedName) return { ok: false, message: '请给当前皮肤取一个名字' };
      const appearance = {
        ...current,
        name: requestedName,
        updatedAt: (this.deps.now ?? Date.now)(),
      };
      const mediaHashes = {
        background: hashFromMediaUrl(appearance.background?.url),
        brandIcon: hashFromMediaUrl(appearance.brand?.icon?.url),
        brandLogo: hashFromMediaUrl(appearance.brand?.logo?.url),
      };
      try {
        const preset = await this.deps.saveWithPreset(appearance, mediaHashes, ghostId, {
          dim: true,
          surfaceOpacity: true,
        });
        this.deps.broadcast(appearance);
        return { ok: true, appearance, preset };
      } catch (error) {
        this.deps.log?.warn('ghost appearance current preset save failed', {
          ghostId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          message: error instanceof Error && error.message ? error.message : '保存皮肤失败',
        };
      }
    }
    if (request.operation === 'reset') {
      try {
        const current = await this.deps.getCurrent();
        if (current && current.sourceGhostId !== ghostId) {
          return { ok: false, message: '当前皮肤由其他插件提供，不能从此插件停用' };
        }
        await this.deps.reset();
      } catch (error) {
        this.deps.log?.warn('ghost appearance reset failed', {
          ghostId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, message: '外观服务暂时不可用' };
      }
      this.deps.broadcast(null);
      return { ok: true, appearance: null };
    }
    const patching = request.operation === 'patch';
    if (request.operation !== 'apply' && !patching) {
      return { ok: false, message: '外观请求操作不正确' };
    }
    if (
      patching &&
      !['name', 'palette', 'background', 'brand', 'dim', 'surfaceOpacity'].some(
        (key) => request[key] !== undefined,
      )
    ) {
      return { ok: false, message: '请至少指定一项要微调的外观内容' };
    }
    if (!patching) {
      try {
        const [legacyCurrent, presets] = await Promise.all([
          this.deps.getCurrent(),
          this.deps.listPresets(ghostId),
        ]);
        if (legacyCurrent?.name && !legacyCurrent.sourceGhostId && presets.length === 0) {
          const legacyHashes = {
            background: hashFromMediaUrl(legacyCurrent.background?.url),
            brandIcon: hashFromMediaUrl(legacyCurrent.brand?.icon?.url),
            brandLogo: hashFromMediaUrl(legacyCurrent.brand?.logo?.url),
          };
          await this.deps.savePreset(legacyCurrent, legacyHashes);
        }
      } catch (error) {
        this.deps.log?.warn('ghost appearance legacy preset migration failed', {
          ghostId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    let current: GhostAppearanceSnapshot | null = null;
    if (patching) {
      try {
        current = await this.deps.getCurrent();
      } catch {
        return { ok: false, message: '外观服务暂时不可用' };
      }
      if (!current) return { ok: false, message: '当前没有可微调的皮肤，请先应用一套皮肤' };
      if (current.sourceGhostId !== ghostId) {
        return { ok: false, message: '当前皮肤由其他插件提供，不能从此插件微调' };
      }
    }
    const palette = request.palette ?? current?.palette;
    if (typeof palette !== 'string' || !PALETTES.has(palette)) {
      return { ok: false, message: '请选择 Cindy 支持的外观调色板' };
    }

    const dim = finiteInRange(request.dim, current?.dim ?? GHOST_APPEARANCE_DEFAULT_DIM, 0, 0.85);
    const surfaceOpacity = finiteInRange(
      request.surfaceOpacity,
      current?.surfaceOpacity ?? GHOST_APPEARANCE_DEFAULT_SURFACE_OPACITY,
      0.55,
      1,
    );
    if (dim === null || surfaceOpacity === null) {
      return { ok: false, message: '外观透明度参数超出允许范围' };
    }
    if (request.name !== undefined && typeof request.name !== 'string') {
      return { ok: false, message: '皮肤名称必须是字符串' };
    }
    let name: string | undefined;
    if (typeof request.name === 'string') {
      const normalized = normalizeSkinName(request.name);
      if (!normalized) return { ok: false, message: '皮肤名称须为 1–48 个可见字符' };
      name = normalized;
    } else if (patching) {
      name = current?.name;
    }

    const resolveOwnedImage = async (
      candidate: Record<string, unknown>,
      label: string,
    ): Promise<{ hash: string; url: string } | GhostPipeAppearanceResult> => {
      const hash = candidate.hash;
      if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
        return { ok: false, message: `${label}图片参数不正确` };
      }
      let canRead = false;
      let image: { url: string; mimeType: string; bytes: number } | null = null;
      try {
        canRead = await this.deps.canReadImage(hash, ghostId);
        if (canRead) image = await this.deps.resolveImage(hash);
      } catch (error) {
        this.deps.log?.warn('ghost appearance media validation failed', {
          ghostId,
          label,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, message: '外观服务暂时不可用' };
      }
      if (!canRead) return { ok: false, message: `${label}图片不属于当前插件` };
      if (!image || !SUPPORTED_STATIC_IMAGE_MIME.has(image.mimeType)) {
        return { ok: false, message: `${label}资源不是受支持的图片` };
      }
      if (image.bytes <= 0 || image.bytes > MAX_SKIN_IMAGE_BYTES) {
        return { ok: false, message: `${label}图片过大，请使用 8 MB 以内的静态图片` };
      }
      try {
        await this.deps.validateImage(hash);
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error && error.message ? error.message : `${label}图片无效`,
        };
      }
      return { hash, url: image.url };
    };

    let background: GhostAppearanceSnapshot['background'] = patching
      ? current?.background
      : undefined;
    const mediaHashes: {
      background?: string;
      brandIcon?: string;
      brandLogo?: string;
    } = patching
      ? {
          background: hashFromMediaUrl(current?.background?.url),
          brandIcon: hashFromMediaUrl(current?.brand?.icon?.url),
          brandLogo: hashFromMediaUrl(current?.brand?.logo?.url),
        }
      : {};
    if (request.background !== undefined) {
      if (request.background === null && patching) {
        background = undefined;
        delete mediaHashes.background;
      } else if (!request.background || typeof request.background !== 'object') {
        return { ok: false, message: '背景图片参数格式不正确' };
      } else {
        const candidate = request.background as Record<string, unknown>;
        const hash = candidate.hash;
        const focusX = finiteInRange(candidate.focusX, 0.5, 0, 1);
        const focusY = finiteInRange(candidate.focusY, 0.5, 0, 1);
        if (typeof hash !== 'string' || !HASH_RE.test(hash) || focusX === null || focusY === null) {
          return { ok: false, message: '背景图片参数不正确' };
        }
        const resolved = await resolveOwnedImage(candidate, '背景');
        if ('ok' in resolved) return resolved;
        background = { url: resolved.url, focusX, focusY };
        mediaHashes.background = resolved.hash;
      }
    }

    let brand: GhostAppearanceSnapshot['brand'] =
      patching && current?.brand ? { ...current.brand } : undefined;
    if (request.brand !== undefined) {
      if (request.brand === null && patching) {
        brand = undefined;
        delete mediaHashes.brandIcon;
        delete mediaHashes.brandLogo;
      } else if (!request.brand || typeof request.brand !== 'object') {
        return { ok: false, message: '品牌图片参数格式不正确' };
      } else {
        const requestedBrand = request.brand as Record<string, unknown>;
        if (Object.keys(requestedBrand).length === 0) {
          return { ok: false, message: '品牌图片参数不能为空' };
        }
        const resolvedBrand: NonNullable<GhostAppearanceSnapshot['brand']> = {
          ...(brand ?? {}),
        };
        if (requestedBrand.icon !== undefined) {
          if (requestedBrand.icon === null && patching) {
            delete resolvedBrand.icon;
            delete mediaHashes.brandIcon;
          } else {
            if (!requestedBrand.icon || typeof requestedBrand.icon !== 'object') {
              return { ok: false, message: '品牌头像图片参数格式不正确' };
            }
            const resolved = await resolveOwnedImage(
              requestedBrand.icon as Record<string, unknown>,
              '品牌头像',
            );
            if ('ok' in resolved) return resolved;
            resolvedBrand.icon = { url: resolved.url };
            mediaHashes.brandIcon = resolved.hash;
          }
        }
        if (requestedBrand.logo !== undefined) {
          if (requestedBrand.logo === null && patching) {
            delete resolvedBrand.logo;
            delete mediaHashes.brandLogo;
          } else {
            if (!requestedBrand.logo || typeof requestedBrand.logo !== 'object') {
              return { ok: false, message: '品牌 Logo 图片参数格式不正确' };
            }
            const logoRequest = requestedBrand.logo as Record<string, unknown>;
            if (
              logoRequest.removeWhiteBackground !== undefined &&
              typeof logoRequest.removeWhiteBackground !== 'boolean'
            ) {
              return { ok: false, message: '品牌 Logo 去背景参数不正确' };
            }
            let resolved = await resolveOwnedImage(logoRequest, '品牌 Logo');
            if ('ok' in resolved) return resolved;
            if (logoRequest.removeWhiteBackground === true) {
              try {
                resolved = await this.deps.removeWhiteLogoBackground(resolved.hash);
              } catch (error) {
                this.deps.log?.warn('ghost appearance logo background removal failed', {
                  ghostId,
                  error: error instanceof Error ? error.message : String(error),
                });
                return {
                  ok: false,
                  message:
                    error instanceof Error && error.message
                      ? error.message
                      : 'Logo 去背景失败，请换用纯白底文字图片',
                };
              }
            }
            resolvedBrand.logo = { url: resolved.url };
            mediaHashes.brandLogo = resolved.hash;
          }
        }
        brand = resolvedBrand.icon || resolvedBrand.logo ? resolvedBrand : undefined;
        if (!patching && !brand) {
          return { ok: false, message: '品牌图片至少需要头像或 Logo' };
        }
      }
    }

    const appearance: GhostAppearanceSnapshot = {
      palette: palette as GhostAppearancePalette,
      sourceGhostId: ghostId,
      ...(name ? { name } : {}),
      ...(background ? { background } : {}),
      ...(brand ? { brand } : {}),
      dim,
      surfaceOpacity,
      updatedAt: (this.deps.now ?? Date.now)(),
    };
    try {
      if (appearance.name) {
        await this.deps.saveWithPreset(appearance, mediaHashes, ghostId, {
          dim: patching || request.dim !== undefined,
          surfaceOpacity: patching || request.surfaceOpacity !== undefined,
        });
      } else {
        await this.deps.save(appearance, mediaHashes, ghostId, {
          dim: patching || request.dim !== undefined,
          surfaceOpacity: patching || request.surfaceOpacity !== undefined,
        });
      }
    } catch (error) {
      this.deps.log?.warn('ghost appearance save failed', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        message:
          error instanceof Error && error.name === 'GhostAppearanceRecoveryError'
            ? error.message
            : '外观保存失败，请稍后重试',
      };
    }
    this.deps.broadcast(appearance);
    return { ok: true, appearance };
  }
}
