import { lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AttachmentCollectionContext,
  ActivePreviewCollection,
  AttachmentPreviewOwnerContext,
  type AttachmentCollectionItem,
  type PreviewLeaveGuard,
} from './AttachmentCollectionContext';
export {
  AttachmentCollectionContext,
  ActivePreviewCollection,
  AttachmentPreviewOwnerContext,
  useOpeningCollection,
  type AttachmentCollectionItem,
  type AttachmentPreviewOwner,
  type PreviewLeaveGuard,
  type PreviewLeaveOutcome,
} from './AttachmentCollectionContext';
import { ImageLightbox } from './ImageLightbox';
import { VideoLightbox } from './VideoLightbox';
import { createPortal } from 'react-dom';
import { PREVIEW_PANEL_CLASS, PREVIEW_PANEL_STYLE, PreviewHeader, PreviewScrim } from './PreviewChrome';
import { Spinner } from '@/components/ui/spinner';
import { lightboxOwnsShortcutTarget } from '@/lib/lightboxLayer';
const TextLightbox = lazy(() =>
  import('./TextLightbox').then((module) => ({ default: module.TextLightbox })),
);
import { ChatSessionFileProvider, useChatSessionFile } from './ChatSessionFileContext';
import { ImageGalleryContext } from './ImageGalleryContext';

export type CollectionImageProps = NonNullable<AttachmentCollectionItem['image']>;

/** Snapshot the opening collection and file origin. Live messages cannot retarget an open viewer. */
export function AttachmentCollectionPreview({
  items: openingItems,
  source,
  onClose,
  initial,
  initialLine,
  triggerRef,
  leaveGuardRef,
}: {
  items: readonly AttachmentCollectionItem[];
  source: string;
  onClose(): void;
  initial?: ReactNode | ((imageProps: CollectionImageProps | undefined) => ReactNode);
  initialLine?: number;
  triggerRef?: React.RefObject<HTMLElement | null>;
  leaveGuardRef?: { current: PreviewLeaveGuard | null };
}) {
  const [snapshot] = useState(() => [...openingItems]);
  // Keep the opening order and identity, but read live annotation metadata for
  // those stable ids so returning to an item does not restore a stale draft.
  const items = snapshot.map((item) => {
    const live = openingItems.find((next) => next.id === item.id);
    return live ? { ...item, image: live.image } : item;
  });
  const [start] = useState(() =>
    Math.max(
      0,
      snapshot.findIndex((item) => item.source === source),
    ),
  );
  const [index, setIndex] = useState(start);
  const fileContext = useChatSessionFile();
  const [origin] = useState(fileContext);
  const beforeLeave = useRef<PreviewLeaveGuard | null>(null);
  const scopeRef = useRef<HTMLElement | null>(null);
  const item = items[index]!;
  const previewOwner = useContext(AttachmentPreviewOwnerContext);
  const onActiveIdChange = previewOwner?.onActiveIdChange;
  useEffect(() => {
    if (item.id) onActiveIdChange?.(item.id);
  }, [item.id, onActiveIdChange]);
  const closing = useRef(false);
  const close = () => {
    closing.current = true;
    onClose();
  };
  const restoreFocus = (event: Event) => {
    if (!triggerRef) return;
    event.preventDefault();
    const trigger = triggerRef.current;
    if (closing.current && trigger && document.contains(trigger)) trigger.focus({ preventScroll: true });
  };
  const select = (next: number) => {
    if (next < 0 || next >= items.length || next === index) return;
    const leave = () => {
      beforeLeave.current = null;
      setIndex(next);
    };
    if (beforeLeave.current) void beforeLeave.current(leave);
    else leave();
  };
  const selectRef = useRef(select);
  selectRef.current = select;
  // Host source changes must settle through the currently mounted collection
  // item, not the unmounted initial item's guard.
  useEffect(() => {
    if (!leaveGuardRef) return;
    const guard: PreviewLeaveGuard = async (leave) => {
      const current = beforeLeave.current;
      if (!current) {
        leave();
        return 'applied';
      }
      return current(leave);
    };
    leaveGuardRef.current = guard;
    return () => {
      leaveGuardRef.current = null;
    };
  }, [leaveGuardRef]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.fullscreenElement) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"], video, audio, [role="menu"]'))
        return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      // The image preview is non-modal: its collection arrows must not consume
      // keys whose focus belongs to the conversation behind the float. Modal
      // viewers keep their existing document-level navigation.
      const panel = scopeRef.current;
      if (panel && !lightboxOwnsShortcutTarget(event.target, panel)) return;
      event.preventDefault();
      selectRef.current(index + (event.key === 'ArrowLeft' ? -1 : 1));
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [index]);
  return (
    <ChatSessionFileProvider value={origin}>
      <AttachmentCollectionContext.Provider value={null}>
        <ImageGalleryContext.Provider value={null}>
          <ActivePreviewCollection.Provider value={{ items, index, select, beforeLeave, scopeRef, restoreFocus }}>
            <Suspense
              key={item.id}
              fallback={createPortal(
                <>
                  <PreviewScrim onClose={close} />
                  <div
                    className={`z-fullscreen flex items-center justify-center ${PREVIEW_PANEL_CLASS}`}
                    style={PREVIEW_PANEL_STYLE}
                  >
                    <PreviewHeader name={item.name} onClose={close} />
                    <Spinner />
                  </div>
                </>,
                document.body,
              )}
            >
              {index === start && initial ? (
                typeof initial === 'function' ? initial(item.image) : initial
              ) : item.media && item.kind === 'image' ? (
                <ImageLightbox
                  src={item.source}
                  filename={item.name}
                  previewOwnerId={item.id}
                  {...item.image}
                  onClose={close}
                />
              ) : item.media && (item.kind === 'video' || item.kind === 'audio') ? (
                <VideoLightbox
                  src={item.source}
                  filename={item.name}
                  kind={item.kind}
                  onClose={close}
                />
              ) : (
                <TextLightbox
                  filePath={item.source}
                  fileName={item.name}
                  initialLine={index === start ? initialLine : undefined}
                  onClose={close}
                />
              )}
            </Suspense>
          </ActivePreviewCollection.Provider>
        </ImageGalleryContext.Provider>
      </AttachmentCollectionContext.Provider>
    </ChatSessionFileProvider>
  );
}
