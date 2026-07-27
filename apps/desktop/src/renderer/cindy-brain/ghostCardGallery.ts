/**
 * Ghost card image gallery projection.
 *
 * Card HTML has already been sanitized by Main before it reaches Renderer.
 * This module only projects image references into the host-owned conversation
 * gallery; it does not parse bytes, widen the iframe bridge, or grant plugins
 * any new capability.
 */

import { GHOST_CARD_SPAWN_SEP } from '../../shared/ghost';
import type { GhostCardEntry, GhostCardSnapshot } from './ghostCardStore';
import type { GalleryImage } from '@/components/chat/ImageGalleryContext';

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const ATTR_RE = /([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const CINDY_MEDIA_IMAGE_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/;

type ReadyGhostCardEntry = Extract<GhostCardEntry, { status: 'ready' }>;

function parseAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(tag)) !== null) {
    attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * Returns only images whose click route opens ImageLightbox. Action/link images
 * remain card controls, while model posters continue to open ModelLightbox.
 */
export function extractGhostCardGallerySrcs(html: string): string[] {
  const srcs: string[] = [];
  for (const tag of html.match(IMG_TAG_RE) ?? []) {
    const attrs = parseAttributes(tag);
    const src = attrs.get('src')?.trim() ?? '';
    if (
      CINDY_MEDIA_IMAGE_RE.test(src) &&
      !attrs.has('data-ghost-action') &&
      !attrs.has('data-ghost-link') &&
      !attrs.has('data-ghost-model')
    ) {
      srcs.push(src);
    }
  }
  return srcs;
}

/** Stable identity used to locate duplicate URLs at the exact clicked card image. */
export function ghostCardGalleryId(callId: string, imageIndex: number): string {
  return `ghost-card:${callId}:${imageIndex}`;
}

function visibleCardHtml(entry: ReadyGhostCardEntry, running: boolean): string {
  return running && entry.animatedHtml ? entry.animatedHtml : entry.html;
}

function projectCard(callId: string, entry: ReadyGhostCardEntry, running: boolean): GalleryImage[] {
  return extractGhostCardGallerySrcs(visibleCardHtml(entry, running)).map((src, imageIndex) => ({
    src,
    galleryId: ghostCardGalleryId(callId, imageIndex),
  }));
}

/**
 * Projects a rendered root card followed by its spawned cards, matching
 * GhostToolCard's DOM order. Only entries belonging to this root call are read.
 */
export function collectGhostCardGalleryImages(
  rootCallId: string,
  snapshot: GhostCardSnapshot,
  rootRunning: boolean,
): GalleryImage[] {
  const root = snapshot.byCallId.get(rootCallId);
  const images: GalleryImage[] = [];
  if (root?.status === 'ready') {
    images.push(...projectCard(rootCallId, root, rootRunning || root.state === 'working'));
  }

  const spawnPrefix = rootCallId + GHOST_CARD_SPAWN_SEP;
  const spawned = [...snapshot.byCallId.entries()]
    .filter(
      (entry): entry is [string, ReadyGhostCardEntry] =>
        entry[0].startsWith(spawnPrefix) && entry[1].status === 'ready',
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [callId, entry] of spawned) {
    images.push(...projectCard(callId, entry, entry.state === 'working'));
  }
  return images;
}
