import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { isImageBytesReachable, loadImageSourceBase64 } from '@/lib/annotationBurnIn';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

export async function saveImageAs(src: string) {
  // The save dialog accepts plain base64 data URLs. Preserve original bytes
  // for URL-encoded images and images with extra MIME parameters as well.
  if (/^data:image\//i.test(src) && !/^data:image\/[a-z0-9+.-]+;base64,/i.test(src)) {
    const { base64, mimeType } = await loadImageSourceBase64(src);
    src = `data:${mimeType};base64,${base64}`;
  }
  return window.electronAPI.saveMediaAs({ url: src });
}

export function DownloadImageMenuItem({ src }: { src: string }) {
  const { t } = useTranslation();
  if (!isImageBytesReachable(src)) return null;

  async function download() {
    try {
      const result = await saveImageAs(src);
      if (!result.canceled) toast.success(t('chat.media.imageSaved'));
    } catch (error) {
      toast.error(t(mapIpcErrorToI18nKey(error, { fallback: 'chat.media.saveFailed' })));
    }
  }

  return (
    <DropdownMenuItem onSelect={() => void download()}>
      <Download className="mr-2 h-4 w-4" />
      {t('chat.shareImage.download')}
    </DropdownMenuItem>
  );
}
