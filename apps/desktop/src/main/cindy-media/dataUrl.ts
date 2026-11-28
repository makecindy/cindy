/**
 * Re-export shared linear `data:` URL / Base64 helpers from `@cindy/maker-shared`
 * so existing desktop imports stay intact (#5081).
 */
export {
  base64DecodedByteLength,
  forEachInlineBase64DataUrl,
  isCanonicalBase64,
  isLooseBase64Chars,
  isStrictBase64Chars,
  normalizeBase64Payload,
  parseBase64DataUrl,
  parseDataUrl,
  replaceInlineBase64DataUrls,
  type InlineBase64DataUrlOptions,
  type ParseBase64DataUrlOptions,
  type ParsedBase64DataUrl,
  type ParsedDataUrl,
} from '@cindy/maker-shared';
