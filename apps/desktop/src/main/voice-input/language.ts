export function elevenLabsLanguageCode(sourceLanguage: string): string | undefined {
  const normalized = sourceLanguage.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return undefined;

  switch (normalized) {
    case 'chinese':
    case 'mandarin':
    case 'simplified chinese':
    case 'traditional chinese':
      return 'zho';
    case 'cantonese':
      return 'yue';
    case 'english':
      return 'en';
    case 'japanese':
      return 'ja';
    case 'korean':
      return 'ko';
  }

  const primary = normalized.split(/[-_]/)[0];
  switch (primary) {
    case 'zh':
      return 'zho';
    case 'yue':
      return 'yue';
    default:
      return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
  }
}

export function openAiLanguageCode(sourceLanguage: string): string | undefined {
  const normalized = sourceLanguage.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return undefined;

  switch (normalized) {
    case 'chinese':
    case 'mandarin':
    case 'simplified chinese':
    case 'traditional chinese':
      return 'zh';
    case 'cantonese':
      return 'yue';
    case 'english':
      return 'en';
    case 'japanese':
      return 'ja';
    case 'korean':
      return 'ko';
  }

  const primary = normalized.split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

/**
 * The Volcengine bigmodel_async endpoint has no documented zh-TW wire value.
 * Normalize Chinese UI locales to its documented Mandarin hint instead of
 * sending the UI locale through as an unvalidated provider parameter.
 */
export function volcengineSaucLanguageCode(sourceLanguage: string): string | undefined {
  const normalized = sourceLanguage.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return undefined;
  if (
    ['chinese', 'mandarin', 'simplified chinese', 'traditional chinese'].includes(normalized) ||
    normalized.split(/[-_]/)[0] === 'zh'
  ) {
    return 'zh-CN';
  }
  return sourceLanguage.trim();
}
