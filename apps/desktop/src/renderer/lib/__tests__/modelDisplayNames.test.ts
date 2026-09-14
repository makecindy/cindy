import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import en from '../../i18n/locales/en/common.json';
import cn from '../../i18n/locales/zh-CN/common.json';
import tw from '../../i18n/locales/zh-TW/common.json';
import { localizedModelName, localizedBrandName, matchesModelName, modelBrand } from '../modelDisplayNames';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'zh-CN', fallbackLng: 'en', resources: {
    en: { translation: en }, 'zh-CN': { translation: cn }, 'zh-TW': { translation: tw },
  } });
});

describe('localized model display names', () => {
  it('uses official Chinese families and keeps versions and variants', () => {
    const t = i18n.getFixedT('zh-CN');
    expect(localizedModelName('Qwen3.8 Max', t)).toBe('千问 3.8 Max');
    expect(localizedModelName('Hy4 preview', t)).toBe('混元 4 preview');
    expect(localizedModelName('Doubao Seed 2.1 Pro', t)).toBe('豆包 Seed 2.1 Pro');
    expect(localizedModelName('Qwen4.1-72B-Future', t)).toBe('千问 4.1-72B-Future');
    expect(localizedModelName('Qwen3.8 Max', i18n.getFixedT('zh-TW'))).toBe('千問 3.8 Max');
  });
  it('leaves English, unknown models and custom labels intact', () => {
    for (const name of ['Hy4 preview', 'Hunyuan 4', 'Qwen3.8 Max', 'Doubao Seed 2.1 Pro']) {
      expect(localizedModelName(name, i18n.getFixedT('en'))).toBe(name);
    }
    for (const name of ['GPT-6 Astra', 'Claude Opus 5', 'Gemini 3.8 Flash', 'Kimi K3', 'GLM 5.3 Flash', '我的模型', 'Hybrid Agent']) {
      expect(localizedModelName(name, i18n.getFixedT('zh-CN'))).toBe(name);
    }
  });
  it('separates the manufacturer from the model name and preserves unknown namespaces', () => {
    const t = i18n.getFixedT('zh-CN');
    expect(localizedBrandName(modelBrand({ id: 'z-ai/glm-5.3-flash' })!, t)).toBe('智谱');
    expect(localizedBrandName(modelBrand({ id: 'moonshotai/kimi-k3' })!, t)).toBe('月之暗面');
    expect(localizedBrandName(modelBrand({ id: 'new-maker/new-model' })!, t)).toBe('new-maker');
  });
  it('searches both languages, manufacturer and exact model ID without modifying model data', () => {
    const model = Object.freeze({ id: 'qwen/qwen3.8-max', name: 'Qwen3.8 Max' });
    for (const locale of ['zh-CN', 'zh-TW', 'en']) {
      const t = i18n.getFixedT(locale);
      for (const q of ['千问', '千問', 'qwen', '阿里巴巴', 'Alibaba', model.id, '千问 Max', '千问3.8']) {
        expect(matchesModelName(model, q, t), `${locale}: ${q}`).toBe(true);
      }
      expect(matchesModelName(model, 'GPT', t)).toBe(false);
    }
    expect(model).toEqual({ id: 'qwen/qwen3.8-max', name: 'Qwen3.8 Max' });
  });
});
