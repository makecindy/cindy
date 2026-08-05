/**
 * videoModelsSync.test.ts
 * ---------------------------------------------------------------------------
 * 同源守卫(与 desktop imageModelCatalogSync 同职责):
 * GATEWAY_VIDEO_MODELS(视频型号 alias 的打包正本;运行时清单以 providers.json
 * 目录为准,目录缺区即视为能力暂不可用,见 cindy-brain/cindyMediaCatalog.ts)
 * 里的每个 id 必须是 video provider 层真实注册的 alias——provider 改名/
 * 下架别名而忘改常量时在这里炸,不许静默漂移;首项必须与注册序首别名一致
 * (首项 = 出厂默认)。
 */

import { describe, expect, it } from 'vitest';

import { GATEWAY_VIDEO_MODELS } from '../../types.js';
import { VideoProviderRegistry } from '../registry.js';
import { createSeedanceProvider } from '../providers/seedance.js';
import { createHappyhorseProvider } from '../providers/happyhorse.js';

function buildRealRegistry(): VideoProviderRegistry {
  // 与 desktop art.ts 同一装配顺序(seedance 先注册,seedance-fast 是全局默认)。
  const registry = new VideoProviderRegistry();
  const stub = { baseUrl: 'https://example.invalid', getApiKey: () => null };
  registry.register(createSeedanceProvider(stub));
  registry.register(createHappyhorseProvider(stub));
  return registry;
}

describe('GATEWAY_VIDEO_MODELS ↔ provider alias 同源', () => {
  it('常量里的每个 id 都能在真实 provider 注册表里解析', () => {
    const registry = buildRealRegistry();
    for (const m of GATEWAY_VIDEO_MODELS) {
      expect(() => registry.resolveByAlias(m.id), m.id).not.toThrow();
    }
  });

  it('常量首项 = 注册序首别名(出厂默认对齐)', () => {
    const registry = buildRealRegistry();
    expect(GATEWAY_VIDEO_MODELS[0].id).toBe(registry.collectAllAliases()[0].alias);
  });

  it('常量无遗漏:注册表的全部别名都在常量里(下拉/白名单不缺项)', () => {
    const registry = buildRealRegistry();
    const constantIds = new Set<string>(GATEWAY_VIDEO_MODELS.map((m) => m.id));
    for (const a of registry.collectAllAliases()) {
      expect(constantIds.has(a.alias), a.alias).toBe(true);
    }
  });
});
