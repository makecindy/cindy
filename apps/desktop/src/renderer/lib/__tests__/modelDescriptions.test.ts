import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import registry from '../../../../../../packages/model-providers/catalog/model-registry.json';
import en from '../../i18n/locales/en/common.json';
import cn from '../../i18n/locales/zh-CN/common.json';
import tw from '../../i18n/locales/zh-TW/common.json';
import ja from '../../i18n/locales/ja/common.json';
import ko from '../../i18n/locales/ko/common.json';
import { localizedModelDescription, modelDescriptionKey } from '../modelDescriptions';
import { matchesModelName } from '../modelDisplayNames';

const locales = { en, 'zh-CN': cn, 'zh-TW': tw, ja, ko };
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'zh-CN', fallbackLng: false, resources: Object.fromEntries(
    Object.entries(locales).map(([lng, translation]) => [lng, { translation }]),
  ) });
});

describe('local model descriptions', () => {
  it('covers every bundled model and wire route in all five languages', () => {
    for (const model of registry.models) {
      for (const id of [model.id, ...model.routes.map((route) => route.modelId)]) {
        const key = modelDescriptionKey({ id });
        expect(key, id).toBeTruthy();
        for (const [lng, resource] of Object.entries(locales)) {
          expect(resource.modelDescriptions, `${id}: ${lng}`).toHaveProperty(key!);
          const description = localizedModelDescription({ id }, i18n.getFixedT(lng));
          expect(description, `${id}: ${lng}`).toBeTruthy();
          expect(description).not.toContain('modelDescriptions.');
          if (lng !== 'en') expect(description).not.toBe(localizedModelDescription({ id }, i18n.getFixedT('en')));
        }
      }
    }
  });

  it('uses the same copy for gateway, subscription, OpenRouter and future family versions', () => {
    const t = i18n.getFixedT('zh-CN');
    for (const id of ['glm-5.3-flash', 'z-ai/glm-5.3-flash', 'xd/z-ai-glm-5.3-flash', 'z-ai/glm-6.1-flash']) {
      expect(localizedModelDescription({ id }, t)).toBe('用于内容写作、编程与问题分析。');
    }
    expect(localizedModelDescription({ id: 'chatgpt/gpt-5.6-sol' }, t))
      .toBe(localizedModelDescription({ id: 'codex/gpt-5.6-sol' }, t));
    expect(localizedModelDescription({ id: 'gpt-5.3-codex-spark' }, t)).toBe(cn.modelDescriptions.quickCoding);
  });

  it('keeps the long-context variant warning instead of replacing it with a general blurb', () => {
    const t = i18n.getFixedT('zh-CN');
    expect(localizedModelDescription({ id: 'chatgpt/gpt-5.6-sol[1m]' }, t)).toBe(cn.modelDescriptions.longContext);
    expect(localizedModelDescription({ id: 'gpt-5.6-sol' }, t)).not.toBe(cn.modelDescriptions.longContext);
  });

  it('respects declared media types ahead of a chat-like name', () => {
    const t = i18n.getFixedT('zh-CN');
    expect(localizedModelDescription({ id: 'gpt-image-2', group: 'gpt' }, t)).toBe(cn.modelDescriptions.image);
    expect(localizedModelDescription({ id: 'gpt-new', mode: 'image_generation' }, t)).toBe(cn.modelDescriptions.image);
    expect(localizedModelDescription({ id: 'gpt-new', mode: 'audio_transcription' }, t)).toBe(cn.modelDescriptions.transcription);
    expect(localizedModelDescription({ id: 'gpt-new', mode: 'future_unknown_mode' }, t)).toBeUndefined();
    expect(localizedModelDescription({ id: 'new-company/new-video', mode: 'video_generation' }, t)).toBe(cn.modelDescriptions.video);
  });

  it('does not leak raw English or manufacture a description for unknown models', () => {
    const model = Object.freeze({ id: 'new-company/new-model', description: 'Untranslated provider description' });
    for (const lng of Object.keys(locales)) expect(localizedModelDescription(model, i18n.getFixedT(lng))).toBeUndefined();
    expect(model.description).toBe('Untranslated provider description');
    expect(matchesModelName(model, 'new-model', i18n.getFixedT('zh-CN'))).toBe(true);
  });

  it('searches the displayed translated description without modifying metadata', () => {
    const model = Object.freeze({ id: 'z-ai/glm-5.3-flash', description: 'Zhipu native multimodal coding model; 1M context' });
    expect(matchesModelName(model, '内容写作', i18n.getFixedT('zh-CN'))).toBe(true);
    expect(matchesModelName(model, 'native multimodal', i18n.getFixedT('zh-CN'))).toBe(true);
    expect(model.description).toBe('Zhipu native multimodal coding model; 1M context');
  });
});
