import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import { SHARE_EXCLUDE_ATTR, SHARE_PENDING_IMAGE_ATTR } from '@/lib/shareConversationImage';
import { cn } from '@/lib/utils';

/** Keep a visible frame until the browser has received and decoded the image. */
export function ChatLoadingImage(props: ComponentProps<'img'>) {
  // A changed URL starts a fresh load, including late remote-origin resolution.
  return <ImageLoad key={props.src} {...props} />;
}

function ImageLoad({ onLoad, style, className, ...props }: ComponentProps<'img'>) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && (
        <span
          {...{ [SHARE_EXCLUDE_ATTR]: '' }}
          role="status"
          aria-label={t('chat.imageMissing.loading')}
          className="inline-flex min-h-[180px] w-[280px] max-w-full self-start items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-tertiary)]"
        >
          <Spinner size={16} aria-hidden="true" />
        </span>
      )}
      <img
        {...props}
        // 分享图自己读图片字节,不必等这里加载完:克隆时去掉占位、显示这张图。
        {...(loaded ? {} : { [SHARE_PENDING_IMAGE_ATTR]: '' })}
        className={cn(
          className,
          loaded && 'motion-safe:animate-fade-in',
        )}
        style={loaded ? style : { ...style, display: 'none' }}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (typeof image.decode === 'function') {
            void image.decode().then(
              () => {
                if (image.isConnected) setLoaded(true);
              },
              () => {
                // Reuse the existing error/retry path; a replaced image must not
                // report a late decode failure against the new source.
                if (!image.isConnected) return;
                setLoaded(true);
                image.dispatchEvent(new Event('error'));
              },
            );
          } else {
            setLoaded(true);
          }
          onLoad?.(event);
        }}
      />
    </>
  );
}
