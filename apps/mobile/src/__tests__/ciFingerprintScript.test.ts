import { describe, expect, it } from 'vitest';
import {
  buildFingerprintEnv,
  compareFingerprintReports,
  computeFingerprintReport,
  GUARD_COMMENT_MARKER,
  guardChangedMarker,
  parseFingerprintArgs,
  parseFingerprintCliOutput,
  renderGuardComment,
} from '../../scripts/ci-fingerprint.mjs';

describe('ci-fingerprint script', () => {
  it('parses its CLI arguments without depending on release-lib', () => {
    expect(
      parseFingerprintArgs([
        'compute',
        '--project',
        '/tmp/mobile',
        '--output=fingerprint.json',
      ]),
    ).toEqual({
      _: ['compute'],
      project: '/tmp/mobile',
      output: 'fingerprint.json',
    });
  });

  it('strips all EXPO_PUBLIC_* from the compute env to keep production semantics', () => {
    const env = buildFingerprintEnv({
      PATH: '/usr/bin',
      EXPO_PUBLIC_APP_VARIANT: 'beta',
      EXPO_PUBLIC_BETA_DEV: 'carol',
      NODE_ENV: 'test',
    });
    expect(env).toEqual({ PATH: '/usr/bin', NODE_ENV: 'test' });
  });

  it('parses the fingerprint CLI hash and rejects malformed output', () => {
    expect(parseFingerprintCliOutput('{"hash":"abc123","sources":[]}')).toBe('abc123');
    expect(() => parseFingerprintCliOutput('not json')).toThrow('not valid JSON');
    expect(() => parseFingerprintCliOutput('{"sources":[]}')).toThrow('no hash');
  });

  it('computes a report per platform via the injected runner', () => {
    const calls: Array<{ platform: string }> = [];
    const report = computeFingerprintReport('apps/mobile', {
      platforms: ['ios', 'android'],
      run: ({ platform }: { platform: string }) => {
        calls.push({ platform });
        return `hash-${platform}`;
      },
    });
    expect(calls.map((call) => call.platform)).toEqual(['ios', 'android']);
    expect(report.platforms).toEqual({ ios: 'hash-ios', android: 'hash-android' });
    expect(typeof report.toolVersion).toBe('string');
  });

  it('flags changed platforms and tool version drift', () => {
    const comparison = compareFingerprintReports(
      { toolVersion: '0.19.4', platforms: { ios: 'aaa', android: 'bbb' } },
      { toolVersion: '0.20.0', platforms: { ios: 'aaa', android: 'ccc' } },
    );
    expect(comparison.changed).toBe(true);
    expect(comparison.toolVersionChanged).toBe(true);
    expect(comparison.rows).toEqual([
      { platform: 'ios', baseHash: 'aaa', currentHash: 'aaa', changed: false },
      { platform: 'android', baseHash: 'bbb', currentHash: 'ccc', changed: true },
    ]);
  });

  it('reports unchanged when hashes match', () => {
    const comparison = compareFingerprintReports(
      { toolVersion: '0.19.4', platforms: { ios: 'aaa', android: 'bbb' } },
      { toolVersion: '0.19.4', platforms: { ios: 'aaa', android: 'bbb' } },
    );
    expect(comparison.changed).toBe(false);
    expect(comparison.toolVersionChanged).toBe(false);
  });

  it('renders a warning comment with per-platform table when changed', () => {
    const comment = renderGuardComment(
      compareFingerprintReports(
        { toolVersion: '0.19.4', platforms: { ios: 'aaa', android: 'bbb' } },
        { toolVersion: '0.19.4', platforms: { ios: 'xxx', android: 'bbb' } },
      ),
    );
    expect(comment.startsWith(GUARD_COMMENT_MARKER)).toBe(true);
    // 第二行是审查门读的机器可读结论,格式变了会让冷更审查门漏判
    expect(comment.split('\n')[1]).toBe(guardChangedMarker(true));
    expect(comment).toContain('会改变 mobile 原生 runtime fingerprint');
    expect(comment).toContain('COLD_BUILD_REQUIRED');
    expect(comment).toContain('| ios | `aaa` | `xxx` | ⚠️ 变化 |');
    expect(comment).toContain('| android | `bbb` | `bbb` | 不变 |');
    expect(comment).not.toContain('@expo/fingerprint` 版本');
  });

  it('renders a resolved comment when unchanged and notes tool version drift', () => {
    const comment = renderGuardComment(
      compareFingerprintReports(
        { toolVersion: '0.19.4', platforms: { ios: 'aaa' } },
        { toolVersion: '0.20.0', platforms: { ios: 'aaa' } },
      ),
    );
    expect(comment.startsWith(GUARD_COMMENT_MARKER)).toBe(true);
    expect(comment.split('\n')[1]).toBe(guardChangedMarker(false));
    expect(comment).toContain('已不再改变 mobile runtime fingerprint');
    expect(comment).toContain('0.19.4 → 0.20.0');
  });
});
