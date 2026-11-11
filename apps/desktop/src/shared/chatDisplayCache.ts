/** Local display snapshots. They never authorize sends, controls or read receipts. */
export type ChatDisplayCacheRequest = {
  owner: { dataOwnerId: string | null; generation: number };
  key: 'groups' | 'cloud-homes' | `companion:${string}`;
} & ({ action: 'read' } | { action: 'write'; value: unknown } | { action: 'remove' });
