import { createContext, useContext, type ComponentProps } from 'react';
import type { PreviewItem } from '@cindy/maker-shared/attachment-preview';
import type { ImageLightbox } from './ImageLightbox';

export type AttachmentCollectionItem = PreviewItem & {
  /** Media URLs are already resolved by the opening surface; files retain host paths. */
  media?: boolean;
  image?: Partial<Pick<
    ComponentProps<typeof ImageLightbox>,
    'src' | 'annotationEdit' | 'initialStrokes' | 'annotationFallbackSrc'
  >>;
};

export const AttachmentCollectionContext = createContext<
  readonly AttachmentCollectionItem[] | null
>(null);
export const ActivePreviewCollection = createContext<{
  items: readonly AttachmentCollectionItem[];
  index: number;
  select(index: number): void;
  beforeLeave: { current: ((leave: () => void) => void) | null };
  restoreFocus?(event: Event): void;
} | null>(null);

export function useOpeningCollection(source: string) {
  const items = useContext(AttachmentCollectionContext);
  return items && items.length > 1 && items.some((item) => item.source === source) ? items : null;
}
