import {
  MODEL_ACCESS_MEDIA_CAPABILITIES,
  type MediaCapability,
  type ModelAccessParseResult,
} from '@cindy/model-providers';

export const MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION = 1 as const;
export const MODEL_ACCESS_INVOCATION_GUIDE_PATH = '/api/model-access/invocation-guide' as const;
export const MODEL_ACCESS_INVOCATION_GUIDES_PATH = '/api/model-access/invocation-guides' as const;

export type MediaResultKind = 'image' | 'video' | 'audio';
export type MediaRequestBodyEncoding = 'json' | 'multipart';

export interface MediaResultExtractor {
  path: string[];
  encoding: 'url' | 'base64';
  kind: MediaResultKind;
  mediaType?: string;
  allowedUrlHosts?: string[];
}

export interface MediaHttpRequestGuide {
  method: 'POST';
  path: string;
  headers?: Record<string, string>;
  /** Defaults to JSON for persisted/older schemaVersion 1 Guides. */
  bodyEncoding?: MediaRequestBodyEncoding;
  bodyModelPath: string[];
  multipartFiles?: MediaMultipartFileGuide[];
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}

export interface MediaMultipartFileGuide {
  bodyField: string;
  formField: string;
  kind: MediaResultKind;
  maxItems: number;
}

export interface MediaSyncResponseGuide {
  mode: 'sync';
  media: MediaResultExtractor[];
}

export interface MediaAsyncPollGuide {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  bodyTaskIdPath?: string[];
  statusPath: string[];
  successValues: string[];
  failureValues: string[];
  recommendedIntervalMs: number;
  timeoutMs: number;
  maxResponseBytes: number;
  media: MediaResultExtractor[];
}

export interface MediaAsyncResponseGuide {
  mode: 'async';
  taskIdPath: string[];
  poll: MediaAsyncPollGuide;
}

export interface MediaInvocationOperationGuide {
  capability: MediaCapability;
  request: MediaHttpRequestGuide;
  response: MediaSyncResponseGuide | MediaAsyncResponseGuide;
  instructions: string;
  exampleBody: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  officialDocs: string;
}

export interface MediaInvocationGuide {
  schemaVersion: typeof MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION;
  guideId: string;
  revision: string;
  connection: { providerId: string };
  operations: MediaInvocationOperationGuide[];
}

export interface ResolvedMediaInvocationGuide {
  modelId: string;
  guide: MediaInvocationGuide;
}

/** Persisted snapshot after `prepare` selects one operation from the Server Guide. */
export type PreparedMediaInvocationGuide = Omit<MediaInvocationGuide, 'operations'> &
  Pick<ResolvedMediaInvocationGuide, 'modelId'> &
  MediaInvocationOperationGuide;

type PlainObject = Record<string, unknown>;

const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'content-type',
  'proxy-authorization',
  'proxy-authenticate',
  'transfer-encoding',
  'connection',
  'trailer',
  'upgrade',
  'te',
]);
const GUIDE_FIELDS = [
  'schemaVersion',
  'guideId',
  'revision',
  'connection',
  'operations',
] as const;
const RESOLVED_GUIDE_FIELDS = ['modelId', 'guide'] as const;
const OPERATION_FIELDS = [
  'capability',
  'request',
  'response',
  'instructions',
  'exampleBody',
  'inputSchema',
  'officialDocs',
] as const;
const PREPARED_GUIDE_FIELDS = [
  'schemaVersion',
  'guideId',
  'modelId',
  'revision',
  'connection',
  ...OPERATION_FIELDS,
] as const;

function ok<T>(value: T): ModelAccessParseResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): ModelAccessParseResult<T> {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownField(value: PlainObject, allowed: readonly string[], path: string): string | null {
  const names = new Set(allowed);
  const field = Object.keys(value).find((candidate) => !names.has(candidate));
  return field ? `${path}.${field} is not allowed` : null;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function objectPathError(value: unknown, path: string): string | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 24 ||
    value.some(
      (segment) =>
        !boundedString(segment, 128) ||
        ['__proto__', 'prototype', 'constructor'].includes(segment),
    )
  ) {
    return `${path} must be a non-empty bounded string path`;
  }
  return null;
}

function relativePathError(value: unknown, path: string, allowTaskId: boolean): string | null {
  const containsControlCharacter =
    typeof value === 'string' &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  if (
    !boundedString(value, 2_048) ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('://') ||
    value.includes('\\') ||
    containsControlCharacter
  ) {
    return `${path} must be a relative HTTP path`;
  }
  if (!allowTaskId && value.includes('{taskId}')) return `${path} cannot contain {taskId}`;
  if (/\{(?!taskId\})/.test(value)) return `${path} contains an unsupported template`;
  return null;
}

function positiveIntegerError(
  value: unknown,
  path: string,
  min: number,
  max: number,
): string | null {
  return !Number.isInteger(value) || (value as number) < min || (value as number) > max
    ? `${path} must be an integer between ${min} and ${max}`
    : null;
}

function headersError(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (!isPlainObject(value) || Object.keys(value).length > 16) {
    return `${path} must be an object with at most 16 fields`;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      return `${path}.${name} is not an allowed fixed header`;
    }
    if (typeof headerValue !== 'string' || headerValue.length > 1_024 || /[\r\n]/.test(headerValue)) {
      return `${path}.${name} must be a bounded string`;
    }
  }
  return null;
}

function extractorError(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  let error = unknownField(
    value,
    ['path', 'encoding', 'kind', 'mediaType', 'allowedUrlHosts'],
    path,
  );
  if (error) return error;
  error = objectPathError(value.path, `${path}.path`);
  if (error) return error;
  if (value.encoding !== 'url' && value.encoding !== 'base64') {
    return `${path}.encoding must be url or base64`;
  }
  if (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio') {
    return `${path}.kind must be image, video or audio`;
  }
  if (value.mediaType !== undefined && !boundedString(value.mediaType, 128)) {
    return `${path}.mediaType must be a bounded string when present`;
  }
  if (value.encoding === 'url') {
    if (
      !Array.isArray(value.allowedUrlHosts) ||
      value.allowedUrlHosts.length === 0 ||
      value.allowedUrlHosts.length > 16 ||
      value.allowedUrlHosts.some(
        (host) =>
          typeof host !== 'string' ||
          !/^[a-z0-9.-]{1,253}$/i.test(host) ||
          !host.includes('.') ||
          /^\d+(?:\.\d+){3}$/.test(host) ||
          host.startsWith('.') ||
          host.endsWith('.') ||
          host.includes('..') ||
          host.toLowerCase().endsWith('.local'),
      )
    ) {
      return `${path}.allowedUrlHosts must contain trusted DNS suffixes`;
    }
  } else if (value.allowedUrlHosts !== undefined) {
    return `${path}.allowedUrlHosts is only valid for URL results`;
  }
  return null;
}

function mediaListError(value: unknown, path: string): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    return `${path} must be a non-empty array with at most 16 entries`;
  }
  for (const [index, extractor] of value.entries()) {
    const error = extractorError(extractor, `${path}[${index}]`);
    if (error) return error;
  }
  return null;
}

function multipartFilesError(value: unknown, path: string): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    return `${path} must be a non-empty array with at most 16 entries`;
  }
  const bodyFields = new Set<string>();
  for (const [index, file] of value.entries()) {
    const filePath = `${path}[${index}]`;
    if (!isPlainObject(file)) return `${filePath} must be an object`;
    let error = unknownField(file, ['bodyField', 'formField', 'kind', 'maxItems'], filePath);
    if (error) return error;
    if (!boundedString(file.bodyField, 128) || !/^[A-Za-z0-9_.-]+$/.test(file.bodyField)) {
      return `${filePath}.bodyField must be a safe bounded string`;
    }
    if (
      !boundedString(file.formField, 128) ||
      !/^[A-Za-z0-9_.-]+$/.test(file.formField.replaceAll('[', '').replaceAll(']', ''))
    ) {
      return `${filePath}.formField must be a bounded string`;
    }
    if (file.kind !== 'image' && file.kind !== 'video' && file.kind !== 'audio') {
      return `${filePath}.kind must be image, video or audio`;
    }
    error = positiveIntegerError(file.maxItems, `${filePath}.maxItems`, 1, 16);
    if (error) return error;
    if (bodyFields.has(file.bodyField)) return `${path} must not repeat bodyField`;
    bodyFields.add(file.bodyField);
  }
  return null;
}

function requestError(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  let error = unknownField(
    value,
    [
      'method',
      'path',
      'headers',
      'bodyEncoding',
      'bodyModelPath',
      'multipartFiles',
      'timeoutMs',
      'maxRequestBytes',
      'maxResponseBytes',
    ],
    path,
  );
  if (error) return error;
  if (value.method !== 'POST') return `${path}.method must be POST`;
  error = relativePathError(value.path, `${path}.path`, false);
  if (error) return error;
  error = headersError(value.headers, `${path}.headers`);
  if (error) return error;
  if (
    value.bodyEncoding !== undefined &&
    value.bodyEncoding !== 'json' &&
    value.bodyEncoding !== 'multipart'
  ) {
    return `${path}.bodyEncoding must be json or multipart`;
  }
  error = objectPathError(value.bodyModelPath, `${path}.bodyModelPath`);
  if (error) return error;
  if (value.bodyEncoding === 'multipart') {
    if ((value.bodyModelPath as string[]).length !== 1) {
      return `${path}.bodyModelPath must be top-level for multipart requests`;
    }
    error = multipartFilesError(value.multipartFiles, `${path}.multipartFiles`);
    if (error) return error;
  } else if (value.multipartFiles !== undefined) {
    return `${path}.multipartFiles is only valid for multipart requests`;
  }
  for (const [field, max] of [
    ['timeoutMs', 600_000],
    ['maxRequestBytes', 268_435_456],
    ['maxResponseBytes', 268_435_456],
  ] as const) {
    error = positiveIntegerError(value[field], `${path}.${field}`, 1, max);
    if (error) return error;
  }
  return null;
}

function stringSetError(value: unknown, path: string): string | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some((item) => !boundedString(item, 128))
  ) {
    return `${path} must be a non-empty bounded string array`;
  }
  return new Set(value).size === value.length ? null : `${path} must not contain duplicates`;
}

function pollError(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  let error = unknownField(
    value,
    [
      'method',
      'path',
      'headers',
      'bodyTaskIdPath',
      'statusPath',
      'successValues',
      'failureValues',
      'recommendedIntervalMs',
      'timeoutMs',
      'maxResponseBytes',
      'media',
    ],
    path,
  );
  if (error) return error;
  if (value.method !== 'GET' && value.method !== 'POST')
    return `${path}.method must be GET or POST`;
  error = relativePathError(value.path, `${path}.path`, true);
  if (error) return error;
  error = headersError(value.headers, `${path}.headers`);
  if (error) return error;
  if (value.method === 'GET') {
    if (!(value.path as string).includes('{taskId}')) {
      return `${path} GET polling path must include {taskId}`;
    }
    if (value.bodyTaskIdPath !== undefined) {
      return `${path}.bodyTaskIdPath is only valid for POST polling`;
    }
  } else if (
    value.bodyTaskIdPath === undefined &&
    !(value.path as string).includes('{taskId}')
  ) {
    return `${path} POST polling must declare bodyTaskIdPath or {taskId}`;
  }
  if (value.bodyTaskIdPath !== undefined) {
    error = objectPathError(value.bodyTaskIdPath, `${path}.bodyTaskIdPath`);
    if (error) return error;
  }
  error = objectPathError(value.statusPath, `${path}.statusPath`);
  if (error) return error;
  error = stringSetError(value.successValues, `${path}.successValues`);
  if (error) return error;
  error = stringSetError(value.failureValues, `${path}.failureValues`);
  if (error) return error;
  for (const [field, max] of [
    ['recommendedIntervalMs', 300_000],
    ['timeoutMs', 600_000],
    ['maxResponseBytes', 268_435_456],
  ] as const) {
    error = positiveIntegerError(value[field], `${path}.${field}`, 1, max);
    if (error) return error;
  }
  return mediaListError(value.media, `${path}.media`);
}

function responseError(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  if (value.mode === 'sync') {
    const unknown = unknownField(value, ['mode', 'media'], path);
    return unknown ?? mediaListError(value.media, `${path}.media`);
  }
  if (value.mode === 'async') {
    let error = unknownField(value, ['mode', 'taskIdPath', 'poll'], path);
    if (error) return error;
    error = objectPathError(value.taskIdPath, `${path}.taskIdPath`);
    return error ?? pollError(value.poll, `${path}.poll`);
  }
  return `${path}.mode must be sync or async`;
}

function operationError(value: unknown, path: string, checkFields = true): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  let error = checkFields ? unknownField(value, OPERATION_FIELDS, path) : null;
  if (error) return error;
  if (
    typeof value.capability !== 'string' ||
    !MODEL_ACCESS_MEDIA_CAPABILITIES.includes(value.capability as MediaCapability)
  ) {
    return `${path}.capability must be supported`;
  }
  if (!boundedString(value.instructions, 20_000)) {
    return `${path}.instructions must be a bounded string`;
  }
  error = requestError(value.request, `${path}.request`);
  if (error) return error;
  error = responseError(value.response, `${path}.response`);
  if (error) return error;
  if (!isPlainObject(value.exampleBody)) return `${path}.exampleBody must be an object`;
  if (!isPlainObject(value.inputSchema)) return `${path}.inputSchema must be an object`;
  if (!boundedString(value.officialDocs, 2_048)) return `${path}.officialDocs must be a URL`;
  try {
    const docs = new URL(value.officialDocs);
    if (docs.protocol !== 'https:' || !docs.hostname || docs.username || docs.password) {
      return `${path}.officialDocs must be an HTTPS URL`;
    }
  } catch {
    return `${path}.officialDocs must be an HTTPS URL`;
  }
  return null;
}

function guideBaseError(value: PlainObject, fields: readonly string[]): string | null {
  let error = unknownField(value, fields, 'guide');
  if (error) return error;
  if (value.schemaVersion !== MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION) {
    return `guide.schemaVersion must be ${MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION}`;
  }
  if (!boundedString(value.guideId, 128) || !/^[a-zA-Z0-9._-]+$/.test(value.guideId)) {
    return 'guide.guideId must be a bounded identifier';
  }
  for (const [field, max] of [['revision', 128]] as const) {
    if (!boundedString(value[field], max)) return `guide.${field} must be a bounded string`;
  }
  if (!isPlainObject(value.connection)) return 'guide.connection must be an object';
  error = unknownField(value.connection, ['providerId'], 'guide.connection');
  if (error) return error;
  if (
    !boundedString(value.connection.providerId, 128) ||
    !/^[a-zA-Z0-9_-]+$/.test(value.connection.providerId)
  ) {
    return 'guide.connection.providerId must be a bounded string';
  }
  return null;
}

function resolvedBindingError(
  value: PlainObject,
  fields: readonly string[],
  path: string,
): string | null {
  const error = unknownField(value, fields, path);
  if (error) return error;
  if (!boundedString(value.modelId, 256)) return `${path}.modelId must be a bounded string`;
  return null;
}

export function parseMediaInvocationGuide(
  value: unknown,
): ModelAccessParseResult<MediaInvocationGuide> {
  if (!isPlainObject(value)) return fail('guide must be an object');
  let error = guideBaseError(value, GUIDE_FIELDS);
  if (error) return fail(error);
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > 16) {
    return fail('guide.operations must be a non-empty array with at most 16 entries');
  }
  const capabilities = new Set<MediaCapability>();
  for (const [index, operation] of value.operations.entries()) {
    error = operationError(operation, `guide.operations[${index}]`);
    if (error) return fail(error);
    const capability = (operation as PlainObject).capability as MediaCapability;
    if (capabilities.has(capability)) {
      return fail('guide.operations must not contain duplicate capabilities');
    }
    capabilities.add(capability);
  }
  return ok(value as unknown as MediaInvocationGuide);
}

export function parseResolvedMediaInvocationGuide(
  value: unknown,
): ModelAccessParseResult<ResolvedMediaInvocationGuide> {
  if (!isPlainObject(value)) return fail('resolved guide must be an object');
  const error = resolvedBindingError(value, RESOLVED_GUIDE_FIELDS, 'resolvedGuide');
  if (error) return fail(error);
  const guide = parseMediaInvocationGuide(value.guide);
  if (!guide.ok) return fail(guide.error);
  return ok(value as unknown as ResolvedMediaInvocationGuide);
}

export function parsePreparedMediaInvocationGuide(
  value: unknown,
): ModelAccessParseResult<PreparedMediaInvocationGuide> {
  if (!isPlainObject(value)) return fail('guide must be an object');
  const error =
    guideBaseError(value, PREPARED_GUIDE_FIELDS) ??
    resolvedBindingError(value, PREPARED_GUIDE_FIELDS, 'guide') ??
    operationError(value, 'guide', false);
  return error ? fail(error) : ok(value as unknown as PreparedMediaInvocationGuide);
}
