import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  authorizeSessionPathOutsideWorkdir,
  resolveAbsoluteSessionPath,
  setSessionPathAuthorizer,
} from '../session-path-auth.js';

afterEach(() => {
  setSessionPathAuthorizer(undefined);
});

describe('session path authorization', () => {
  it('resolves relative paths against the session root', () => {
    expect(resolveAbsoluteSessionPath('/repo', 'docs/a.pdf')).toBe(path.resolve('/repo', 'docs/a.pdf'));
    expect(resolveAbsoluteSessionPath('/repo', '/tmp/out.pdf')).toBe(path.resolve('/tmp/out.pdf'));
  });

  it('fails closed for remote sessions and when no host authorizer is registered', async () => {
    await expect(authorizeSessionPathOutsideWorkdir({
      workingDir: '/repo',
      remoteHostId: 'ssh-1',
      path: '/tmp/out.pdf',
      toolName: 'cindy-docs',
      operation: 'write',
    })).resolves.toMatchObject({ allowed: false });

    await expect(authorizeSessionPathOutsideWorkdir({
      workingDir: '/repo',
      path: '/tmp/out.pdf',
      toolName: 'cindy-docs',
      operation: 'write',
    })).resolves.toMatchObject({ allowed: false });
  });

  it('delegates local decisions to the host authorizer', async () => {
    setSessionPathAuthorizer(async (request) => {
      expect(request.path).toBe(path.resolve('/tmp/out.pdf'));
      return { allowed: true };
    });
    await expect(authorizeSessionPathOutsideWorkdir({
      workingDir: '/repo',
      path: path.resolve('/tmp/out.pdf'),
      toolName: 'cindy-docs',
      operation: 'write',
    })).resolves.toEqual({ allowed: true });
  });
});
