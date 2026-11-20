/**
 * /harnesses: where a plugin publishes whether its declared task engines can run right now.
 *
 * Same shape as /models: free of Electron, called from the cindy-ghost:// handler. The body replaces
 * the stored list as a whole; an unchanged list writes nothing and notifies nobody, so a plugin can
 * publish every time it starts or its settings page opens. Only metadata is stored — never a command.
 */
import {
  parseGhostHarnessAvailability,
  storedGhostHarnessAvailability,
  type GhostHarnessDecl,
} from '@cindy/plugin-protocol';

export interface GhostHarnessesEndpointStore {
  read(ghostId: string): Record<string, unknown>;
  write(ghostId: string, value: Record<string, unknown>): void;
}

const json = (status: number, value: unknown) => ({ status, body: JSON.stringify(value) });

export async function handleGhostHarnessesRequest(args: {
  ghostId: string;
  method: string;
  readBodyText: () => Promise<string>;
  isCurrent: () => boolean;
  /** Null when the plugin is not installed; undefined when the manifest declares no harnesses. */
  declared: () => readonly GhostHarnessDecl[] | undefined | null;
  store: GhostHarnessesEndpointStore;
  onChanged: () => void;
}): Promise<{ status: number; body?: string }> {
  const { ghostId, method, store } = args;
  if (!args.isCurrent()) return { status: 403 };
  const declared = args.declared();
  if (declared === null) return { status: 404 };
  if (method !== 'GET' && method !== 'PUT') return { status: 405 };
  if (!declared?.length) return json(403, { error: 'Declare "harnesses" in ghost.json before publishing availability' });
  const ids = declared.map((harness) => harness.id);
  // Stored data is re-validated on read: an entry for an engine the current manifest no longer
  // declares (or a damaged file) is not returned as if it were still published.
  const current = storedGhostHarnessAvailability(store.read(ghostId), ids);
  if (method === 'GET') return json(200, { harnesses: current });
  let raw: unknown;
  try {
    raw = JSON.parse(await args.readBodyText());
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }
  if (!args.isCurrent()) return { status: 403 };
  const parsed = parseGhostHarnessAvailability(raw, ids);
  if (!parsed.ok) return json(400, { error: parsed.reason });
  if (JSON.stringify(current) !== JSON.stringify(parsed.harnesses)) {
    store.write(ghostId, { harnesses: parsed.harnesses });
    args.onChanged();
  }
  return json(200, { harnesses: parsed.harnesses });
}
