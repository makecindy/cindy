// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  collectGhostCardGalleryImages,
  createGhostCardSpawnIndex,
  extractGhostCardGallerySrcs,
  ghostCardGalleryId,
} from '@/cindy-brain/ghostCardGallery';
import type { GhostCardSnapshot } from '@/cindy-brain/ghostCardStore';
import { GHOST_CARD_SPAWN_SEP } from '../../shared/ghost';

function media(char: string, ext = 'png'): string {
  return `cindy-media://blobs/${char.repeat(64)}.${ext}`;
}

describe('ghost card conversation gallery projection', () => {
  it('keeps only images whose card click route opens ImageLightbox', () => {
    const normal = media('a');
    const action = media('b');
    const link = media('c');
    const modelPoster = media('d');
    const nestedAction = media('e');
    const nestedLink = media('6');
    const cssPhantom = media('7');

    expect(
      extractGhostCardGallerySrcs(`
        <style>.preview::before { content: '<img src="${cssPhantom}">'; }</style>
        <img src="${normal}" alt="result">
        <img src="${action}" data-ghost-action="retry">
        <img src="${link}" data-ghost-link="https://example.com">
        <div data-ghost-action="retry"><img src="${nestedAction}"></div>
        <a data-ghost-link="https://example.com"><img src="${nestedLink}"></a>
        <img src="${modelPoster}" data-ghost-model="${media('8', 'glb')}">
        <img src="https://example.com/not-managed.png">
      `),
    ).toEqual([normal]);
  });

  it('matches root and spawned card render order with stable duplicate identities', () => {
    const repeated = media('f');
    const animated = media('1');
    const spawnEarly = `root${GHOST_CARD_SPAWN_SEP}001`;
    const spawnLate = `root${GHOST_CARD_SPAWN_SEP}002`;
    const snapshot: GhostCardSnapshot = {
      version: 1,
      liveCards: [],
      byCallId: new Map([
        [
          spawnLate,
          {
            status: 'ready',
            ghostId: 'cindy-art',
            html: `<img src="${repeated}">`,
            height: 200,
          },
        ],
        [
          'root',
          {
            status: 'ready',
            ghostId: 'cindy-art',
            html: `<img src="${repeated}">`,
            animatedHtml: `<img src="${animated}">`,
            height: 200,
          },
        ],
        [
          spawnEarly,
          {
            status: 'ready',
            ghostId: 'cindy-art',
            html: `<img src="${repeated}">`,
            height: 200,
          },
        ],
      ]),
    };

    const spawnIndex = createGhostCardSpawnIndex(snapshot);
    expect([...spawnIndex.keys()]).toEqual(['root']);
    expect(collectGhostCardGalleryImages('root', snapshot, true, spawnIndex)).toEqual([
      { src: animated, galleryId: ghostCardGalleryId('root', 0) },
      { src: repeated, galleryId: ghostCardGalleryId(spawnEarly, 0) },
      { src: repeated, galleryId: ghostCardGalleryId(spawnLate, 0) },
    ]);
  });
});
