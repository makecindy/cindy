/** Explicit ordered images supplied by the opening surface. In a task this is every
 * image in the loaded history (MessageStream derives it from render data, never the DOM);
 * group chat, drafts and file lists supply their own narrower lists.
 * Portals retain this scope. Annotation metadata travels with each image so switching
 * keeps editable strokes.
 */
import { createContext } from 'react';
import type { AnnotationStroke } from './lightboxAnnotations';
import type { AttachmentCollectionItem } from './AttachmentCollectionContext';
import { previewSourceName } from '@cindy/maker-shared/attachment-preview';

/** 会话画廊里的一张图:src 为渲染所用 URL(标注图 = 烧录图)。 */
export interface GalleryImage {
  src: string;
  /**
   * Optional stable identity for images rendered outside the host DOM, such as
   * plugin card iframe images. It disambiguates repeated URLs when opening the
   * conversation gallery from one of those images.
   */
  galleryId?: string;
  /** 烧录标注图的未烧录原图 URL(与 ImageRef.annotationSourceUrl 同源)。 */
  annotationSourceUrl?: string;
  /** 持久化的矢量笔迹;与 annotationSourceUrl 成对出现才有意义。 */
  annotationStrokes?: readonly AnnotationStroke[];
  /** Render item that shows this image. Repeated URLs open at the clicked row. */
  scope?: string;
  /**
   * Markdown destination as written in the reply. The rendered address is
   * re-encoded or resolved asynchronously, so a click from a reply image matches on this.
   */
  target?: string;
  /** Reply repeat identity: the text section rendering it and which repeat of `target` there. */
  occurrence?: GalleryOccurrence;
  /**
   * Reply image written relative to the task folder. The folder search may settle
   * after the gallery is built, so the viewer resolves it when shown, as the reply
   * does; `src` is the address known when the gallery was built.
   */
  workspace?: GalleryWorkspacePath;
  /** Original attachment name when the message carries one. */
  name?: string;
  /** Explicit caption for this occurrence of a structured reply image. */
  caption?: string;
}

export interface GalleryOccurrence {
  /** Section of a reply (see replySectionId) that renders the image. */
  section: string;
  /** Which repeat of the destination within that section (0 for the first). */
  index: number;
}

/**
 * Identity of one rendered section of a reply: a plain-text part (by its source
 * offset) or one component node inside a component block. The gallery and the
 * reply renderer derive it the same way, so identical text in two sections stays apart.
 */
export function replySectionId(messageKey: string, partKey: number, nodeId?: string): string {
  return nodeId === undefined ? `${messageKey}\u0000${partKey}` : `${messageKey}\u0000${partKey}\u0000${nodeId}`;
}

/**
 * Section of the images a row lists from message data rather than reply text: user
 * uploads and tool / plugin-card media outside the card itself. Plugin-card images
 * are identified by galleryId instead.
 */
export const STRUCTURED_IMAGE_SECTION = '\u0000structured';

/** Which repeat of its address each image is, in row order (0 for the first). */
export function repeatIndexes(srcs: readonly string[]): number[] {
  const seen = new Map<string, number>();
  return srcs.map((src) => {
    const index = seen.get(src) ?? 0;
    seen.set(src, index + 1);
    return index;
  });
}

export function structuredImageOccurrence(index: number): GalleryOccurrence {
  return { section: STRUCTURED_IMAGE_SECTION, index };
}

export interface GalleryWorkspacePath {
  path: string;
  workingDir: string;
  /** Loadable address for the settled local path (the reply's own derivation). */
  address: (local: string | undefined) => string | undefined;
}

/** Opening surface collection. Without a provider the viewer shows only its source. */
export const ImageGalleryContext = createContext<readonly GalleryImage[] | null>(null);
/** Key of the render item that contains the opening image. */
export const ImageGalleryScopeContext = createContext<string | null>(null);

export interface GalleryOpening {
  src: string;
  galleryId?: string;
  target?: string;
  occurrence?: GalleryOccurrence;
  scope?: string | null;
}

/**
 * Where the clicked image sits in the gallery, or -1 when it is not part of it.
 * Identity wins over URL. Inside a task the clicked row is known, and only that
 * row's entries count: an image the gallery does not hold (a reply still
 * streaming) must not open at a copy of the same URL elsewhere.
 */
export function galleryOpeningIndex(
  images: readonly GalleryImage[] | null,
  opening: GalleryOpening,
): number {
  if (!images?.length) return -1;
  if (opening.galleryId) {
    const keyed = images.findIndex((image) => image.galleryId === opening.galleryId);
    if (keyed >= 0) return keyed;
  }
  if (opening.scope) {
    const inScope = (image: GalleryImage) =>
      image.scope === opening.scope &&
      (opening.target ? image.target === opening.target : image.src === opening.src);
    // A reply can show the same image twice; open at the repeat that was clicked.
    const clicked = opening.occurrence;
    if (clicked) {
      const repeat = images.findIndex(
        (image) =>
          inScope(image) &&
          image.occurrence?.index === clicked.index &&
          image.occurrence.section === clicked.section,
      );
      if (repeat >= 0) return repeat;
    }
    return images.findIndex(inScope);
  }
  return images.findIndex((image) => image.src === opening.src);
}

/** The entry matched the reply destination, not the clicked address. */
export function galleryOpeningByTarget(image: GalleryImage | undefined, opening: GalleryOpening): boolean {
  return !!image && !!opening.target && image.target === opening.target;
}

/** Keep the displayed (burned) identity for selection, but edit the original pixels. */
export function galleryImagePreviewItem(image: GalleryImage, id: string): AttachmentCollectionItem {
  return {
    id: image.galleryId ?? id,
    name: image.name || previewSourceName(image.src, 'Image'),
    source: image.src,
    kind: 'image',
    media: true,
    image: image.annotationSourceUrl
      ? { src: image.annotationSourceUrl, initialStrokes: image.annotationStrokes, annotationFallbackSrc: image.src }
      : undefined,
  };
}
