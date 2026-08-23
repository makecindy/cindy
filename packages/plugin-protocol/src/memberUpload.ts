import {
  PluginProtocolError,
  httpsUrl,
  isoDate,
  nextCursor,
  object,
  sha256,
  string,
} from './internal/parse.js';
import { isValidPluginResourceId } from './internal/pluginResourceId.js';
import { isValidGhostId } from './manifest.js';

export { PluginProtocolError } from './internal/parse.js';

/**
 * Organization member Plugin publishing wire contract.
 *
 * The limits below govern the member-upload channel only. Until plugin-server
 * wires this channel in, its existing publisher-path validation limits remain
 * authoritative for the paths it already serves.
 */

/** Maximum accepted `.cindy` archive size, aligned with Cindy Forge Node packages. */
export const PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
/** Maximum aggregate uncompressed ZIP size. */
export const PLUGIN_MEMBER_UPLOAD_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
/** Maximum number of ZIP entries. */
export const PLUGIN_MEMBER_UPLOAD_MAX_ZIP_ENTRIES = 2_048;

/** Persistent source recorded for an interactive member upload. */
export const PLUGIN_MEMBER_UPLOAD_PUBLISH_SOURCE = 'member_upload' as const;

/** Persistent upload-task states returned by commit, status and "my publishes" APIs. */
export const PLUGIN_MEMBER_UPLOAD_STATUSES = [
  'awaiting_upload',
  'validating',
  'publishing',
  'succeeded',
  'failed',
  'expired',
] as const;
export type PluginMemberUploadStatus = (typeof PLUGIN_MEMBER_UPLOAD_STATUSES)[number];

/** Release review state after a member upload has produced a Release. */
export const PLUGIN_MEMBER_RELEASE_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type PluginMemberReleaseReviewStatus =
  (typeof PLUGIN_MEMBER_RELEASE_REVIEW_STATUSES)[number];

/** Stable asynchronous failure codes persisted on an upload task. */
export const PLUGIN_MEMBER_UPLOAD_FAILURE_CODES = [
  'UPLOAD_OBJECT_MISSING',
  'UPLOAD_SIZE_MISMATCH',
  'UPLOAD_SHA256_MISMATCH',
  'PLUGIN_PACKAGE_INVALID',
  'MEMBERSHIP_INACTIVE',
  'PUBLISH_NOT_AUTHORIZED',
  'PLUGIN_GHOST_ID_CONFLICT',
  'PUBLISH_STORAGE_UNAVAILABLE',
  'PUBLISH_INTERNAL_ERROR',
] as const;
export type PluginMemberUploadFailureCode = (typeof PLUGIN_MEMBER_UPLOAD_FAILURE_CODES)[number];

/** Identity and idempotency are carried by verified auth/header context, not this body. */
export interface PreparePluginMemberUploadRequest {
  sizeBytes: number;
  sha256: string;
}

export interface PreparePluginMemberUploadResponse {
  uploadId: string;
  putUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
  status: 'awaiting_upload';
}

/** ghostId, version and actor identity cannot be overridden by the commit body. */
export type CommitPluginMemberUploadRequest = Record<string, never>;

export interface CommitPluginMemberUploadResponse {
  uploadId: string;
  status: PluginMemberUploadStatus;
}

export interface PluginMemberUploadFailure {
  code: PluginMemberUploadFailureCode;
  /** Safe, user-facing reason. Must not contain internal object keys or audit details. */
  message: string;
}

export interface PluginMemberUploadStatusResponse {
  uploadId: string;
  status: PluginMemberUploadStatus;
  pluginId: string | null;
  releaseId: string | null;
  ghostId: string | null;
  version: string | null;
  /** Null until a Release exists; changes independently after upload success. */
  reviewStatus: PluginMemberReleaseReviewStatus | null;
  failure: PluginMemberUploadFailure | null;
}

export interface PluginMemberReleaseSummary extends PluginMemberUploadStatusResponse {
  createdAt: string;
  updatedAt: string;
}

export interface ListMyPluginMemberReleasesResponse {
  releases: PluginMemberReleaseSummary[];
  nextCursor: string | null;
}

function nullableString(value: unknown, path: string, max = 256): string | null {
  return value === null ? null : string(value, path, max);
}

function nullableGhostId(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (!isValidGhostId(value)) {
    throw new PluginProtocolError(`${path} 不合法`);
  }
  return value;
}

function nullablePluginId(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (!isValidPluginResourceId(value)) {
    throw new PluginProtocolError(`${path} 不合法`);
  }
  return value;
}

function enumValue<T extends string>(
  values: readonly T[],
  value: unknown,
  path: string,
  description: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new PluginProtocolError(`${path} ${description}`);
  }
  return value as T;
}

function uploadStatus(value: unknown, path: string): PluginMemberUploadStatus {
  return enumValue(PLUGIN_MEMBER_UPLOAD_STATUSES, value, path, '不在成员上传状态集合中');
}

function reviewStatus(value: unknown, path: string): PluginMemberReleaseReviewStatus | null {
  if (value === null) return null;
  return enumValue(
    PLUGIN_MEMBER_RELEASE_REVIEW_STATUSES,
    value,
    path,
    '不在 Release 审核状态集合中',
  );
}

function failure(value: unknown, path: string): PluginMemberUploadFailure | null {
  if (value === null) return null;
  const raw = object(value, path);
  return {
    code: enumValue(
      PLUGIN_MEMBER_UPLOAD_FAILURE_CODES,
      raw.code,
      `${path}.code`,
      '不在成员上传失败码集合中',
    ),
    message: string(raw.message, `${path}.message`, 1_000),
  };
}

/** Validates the prepare body and rejects actor/package metadata overrides. */
export function parsePreparePluginMemberUploadRequest(
  value: unknown,
): PreparePluginMemberUploadRequest {
  const raw = object(value, 'request');
  const unknownKeys = Object.keys(raw).filter((key) => key !== 'sizeBytes' && key !== 'sha256');
  if (unknownKeys.length > 0) {
    throw new PluginProtocolError(`request 不接受字段: ${unknownKeys.join(', ')}`);
  }
  if (
    typeof raw.sizeBytes !== 'number' ||
    !Number.isSafeInteger(raw.sizeBytes) ||
    raw.sizeBytes <= 0 ||
    raw.sizeBytes > PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES
  ) {
    throw new PluginProtocolError(
      `request.sizeBytes 必须是 1–${PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES} 的安全整数`,
    );
  }
  return { sizeBytes: raw.sizeBytes, sha256: sha256(raw.sha256, 'request.sha256') };
}

/** Validates that commit carries no package, path or identity override fields. */
export function parseCommitPluginMemberUploadRequest(
  value: unknown,
): CommitPluginMemberUploadRequest {
  if (value === undefined || value === null) return {};
  const raw = object(value, 'request');
  const keys = Object.keys(raw);
  if (keys.length > 0) {
    throw new PluginProtocolError(`request 不接受字段: ${keys.join(', ')}`);
  }
  return {};
}

export function parsePreparePluginMemberUploadResponse(
  value: unknown,
): PreparePluginMemberUploadResponse {
  const raw = object(value, 'response');
  if (raw.status !== 'awaiting_upload') {
    throw new PluginProtocolError('response.status 必须是 awaiting_upload');
  }
  const putUrl = httpsUrl(raw.putUrl, 'response.putUrl');
  const rawHeaders = object(raw.headers, 'response.headers');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new PluginProtocolError('response.headers 包含非法 HTTP header 名');
    }
    const headerValue = string(value, `response.headers.${name}`, 8_192);
    if (/[\r\n]/.test(headerValue)) {
      throw new PluginProtocolError(`response.headers.${name} 不得包含换行`);
    }
    headers[name] = headerValue;
  }
  return {
    uploadId: string(raw.uploadId, 'response.uploadId', 128),
    putUrl,
    headers,
    expiresAt: isoDate(raw.expiresAt, 'response.expiresAt'),
    status: 'awaiting_upload',
  };
}

export function parseCommitPluginMemberUploadResponse(
  value: unknown,
): CommitPluginMemberUploadResponse {
  const raw = object(value, 'response');
  return {
    uploadId: string(raw.uploadId, 'response.uploadId', 128),
    status: uploadStatus(raw.status, 'response.status'),
  };
}

function parsePluginMemberUploadStatusResponseAtPath(
  value: unknown,
  path: string,
): PluginMemberUploadStatusResponse {
  const raw = object(value, path);
  const status = uploadStatus(raw.status, `${path}.status`);
  const parsedReviewStatus = reviewStatus(raw.reviewStatus, `${path}.reviewStatus`);
  const parsedFailure = failure(raw.failure, `${path}.failure`);
  const result: PluginMemberUploadStatusResponse = {
    uploadId: string(raw.uploadId, `${path}.uploadId`, 128),
    status,
    pluginId: nullablePluginId(raw.pluginId, `${path}.pluginId`),
    releaseId: nullableString(raw.releaseId, `${path}.releaseId`, 128),
    ghostId: nullableGhostId(raw.ghostId, `${path}.ghostId`),
    version: nullableString(raw.version, `${path}.version`, 32),
    reviewStatus: parsedReviewStatus,
    failure: parsedFailure,
  };
  if (status === 'succeeded') {
    if (
      result.pluginId === null ||
      result.releaseId === null ||
      result.ghostId === null ||
      result.version === null ||
      result.reviewStatus === null
    ) {
      throw new PluginProtocolError('succeeded 状态必须包含 Release 标识与审核状态');
    }
  } else if (result.reviewStatus !== null) {
    throw new PluginProtocolError('仅 succeeded 状态可包含 reviewStatus');
  }
  if (status === 'failed' && result.failure === null) {
    throw new PluginProtocolError('failed 状态必须包含 failure');
  }
  if (status !== 'failed' && result.failure !== null) {
    throw new PluginProtocolError('仅 failed 状态可包含 failure');
  }
  return result;
}

export function parsePluginMemberUploadStatusResponse(
  value: unknown,
): PluginMemberUploadStatusResponse {
  return parsePluginMemberUploadStatusResponseAtPath(value, 'response');
}

function parseMemberReleaseSummary(value: unknown, path: string): PluginMemberReleaseSummary {
  const raw = object(value, path);
  const status = parsePluginMemberUploadStatusResponseAtPath(raw, path);
  return {
    ...status,
    createdAt: isoDate(raw.createdAt, `${path}.createdAt`),
    updatedAt: isoDate(raw.updatedAt, `${path}.updatedAt`),
  };
}

export function parseListMyPluginMemberReleasesResponse(
  value: unknown,
): ListMyPluginMemberReleasesResponse {
  const raw = object(value, 'response');
  if (!Array.isArray(raw.releases)) {
    throw new PluginProtocolError('response.releases 必须是数组');
  }
  return {
    releases: raw.releases.map((release, index) =>
      parseMemberReleaseSummary(release, `response.releases[${index}]`),
    ),
    nextCursor: nextCursor(raw.nextCursor, 'response.nextCursor'),
  };
}
