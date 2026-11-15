/**
 * Desktop projects plugin cards into inert text and backslash-escapes every Markdown punctuation
 * mark (`cardRemoteResource.ts`). The phone's Markdown renderer keeps those backslashes (and reads
 * `\(`…`\)` as a formula), so card text is shown as plain text with the escapes removed.
 */
export function pluginCardPlainText(escaped: string): string {
  return escaped.replace(/\\([\\`*_{}[\]()<>#+.!|~-])/g, '$1');
}
