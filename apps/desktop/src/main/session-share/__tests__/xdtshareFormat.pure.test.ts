import { describe, expect, it } from 'vitest';

import {
  XDTSHARE_ENCRYPTED_HEADER_LENGTH,
  XDTSHARE_PLAIN_HEADER_LENGTH,
  XdtshareError,
  decodeXdtshareHeader,
  encodeEncryptedHeader,
  encodePlainHeader,
  looksLikeZip,
  validateManifest,
} from '../xdtshareFormat.pure.js';

function validManifest(): Record<string, unknown> {
  return {
    formatVersion: 1,
    minReaderVersion: 1,
    appVersion: '1.0.0',
    platform: 'darwin',
    exportedAt: '2026-07-04T00:00:00.000Z',
    agentKind: 'cc',
    title: 'test session',
    workspaceKind: 'project',
    originalWorkingDir: '/Users/a/proj',
    sdkSessionIds: ['sid-1', 'sid-2'],
    activeSdkSessionId: 'sid-2',
    exportFidelity: 'full',
    counts: { messages: 3, media: 1 },
    entries: [{ path: 'messages.jsonl', bytes: 10, sha256: 'ab' }],
    transcripts: [
      { sdkSessionId: 'sid-1', path: 'transcripts/claude/sid-1.jsonl' },
      { sdkSessionId: 'sid-2', path: null },
    ],
  };
}

describe('xdtshare header', () => {
  it('plain header roundtrip', () => {
    const header = encodePlainHeader();
    expect(header.length).toBe(XDTSHARE_PLAIN_HEADER_LENGTH);
    const decoded = decodeXdtshareHeader(Buffer.concat([header, Buffer.from('PK\x03\x04rest')]));
    expect(decoded).toEqual({ cipher: 0, payloadOffset: XDTSHARE_PLAIN_HEADER_LENGTH });
  });

  it('encrypted header roundtrip preserves kdf params, salt, iv', () => {
    const salt = Buffer.alloc(16, 0xaa);
    const iv = Buffer.alloc(12, 0xbb);
    const header = encodeEncryptedHeader({ logN: 15, r: 8, p: 1, salt, iv });
    expect(header.length).toBe(XDTSHARE_ENCRYPTED_HEADER_LENGTH);
    const tag = Buffer.alloc(16, 0xcc);
    tag.copy(header, 44);
    const decoded = decodeXdtshareHeader(Buffer.concat([header, Buffer.from('cipherbytes')]));
    if (decoded.cipher !== 1) throw new Error('expected encrypted header');
    expect(decoded.logN).toBe(15);
    expect(decoded.r).toBe(8);
    expect(decoded.p).toBe(1);
    expect(decoded.salt.equals(salt)).toBe(true);
    expect(decoded.iv.equals(iv)).toBe(true);
    expect(decoded.authTag.equals(tag)).toBe(true);
    expect(decoded.aad.equals(header.subarray(0, 44))).toBe(true);
    expect(decoded.payloadOffset).toBe(XDTSHARE_ENCRYPTED_HEADER_LENGTH);
  });

  it('rejects bad magic with SHARE_FILE_INVALID', () => {
    const bogus = Buffer.from('NOTSHARExxxxxxxxxxxx');
    expect(() => decodeXdtshareHeader(bogus)).toThrowError(XdtshareError);
    try {
      decodeXdtshareHeader(bogus);
    } catch (err) {
      expect((err as XdtshareError).code).toBe('SHARE_FILE_INVALID');
    }
  });

  it('rejects newer header version with SHARE_VERSION_UNSUPPORTED', () => {
    const header = encodePlainHeader();
    header.writeUInt8(99, 8);
    try {
      decodeXdtshareHeader(header);
      expect.unreachable();
    } catch (err) {
      expect((err as XdtshareError).code).toBe('SHARE_VERSION_UNSUPPORTED');
    }
  });

  it('rejects truncated encrypted header and out-of-range scrypt params', () => {
    const salt = Buffer.alloc(16, 1);
    const iv = Buffer.alloc(12, 2);
    const header = encodeEncryptedHeader({ logN: 15, r: 8, p: 1, salt, iv });
    expect(() => decodeXdtshareHeader(header.subarray(0, 30))).toThrowError(XdtshareError);

    const evil = Buffer.from(header);
    evil.writeUInt8(31, 12); // logN=31 → 128GB 内存放大
    try {
      decodeXdtshareHeader(evil);
      expect.unreachable();
    } catch (err) {
      expect((err as XdtshareError).code).toBe('SHARE_FILE_INVALID');
    }
  });

  it('looksLikeZip detects zip magic', () => {
    expect(looksLikeZip(Buffer.from('PK\x03\x04...'))).toBe(true);
    expect(looksLikeZip(Buffer.from('nope'))).toBe(false);
    expect(looksLikeZip(Buffer.alloc(0))).toBe(false);
  });
});

describe('validateManifest', () => {
  it('accepts a valid manifest and ignores unknown fields', () => {
    const raw = { ...validManifest(), futureField: { anything: true } };
    const manifest = validateManifest(raw);
    expect(manifest.agentKind).toBe('cc');
    expect(manifest.sdkSessionIds).toEqual(['sid-1', 'sid-2']);
    expect(manifest.transcripts[1].path).toBeNull();
    expect(manifest.counts).toEqual({ messages: 3, media: 1 });
    expect('futureField' in manifest).toBe(false);
  });

  it('accepts Pi manifests without relabeling the agent', () => {
    expect(validateManifest({ ...validManifest(), agentKind: 'pi' }).agentKind).toBe('pi');
  });

  it('rejects minReaderVersion above this reader', () => {
    try {
      validateManifest({ ...validManifest(), minReaderVersion: 999 });
      expect.unreachable();
    } catch (err) {
      expect((err as XdtshareError).code).toBe('SHARE_VERSION_UNSUPPORTED');
    }
  });

  it.each([
    ['missing agentKind', { agentKind: undefined }],
    ['unknown agentKind', { agentKind: 'gemini' }],
    ['unknown fidelity', { exportFidelity: 'lossy' }],
    ['bad entries', { entries: [{ path: 1 }] }],
    ['bad transcripts', { transcripts: [{}] }],
    ['non-integer formatVersion', { formatVersion: 1.5 }],
  ])('rejects %s with SHARE_FILE_INVALID', (_label, patch) => {
    try {
      validateManifest({ ...validManifest(), ...patch });
      expect.unreachable();
    } catch (err) {
      expect((err as XdtshareError).code).toBe('SHARE_FILE_INVALID');
    }
  });

  it('rejects non-object input', () => {
    expect(() => validateManifest(null)).toThrowError(XdtshareError);
    expect(() => validateManifest('{}')).toThrowError(XdtshareError);
  });

  it('accepts a valid orca section and roundtrips worker metadata', () => {
    const manifest = validateManifest({
      ...validManifest(),
      orca: {
        teamStatus: 'active',
        workers: [
          {
            index: 0,
            agentKind: 'codex',
            title: 'Worker 1',
            role: 'developer',
            label: 'dev-1',
            status: 'done',
            focused: true,
            sdkSessionIds: ['thread-1'],
            activeSdkSessionId: 'thread-1',
            counts: { messages: 5 },
            transcripts: [{ sdkSessionId: 'thread-1', path: 'orca/workers/0/transcripts/codex/r.jsonl' }],
          },
        ],
      },
    });
    expect(manifest.orca).toBeDefined();
    expect(manifest.orca!.teamStatus).toBe('active');
    expect(manifest.orca!.workers[0]).toMatchObject({
      index: 0,
      agentKind: 'codex',
      label: 'dev-1',
      status: 'done',
      focused: true,
      counts: { messages: 5 },
    });
  });

  it('manifest without orca leaves the field absent', () => {
    expect('orca' in validateManifest(validManifest())).toBe(false);
  });

  it.each([
    ['unknown orca teamStatus', { teamStatus: 'paused', workers: [] }],
    [
      'unknown orca worker status',
      {
        teamStatus: 'active',
        workers: [
          {
            index: 0,
            agentKind: 'cc',
            title: 'w',
            role: 'developer',
            label: null,
            status: 'zombie',
            focused: false,
            sdkSessionIds: [],
            activeSdkSessionId: null,
            counts: { messages: 0 },
            transcripts: [],
          },
        ],
      },
    ],
    [
      'unknown orca worker agentKind',
      {
        teamStatus: 'active',
        workers: [
          {
            index: 0,
            agentKind: 'gemini',
            title: 'w',
            role: 'developer',
            label: null,
            status: 'idle',
            focused: false,
            sdkSessionIds: [],
            activeSdkSessionId: null,
            counts: { messages: 0 },
            transcripts: [],
          },
        ],
      },
    ],
  ])('rejects %s with SHARE_FILE_INVALID', (_label, orca) => {
    try {
      validateManifest({ ...validManifest(), orca });
      expect.unreachable();
    } catch (err) {
      expect((err as XdtshareError).code).toBe('SHARE_FILE_INVALID');
    }
  });
});
