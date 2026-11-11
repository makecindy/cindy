import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { workdirDiagnosticContext, workdirDiagnosticErrorCode, workdirDiagnosticId } from '../workdirDiagnostics';

describe('working directory diagnostic privacy', () => {
  it('correlates normalized paths without exposing directories or session contents', () => {
    const dir = path.resolve('private-project');
    const context = workdirDiagnosticContext('private-session', dir);
    expect(context.directoryRef).toBe(workdirDiagnosticId(path.join(dir, '.')));
    expect(context.directoryRef).not.toBe(workdirDiagnosticId(path.join(dir, 'other')));
    expect(context.sessionRef).not.toBe(workdirDiagnosticContext('other-session', dir).sessionRef);
    expect(context.sessionRef).toMatch(/^[a-f0-9]{16}$/);
    expect(context.directoryRef).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(context)).not.toContain('private');
  });

  it('does not reuse directory references across module lifetimes', async () => {
    const dir = path.resolve('private-project');
    const before = workdirDiagnosticId(dir);
    vi.resetModules();
    const fresh = await import('../workdirDiagnostics');
    expect(fresh.workdirDiagnosticId(dir)).not.toBe(before);
  });

  it.each(['ENOENT', 'EACCES', 'EIO', 'WORKDIR_PROBE_TIMEOUT', 'WORKDIR_PROBE_UNAVAILABLE'])('retains only known error codes: %s', (code) => {
    const error = Object.assign(new Error('private path and credentials'), { code });
    expect(workdirDiagnosticErrorCode(error)).toBe(code);
  });

  it.each([null, undefined, {}, { code: 42 }, { code: 'PRIVATE_CREDENTIAL' }, new Error('private-project')])('does not copy arbitrary error details: %j', (error) => {
    expect(workdirDiagnosticErrorCode(error)).toBe('UNKNOWN');
  });
});
