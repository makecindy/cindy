export function formatRunningTokenCount(tokenUsage: number, isRunning: boolean): string {
  if (isRunning && tokenUsage === 0) return '—';
  return tokenUsage >= 1000
    ? `${(tokenUsage / 1000).toFixed(1)}k`
    : `${tokenUsage}`;
}
