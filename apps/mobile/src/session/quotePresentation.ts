export function compactQuoteLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
