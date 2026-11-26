import { parseSharedTaskPeer } from '@cindy/device-link';
import { buildTaskDeepLink, stripDeepLinkPathPrefix } from '../../shared/deepLinkSchemes.js';

/** A guest target always retains its share and host identity, never a bare local ID. */
export function parseSharedTaskTarget(value: string) {
  let sessionId: string;
  let peer: string;
  const path = stripDeepLinkPathPrefix(value, 'session/');
  try {
    if (path !== null) {
      const split = path.indexOf('?');
      if (split <= 0 || path.includes('#')) return null;
      const query = new URLSearchParams(path.slice(split + 1));
      if (query.getAll('device').length !== 1) return null;
      // Decode the original path, without URL dot-segment normalization that
      // could silently turn an invalid link into a different task.
      sessionId = decodeURIComponent(path.slice(0, split));
      peer = query.get('device')!;
    } else {
      // Scoped peer keys contain JSON device IDs, which may themselves contain ::.
      const qualified = /^(\[.*\]~*)::(.+)$/.exec(value);
      if (!qualified) return null;
      peer = qualified[1]!;
      sessionId = qualified[2]!;
    }
    if (parseSharedTaskPeer(peer)?.role !== 'host' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) return null;
    return { peer, sessionId, taskLink: buildTaskDeepLink(sessionId, peer) };
  } catch { return null; }
}
