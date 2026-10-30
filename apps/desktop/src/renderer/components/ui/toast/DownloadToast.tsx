import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { FileTransferToast } from '@/lib/fileTransferToasts';
import { Toast } from './Toast';

export function DownloadToast({ items }: { items: readonly FileTransferToast[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (items.length < 2) setOpen(false);
  }, [items.length]);
  if (!items.length) return null;

  const first = items[0];
  return (
    <div data-download-toast data-toast-id="file-transfers" className="max-w-[calc(100%_-_32px)]">
      {items.length === 1 ? (
        <Toast item={first} />
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <Toast
            item={{
              ...first,
              message: t('chat.remoteFile.downloadsInProgress', { count: items.length }),
              action: undefined,
            }}
            message={
              <PopoverTrigger asChild>
                <Button variant="secondary" tone="quiet" size="sm" compact className="gap-2 text-13">
                  {t('chat.remoteFile.downloadsInProgress', { count: items.length })}
                  {open ? (
                    <ChevronUp className="h-4 w-4 shrink-0" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0" />
                  )}
                </Button>
              </PopoverTrigger>
            }
          />
          <PopoverContent
            className="pointer-events-auto z-[10101] w-[440px] max-w-[calc(100vw_-_32px)] p-2"
            sideOffset={8}
            aria-label={t('chat.remoteFile.downloadsInProgress', { count: items.length })}
          >
            <ul className="max-h-[min(360px,60vh)] overflow-y-auto">
              {items.map((item) => (
                <li
                  key={item.id}
                  data-download-id={item.id}
                  className="flex items-center gap-3 border-b border-[var(--border-default)] px-2 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-13 font-medium leading-5 text-[var(--text-primary)] [overflow-wrap:anywhere]">
                      {item.name}
                    </div>
                    <div className="mt-1 text-12 leading-normal tabular-nums text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                      {item.message}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    compact
                    className="shrink-0"
                    aria-label={`${item.action?.label} ${item.name}`}
                    onClick={item.action?.onClick}
                  >
                    {item.action?.label}
                  </Button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
