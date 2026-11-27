import type { RecoveryRule } from './types.js';

const missingReasoningItem = /item with id '(rs_[a-z0-9_-]+)' not found\.\s+items are not persisted when `store` is set to false\./i;
const unverifiableReasoningItem = /encrypted content for item (rs_[a-z0-9_-]+) could not be verified\.\s+reason: encrypted content could not be decrypted or parsed\./i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function withoutReasoningItem(
  body: Buffer,
  id: string | undefined,
  shouldRemove: (item: Record<string, unknown>) => boolean,
): Buffer | null {
  if (!id) return null;
  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(request) || request.store !== false || !Array.isArray(request.input)) return null;
  const input = request.input.filter((item: unknown) =>
    !isRecord(item) || item.id !== id || !shouldRemove(item),
  );
  return input.length === request.input.length
    ? null
    : Buffer.from(JSON.stringify({ ...request, input }));
}

function unverifiableReasoningId(text?: string): string | undefined {
  if (!text) return undefined;
  try {
    const response: unknown = JSON.parse(text);
    if (!isRecord(response) || !isRecord(response.error)) return undefined;
    const { code, message } = response.error;
    if (code !== 'invalid_encrypted_content' || typeof message !== 'string') return undefined;
    return unverifiableReasoningItem.exec(message)?.[1];
  } catch {
    return undefined;
  }
}

const hasCiphertext = (item: Record<string, unknown>): boolean =>
  typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;

// #9928: only remove the items the Responses upstream confirmed cannot be replayed.
export const missingReasoningItemRecoveryRule: RecoveryRule = {
  id: 'missing_reasoning_item',
  statusCodes: [404],
  enabled: () => true,
  matches: (text) => missingReasoningItem.test(text),
  allowExtraRules: false,
  applyOnUnmatchedRetry: false,
  strip: (body, errorText) => withoutReasoningItem(
    body, errorText?.match(missingReasoningItem)?.[1],
    (item) => (item.type === 'reasoning' || item.type === 'item_reference') && !hasCiphertext(item),
  ),
  // Real DeepSeek history can contain both an unsaved item and foreign ciphertext.
  // The second upstream response must point to the sealed item before we remove it.
  followUpRule: {
    id: 'unverifiable_reasoning_after_missing',
    statusCodes: [400],
    boundedErrorBody: true,
    enabled: () => true,
    matches: (text) => unverifiableReasoningId(text) !== undefined,
    allowExtraRules: false,
    applyOnUnmatchedRetry: false,
    strip: (body, errorText) => withoutReasoningItem(
      body, unverifiableReasoningId(errorText),
      (item) => item.type === 'reasoning' && hasCiphertext(item),
    ),
  },
};
