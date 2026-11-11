import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import {
  SHARE_DEFERRED_IMAGE_SRC_ATTR,
  SHARE_EXCLUDE_ATTR,
  SHARE_PENDING_IMAGE_ATTR,
} from '@/lib/shareConversationImage';
import { cn } from '@/lib/utils';
import { REMOTE_MEDIA_SCHEME } from '@/../shared/remoteMediaUrl';

/**
 * How far outside the scroll viewport an image from another computer starts
 * loading, in viewport heights above and below. Generous on purpose, so
 * switching back to a task or scrolling normally finds images already there;
 * only images far away wait instead of all competing for the device link.
 */
const REMOTE_PRELOAD_VIEWPORTS = 3;

/** Keep a visible frame until the browser has received and decoded the image. */
export function ChatLoadingImage(props: ComponentProps<'img'>) {
  // A changed URL starts a fresh load, including late remote-origin resolution.
  return <ImageLoad key={props.src} {...props} />;
}

/** The nearest ancestor that actually scrolls vertically; the margin follows its height. */
function scrollRootOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    if (scrollable && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Remote images are fetched from the other computer on request. The hidden
 * `<img>` cannot use native lazy loading (it never becomes visible), so the
 * visible placeholder is observed instead. Once near, it stays near.
 */
function useNearScrollViewport(defer: boolean) {
  const placeholderRef = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(!defer);
  useEffect(() => {
    if (near) return;
    const placeholder = placeholderRef.current;
    if (!placeholder || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    let observer: IntersectionObserver | null = null;
    const observeNearScroll = () => {
      const root = scrollRootOf(placeholder);
      // rootMargin percentages resolve against the root's width, so use pixels.
      const preload = Math.round(REMOTE_PRELOAD_VIEWPORTS * (root?.clientHeight ?? window.innerHeight));
      const intersection = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          intersection.disconnect();
          setNear(true);
        },
        { root, rootMargin: `${preload}px 0px` },
      );
      intersection.observe(placeholder);
      observer = intersection;
    };
    // Inside a hidden panel (e.g. an inactive sidebar tab) nothing has a size yet, so
    // the scroll root cannot be found. Wait until the placeholder is laid out.
    if (placeholder.getClientRects().length === 0 && typeof ResizeObserver !== 'undefined') {
      const layout = new ResizeObserver(() => {
        if (placeholder.getClientRects().length === 0) return;
        layout.disconnect();
        observeNearScroll();
      });
      layout.observe(placeholder);
      return () => {
        layout.disconnect();
        observer?.disconnect();
      };
    }
    observeNearScroll();
    return () => observer?.disconnect();
  }, [near]);
  return { placeholderRef, near };
}

function ImageLoad({ onLoad, style, className, src, ...props }: ComponentProps<'img'>) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const remote = typeof src === 'string' && src.startsWith(`${REMOTE_MEDIA_SCHEME}:`);
  const { placeholderRef, near } = useNearScrollViewport(remote);
  return (
    <>
      {!loaded && (
        <span
          ref={placeholderRef}
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
        src={near ? src : undefined}
        // 分享图自己读图片字节,不必等这里加载完:克隆时去掉占位、显示这张图;
        // 还没开始取的远程图把地址交给分享管线。
        {...(loaded ? {} : { [SHARE_PENDING_IMAGE_ATTR]: '' })}
        {...(near ? {} : { [SHARE_DEFERRED_IMAGE_SRC_ATTR]: src })}
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
