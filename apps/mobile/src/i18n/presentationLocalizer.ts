import { i18n } from '@/i18n';
import type {
  PresentationLocalizer,
  PresentationTranslator,
} from '@cindy/maker-shared/presentation-localization';

export const mobilePresentationTranslate: PresentationTranslator = (key, fallback, values) =>
  i18n.t(key, { defaultValue: fallback, ...values });

export const mobilePresentationLocalizer: PresentationLocalizer = {
  translate: mobilePresentationTranslate,
  formatDate: (date) => new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language).format(date),
  formatTime: (date) => new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date),
};
