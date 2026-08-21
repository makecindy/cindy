import { useTranslation } from 'react-i18next';

import { detectOllamaPackaging } from '../../../shared/localModelRuntime';

export function LocalPackagingTag({ libraryName }: { libraryName: string }) {
  const { t } = useTranslation();
  const packaging = detectOllamaPackaging(libraryName);
  if (!packaging) return null;
  return (
    <span
      className="rounded-full px-2 py-0.5 text-11 font-medium"
      style={{
        backgroundColor: 'var(--surface-chip)',
        color: 'var(--text-secondary)',
      }}
    >
      {t(`settings.providers.local.packaging.${packaging}`)}
    </span>
  );
}
