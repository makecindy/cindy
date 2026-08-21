let lastResolvedIsDark: boolean | undefined;

/** Keep the renderer-resolved app theme available for windows created later. */
export function rememberResolvedAppTheme(isDark: boolean): void {
  lastResolvedIsDark = isDark;
}

/** Fall back to the OS theme until the renderer has resolved the app preference. */
export function resolveAppThemeIsDark(systemIsDark: boolean): boolean {
  return lastResolvedIsDark ?? systemIsDark;
}
