/**
 * imageModelCatalogSync.test.ts — 图像模型两份打包源的同源守卫。
 *
 * 运行时清单以 providers.json 目录(getActiveCatalog)为准,目录缺区即视为
 * 能力暂不可用(不再回落常量,见 cindyMediaCatalog.ts);@cindy/mcps 的
 * GATEWAY_IMAGE_MODELS 仍是图像通道 enum(GatewayImageModel)的类型正本。
 * 两者随 App 同版发布,必须逐项一致——漂移会造成"下拉可选但图像通道
 * enum 不认"(或反之)的割裂。改任一边,另一边必须同步。
 */

import { describe, it, expect } from 'vitest';
import { GATEWAY_IMAGE_MODELS } from '../../cindy-proxy-media/types.js';
import { BUNDLED_CATALOG } from '@cindy/model-providers';

const LEGACY_PREVIEW_IMAGE_MODELS = ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview'] as const;
const ACTIVE_GEMINI_IMAGE_MODELS = ['gemini-3-pro-image', 'gemini-3.1-flash-image'] as const;

describe('图像模型清单同源守卫', () => {
  it('内置目录 xd.imageModels 与 @cindy/mcps 打包常量逐项一致(id + 显示名)', () => {
    const xd = BUNDLED_CATALOG.providers.find((p) => p.id === 'xd');
    expect(xd?.imageModels, '内置目录 xd 供应商缺 imageModels 区').toBeTruthy();
    expect(xd?.imageModels).toEqual(GATEWAY_IMAGE_MODELS.map((m) => ({ id: m.id, name: m.label })));
  });

  it('旧 preview alias 不再进入目录、打包兜底或默认档位', () => {
    const xd = BUNDLED_CATALOG.providers.find((p) => p.id === 'xd');
    const catalogIds = new Set((xd?.imageModels ?? []).map((m) => m.id));
    const fallbackIds = new Set<string>(GATEWAY_IMAGE_MODELS.map((m) => m.id));
    const defaults = new Set<string>(Object.values(xd?.imageDefaults ?? {}));

    for (const id of LEGACY_PREVIEW_IMAGE_MODELS) {
      expect(catalogIds.has(id), `${id} 仍在内置目录`).toBe(false);
      expect(fallbackIds.has(id), `${id} 仍在图片通道打包兜底`).toBe(false);
      expect(defaults.has(id), `${id} 仍被默认档位引用`).toBe(false);
    }
  });

  it('网关当前 Gemini alias 同时进入目录与打包兜底，draft 指向 Flash', () => {
    const xd = BUNDLED_CATALOG.providers.find((p) => p.id === 'xd');
    const catalogIds = new Set((xd?.imageModels ?? []).map((m) => m.id));
    const fallbackIds = new Set<string>(GATEWAY_IMAGE_MODELS.map((m) => m.id));

    for (const id of ACTIVE_GEMINI_IMAGE_MODELS) {
      expect(catalogIds.has(id), `${id} 未进入内置目录`).toBe(true);
      expect(fallbackIds.has(id), `${id} 未进入图片通道打包兜底`).toBe(true);
    }
    expect(xd?.imageDefaults?.draft).toBe('gemini-3.1-flash-image');
  });
});

describe('图像默认选型入册守卫', () => {
  it('内置目录 xd.imageDefaults 存在且每个值都指向在册模型', () => {
    const xd = BUNDLED_CATALOG.providers.find((p) => p.id === 'xd');
    const ids = new Set((xd?.imageModels ?? []).map((m) => m.id));
    expect(xd?.imageDefaults?.standard, '缺 imageDefaults.standard(默认选型必须入册,代码零字面量)').toBeTruthy();
    for (const v of Object.values(xd?.imageDefaults ?? {})) {
      expect(ids.has(v as string), `imageDefaults 值 ${String(v)} 不在 imageModels`).toBe(true);
    }
  });
});
