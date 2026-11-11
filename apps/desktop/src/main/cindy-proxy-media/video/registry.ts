/**
 * art/video/registry.ts
 * ---------------------------------------------------------------------------
 * Maps a model alias (the LLM-facing name) → concrete VideoProvider, and
 * collects metadata across all providers for tool-description generation.
 *
 * Stateless, no I/O. Constructed once per CindyProxyMediaService.
 */

import type { VideoModelAlias, VideoProvider, VideoRefMode } from './types.js';

interface ResolvedAlias {
  provider: VideoProvider;
  /** 模型目录中的来源 id（例如 xd / xai），与内部执行器 id 分离。 */
  catalogProviderId: string;
  internalModel: string;
  summary: string;
  expectedSeconds: number;
}

export class VideoProviderRegistry {
  private readonly providers = new Map<string, VideoProvider>();
  private readonly aliasIndex = new Map<string, ResolvedAlias>();

  register(provider: VideoProvider, catalogProviderId = 'xd'): void {
    if (this.providers.has(provider.id)) {
      throw new Error(
        `[videoRegistry] duplicate provider id: ${provider.id}`,
      );
    }
    for (const a of provider.capabilities.modelAliases) {
      if (this.aliasIndex.has(a.alias)) {
        throw new Error(
          `[videoRegistry] duplicate alias: ${a.alias} (already registered by ${this.aliasIndex.get(a.alias)!.provider.id})`,
        );
      }
      const expected =
        provider.capabilities.expectedSecondsByAlias[a.alias] ?? 120;
      this.aliasIndex.set(a.alias, {
        provider,
        catalogProviderId,
        internalModel: a.internalModel,
        summary: a.summary,
        expectedSeconds: expected,
      });
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * 用同一 provider 的新能力快照补充／更新 alias。旧 alias 索引不删除：目录热更
   * 期间已经提交的长视频任务仍要能继续 poll/download；新请求是否可用由当前目录
   * 白名单在提交前重查。其它 provider 已占用的 alias 仍严格拒绝。
   */
  registerOrExtend(provider: VideoProvider, catalogProviderId = 'xd'): void {
    const existing = this.providers.get(provider.id);
    if (!existing) {
      this.register(provider, catalogProviderId);
      return;
    }
    for (const alias of provider.capabilities.modelAliases) {
      const occupied = this.aliasIndex.get(alias.alias);
      if (
        occupied &&
        (occupied.provider.id !== provider.id ||
          occupied.catalogProviderId !== catalogProviderId)
      ) {
        throw new Error(
          `[videoRegistry] duplicate alias: ${alias.alias} (already registered by ${occupied.provider.id})`,
        );
      }
    }
    for (const alias of provider.capabilities.modelAliases) {
      this.aliasIndex.set(alias.alias, {
        provider,
        catalogProviderId,
        internalModel: alias.internalModel,
        summary: alias.summary,
        expectedSeconds: provider.capabilities.expectedSecondsByAlias[alias.alias] ?? 120,
      });
    }
    this.providers.set(provider.id, provider);
  }

  /** True if at least one provider is registered. Tools should be omitted
   *  from the catalog when this is false (no models = no callable tools). */
  hasAny(): boolean {
    return this.aliasIndex.size > 0;
  }

  /** 目录热更可能先于客户端通道代码；未知 alias 必须从可选清单中过滤。 */
  hasAlias(alias: string, catalogProviderId?: string): boolean {
    const resolved = this.aliasIndex.get(alias);
    return Boolean(
      resolved &&
        (catalogProviderId === undefined || resolved.catalogProviderId === catalogProviderId),
    );
  }

  /** Throws on unknown alias — handler converts that to INVALID_ARGS. */
  resolveByAlias(alias: string): ResolvedAlias {
    const r = this.aliasIndex.get(alias);
    if (!r) {
      throw new Error(
        `unknown video model alias: ${alias}. Known: ${Array.from(this.aliasIndex.keys()).join(', ')}`,
      );
    }
    return r;
  }

  /** Ordered list of all aliases across all providers, in registration order.
   *  First alias is the global default. */
  collectAllAliases(): Array<VideoModelAlias & { expectedSeconds: number; providerId: string }> {
    const out: Array<VideoModelAlias & { expectedSeconds: number; providerId: string }> = [];
    for (const provider of this.providers.values()) {
      for (const a of provider.capabilities.modelAliases) {
        const expected =
          provider.capabilities.expectedSecondsByAlias[a.alias] ?? 120;
        out.push({ ...a, expectedSeconds: expected, providerId: provider.id });
      }
    }
    return out;
  }

  /** Union of supported durations / resolutions / ratios / fps across all
   *  registered providers — used to build the zod enum on the tool schema.
   *  Per-provider validity is enforced again at call time. */
  collectUnionParams(): {
    durations: number[];
    resolutions: string[];
    ratios: string[];
    fps: number[];
    /** 逐 refMode 的张数上界(取各 provider 的最大值);没有任何 provider
     *  支持的用法不会出现在表里。 */
    maxImagesUpperBoundByRefMode: Partial<Record<VideoRefMode, number>>;
  } {
    const durations = new Set<number>();
    const resolutions = new Set<string>();
    const ratios = new Set<string>();
    const fps = new Set<number>();
    const maxImagesUpperBoundByRefMode: Partial<Record<VideoRefMode, number>> = {};
    for (const p of this.providers.values()) {
      for (const d of p.capabilities.supportedDurations) durations.add(d);
      for (const r of p.capabilities.supportedResolutions) resolutions.add(r);
      for (const r of p.capabilities.supportedRatios) ratios.add(r);
      for (const f of p.capabilities.supportedFps) fps.add(f);
      for (const [mode, max] of Object.entries(p.capabilities.maxImagesByRefMode)) {
        if (max === undefined) continue;
        const key = mode as VideoRefMode;
        const prev = maxImagesUpperBoundByRefMode[key];
        if (prev === undefined || max > prev) maxImagesUpperBoundByRefMode[key] = max;
      }
    }
    return {
      durations: Array.from(durations).sort((a, b) => a - b),
      resolutions: Array.from(resolutions),
      ratios: Array.from(ratios),
      fps: Array.from(fps).sort((a, b) => a - b),
      maxImagesUpperBoundByRefMode,
    };
  }
}
