import EmojiPicker from 'emoji-picker-react';
import { useTranslation } from 'react-i18next';
import './FullReactionPicker.css';

const dictionaries = {
  de: () => import('emoji-picker-react/data/emojis-de'),
  es: () => import('emoji-picker-react/data/emojis-es'),
  fr: () => import('emoji-picker-react/data/emojis-fr'),
  ja: () => import('emoji-picker-react/data/emojis-ja'),
  ko: () => import('emoji-picker-react/data/emojis-ko'),
  pt: () => import('emoji-picker-react/data/emojis-pt'),
  zh: () => import('emoji-picker-react/data/emojis-zh'),
  'zh-Hant': () => import('emoji-picker-react/data/emojis-zh-hant'),
};

export default function FullReactionPicker({ onChoose }: { onChoose: (emoji: string, from?: DOMRect) => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const language = /^zh-(TW|Hant)/i.test(locale) ? 'zh-Hant' : locale.split('-')[0];
  const dictionary = Object.hasOwn(dictionaries, language) ? dictionaries[language as keyof typeof dictionaries] : undefined;
  const search = t('sidebar.navigation.items.search');
  return <EmojiPicker className="chat-full-reaction-picker" emojiStyle="native" emojiData={dictionary}
    width="min(264px, calc(100vw - 40px))" height="var(--chat-reaction-catalog-height)"
    previewConfig={{ showPreview: false }}
    labels={{ searchPlaceholder: search, searchLabel: search, searchClear: t('commonUi.clearSearch'),
      searchResultsNone: t('ccAgent.workdirBrowse.searchPanel.noResults'), loading: t('bots.groupChat.files.loading'), retryLoading: t('bots.retry') }}
    onEmojiClick={({ emoji }, event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      onChoose(emoji, button?.getBoundingClientRect());
    }} />;
}
