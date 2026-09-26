import { describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG } from '@cindy/model-providers';

import { chatBridgeCapabilitiesForRoute } from '../codex-proxy-host.js';

describe('预设 Codex 图片能力与 Chat 桥接一致', () => {
  it('走 openai-chat 的 Codex 模型只有桥接已验证时才声明支持图片', () => {
    const mismatched: string[] = [];
    for (const preset of BUNDLED_CATALOG.presets ?? []) {
      const runtime = preset.runtimes.codex;
      if (!runtime) continue;
      for (const model of runtime.models) {
        const wire = model.route?.wireProtocol ?? runtime.wireProtocol ?? 'openai-responses';
        if (wire !== 'openai-chat' || model.supportsImageInput !== true) continue;
        const upstream = model.route?.baseUrl ?? runtime.baseUrl;
        if (chatBridgeCapabilitiesForRoute(upstream, model.id).imageInput !== 'image_url') {
          mismatched.push(`${preset.id}/${model.id}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('第三方直连 Registry 路由不在路由级声明图片输入（路由默认值会作用到 Codex）', () => {
    const firstParty = new Set(['xd', 'openai', 'anthropic']);
    const offenders = (BUNDLED_CATALOG.modelRegistry?.models ?? []).flatMap((entry) =>
      entry.routes
        .filter(
          (route) =>
            !firstParty.has(route.providerId) &&
            route.agents.includes('codex') &&
            (route.defaults?.supportsImageInput === true ||
              route.forceOverrides?.supportsImageInput === true),
        )
        .map((route) => `${entry.id} ${route.providerId}:${route.modelId}`),
    );
    expect(offenders).toEqual([]);
  });
});
