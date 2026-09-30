/**
 * Either legacy ownership signal is enough to keep a caller on the Bot surface.
 * Requiring both lets a partial Bot record fall through to the full default
 * surface, which includes Session control and history.
 */
export function classifyHelperSurface(
  source: string | null | undefined,
  hasBotLink: boolean,
): 'bot' | 'default' {
  return source === 'bot' || hasBotLink ? 'bot' : 'default';
}
