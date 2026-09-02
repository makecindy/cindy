/** 成长尾注深链可短暂高亮对应列表。 */
export type BotSettingsHighlightId = 'memory' | 'learned';

export function resolveBotSettingsHighlight(
  value: string | null | undefined,
): BotSettingsHighlightId | null {
  return value === 'memory' || value === 'learned' ? value : null;
}

/** 跳到记忆和成长页，并高亮对应列表。 */
export function buildBotGrowthSettingsPath(
  botId: string,
  highlight: BotSettingsHighlightId,
): string {
  return `/bots/${encodeURIComponent(botId)}?settings=1&anchor=grew&highlight=${highlight}`;
}
