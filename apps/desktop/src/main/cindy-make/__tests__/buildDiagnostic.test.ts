import { describe, expect, it } from 'vitest';
import { createMakeBuildOutput } from '../buildDiagnostic';
import { parseCindyMakeBuildDiagnostic } from '../../../shared/cindyMakeBuildDiagnostic';

describe('personal build failure diagnostics', () => {
  it('keeps the download failure instead of only the outer command failure', () => {
    const output = createMakeBuildOutput();
    output.append(
      'An unhandled rejection has occurred inside Forge:\nRequestError: connect ETIMEDOUT 192.0.2.1:443\n',
    );
    output.append('    at ClientRequest.emit (C:/private/node_modules/got/index.js:970:111)\n');
    output.append('Error: Command failed: npx electron-forge make\n');
    expect(output.failure(1).message).toBe(
      'RequestError: connect ETIMEDOUT 192.0.2.1:443\nError: Command failed: npx electron-forge make',
    );
  });
  it('keeps the actual fatal cause across terminal chunks and wrapper stack traces', () => {
    const output = createMakeBuildOutput();
    output.append(
      '\u001b[31mFATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of',
    );
    output.append(' memory\u001b[0m\r\n');
    output.append('1: 00007FF6B8B750BF node::OnFatalError+1343\r\n');
    output.append(
      'Error: Command failed: npx electron-forge make\r\n    at runForgeMake (C:/Users/Private/source/package.mjs:220:3)',
    );
    expect(output.failure(1)).toEqual({
      kind: 'outOfMemory',
      exitCode: 1,
      message:
        'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\nError: Command failed: npx electron-forge make',
    });
  });

  it('redacts credentials and both platforms paths before retaining a receipt', () => {
    const output = createMakeBuildOutput();
    output.append(
      'Error: api_key=not-a-real-secret; C:\\Users\\Private User\\project\\file.ts(2,3): MSB8040\n',
    );
    output.append('Error: missing /Users/private/project/file.ts\n');
    output.append(
      'Error: download https://user:not-a-real-password@example.test/pkg?token=not-a-real-token\n',
    );
    output.append(
      'C:\\Program Files (x86)\\private\\Microsoft.Cpp.targets(811,5): error MSB4018: FileTracker failed\n',
    );
    const result = output.failure(134);
    expect(result.exitCode).toBe(134);
    expect(result.message).toContain('MSB8040');
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toMatch(/not-a-real|Private|private|example\.test/);
    expect(parseCindyMakeBuildDiagnostic(result)).toEqual(result);
  });

  it('bounds progress noise without retaining a truncated credential or stale failure', () => {
    const output = createMakeBuildOutput();
    output.append('Error: stale failure\n');
    output.append('Error: token=' + 'secret'.repeat(10_000));
    output.append('Error: secret continuation');
    output.append('\nError: ENOSPC: no space left on device\n');
    expect(output.failure(1).message).toBe('Error: ENOSPC: no space left on device');
    expect(createMakeBuildOutput().failure(0, true)).toEqual({ kind: 'timeout', exitCode: 0 });
    expect(createMakeBuildOutput().failure(2)).toEqual({ kind: 'process', exitCode: 2 });
  });

  it('validates saved fields, strips terminal hyperlinks and bounds display text', () => {
    expect(parseCindyMakeBuildDiagnostic({ kind: 'unknown', message: 'private' })).toBeUndefined();
    const result = parseCindyMakeBuildDiagnostic({
      kind: 'process',
      exitCode: 'private',
      message:
        '\u001b]8;;https://private.test\u0007Error: missing dependency\u001b]8;;\u0007\n' +
        'x'.repeat(5000),
      stdout: 'private',
    });
    expect(result).not.toHaveProperty('stdout');
    expect(result).not.toHaveProperty('exitCode');
    expect(result?.message).toHaveLength(2000);
    expect(result?.message).toMatch(/^Error: missing dependency/);
    expect(result?.message).not.toMatch(/private|\u001b/);
  });
});
