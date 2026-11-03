import { useTranslation } from 'react-i18next';
import { LocalModelTag } from './LocalModelDownloadUI';

import { detectOllamaPackaging } from '../../../shared/localModelRuntime';

export function LocalPackagingTag({ libraryName }: { libraryName: string }) {
  const { t } = useTranslation();
  const packaging = detectOllamaPackaging(libraryName);
  if (!packaging) return null;
  return <LocalModelTag>{t(`settings.providers.local.packaging.${packaging}`)}</LocalModelTag>;
}
