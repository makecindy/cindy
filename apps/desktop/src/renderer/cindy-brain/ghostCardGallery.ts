/**
 * Ghost card image gallery projection.
 *
 * Card HTML has already been sanitized by Main before it reaches Renderer.
 * This module only projects image references into the host-owned conversation
 * gallery; it does not parse bytes, widen the iframe bridge, or grant plugins
 * any new capability.
 */

import { ghostCardRootCallId } from '../../shared/ghost';
import type { GhostCardEntry, GhostCardSnapshot } from './ghostCardStore';
import type { GalleryImage } from '@/components/chat/ImageGalleryContext';

const CINDY_MEDIA_IMAGE_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/;

type ReadyGhostCardEntry = Extract<GhostCardEntry, { status: 'ready' }>;
type SpawnCard = { callId: string; entry: ReadyGhostCardEntry };
export type GhostCardSpawnIndex = ReadonlyMap<string, readonly SpawnCard[]>;

/**
 * Returns only images whose click route opens ImageLightbox. Action/link images
 * remain card controls, while model posters continue to open ModelLightbox.
 */
export function extractGhostCardGallerySrcs(html: string): string[] {
  const cardDocument = new DOMParser().parseFromString(html, 'text/html');
  return [...cardDocument.querySelectorAll<HTMLImageElement>('img[src]')]
    .filter((img) => {
      const src = img.getAttribute('src')?.trim() ?? '';
      return (
        CINDY_MEDIA_IMAGE_RE.test(src) &&
        !img.closest('[data-ghost-action], [data-ghost-link]') &&
        !img.dataset.ghostModel
      );
    })
    .map((img) => img.getAttribute('src')!.trim());
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

/** Builds the root → spawned-card lookup once for one session gallery projection. */
export function createGhostCardSpawnIndex(snapshot: GhostCardSnapshot): GhostCardSpawnIndex {
  const mutable = new Map<string, SpawnCard[]>();
  for (const [callId, entry] of snapshot.byCallId) {
    if (entry.status !== 'ready') continue;
    const rootCallId = ghostCardRootCallId(callId);
    if (rootCallId === callId) continue;
    const cards = mutable.get(rootCallId) ?? [];
    cards.push({ callId, entry });
    mutable.set(rootCallId, cards);
  }
  for (const cards of mutable.values()) {
    cards.sort((left, right) =>
      left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0,
    );
  }
  return mutable;
}

/**
 * Projects a rendered root card followed by its spawned cards, matching
 * GhostToolCard's DOM order. Only entries belonging to this root call are read.
 */
export function collectGhostCardGalleryImages(
  rootCallId: string,
  snapshot: GhostCardSnapshot,
  rootRunning: boolean,
  spawnIndex: GhostCardSpawnIndex,
): GalleryImage[] {
  const root = snapshot.byCallId.get(rootCallId);
  const images: GalleryImage[] = [];
  if (root?.status === 'ready') {
    images.push(...projectCard(rootCallId, root, rootRunning || root.state === 'working'));
  }

  for (const { callId, entry } of spawnIndex.get(rootCallId) ?? []) {
    images.push(...projectCard(callId, entry, entry.state === 'working'));
  }
  return images;
}
