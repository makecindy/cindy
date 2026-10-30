/**
 * Keep the development Forge process above the one-shot rebuild peak observed
 * in the desktop main target. An explicit developer override always wins.
 */
export const DESKTOP_DEV_MAX_OLD_SPACE = 6144;

const MAX_OLD_SPACE_OPTION = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s)/;

export function withDesktopDevNodeOptions(env = process.env) {
  const next = { ...env };
  const existing = next.NODE_OPTIONS?.trim() ?? '';
  if (!MAX_OLD_SPACE_OPTION.test(existing)) {
    next.NODE_OPTIONS = [existing, `--max-old-space-size=${DESKTOP_DEV_MAX_OLD_SPACE}`]
      .filter(Boolean)
      .join(' ');
  }
  return next;
}
