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

import {
  GHOST_VIDEO_MAX_SOURCES_BY_REF_MODE,
  GHOST_VIDEO_REF_MODES,
} from '../../../../shared/ghost.js';
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

/**
 * 同源守卫之二:协议层的参考图张数粗筛上界(shared/ghost.ts,插件协议面)
 * 与 provider 实际声明的上限。
 *
 * 两处必然是双源——`shared/` 不能依赖 `main/` 的 provider registry(依赖
 * 方向),而协议层常量还要供插件手册与类型引用,只能手写。既然消不掉双源,
 * 就在这里守:**协议层上界不得低于任何 provider 的实际上限**,低了就会把
 * 型号明明支持的张数在粗筛阶段误拒(而且拒绝话术还报的是协议层的数)。
 *
 * 反方向(协议层比 provider 宽)刻意放行:`first_and_last_frame` 的 2 是
 * 「首+尾」的语义上界,与当前注册了几个 provider 无关;宽出来的部分由按
 * 型号二次校验兜住,话术仍报该型号的真实上限。
 */
describe('参考图张数上界 ↔ provider capabilities 同源', () => {
  it('协议层上界 ≥ 各 provider 的实际上限(调高 provider 忘改协议层就在这炸)', () => {
    const registry = buildRealRegistry();
    const union = registry.collectUnionParams().maxImagesUpperBoundByRefMode;
    for (const [mode, providerMax] of Object.entries(union)) {
      const protocolMax =
        GHOST_VIDEO_MAX_SOURCES_BY_REF_MODE[
          mode as keyof typeof GHOST_VIDEO_MAX_SOURCES_BY_REF_MODE
        ];
      expect(protocolMax, `refMode '${mode}' 缺协议层上界`).toBeDefined();
      expect(
        protocolMax,
        `refMode '${mode}':provider 支持 ${providerMax} 张,协议层粗筛却只放 ${protocolMax} 张`,
      ).toBeGreaterThanOrEqual(providerMax as number);
    }
  });

  it('provider 不得声明协议层不认识的 refMode(否则插件永远传不进来)', () => {
    const registry = buildRealRegistry();
    const known = new Set<string>(GHOST_VIDEO_REF_MODES);
    const union = registry.collectUnionParams().maxImagesUpperBoundByRefMode;
    for (const mode of Object.keys(union)) {
      expect(known.has(mode), `provider 声明了协议层没有的 refMode '${mode}'`).toBe(true);
    }
  });
});
