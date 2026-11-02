/**
 * /models: where a plugin publishes the models it adds to the model picker.
 *
 * Same shape as /kv: free of Electron, called from the cindy-ghost:// handler. Unchanged lists do not
 * notify, so a plugin can safely publish every time it starts.
 */
import { parseGhostPublishedModels, type GhostModelsNeeds } from '@cindy/plugin-protocol';

export interface GhostModelsEndpointStore {
  read(ghostId: string): Record<string, unknown>;
  write(ghostId: string, value: Record<string, unknown>): void;
}

const json = (status: number, value: unknown) => ({ status, body: JSON.stringify(value) });

export async function handleGhostModelsRequest(args: {
  ghostId: string;
  method: string;
  readBodyText: () => Promise<string>;
  isCurrent: () => boolean;
  /** Null when the plugin is not installed. */
  needs: () => GhostModelsNeeds | undefined | null;
  store: GhostModelsEndpointStore;
  onChanged: () => void;
}): Promise<{ status: number; body?: string }> {
  const { ghostId, method, store } = args;
  if (!args.isCurrent()) return { status: 403 };
  const needs = args.needs();
  if (needs === null) return { status: 404 };
  if (method === 'GET') return json(200, { models: store.read(ghostId).models ?? [] });
  if (method !== 'PUT') return { status: 405 };
  if (!needs) return json(403, { error: 'Declare "models" in ghost.json before publishing models' });
  let raw: unknown;
  try {
    raw = JSON.parse(await args.readBodyText());
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }
  if (!args.isCurrent()) return { status: 403 };
  const parsed = parseGhostPublishedModels(raw, needs.types);
  if (!parsed.ok) return json(400, { error: parsed.reason });
  const changed = JSON.stringify(store.read(ghostId).models ?? []) !== JSON.stringify(parsed.models);
  if (changed) {
    store.write(ghostId, { models: parsed.models });
    args.onChanged();
  }
  return json(200, { models: parsed.models, skipped: parsed.skipped });
}
