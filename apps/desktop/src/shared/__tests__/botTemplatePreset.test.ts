import { describe, expect, it } from 'vitest';
import { BOT_TEMPLATE_PRESET_IDENTITIES, CINDY_DEFAULT_IDENTITY, inferBotTemplatePresetId, BOT_TEMPLATE_PRESET_IDS, isBotTemplatePresetId } from '../botTemplatePreset';

describe('Cindy identity compatibility', () => {
  it('recognizes both the shipped legacy identity and the new client partner identity', () => {
    expect(inferBotTemplatePresetId(BOT_TEMPLATE_PRESET_IDENTITIES.cindy)).toBe('cindy');
    expect(inferBotTemplatePresetId(CINDY_DEFAULT_IDENTITY)).toBe('cindy');
  });
  it('never infers a template after the user customizes either identity', () => {
    for (const identity of [BOT_TEMPLATE_PRESET_IDENTITIES.cindy, CINDY_DEFAULT_IDENTITY]) {
      expect(inferBotTemplatePresetId(identity + '\nMy own instructions')).toBeNull();
    }
  });
});

it('only offers Cindy; retired role names no longer resolve to templates', () => {
  expect(BOT_TEMPLATE_PRESET_IDS).toEqual(['cindy']);
  expect(isBotTemplatePresetId('dash')).toBe(false);
  expect(isBotTemplatePresetId('lizi')).toBe(false);
});
