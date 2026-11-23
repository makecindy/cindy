import { createContext, useContext } from 'react';
import type { PreviewItem } from '@cindy/maker-shared/attachment-preview';
import type { AnnotationStroke } from './lightboxAnnotations';

/** Image props accepted by a collection item, kept structural to avoid a type cycle. */
export type AttachmentCollectionImageProps = {
  src?: string;
  annotationEdit?: {
    initialStrokes?: readonly AnnotationStroke[];
    onDraftChange?: (result: { strokes: AnnotationStroke[] }) => void;
    onSave: (result: { strokes: AnnotationStroke[] }) => void | Promise<void>;
  };
  initialStrokes?: readonly AnnotationStroke[];
  annotationFallbackSrc?: string;
  annotationDisabled?: boolean;
};

export type AttachmentCollectionItem = PreviewItem & {
  /** Media URLs are already resolved by the opening surface; files retain host paths. */
  media?: boolean;
  image?: AttachmentCollectionImageProps;
};

/** A present live item with no strokes is an explicitly cleared draft, not a missing baseline. */
export function normalizedLiveCollectionItem(
  item: AttachmentCollectionItem,
): AttachmentCollectionItem {
  const liveStrokes =
    item.image?.initialStrokes ?? item.image?.annotationEdit?.initialStrokes ?? [];
  if (!item.image) {
    return item.kind === 'image' ? { ...item, image: { initialStrokes: liveStrokes } } : item;
  }
  return {
    ...item,
    image: {
      ...item.image,
      initialStrokes: liveStrokes,
      annotationEdit: item.image.annotationEdit
        ? { ...item.image.annotationEdit, initialStrokes: liveStrokes }
        : undefined,
    },
  };
}

export type PreviewLeaveOutcome = 'applied' | 'cancelled' | 'busy';
export type PreviewLeaveGuard = (leave: () => void) => Promise<PreviewLeaveOutcome>;

export const AttachmentCollectionContext = createContext<
  readonly AttachmentCollectionItem[] | null
>(null);
export const ActivePreviewCollection = createContext<{
  items: readonly AttachmentCollectionItem[];
  index: number;
  select(index: number): void;
  beforeLeave: { current: PreviewLeaveGuard | null };
  /** The foreground image preview registers its non-modal keyboard scope here. */
  scopeRef: { current: HTMLElement | null };
  restoreFocus?(event: Event): void;
} | null>(null);

export function useOpeningCollection(source: string) {
  const items = useContext(AttachmentCollectionContext);
  return items && items.length > 1 && items.some((item) => item.source === source) ? items : null;
}
