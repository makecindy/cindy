/**
 * safeStorage 诊断日志载荷的不变式回归(#871 / #912 review P2):
 * 错误只记 code/name,绝不落 err.message(可能携带 userData 绝对路径)或明文。
 */
import { describe, expect, it } from 'vitest';

import { buildSafeStorageIssueMeta } from '../safeStorageIssueLog';

describe('buildSafeStorageIssueMeta', () => {
  it('fs 错误只落 code,message 里的绝对路径与明文绝不进载荷', () => {
    const err = new Error(
      "EACCES: permission denied, open '/Users/someone/Library/Application Support/Cindy/safe-storage/token.enc' plaintext=hunter2",
    ) as NodeJS.ErrnoException;
    err.code = 'EACCES';
    const meta = buildSafeStorageIssueMeta('token', err);
    expect(meta).toEqual({ key: 'token', error: 'EACCES' });
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain(err.message);
  });

  it('无 code 的 Error 落 name,同样不带 message', () => {
    const err = new TypeError('decrypt blew up with secret material: s3cr3t');
    const meta = buildSafeStorageIssueMeta('token', err);
    expect(meta).toEqual({ key: 'token', error: 'TypeError' });
    expect(JSON.stringify(meta)).not.toContain('s3cr3t');
  });

  it('非 Error(字符串/undefined)不产生 error 字段,内容不透传', () => {
    expect(buildSafeStorageIssueMeta('token', 'raw secret string')).toEqual({ key: 'token' });
    expect(buildSafeStorageIssueMeta('token')).toEqual({ key: 'token' });
  });

  it('code 非字符串(异常形态)回退到 name,不透传对象', () => {
    const err = new Error('boom') as Error & { code: unknown };
    err.code = { weird: true };
    expect(buildSafeStorageIssueMeta('token', err)).toEqual({ key: 'token', error: 'Error' });
  });
});
