export const GROUP_WINDOW_ENTRY_TEXT_MAX_CHARS = 500;

export function createFenceNeutralizer(
  tags: readonly string[],
): (value: string) => string {
  const pattern = new RegExp(`<(\\/?)(${tags.join("|")})`, "gi");
  return (value) => value.replace(pattern, "<\u200b$1$2");
}
