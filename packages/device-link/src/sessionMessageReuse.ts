import type { InvokePayload } from "./protocol.js";

/** List subscribers opt into ordinary chat text, without active-control intent. */
export const CONTROLLER_CAPABILITY_SESSION_LIST_MESSAGES_V1 =
  "session-list-messages-v1";
export const MESSAGE_BODY_FORMAT = "message-bodies-v1";
const MAX_BODIES = 256;
const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_LIST_MESSAGE_CHARS = 200_000;
export const messageRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Attachments and structured cards keep their existing on-demand path. */
export function isReusableMessage(
  row: unknown,
): row is Record<string, unknown> & { id: string } {
  return (
    messageRecord(row) &&
    typeof row.id === "string" &&
    row.id.length > 0 &&
    (row.role === "assistant" || row.role === "user") &&
    (typeof row.content === "string"
      ? row.content.length <= MAX_LIST_MESSAGE_CHARS
      : messageRecord(row.content) &&
        typeof row.content.text === "string" &&
        row.content.text.length <= MAX_LIST_MESSAGE_CHARS &&
        Object.keys(row.content).every((key) => key === "text"))
  );
}

export function isListMessagePush(channel: string, value: unknown): boolean {
  if (!messageRecord(value)) return false;
  if (channel === "local-db:messages:created")
    return isReusableMessage(value.message);
  if (
    channel === "local-db:messages:deleted" ||
    channel === "maker:status-changed"
  )
    return true;
  // Only complete persisted bodies enter prefetch. Streaming text and SDK done
  // stay on the detail topic: prefixes cannot establish a whole-message bound.
  return false;
}

/** Only traverse protocol message containers, never user content. */
export function mapMessageBodies(
  value: unknown,
  map: (row: Record<string, unknown>) => unknown,
): unknown {
  if (Array.isArray(value))
    return value.map((row) => (messageRecord(row) ? map(row) : row));
  if (!messageRecord(value)) return value;
  if (Array.isArray(value.items))
    return {
      ...value,
      items: value.items.map(function item(value): unknown {
        if (!messageRecord(value)) return value;
        if (value.type === "messages" && Array.isArray(value.messages))
          return { ...value, messages: mapMessageBodies(value.messages, map) };
        if (value.type === "work" && Array.isArray(value.children))
          return { ...value, children: value.children.map(item) };
        return value;
      }),
    };
  if (Array.isArray(value.messages))
    return { ...value, messages: mapMessageBodies(value.messages, map) };
  return value;
}

type Body = { id: string; version: string; contentJson: string };
const readChannels = new Set([
  "local-db:messages:list",
  "local-db:messages:view",
]);

/** Bounded transport deduplication; app stores remain responsible for display and disk. */
export class SessionMessageReuse {
  private bodies = new Map<
    string,
    { peer: string; session: string; body: Body }
  >();
  private bytes = 0;
  private generation = 0;

  clear(): void {
    this.bodies.clear();
    this.bytes = 0;
    this.generation++;
  }

  private remember(
    peer: string,
    session: string,
    row: Record<string, unknown>,
  ): void {
    if (
      !isReusableMessage(row) ||
      typeof row.remoteBodyVersion !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.remoteBodyVersion)
    )
      return;
    const key = JSON.stringify([peer, session, row.id]);
    const previous = this.bodies.get(key);
    if (previous) this.bytes -= previous.body.contentJson.length * 2;
    this.bodies.delete(key);
    const contentJson = JSON.stringify(row.content);
    this.bodies.set(key, {
      peer,
      session,
      body: { id: row.id, version: row.remoteBodyVersion, contentJson },
    });
    this.bytes += contentJson.length * 2;
    while (this.bodies.size > MAX_BODIES || this.bytes > MAX_BYTES) {
      const first = this.bodies.entries().next().value!;
      this.bytes -= first[1].body.contentJson.length * 2;
      this.bodies.delete(first[0]);
    }
  }

  receive(peer: string, channel: string, payload: unknown): void {
    if (!messageRecord(payload) || typeof payload.sessionId !== "string")
      return;
    if (
      channel === "local-db:messages:created" &&
      messageRecord(payload.message)
    ) {
      this.remember(peer, payload.sessionId, payload.message);
    }
    // A clear/delete may reuse the same identity later; never advertise old bodies.
    if (
      channel === "local-db:messages:deleted" ||
      channel === "local-db:session:error-persisted" ||
      (channel === "local-db:sessions:patched" &&
        messageRecord(payload.patch) &&
        ("clearedAt" in payload.patch ||
          payload.patch.status === "deleted" ||
          payload.patch.status === "archived"))
    ) {
      for (const [key, entry] of this.bodies) {
        if (entry.peer !== peer || entry.session !== payload.sessionId)
          continue;
        this.bytes -= entry.body.contentJson.length * 2;
        this.bodies.delete(key);
      }
    }
  }

  prepare(
    peer: string,
    payload: InvokePayload,
  ): { payload: InvokePayload; decode(value: unknown): unknown } {
    const session = payload.args?.[0];
    if (
      !readChannels.has(payload.channel) ||
      typeof session !== "string" ||
      (payload.args[1] != null && !messageRecord(payload.args[1]))
    )
      return { payload, decode: (value) => value };
    // This immutable request snapshot survives eviction, later pushes and concurrent reads.
    const snapshot = new Map<string, Body>();
    for (const entry of this.bodies.values()) {
      if (entry.peer === peer && entry.session === session)
        snapshot.set(entry.body.id, entry.body);
    }
    const generation = this.generation;
    const args = [...payload.args];
    args[1] = {
      ...((args[1] as object) ?? {}),
      messageBodies: {
        version: 1,
        known: [...snapshot.values()].map(({ id, version }) => [id, version]),
      },
    };
    return {
      payload: { ...payload, args },
      decode: (value) => {
        const packed =
          messageRecord(value) && value.format === MESSAGE_BODY_FORMAT;
        const decoded = mapMessageBodies(
          packed ? value.value : value,
          (row) => {
            let restored = row;
            if (
              packed &&
              !Object.prototype.hasOwnProperty.call(row, "content")
            ) {
              const body = snapshot.get(String(row.id));
              if (!body || row.remoteBodyVersion !== body.version)
                throw new Error("Missing remote message body");
              restored = { ...row, content: JSON.parse(body.contentJson) };
            }
            if (generation === this.generation)
              this.remember(peer, session, restored);
            return restored;
          },
        );
        return decoded;
      },
    };
  }
}
