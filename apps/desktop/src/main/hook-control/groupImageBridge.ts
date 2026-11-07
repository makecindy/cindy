import type { GroupHistorySearchLane } from '../im/shared/groupHistorySearch';

type Reader = (lane: GroupHistorySearchLane, token: string) => Promise<Buffer | null>;
let reader: Reader | null = null;
export function registerGroupImageReader(value: Reader | null): void {
  reader = value;
}
export function readOfficialGroupImage(
  lane: GroupHistorySearchLane,
  token: string,
): Promise<Buffer | null> {
  return reader?.(lane, token) ?? Promise.resolve(null);
}

export async function fetchOfficialGroupImage(
  url: string,
  authToken: string,
  token: string,
): Promise<Buffer | null> {
  const endpoint = new URL(url);
  endpoint.protocol =
    endpoint.protocol === 'wss:'
      ? 'https:'
      : endpoint.protocol === 'ws:'
        ? 'http:'
        : endpoint.protocol;
  endpoint.pathname =
    endpoint.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '') + '/telegram/group-image';
  endpoint.search = '';
  endpoint.hash = '';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 20 * 1024 * 1024) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
