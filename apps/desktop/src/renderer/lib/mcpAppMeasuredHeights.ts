import { McpAppMeasuredHeights, parseMcpAppMeasurements } from '@cindy/maker-shared/mcp-app-controller';
import { getDataOwnerGeneration, subscribeDataOwnerGeneration } from '../contexts/dataOwnerGeneration';

function openCache(dataOwnerId: string | null): McpAppMeasuredHeights {
  const key = dataOwnerId && `cindy.mcpAppHeights.v1.${encodeURIComponent(dataOwnerId)}`;
  let stored: string | null = null;
  try { if (key) stored = localStorage.getItem(key); } catch { /* Memory-only profile. */ }
  const cache: McpAppMeasuredHeights = new McpAppMeasuredHeights(stored, (snapshot, changes) => {
    if (!key) return;
    const save = () => {
      if (cache !== desktopMcpAppHeights) return;
      // Detached task windows share the same profile. Merge concurrent windows' batches.
      const latest = localStorage.getItem(key);
      if (latest !== stored) {
        const entries = new Map(parseMcpAppMeasurements(latest).map(entry => [entry[0], entry]));
        for (const entry of changes) { entries.delete(entry[0]); entries.set(entry[0], entry); }
        localStorage.setItem(key, JSON.stringify([...entries.values()].slice(-100)));
        // This window's snapshot lacks the concurrent batch. Keep merging until next activation.
        stored = null;
      } else {
        stored = JSON.stringify(snapshot);
        localStorage.setItem(key, stored);
      }
    };
    return navigator.locks ? navigator.locks.request(key, save) : save();
  });
  return cache;
}

let ownerId = getDataOwnerGeneration().dataOwnerId;
export let desktopMcpAppHeights = openCache(ownerId);
if (typeof window !== 'undefined') {
  subscribeDataOwnerGeneration(() => {
    const nextOwnerId = getDataOwnerGeneration().dataOwnerId;
    if (nextOwnerId === ownerId) return;
    desktopMcpAppHeights.dispose();
    ownerId = nextOwnerId;
    desktopMcpAppHeights = openCache(ownerId);
  });
  window.addEventListener('pagehide', () => { void desktopMcpAppHeights.flush(); });
}
