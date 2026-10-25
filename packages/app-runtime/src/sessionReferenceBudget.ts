export const MAX_SESSION_REFERENCES = 8;
export const MAX_REFERENCE_MESSAGES = 20;
export const MAX_REFERENCE_TOKENS = 8_000;

export function estimateReferenceTokens(text: string): number {
  let wide = 0;
  let ascii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) <= 0x7f) ascii += 1;
    else wide += 1;
  }
  return wide + Math.ceil(ascii / 4);
}
