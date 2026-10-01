import { i18n } from '@/i18n';
import { formatPresentationDate, formatPresentationTime } from './dateFormatters';
import type {
  PresentationLocalizer,
  PresentationTranslator,
} from '@cindy/maker-shared/presentation-localization';

export const mobilePresentationTranslate: PresentationTranslator = (key, fallback, values) =>
  i18n.t(key, { defaultValue: fallback, ...values });

export const mobilePresentationLocalizer: PresentationLocalizer = {
  translate: mobilePresentationTranslate,
  formatDate: (date) => formatPresentationDate(date, i18n.resolvedLanguage || i18n.language),
  formatTime: (date) => formatPresentationTime(date, i18n.resolvedLanguage || i18n.language),
};
