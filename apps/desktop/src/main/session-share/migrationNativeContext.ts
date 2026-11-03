import { createHash } from 'node:crypto';

/** New native identities for migration copies, deterministic across retries of one handoff.
 * Only unindexed incoming bytes are rewritten; existing vendor files are never modified. */
export function migrationNativeContext(migrationId: string, nativeIds: readonly string[]) {
  const ids = new Map(
    nativeIds.map((id) => {
      const hex = createHash('sha256').update(`${migrationId}\0${id}`).digest('hex');
      return [
        id,
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
      ];
    }),
  );
  const id = (value: string) => ids.get(value) ?? value;
  const metadata = (raw: string | null): string | null => {
    if (!raw) return raw;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Legacy switch messages and optional metadata can be plain text.
      // Preserve those bytes, just as the ordinary transcript reader does.
      return raw;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return raw;
    let changed = false;
    for (const key of [
      'sdkSessionId',
      'fromSdkSessionId',
      'toSdkSessionId',
      'sourceSdkSessionId',
    ]) {
      if (typeof value[key] === 'string' && ids.has(value[key])) {
        value[key] = id(value[key]);
        changed = true;
      }
    }
    const anchor = value.nativeForkAnchor;
    if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
      const nativeAnchor = anchor as Record<string, unknown>;
      if (typeof nativeAnchor.sdkSessionId === 'string' && ids.has(nativeAnchor.sdkSessionId)) {
        value.nativeForkAnchor = { ...nativeAnchor, sdkSessionId: id(nativeAnchor.sdkSessionId) };
        changed = true;
      }
    }
    return changed ? JSON.stringify(value) : raw;
  };
  /** One transcript line (without its `\n`). */
  const line = (text: string, agent: 'cc' | 'codex'): string => {
    if (!text.trim()) return text;
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      // Native readers tolerate interrupted/legacy lines; copying must preserve them.
      return text;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return text;
    if (agent === 'cc' && typeof row.sessionId === 'string' && ids.has(row.sessionId)) {
      return JSON.stringify({ ...row, sessionId: id(row.sessionId) });
    }
    if (
      agent === 'codex' &&
      row.type === 'session_meta' &&
      typeof row.payload?.id === 'string' &&
      ids.has(row.payload.id)
    ) {
      // Codex native IDs are equal-length UUIDs. Preserve all other bytes and line offsets.
      return text.replace(
        /("id"\s*:\s*)("(?:[^"\\]|\\.)*")/g,
        (_match, prefix: string, value: string) =>
          `${prefix}${JSON.stringify(id(JSON.parse(value)))}`,
      );
    }
    return text;
  };
  /**
   * Whether `line` can change the bytes. Rewrites need a mapped ID as a JSON string value,
   * and native writers never escape UUID characters, so other lines can be copied as bytes.
   */
  const mayRewrite = (bytes: Buffer): boolean =>
    [...ids.keys()].some((nativeId) => bytes.includes(nativeId));
  const transcript = (bytes: Buffer, agent: 'cc' | 'codex'): Buffer =>
    Buffer.from(
      bytes
        .toString('utf8')
        .split('\n')
        .map((text) => line(text, agent))
        .join('\n'),
    );
  const stateRows = <
    T extends {
      threads: Array<Record<string, unknown>>;
      threadDynamicTools: Array<Record<string, unknown>>;
      threadSpawnEdges: Array<Record<string, unknown>>;
    },
  >(
    rows: T,
  ): T => {
    const rewrite = (row: Record<string, unknown>, fields: string[]) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          fields.includes(key) && typeof value === 'string' ? id(value) : value,
        ]),
      );
    return {
      ...rows,
      threads: rows.threads.map((row) => rewrite(row, ['id'])),
      threadDynamicTools: rows.threadDynamicTools.map((row) => rewrite(row, ['thread_id'])),
      threadSpawnEdges: rows.threadSpawnEdges.map((row) =>
        rewrite(row, ['parent_thread_id', 'child_thread_id']),
      ),
    };
  };
  return { id, metadata, line, mayRewrite, transcript, stateRows };
}
