// 测试价值
// - 生产入口与可观察结果：withResolvedPiImageInput 加上
//   buildPiNativeProvidersFromConfigs，也就是 piNativeProviders() 投影前
//   做的那一步。用户在 model-catalog-overrides.json 打开图片输入后，
//   投影出的 Pi 模型 input 必须含 image；没有声明则仍是纯文本。
// - Bug／规则依据：PR #9576 评审 PRRT_kwDOTgdRUs61sJAs（P1）。host 不把
//   active catalog 传进共享投影，override 里打开的图片能力被兜底成纯文本，
//   Pi 发图抛 PI_IMAGE_INPUT_UNSUPPORTED。
// - 现有覆盖缺口：Desktop 的 piNativeProviders.test.ts 直接把 catalog 传进
//   buildPiNativeProvidersFromConfigs，覆盖不到 host 这条不传 catalog、
//   只靠模型自身标记的调用。
// - 最小失败输入：自定义模型未声明图片，只在 overrides 的 pi 补丁里
//   supportsImageInput: true。修复前投影 input 为 ['text']。
// - tier：unit。进程内目录状态，不开库、不走网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { buildPiNativeProvidersFromConfigs } from '../../../desktop/src/main/maker-host/pi-native-catalog.ts';
import {
  getActiveCatalog,
  setActiveCatalog,
  setCustomProviderConfigs,
  setCustomProviders,
  setLocalCatalogOverrides,
} from '../../../desktop/src/main/maker-host/active-catalog.ts';
import {
  EMPTY_MODEL_CATALOG_OVERRIDES,
  sanitizeModelCatalogOverrides,
} from '../../../desktop/src/main/maker-host/model-plane/localCatalogOverrides.ts';
import { withResolvedPiImageInput } from './pi-image-input.ts';

const PROVIDER_ID = 'vision-fixture';
const MODEL_ID = 'fixture-text-model';
const config = {
  id: PROVIDER_ID,
  name: 'Vision fixture',
  auth: { method: 'apiKey' },
  runtimes: {
    pi: {
      baseUrl: 'https://provider.invalid/v1',
      wireProtocol: 'openai-chat',
      models: [{ id: MODEL_ID, name: 'Fixture text model', contextWindow: 8192 }],
    },
  },
};

function install(supportsImageInput) {
  setActiveCatalog(BUNDLED_CATALOG);
  setCustomProviderConfigs([config]);
  if (supportsImageInput === undefined) {
    setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
    return;
  }
  const parsed = sanitizeModelCatalogOverrides({
    version: 1,
    patches: {
      [`${encodeURIComponent(PROVIDER_ID)}:${MODEL_ID}`]: {
        perAgent: { pi: { supportsImageInput } },
      },
    },
  });
  assert.deepEqual(parsed.invalid, []);
  setLocalCatalogOverrides(parsed.overrides);
  assert.equal(
    getActiveCatalog().providers.find(provider => provider.id === PROVIDER_ID)
      ?.models.pi?.find(model => model.id === MODEL_ID)?.supportsImageInput,
    supportsImageInput,
  );
}

function projectedInput() {
  // Same two calls as piNativeProviders(), without the owner database.
  const configs = withResolvedPiImageInput([config], getActiveCatalog());
  const native = buildPiNativeProvidersFromConfigs(configs, () => 'fixture-key');
  return native.providers.find(provider => provider.id === PROVIDER_ID)
    ?.models.find(model => model.id === MODEL_ID)?.input;
}

function reset() {
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
  setCustomProviders([]);
  setActiveCatalog(BUNDLED_CATALOG);
}

for (const declared of [true, false]) {
  test(`an override that sets image input to ${declared} reaches the headless Pi projection`, () => {
    install(declared);
    try {
      assert.deepEqual(projectedInput(), declared ? ['text', 'image'] : ['text']);
    } finally {
      reset();
    }
  });
}

test('a custom model with no image declaration stays text-only on the headless host', () => {
  install(undefined);
  try {
    assert.deepEqual(projectedInput(), ['text']);
  } finally {
    reset();
  }
});
