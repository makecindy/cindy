import { createHash } from 'node:crypto';
import {
  isReusableMessage,
  mapMessageBodies,
  messageRecord,
  MESSAGE_BODY_FORMAT,
} from '@cindy/device-link';

/** The digest covers the exact sanitized wire body, not its sidebar preview. */
export function versionMessageBody(row: Record<string, unknown>): Record<string, unknown> {
  return isReusableMessage(row)
    ? {
        ...row,
        remoteBodyVersion: createHash('sha256').update(JSON.stringify(row.content)).digest('hex'),
      }
    : row;
}

/** Opt-in compression after authorization and sanitization; metadata always stays fresh. */
export function encodeMessageBodies(
  channel: string | undefined,
  args: unknown[] | undefined,
  value: unknown,
): unknown {
  if (channel !== 'local-db:messages:view' && channel !== 'local-db:messages:list') return value;
  if (messageRecord(value) && value.format === MESSAGE_BODY_FORMAT) return value;
  const options = args?.[1];
  const request = messageRecord(options) ? options.messageBodies : undefined;
  if (!messageRecord(request) || request.version !== 1 || !Array.isArray(request.known))
    return value;
  const known = new Map<string, string>();
  for (const entry of request.known.slice(0, 256)) {
    if (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      entry[0].length <= 256 &&
      typeof entry[1] === 'string' &&
      /^[a-f0-9]{64}$/.test(entry[1])
    )
      known.set(entry[0], entry[1]);
  }
  return {
    format: MESSAGE_BODY_FORMAT,
    value: mapMessageBodies(value, (row) => {
      const versioned = versionMessageBody(row);
      if (!isReusableMessage(versioned) || known.get(versioned.id) !== versioned.remoteBodyVersion)
        return versioned;
      const { content: _content, ...reference } = versioned;
      return reference;
    }),
  };
}
