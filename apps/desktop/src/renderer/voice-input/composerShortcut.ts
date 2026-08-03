export function hasComposerModifier(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>,
  platform: string | undefined,
): boolean {
  return event.ctrlKey || (platform === 'darwin' && event.metaKey);
}
