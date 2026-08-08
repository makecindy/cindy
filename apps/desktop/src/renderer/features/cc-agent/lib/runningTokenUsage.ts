export function formatRunningTokenUsage(tokenUsage: number, isRunning: boolean): string {
  if (isRunning && tokenUsage === 0) return '— tokens';
  return tokenUsage >= 1000
    ? `${(tokenUsage / 1000).toFixed(1)}k tokens`
    : `${tokenUsage} tokens`;
}
