import { randomUUID } from 'node:crypto';

import { GHOST_MEDIA_HANDOVER_MIME, type GhostPanelMediaTarget } from '../../shared/ghost.js';
import { parsePluginStoragePart } from '../../shared/pluginIdentity.js';
import { parseGhostMediaHandoverUrl } from './previewGate.js';

interface GhostMediaHandoverSource extends GhostPanelMediaTarget {
  instanceId: string;
  isCurrent(): boolean;
}

export class GhostMediaHandoverTargetTracker {
  private readonly sources = new Map<string, GhostMediaHandoverSource>();

  register(source: GhostMediaHandoverSource): string {
    if (parsePluginStoragePart(source.instanceId)?.ghostId !== source.ghostId) {
      throw new Error('Invalid ghost media handover source');
    }
    const token = randomUUID();
    this.sources.set(token, { ...source });
    return token;
  }

  revoke(token: string): void {
    this.sources.delete(token);
  }

  resolve(token: unknown, uri: unknown): GhostPanelMediaTarget | null {
    if (typeof token !== 'string' || token.length !== 36 || typeof uri !== 'string') return null;
    const source = this.sources.get(token);
    if (!source) return null;
    try {
      if (!source.isCurrent()) {
        this.revoke(token);
        return null;
      }
    } catch {
      this.revoke(token);
      return null;
    }
    if (parseGhostMediaHandoverUrl(uri)?.ghostId !== source.ghostId) return null;
    return { ghostId: source.ghostId, instanceId: source.instanceId };
  }
}

export const ghostMediaHandoverTargetTracker = new GhostMediaHandoverTargetTracker();

export function resolveGhostMediaHandoverTarget(token: unknown, uri: unknown): GhostPanelMediaTarget | null {
  return ghostMediaHandoverTargetTracker.resolve(token, uri);
}

export function ghostMediaHandoverDragScript(sourceToken: string): string {
  return '(' + installGhostMediaHandoverDrag.toString() + ')('
    + JSON.stringify(GHOST_MEDIA_HANDOVER_MIME) + ',' + JSON.stringify(sourceToken) + ')';
}

function installGhostMediaHandoverDrag(mime: string, sourceToken: string): void {
  const handleDrag = (event: DragEvent) => {
    if (!event.isTrusted || !event.dataTransfer) return;
    const candidates: string[] = [];
    for (const type of ['text/uri-list', 'text/plain']) {
      const raw = event.dataTransfer.getData(type);
      candidates.push(...raw.split(String.fromCharCode(10)).map((line) => line.trim()));
    }
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest('a');
    if (anchor instanceof HTMLAnchorElement) candidates.push(anchor.href);
    const media = target?.closest('img,video');
    if (media instanceof HTMLImageElement || media instanceof HTMLVideoElement) {
      candidates.push(media.currentSrc || media.src);
    }
    const uri = candidates.find((candidate) => {
      try {
        const parsed = new URL(candidate);
        const parts = parsed.pathname.split('/');
        return parsed.protocol === 'cindy-ghost:' && parts.length === 3
          && ['media', 'preview'].includes(parts[1])
          && /^[a-f0-9]{64}[.](png|jpg|jpeg|gif|webp|mp4|webm)$/i.test(parts[2])
          && !parsed.search && !parsed.hash;
      } catch {
        return false;
      }
    });
    if (!uri) return;
    event.dataTransfer.setData(mime, JSON.stringify({ uri, sourceToken }));
  };
  window.addEventListener('dragstart', handleDrag, true);
  window.addEventListener('dragstart', handleDrag, false);
}
