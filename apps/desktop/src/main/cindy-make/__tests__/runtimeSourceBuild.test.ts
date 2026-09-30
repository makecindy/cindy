import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { captureRuntimeSource, cindyRuntimeSourcePlugin } from '../../../../cindy-runtime-source';

const root = path.resolve('source-checkout');
const commit = 'a'.repeat(40);
const deps = (status = '') => ({
  git: vi.fn((args: string[]) =>
    args[0] === 'status'
      ? status
      : args[0] === 'show'
        ? '{"version":"0.0.0","name":"desktop"}'
        : commit,
  ),
  readPackage: vi.fn(() => '{"version":"1.2.3","name":"desktop"}'),
});

describe('runtime source build capture', () => {
  it('embeds a fixed commit and dirty marker, never a mutable branch name', () => {
    expect(captureRuntimeSource(root, true, deps())).toEqual({ commit, dirty: false, root });
    expect(captureRuntimeSource(root, false, deps())).toEqual({ commit, dirty: false });
  });
  it.each([' M changed.ts\0', '?? local.ts\0', 'M  staged.ts\0'])(
    'marks %s as uncertain',
    (status) => {
      expect(captureRuntimeSource(root, false, deps(status)).dirty).toBe(true);
    },
  );
  it('ignores only the packaging version substitution, not local code edits', () => {
    const versionOnly = deps(' M apps/desktop/package.json\0');
    expect(captureRuntimeSource(root, false, versionOnly).dirty).toBe(false);
    expect(captureRuntimeSource(root, true, versionOnly).dirty).toBe(true);
    versionOnly.readPackage.mockReturnValue('{"version":"1.2.3","name":"different"}');
    expect(captureRuntimeSource(root, false, versionOnly).dirty).toBe(true);
    expect(
      captureRuntimeSource(root, false, deps(' M apps/desktop/package.json\0 M file.ts\0')).dirty,
    ).toBe(true);
  });
  it('does not fabricate an identity when Git is absent or moves during capture', () => {
    const moving = deps();
    moving.git
      .mockReturnValueOnce(commit)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('b'.repeat(40));
    expect(captureRuntimeSource(root, true, moving)).toEqual({});
    const failing = deps();
    failing.git.mockImplementation(() => {
      throw new Error('git unavailable');
    });
    expect(captureRuntimeSource(root, false, failing)).toEqual({});
  });
  it('re-captures a cached module on rebuild and touches only the runtime identity module', () => {
    const capture = vi.fn(() => ({ commit, dirty: false }));
    const plugin = cindyRuntimeSourcePlugin(root, true, capture);
    const transform = plugin.transform as (
      source: string,
      id: string,
    ) => { code: string } | undefined;
    const cached = plugin.shouldTransformCachedModule as (input: {
      id: string;
    }) => boolean | undefined;
    const moduleId = path.join(root, 'apps/desktop/src/main/cindy-make/runtimeVersion.ts');
    const source = 'const build = import.meta.env.CINDY_RUNTIME_SOURCE ?? {};';
    expect(cached({ id: moduleId })).toBe(true);
    expect(cached({ id: moduleId.replaceAll(path.sep, '\\') })).toBe(true);
    expect(transform(source, moduleId)?.code).toContain(commit);
    capture.mockReturnValue({ commit: 'b'.repeat(40), dirty: true });
    expect(transform(source, moduleId)?.code).toContain('b'.repeat(40));
    expect(transform(source, 'unrelated.ts')).toBeUndefined();
    expect(cached({ id: 'unrelated.ts' })).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
