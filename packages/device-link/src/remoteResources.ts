/**
 * Stable, module-neutral API used by remote controllers to discover and operate
 * host-owned product resources. Feature modules register providers on the host;
 * controllers render the portable collection/resource/action primitives below.
 *
 * Compatibility rules:
 * - fields are additive and consumers must ignore unknown fields;
 * - `primitive` and resource `kind` are open strings;
 * - every non-core presentation block carries fallbackMarkdown;
 * - descriptors are presentation hints, never authorization. The host validates
 *   every invocation again in the provider that owns the action.
 */

export const REMOTE_RESOURCE_PROTOCOL_VERSION = 1;

export const REMOTE_RESOURCE_MANIFEST_CHANNEL = 'maker:remote-resources:manifest';
export const REMOTE_RESOURCE_LIST_CHANNEL = 'maker:remote-resources:list';
export const REMOTE_RESOURCE_GET_CHANNEL = 'maker:remote-resources:get';
export const REMOTE_RESOURCE_INVOKE_CHANNEL = 'maker:remote-resources:invoke';
export const REMOTE_RESOURCE_CHANGED_CHANNEL = 'maker:remote-resources:changed';

export const REMOTE_RESOURCE_CHANNELS = [
  REMOTE_RESOURCE_MANIFEST_CHANNEL,
  REMOTE_RESOURCE_LIST_CHANNEL,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
] as const;

export interface RemoteLocalizedText {
  fallback: string;
  translations?: Readonly<Record<string, string>>;
}

export type RemoteText = string | RemoteLocalizedText;

export interface RemoteResourceClientDescriptor {
  protocolVersion: number;
  /** Portable UI primitives understood by this controller. Open and additive. */
  primitives: string[];
  /** BCP-47-ish UI locale. It is presentation input, never an authorization signal. */
  locale?: string;
}

export interface RemoteResourceRef {
  collectionId: string;
  kind: string;
  id: string;
}

export interface RemoteResourceStatus {
  label: RemoteText;
  /** Stable visual semantics. Unknown tones must render as neutral. */
  tone?: 'neutral' | 'positive' | 'warning' | 'critical' | string;
}

export interface RemoteResourceBadge {
  label?: RemoteText;
  accessibilityLabel: RemoteText;
  tone?: 'neutral' | 'positive' | 'warning' | 'critical' | string;
}

export interface RemoteResourceAvatar {
  /** `emoji`, `asset`, `media`, and `text` are the initial portable kinds. Unknown kinds use fallbackText. */
  kind: string;
  value: string;
  fallbackText: string;
  color?: string;
}

export interface RemoteResourceDisplay {
  title: RemoteText;
  subtitle?: RemoteText;
  preview?: RemoteText;
  timestamp?: number;
  /** Latest visible reply in host time; controllers keep their own read position. */
  lastReplyAt?: number;
  avatar?: RemoteResourceAvatar;
  status?: RemoteResourceStatus;
  badges?: RemoteResourceBadge[];
}

export interface RemoteSessionLinkTarget {
  kind: 'session';
  sessionId: string;
}

export interface RemoteResourceLinkTarget {
  kind: 'resource';
  ref: RemoteResourceRef;
}

export type RemoteLinkTarget = RemoteSessionLinkTarget | RemoteResourceLinkTarget;

export interface RemoteResourceLink {
  rel: string;
  target: RemoteLinkTarget;
  label?: RemoteText;
}

export interface RemoteActionField {
  id: string;
  label: RemoteText;
  kind: 'text' | 'multiline' | 'toggle' | 'select' | string;
  required?: boolean;
  placeholder?: RemoteText;
  options?: Array<{ value: string; label: RemoteText }>;
}

export interface RemoteActionDescriptor {
  id: string;
  label: RemoteText;
  tone?: 'neutral' | 'primary' | 'destructive' | string;
  confirmation?: {
    title: RemoteText;
    body?: RemoteText;
    confirmLabel?: RemoteText;
  };
  fields?: RemoteActionField[];
}

export interface RemoteResourceBlock {
  id: string;
  /** Open primitive name. Older controllers render fallbackMarkdown. */
  primitive: string;
  title?: RemoteText;
  fallbackMarkdown: string;
  data?: unknown;
}

export interface RemoteCollectionItem {
  ref: RemoteResourceRef;
  display: RemoteResourceDisplay;
  links: RemoteResourceLink[];
  actions?: RemoteActionDescriptor[];
  /** Opaque provider revision. Controllers compare it but never interpret it. */
  revision: string;
}

export interface RemoteResource extends RemoteCollectionItem {
  blocks?: RemoteResourceBlock[];
}

export interface RemoteCollectionDescriptor {
  id: string;
  resourceKind: string;
  title: RemoteText;
  placement?: string;
  icon?: {
    name: string;
    fallbackText: string;
  };
  actions?: RemoteActionDescriptor[];
}

export interface RemoteResourceManifestRequest {
  client: RemoteResourceClientDescriptor;
}

export interface RemoteResourceManifestResponse {
  protocolVersion: number;
  collections: RemoteCollectionDescriptor[];
}

export interface RemoteCollectionListRequest {
  client: RemoteResourceClientDescriptor;
  collectionId: string;
  cursor?: string;
  limit?: number;
  query?: string;
}

export interface RemoteCollectionListResponse {
  collectionId: string;
  revision: string;
  items: RemoteCollectionItem[];
  nextCursor?: string;
}

export interface RemoteResourceGetRequest {
  client: RemoteResourceClientDescriptor;
  ref: RemoteResourceRef;
}

export interface RemoteActionInvokeRequest {
  client: RemoteResourceClientDescriptor;
  collectionId: string;
  actionId: string;
  resourceRef?: RemoteResourceRef;
  input?: Record<string, unknown>;
}

export type RemoteActionEffect =
  | { kind: 'refresh-collection'; collectionId: string }
  | { kind: 'refresh-resource'; ref: RemoteResourceRef }
  | { kind: 'navigate'; target: RemoteLinkTarget }
  | { kind: 'toast'; message: RemoteText };

export interface RemoteActionInvokeResponse {
  effects: RemoteActionEffect[];
}

export interface RemoteResourceChangedPayload {
  collectionId: string;
  resourceRefs?: RemoteResourceRef[];
  revision?: string;
}

const MAX_ID_CHARS = 160;
const MAX_CURSOR_CHARS = 1_024;
const MAX_QUERY_CHARS = 1_000;
const MAX_LOCALE_CHARS = 64;
const MAX_PRIMITIVES = 128;
const MAX_ACTION_INPUT_BYTES = 64 * 1_024;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** Dependency-free UTF-8 byte count; this package also runs in React Native. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function parseRemoteResourceClientDescriptor(
  value: unknown,
): RemoteResourceClientDescriptor | null {
  const record = recordOf(value);
  if (!record) return null;
  const protocolVersion = record.protocolVersion;
  const primitives = record.primitives;
  if (!Number.isInteger(protocolVersion) || (protocolVersion as number) < 1) return null;
  if (!Array.isArray(primitives) || primitives.length > MAX_PRIMITIVES) return null;
  const normalizedPrimitives: string[] = [];
  for (const primitive of primitives) {
    const normalized = boundedText(primitive, MAX_ID_CHARS);
    if (!normalized) return null;
    if (!normalizedPrimitives.includes(normalized)) normalizedPrimitives.push(normalized);
  }
  const locale = record.locale === undefined
    ? undefined
    : boundedText(record.locale, MAX_LOCALE_CHARS);
  if (record.locale !== undefined && !locale) return null;
  return {
    protocolVersion: protocolVersion as number,
    primitives: normalizedPrimitives,
    ...(locale ? { locale } : {}),
  };
}

export function parseRemoteResourceRef(value: unknown): RemoteResourceRef | null {
  const record = recordOf(value);
  if (!record) return null;
  const collectionId = boundedText(record.collectionId, MAX_ID_CHARS);
  const kind = boundedText(record.kind, MAX_ID_CHARS);
  const id = boundedText(record.id, MAX_ID_CHARS);
  return collectionId && kind && id ? { collectionId, kind, id } : null;
}

export function parseRemoteResourceManifestRequest(
  value: unknown,
): RemoteResourceManifestRequest | null {
  const record = recordOf(value);
  const client = parseRemoteResourceClientDescriptor(record?.client);
  return client ? { client } : null;
}

export function parseRemoteCollectionListRequest(
  value: unknown,
): RemoteCollectionListRequest | null {
  const record = recordOf(value);
  if (!record) return null;
  const client = parseRemoteResourceClientDescriptor(record.client);
  const collectionId = boundedText(record.collectionId, MAX_ID_CHARS);
  if (!client || !collectionId) return null;
  const cursor = record.cursor === undefined ? undefined : boundedText(record.cursor, MAX_CURSOR_CHARS);
  const query = record.query === undefined ? undefined : boundedText(record.query, MAX_QUERY_CHARS);
  const limit = record.limit === undefined
    ? undefined
    : Number.isInteger(record.limit) && (record.limit as number) > 0 && (record.limit as number) <= 200
      ? record.limit as number
      : null;
  if ((record.cursor !== undefined && !cursor) || (record.query !== undefined && !query) || limit === null) {
    return null;
  }
  return {
    client,
    collectionId,
    ...(cursor ? { cursor } : {}),
    ...(query ? { query } : {}),
    ...(limit ? { limit } : {}),
  };
}

export function parseRemoteResourceChangedPayload(
  value: unknown,
): RemoteResourceChangedPayload | null {
  const record = recordOf(value);
  if (!record) return null;
  const collectionId = boundedText(record.collectionId, MAX_ID_CHARS);
  if (!collectionId) return null;
  let resourceRefs: RemoteResourceRef[] | undefined;
  if (record.resourceRefs !== undefined) {
    if (!Array.isArray(record.resourceRefs) || record.resourceRefs.length > 256) return null;
    resourceRefs = [];
    for (const candidate of record.resourceRefs) {
      const ref = parseRemoteResourceRef(candidate);
      if (!ref || ref.collectionId !== collectionId) return null;
      resourceRefs.push(ref);
    }
  }
  const revision = record.revision === undefined
    ? undefined
    : boundedText(record.revision, MAX_CURSOR_CHARS);
  if (record.revision !== undefined && revision === null) return null;
  return {
    collectionId,
    ...(resourceRefs ? { resourceRefs } : {}),
    ...(revision ? { revision } : {}),
  };
}

export function parseRemoteResourceGetRequest(value: unknown): RemoteResourceGetRequest | null {
  const record = recordOf(value);
  if (!record) return null;
  const client = parseRemoteResourceClientDescriptor(record.client);
  const ref = parseRemoteResourceRef(record.ref);
  return client && ref ? { client, ref } : null;
}

export function parseRemoteActionInvokeRequest(value: unknown): RemoteActionInvokeRequest | null {
  const record = recordOf(value);
  if (!record) return null;
  const client = parseRemoteResourceClientDescriptor(record.client);
  const collectionId = boundedText(record.collectionId, MAX_ID_CHARS);
  const actionId = boundedText(record.actionId, MAX_ID_CHARS);
  if (!client || !collectionId || !actionId) return null;
  const resourceRef = record.resourceRef === undefined
    ? undefined
    : parseRemoteResourceRef(record.resourceRef);
  if (record.resourceRef !== undefined && !resourceRef) return null;
  const input = record.input === undefined ? undefined : recordOf(record.input);
  if (record.input !== undefined && !input) return null;
  if (input) {
    try {
      if (utf8ByteLength(JSON.stringify(input)) > MAX_ACTION_INPUT_BYTES) return null;
    } catch {
      return null;
    }
  }
  return {
    client,
    collectionId,
    actionId,
    ...(resourceRef ? { resourceRef } : {}),
    ...(input ? { input } : {}),
  };
}

/** Resolve host-owned copy without requiring a mobile release for new labels. */
export function resolveRemoteText(value: RemoteText, locale?: string): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || typeof value.fallback !== 'string') return '';
  if (!locale || !value.translations || typeof value.translations !== 'object') return value.fallback;
  const exact = value.translations[locale];
  if (typeof exact === 'string' && exact) return exact;
  const language = locale.split('-')[0];
  const translated = value.translations[language];
  return typeof translated === 'string' && translated ? translated : value.fallback;
}
