let lastResolvedIsDark: boolean | undefined;

export type AppThemeMode = 'system' | 'light' | 'dark';

export function isAppThemeMode(value: unknown): value is AppThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Keep the renderer-resolved app theme available for windows created later. */
export function rememberResolvedAppTheme(isDark: boolean): void {
  lastResolvedIsDark = isDark;
}

/** Fall back to the persisted theme snapshot until the renderer resolves this run's preference. */
export function resolveAppThemeIsDark(
  systemIsDark: boolean,
  persistedMode: AppThemeMode = 'system',
  persistedResolvedIsDark?: boolean,
): boolean {
  if (lastResolvedIsDark !== undefined) return lastResolvedIsDark;
  if (persistedMode === 'system') return systemIsDark;
  if (persistedResolvedIsDark !== undefined) return persistedResolvedIsDark;
  if (persistedMode === 'dark') return true;
  if (persistedMode === 'light') return false;
  return systemIsDark;
}
