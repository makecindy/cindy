import { i18n } from '@/i18n';

function normalizedVoiceLanguage(language: string | null | undefined): string | undefined {
  const value = language?.trim();
  return value || undefined;
}

/**
 * `auto` 对 ASR 的语义是让 provider 自行探测，不得把 App UI 语言强塞进识别提示。
 * 托管 voice-server 请求在这里归一化；直连 provider 在各自协议边界省略 `auto` 提示。
 */
export function resolveMobileVoiceAsrLanguage(
  language: string | null | undefined,
): string | undefined {
  const value = normalizedVoiceLanguage(language);
  return !value || value.toLowerCase() === 'auto' ? undefined : value;
}

/** 当前 Mobile UI 的实际生效语言；手动 override 已由 LocaleProvider 同步给 i18next。 */
export function currentMobileVoiceUiLanguage(): string {
  return normalizedVoiceLanguage(i18n.resolvedLanguage)
    ?? normalizedVoiceLanguage(i18n.language)
    ?? 'en';
}

/**
 * 润色与词典学习需要一个具体语言作上下文；显式语音语言优先，`auto` 则回落 UI 语言。
 * 这与 ASR 的自动探测刻意分离，避免中英混说被错误锁定。
 */
export function resolveMobileVoiceRefinementSourceLanguage(
  language: string | null | undefined,
  uiLanguage = currentMobileVoiceUiLanguage(),
): string {
  return resolveMobileVoiceAsrLanguage(language)
    ?? normalizedVoiceLanguage(uiLanguage)
    ?? 'en';
}
