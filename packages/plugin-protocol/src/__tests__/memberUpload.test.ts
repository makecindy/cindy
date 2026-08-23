import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PLUGIN_MEMBER_RELEASE_REVIEW_STATUSES,
  PLUGIN_MEMBER_UPLOAD_FAILURE_CODES,
  PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES,
  PLUGIN_MEMBER_UPLOAD_MAX_UNCOMPRESSED_BYTES,
  PLUGIN_MEMBER_UPLOAD_MAX_ZIP_ENTRIES,
  PLUGIN_MEMBER_UPLOAD_PUBLISH_SOURCE,
  PLUGIN_MEMBER_UPLOAD_STATUSES,
  parseCommitPluginMemberUploadRequest,
  parseListMyPluginMemberReleasesResponse,
  parsePluginMemberUploadStatusResponse,
  parsePreparePluginMemberUploadRequest,
  parsePreparePluginMemberUploadResponse,
  type CommitPluginMemberUploadRequest,
  type PreparePluginMemberUploadRequest,
} from '../memberUpload.js';

const SHA256 = 'a'.repeat(64);
const NOW = '2026-08-09T03:00:00.000Z';
const PLUGIN_ID = `c${'p'.repeat(24)}`;

function succeededStatus() {
  return {
    uploadId: 'upload-1',
    status: 'succeeded',
    pluginId: PLUGIN_ID,
    releaseId: 'release-1',
    ghostId: 'release-helper',
    version: '1.0.0',
    reviewStatus: 'pending',
    failure: null,
  };
}

describe('member upload contract', () => {
  it('exports the Forge package limits as the protocol authority', () => {
    expect(PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES).toBe(128 * 1024 * 1024);
    expect(PLUGIN_MEMBER_UPLOAD_MAX_UNCOMPRESSED_BYTES).toBe(256 * 1024 * 1024);
    expect(PLUGIN_MEMBER_UPLOAD_MAX_ZIP_ENTRIES).toBe(2_048);
  });

  it('keeps source, task states, review states and asynchronous failures unique', () => {
    expect(PLUGIN_MEMBER_UPLOAD_PUBLISH_SOURCE).toBe('member_upload');
    expect(PLUGIN_MEMBER_UPLOAD_STATUSES).toEqual([
      'awaiting_upload',
      'validating',
      'publishing',
      'succeeded',
      'failed',
      'expired',
    ]);
    expect(PLUGIN_MEMBER_RELEASE_REVIEW_STATUSES).toEqual(['pending', 'approved', 'rejected']);
    expect(new Set(PLUGIN_MEMBER_UPLOAD_FAILURE_CODES).size).toBe(
      PLUGIN_MEMBER_UPLOAD_FAILURE_CODES.length,
    );
  });

  it('validates prepare size/hash and rejects identity or package metadata overrides', () => {
    expect(
      parsePreparePluginMemberUploadRequest({
        sizeBytes: PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES,
        sha256: SHA256,
      }),
    ).toEqual({ sizeBytes: PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES, sha256: SHA256 });
    expect(() =>
      parsePreparePluginMemberUploadRequest({
        sizeBytes: PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES + 1,
        sha256: SHA256,
      }),
    ).toThrow(/sizeBytes/);
    expect(() =>
      parsePreparePluginMemberUploadRequest({
        sizeBytes: 1,
        sha256: SHA256.toUpperCase(),
      }),
    ).toThrow(/sha256/);
    expect(() =>
      parsePreparePluginMemberUploadRequest({
        sizeBytes: 1,
        sha256: SHA256,
        organizationId: 'forged-org',
      }),
    ).toThrow(/organizationId/);
    expect(parseCommitPluginMemberUploadRequest(undefined)).toEqual({});
    expect(parseCommitPluginMemberUploadRequest({})).toEqual({});
    expect(() => parseCommitPluginMemberUploadRequest({ ghostId: 'forged' })).toThrow(/ghostId/);
  });

  it('validates the private PUT ticket without weakening HTTPS or header safety', () => {
    const response = {
      uploadId: 'upload-1',
      putUrl: 'https://uploads.example.test/private?signature=test',
      headers: { 'content-type': 'application/octet-stream', 'x-oss-forbid-overwrite': 'true' },
      expiresAt: NOW,
      status: 'awaiting_upload',
    };
    expect(parsePreparePluginMemberUploadResponse(response)).toEqual(response);
    expect(() =>
      parsePreparePluginMemberUploadResponse({
        ...response,
        putUrl: 'http://uploads.example.test/private',
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      parsePreparePluginMemberUploadResponse({
        ...response,
        headers: { 'x-test': 'ok\r\nAuthorization: forged' },
      }),
    ).toThrow(/换行/);
  });

  it('keeps upload task status separate from Release review status', () => {
    expect(parsePluginMemberUploadStatusResponse(succeededStatus())).toEqual(succeededStatus());
    expect(
      parsePluginMemberUploadStatusResponse({
        uploadId: 'upload-2',
        status: 'failed',
        pluginId: null,
        releaseId: null,
        ghostId: null,
        version: null,
        reviewStatus: null,
        failure: { code: 'PLUGIN_PACKAGE_INVALID', message: 'ghost.json 不合法' },
      }).failure?.code,
    ).toBe('PLUGIN_PACKAGE_INVALID');
    expect(() =>
      parsePluginMemberUploadStatusResponse({
        ...succeededStatus(),
        reviewStatus: null,
      }),
    ).toThrow(/审核状态/);
    expect(() =>
      parsePluginMemberUploadStatusResponse({
        ...succeededStatus(),
        status: 'failed',
        failure: null,
        reviewStatus: null,
      }),
    ).toThrow(/failure/);
  });

  it('rejects invalid ghost IDs in status and my-publishes responses', () => {
    expect(() =>
      parsePluginMemberUploadStatusResponse({
        ...succeededStatus(),
        ghostId: 'Bad Ghost Id',
      }),
    ).toThrow('response.ghostId 不合法');

    expect(() =>
      parseListMyPluginMemberReleasesResponse({
        releases: [
          {
            ...succeededStatus(),
            ghostId: 'con',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        nextCursor: null,
      }),
    ).toThrow('response.releases[0].ghostId 不合法');
  });

  it('rejects invalid Plugin resource IDs in status and my-publishes responses', () => {
    expect(() =>
      parsePluginMemberUploadStatusResponse({
        ...succeededStatus(),
        pluginId: 'plugin-1',
      }),
    ).toThrow('response.pluginId 不合法');

    expect(() =>
      parseListMyPluginMemberReleasesResponse({
        releases: [
          {
            ...succeededStatus(),
            pluginId: 'plugin-1',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        nextCursor: null,
      }),
    ).toThrow('response.releases[0].pluginId 不合法');
  });

  it('preserves top-level paths and reports nested my-publishes paths', () => {
    expect(() =>
      parsePluginMemberUploadStatusResponse({
        ...succeededStatus(),
        status: 'unknown',
      }),
    ).toThrow('response.status 不在成员上传状态集合中');

    expect(() =>
      parseListMyPluginMemberReleasesResponse({
        releases: [
          { ...succeededStatus(), createdAt: NOW, updatedAt: NOW },
          { ...succeededStatus(), status: 'unknown', createdAt: NOW, updatedAt: NOW },
        ],
        nextCursor: null,
      }),
    ).toThrow('response.releases[1].status 不在成员上传状态集合中');
  });

  it('round-trips my-publishes timestamps and opaque cursor', () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: NOW, uploadId: 'upload-1' })).toString(
      'base64url',
    );
    const response = {
      releases: [{ ...succeededStatus(), createdAt: NOW, updatedAt: NOW }],
      nextCursor: cursor,
    };
    expect(parseListMyPluginMemberReleasesResponse(response)).toEqual(response);
    expect(() =>
      parseListMyPluginMemberReleasesResponse({
        ...response,
        releases: [{ ...response.releases[0], updatedAt: 'tomorrow' }],
      }),
    ).toThrow(/updatedAt/);
  });

  it('exports request types that cannot carry actor identity', () => {
    expectTypeOf<PreparePluginMemberUploadRequest>().toEqualTypeOf<{
      sizeBytes: number;
      sha256: string;
    }>();
    expectTypeOf<CommitPluginMemberUploadRequest>().toEqualTypeOf<Record<string, never>>();
  });
});
