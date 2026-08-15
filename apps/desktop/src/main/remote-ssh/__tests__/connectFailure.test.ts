/**
 * classifyConnectFailure unit tests.
 * Covers: ENOENT-code classification, remote-forged message rejection,
 * auth-failure passthrough, and fallback to SSH_CONNECT_FAILED.
 */

import { describe, expect, it } from 'vitest';
import {
  KEY_FILE_NOT_FOUND_CODE,
  KEY_FILE_UNREADABLE_CODE,
  PINNED_AGENT_FAILED_CODE,
} from '@cindy/maker-remote-ssh';

import { classifyConnectFailure } from '../connect-failure.js';

describe('classifyConnectFailure', () => {
  it('classifies the resolveAuth ENOENT error as SSH_KEY_FILE_NOT_FOUND via its stable local code', () => {
    const err = new Error(`identity file not found: C:\\Users\\someone\\.ssh\\id_ed25519`);
    (err as { code?: string }).code = KEY_FILE_NOT_FOUND_CODE;
    const { code, msg } = classifyConnectFailure(err);
    expect(code).toBe('SSH_KEY_FILE_NOT_FOUND');
    expect(msg).toBe('identity file not found: C:\\Users\\someone\\.ssh\\id_ed25519');
  });

  // 轮 22-F3:补 KEY_FILE_UNREADABLE(EACCES/EISDIR 等本地 key 读取错误)与
  // PINNED_AGENT_FAILED(agent+pinned 解析失败)的显式分类断言 —— 防止后续
  // 改动把它们误回落到 SSH_CONNECT_FAILED(可重试语义)而测试仍全绿。
  it('classifies local key unreadable (EACCES) as SSH_KEY_FILE_NOT_FOUND', () => {
    const err = new Error('EACCES: permission denied, open \'/Users/someone/.ssh/id_ed25519\'');
    (err as { code?: string }).code = KEY_FILE_UNREADABLE_CODE;
    expect(classifyConnectFailure(err).code).toBe('SSH_KEY_FILE_NOT_FOUND');
  });

  it('classifies pinned-agent parse failure as SSH_KEY_FILE_NOT_FOUND (non-retryable config error)', () => {
    const err = new Error('agent + pinned key failed (invalid public key format). Make sure ... exists');
    (err as { code?: string }).code = PINNED_AGENT_FAILED_CODE;
    const { code, msg } = classifyConnectFailure(err);
    expect(code).toBe('SSH_KEY_FILE_NOT_FOUND');
    expect(msg).toContain('agent + pinned key failed');
  });

  it('does NOT classify a remote-forged message that merely looks like a key-file error', () => {
    // 远端 SSH 服务端可以注入 message 文本,但永远无法设置我们本地打的 code。
    const forged = new Error('identity file not found: C:\\Users\\someone\\.ssh\\id_ed25519');
    expect(classifyConnectFailure(forged).code).toBe('SSH_CONNECT_FAILED');
  });

  it('still classifies auth-shaped failures as SSH_AUTH_FAILED', () => {
    expect(classifyConnectFailure(new Error('Permission denied (publickey)')).code).toBe('SSH_AUTH_FAILED');
    expect(classifyConnectFailure(new Error('All configured authentication methods failed')).code).toBe('SSH_AUTH_FAILED');
  });

  it('falls back to SSH_CONNECT_FAILED for network/handshake errors', () => {
    expect(classifyConnectFailure(new Error('connect ETIMEDOUT 10.0.0.5:22')).code).toBe('SSH_CONNECT_FAILED');
    expect(classifyConnectFailure('connection closed before ready').code).toBe('SSH_CONNECT_FAILED');
    expect(classifyConnectFailure(undefined).code).toBe('SSH_CONNECT_FAILED');
  });
});
