import { describe, expect, it } from 'vitest';
import {
  INVOKE_TIMEOUT_OVERRIDES_MS,
  ORCA_REMOTE_WORKER_CAPS_CHANNEL,
  ORCA_REMOTE_WORKER_OPEN_CHANNEL,
  ORCA_REMOTE_WORKER_OPEN_TIMEOUT_MS,
  ORCA_REMOTE_WORKER_RELEASE_CHANNEL,
  REMOTE_INVOKE_ALLOWLIST,
  parseOrcaRemoteWorkerOpenRequest,
  parseOrcaRemoteWorkerReleaseRequest,
} from '../index.js';

const base = {
  sessionId: 'w_remote_1',
  agentKind: 'claude-code',
  permissionMode: 'auto',
  title: 'Worker · 转写',
  lead: { leadSessionId: 'lead-1', leadTitle: '整理产品访谈报告', workerLabel: '转写' },
};

describe('orca remote worker channels', () => {
  // Shared-task guests are refused by the desktop shared-task gate (not in its channel list).
  it('registers caps / open / release on the same-account allowlist', () => {
    for (const channel of [
      ORCA_REMOTE_WORKER_CAPS_CHANNEL,
      ORCA_REMOTE_WORKER_OPEN_CHANNEL,
      ORCA_REMOTE_WORKER_RELEASE_CHANNEL,
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(channel)).toBe(true);
    }
  });

  it('gives open a longer invoke budget than the default', () => {
    expect(INVOKE_TIMEOUT_OVERRIDES_MS[ORCA_REMOTE_WORKER_OPEN_CHANNEL]).toBe(
      ORCA_REMOTE_WORKER_OPEN_TIMEOUT_MS,
    );
  });
});

describe('parseOrcaRemoteWorkerOpenRequest', () => {
  it('keeps known fields, trims text and drops unknown fields', () => {
    expect(
      parseOrcaRemoteWorkerOpenRequest({
        ...base,
        model: ' claude-opus-5-5 ',
        workingDir: '/Users/demo/Interviews',
        fastMode: false,
        leadDeviceId: 'spoofed',
        extra: 1,
      }),
    ).toEqual({
      ...base,
      model: 'claude-opus-5-5',
      workingDir: '/Users/demo/Interviews',
      fastMode: false,
    });
  });

  it('treats blank optional fields as absent', () => {
    expect(parseOrcaRemoteWorkerOpenRequest({ ...base, model: '  ', workingDir: '' })).toEqual(base);
  });

  it.each([
    ['unsafe session id', { ...base, sessionId: '../x' }],
    ['unknown agent', { ...base, agentKind: 'gpt' }],
    ['unsupported permission mode', { ...base, permissionMode: 'ask' }],
    ['missing title', { ...base, title: ' ' }],
    ['missing lead', { ...base, lead: undefined }],
    ['unsafe lead session id', { ...base, lead: { ...base.lead, leadSessionId: 'a/b' } }],
    ['missing worker label', { ...base, lead: { ...base.lead, workerLabel: '' } }],
    ['working dir with newline', { ...base, workingDir: '/tmp/a\nb' }],
    ['non-boolean fastMode', { ...base, fastMode: 'yes' }],
  ])('rejects %s', (_name, input) => {
    expect(() => parseOrcaRemoteWorkerOpenRequest(input)).toThrow(/\[INVALID_PARAMS\]/);
  });
});

describe('parseOrcaRemoteWorkerReleaseRequest', () => {
  it('accepts a safe session id only', () => {
    expect(parseOrcaRemoteWorkerReleaseRequest({ sessionId: 'w_remote_1', x: 1 })).toEqual({
      sessionId: 'w_remote_1',
    });
    expect(() => parseOrcaRemoteWorkerReleaseRequest({ sessionId: 'a b' })).toThrow(/INVALID_PARAMS/);
    expect(() => parseOrcaRemoteWorkerReleaseRequest(null)).toThrow(/INVALID_PARAMS/);
  });
});
