export type PlaintextEditorChrome = 'code' | 'markdown' | 'plain';

const HEX_COLOR_RE =
  /(^|[^0-9A-Za-z_#])(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))(?![\w])/g;

export function findHexColors(
  text: string,
): Array<{ from: number; to: number; color: string }> {
  return Array.from(text.matchAll(HEX_COLOR_RE), (match) => {
    const from = (match.index ?? 0) + match[1].length;
    return { from, to: from + match[2].length, color: match[2] };
  });
}

export function getPlaintextEditorChrome(language: string | undefined): PlaintextEditorChrome {
  const normalizedLanguage = language?.toLowerCase();
  const isMarkdown = normalizedLanguage === 'markdown' || normalizedLanguage === 'md';
  if (isMarkdown) return 'markdown';
  if (normalizedLanguage) return 'code';
  return 'plain';
}
