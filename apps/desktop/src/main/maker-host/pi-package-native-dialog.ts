const UNSAFE_NATIVE_DIALOG_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function visibleUnicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return '';
  const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
  return `\\u{${hex}}`;
}

/**
 * Makes untrusted Pi package text unambiguous inside a native dialog.
 *
 * Mutation grants and Pi execution keep using the original request. This is
 * display-only: embedded controls, line separators, and Unicode formatting
 * characters (including bidi controls) become visible escapes. Existing
 * backslashes are doubled whenever escaping is needed so a literal source
 * cannot imitate an escaped control character.
 */
export function escapePiPackageNativeDialogText(value: string): string {
  const trimmed = value.trim();
  if (!UNSAFE_NATIVE_DIALOG_CHARACTER.test(trimmed)) return trimmed;

  let escaped = '';
  for (const character of trimmed) {
    if (character === '\\') {
      escaped += '\\\\';
    } else if (UNSAFE_NATIVE_DIALOG_CHARACTER.test(character)) {
      escaped += visibleUnicodeEscape(character);
    } else {
      escaped += character;
    }
  }
  return escaped;
}
