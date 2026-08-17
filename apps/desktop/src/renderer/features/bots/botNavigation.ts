export function shouldDeferCanonicalBotSessionNavigation(input: {
  settingsOpen: boolean;
  addOpen: boolean;
  addRequested: boolean;
}): boolean {
  return input.settingsOpen || input.addOpen || input.addRequested;
}
