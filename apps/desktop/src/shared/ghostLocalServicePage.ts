export const GHOST_LOCAL_SERVICE_PERMISSION = 'main-view:local-service';

/** A renderer claim only. Main derives the actual in-memory guest partition. */
export const GHOST_LOCAL_SERVICE_PARTITION = 'cindy-plugin-local-service:';

/** HTTP resources and the WebSocket endpoint on that exact HTTP authority. */
export function isGhostLocalServiceRequest(origin: string, value: string, webSocket = false): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (url.protocol === 'http:' && url.origin === origin) ||
      (webSocket && url.protocol === 'ws:' && `http://${url.host}` === origin);
  } catch {
    return false;
  }
}
