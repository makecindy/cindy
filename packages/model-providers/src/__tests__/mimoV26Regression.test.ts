/**
 * 小米 MiMo V2.6 专项回归门禁(#4865 review 跟进)。
 *
 * 背景:MiMo 的深度思考只有开/关、不是 `reasoning_effort` 档位模型(官方
 * `thinking.type: enabled|disabled`;实测 `max` → 400、`high` → 200、省略 → 200),
 * Pro/Flash 为官方全模态(支持图片输入)。这两条是修复「发 max 被 400 拒绝」与
 * 「Pi 带图消息被本地拦下」的关键配置;通用目录测试只验证结构合法,后续目录同步
 * 若重新引入伪档位或丢失图片能力仍会绿。本测试把最终连接投影的语义钉在 CI。
 *
 * 判定路径与 toCatalogModel 一致:Registry 公共资料按 model id/alias 合并进所有
 * 连接(含存量自定义连接),`[]` / `null` 是显式值不再继承;`efforts: []` 时
 * resolveModelMetadata 强制 `defaultEffort = null`。
 */

import { describe, expect, it } from "vitest";

import { BUNDLED_CATALOG } from "../catalog.js";
import { buildUserProvider } from "../user-provider.js";
import { PROVIDER_MODEL_CATALOG } from "../providerModelCatalog.js";
import type { CustomProviderConfig, ProviderRuntimeModelConfig } from "../types.js";
import { parseModelRegistry } from "../modelAccessValidator.js";
import {
  findBaseModel,
  resolveModelMetadata,
} from "../modelMetadataLayers.js";
import modelRegistryJson from "../../catalog/model-registry.json" with { type: "json" };
import type { ModelRegistry } from "../modelAccessBean.js";

const rawRegistry = modelRegistryJson as unknown as ModelRegistry;
const registry = parseModelRegistry(rawRegistry);
const MIMO_PRESET_IDS = ["xiaomi-mimo-api-cn", "xiaomi-mimo-token-plan-cn"];
const IMAGE_MODELS = new Set(["mimo-v2.6-pro", "mimo-v2.6-flash"]);

// #10434, unit: the previous tests stopped before buildUserProvider, where the
// native catalog's high tier replaced the Registry's empty intensity ladder.
describe.each(['xiaomi', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp'])(
  'MiMo thinking switch through the actual connection projection: %s', source => {
    const rows = PROVIDER_MODEL_CATALOG.providers[source].filter(row => row.id.startsWith('mimo-v2.6-'));
    const project = (model: Omit<ProviderRuntimeModelConfig, 'name'>, legacy = false, baseUrl = rows[0].upstream) => {
      const configuredModel = { name: model.id, ...model };
      const config: CustomProviderConfig = { id: 'mimo-connection', name: 'MiMo', runtimes: { pi: {
        baseUrl, wireProtocol: 'openai-chat',
        ...(legacy ? { piCatalogProviderId: source } : {}), models: [configuredModel],
      } } };
      const before = structuredClone(config);
      const result = buildUserProvider(config, { modelRegistry: BUNDLED_CATALOG.modelRegistry }).models.pi![0];
      expect(config).toEqual(before);
      expect(result.userModelConfig).toEqual(configuredModel);
      return result;
    };
    it.each([false, true])('exposes the switch without fake intensity levels (legacy=%s)', legacy => {
      for (const row of rows) {
        expect(project({ id: row.id }, legacy)).toMatchObject({
          thinkingToggle: true, efforts: [], defaultEffort: null, supportsImageInput: true,
        });
      }
    });
    it('exposes the same switch when creating a connection from its current preset', () => {
      const presetId = source === 'xiaomi' ? 'xiaomi-mimo-api-cn'
        : source === 'xiaomi-token-plan-cn' ? 'xiaomi-mimo-token-plan-cn' : source;
      const preset = BUNDLED_CATALOG.presets!.find(preset => preset.id === presetId)!;
      const runtime = preset.runtimes.pi!;
      const provider = buildUserProvider({ id: 'new-mimo', name: 'MiMo', runtimes: { pi: {
        ...runtime, catalogPresetId: preset.id,
      } } }, { presets: BUNDLED_CATALOG.presets, modelRegistry: BUNDLED_CATALOG.modelRegistry });
      for (const row of rows) expect(provider.models.pi!.find(model => model.id === row.id))
        .toMatchObject({ thinkingToggle: true, efforts: [], defaultEffort: null });
    });
    it('preserves explicit user overrides and does not lend the switch to another route', () => {
      expect(project({ id: rows[0].id, thinkingToggle: false }).thinkingToggle).not.toBe(true);
      expect(project({ id: rows[0].id, reasoning: false }).thinkingToggle).not.toBe(true);
      expect(project({ id: rows[0].id, reasoning: true, reasoningEfforts: ['medium'], reasoningDefaultEffort: 'medium' }))
        .toMatchObject({ efforts: ['medium'], defaultEffort: 'medium' });
      expect(project({ id: rows[0].id }, true, 'https://proxy.example/v1').thinkingToggle).not.toBe(true);
      expect(project({ id: rows[0].id, piApi: 'openai-responses' }).thinkingToggle).not.toBe(true);
      expect(project({ id: 'mimo-v2.7-pro' }).thinkingToggle).not.toBe(true);
    });
  },
);

/** 裸 model id → Registry 公共条目(alias 唯一匹配)。 */
function baseModelFor(bareId: string) {
  if (!registry.ok) throw new Error(registry.error);
  const base = findBaseModel(registry.value, bareId);
  expect(base, `Registry 缺少 MiMo 公共条目: ${bareId}`).toBeDefined();
  return base!;
}

describe("MiMo V2.6 Registry 公共条目", () => {
  it("打包的 model-registry.json 整体可解析", () => {
    expect(registry.ok, registry.ok ? "" : registry.error).toBe(true);
  });

  it.each([
    "mimo-v2.6-pro",
    "mimo-v2.6-flash",
    "mimo-v2.6-pro-ultraspeed",
  ])("%s 声明空档位且无默认档(不得重新引入通用档位)", (bareId) => {
    // 必须是显式空数组 + null,不是缺字段:缺字段会触发 CUSTOM_EFFORTS 通用五档回退,
    // 把已被 400 证明非法的 max 又发回 MiMo。
    expect(baseModelFor(bareId).defaults.efforts).toEqual([]);
    expect(baseModelFor(bareId).defaults.defaultEffort).toBeNull();
  });

  it.each([...IMAGE_MODELS])("%s 声明支持图片输入(全模态)", (bareId) => {
    expect(baseModelFor(bareId).defaults.supportsImageInput).toBe(true);
  });
});

describe.each(MIMO_PRESET_IDS)("MiMo 预设连接投影: %s", (presetId) => {
  const preset = BUNDLED_CATALOG.presets?.find((p) => p.id === presetId);
  expect(preset, `bundled 目录缺少预设 ${presetId}`).toBeDefined();

  it.each(["claude-code", "codex", "pi"])(
    "runtime %s 的推荐模型投影为空档位且 Pro/Flash 可图片输入",
    (agent) => {
      const models = preset?.runtimes[agent as "claude-code"]?.models ?? [];
      expect(models.length).toBeGreaterThan(0);
      // 推荐集即 V2.6:V2.5 已官宣下线,合并视图保留的 V2.5 兼容行必须
      // defaultEnabled:false(不推荐、仅手动可用),不得回流推荐清单。
      const recommended = models.filter(
        (model) => model.defaultEnabled !== false,
      );
      expect(recommended.length).toBeGreaterThan(0);
      for (const model of recommended)
        expect(model.id.startsWith("mimo-v2.6"), model.id).toBe(true);
      for (const model of models) {
        if (!model.id.startsWith("mimo-v2.6")) continue;
        if (!registry.ok) throw new Error(registry.error);
        const resolved = resolveModelMetadata(
          registry.value,
          presetId,
          model.id,
          undefined,
          undefined,
          agent,
        );
        expect(resolved.efforts, `${agent}/${model.id} 档位投影`).toEqual([]);
        expect(
          resolved.defaultEffort,
          `${agent}/${model.id} 默认档投影`,
        ).toBeNull();
        if (IMAGE_MODELS.has(model.id)) {
          expect(
            resolved.supportsImageInput,
            `${agent}/${model.id} 图片能力投影`,
          ).toBe(true);
          // 预设行的图片能力只落在 pi 行(新连接快照,pi 侧 input 才含 image);
          // cc/codex 行不攃能力字段,由 Registry 公共投影供片。
          if (agent === "pi")
            expect(
              model.supportsImageInput,
              `${agent}/${model.id} 预设行图片能力`,
            ).toBe(true);
        }
      }
    },
  );
});
