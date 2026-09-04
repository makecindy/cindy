export const BOT_TEMPLATE_PRESET_IDS = ['cindy', 'dash', 'lizi'] as const;

export type BotTemplatePresetId = (typeof BOT_TEMPLATE_PRESET_IDS)[number];

export function isBotTemplatePresetId(value: unknown): value is BotTemplatePresetId {
  return (
    typeof value === 'string' && (BOT_TEMPLATE_PRESET_IDS as readonly string[]).includes(value)
  );
}
