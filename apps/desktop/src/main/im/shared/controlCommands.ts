/**
 * `!stop` control command shared by the normal message router and channel
 * interaction interceptors. Keep this leaf module dependency-free so prompts
 * can bypass stop handling without importing the full message pipeline.
 */
export function isStopCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '!stop' || normalized === '！stop';
}
