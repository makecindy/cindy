import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalBuiltInSkillActivationPath } from '../built-in-skill-activation';

// Exercise Windows path semantics on every CI host, without real filesystem I/O.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { default: actual.win32 };
});
vi.mock('node:fs', () => ({
  default: { realpathSync: Object.assign(vi.fn(), { native: vi.fn() }) },
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('Windows built-in Skill activation identity', () => {
  it.each([
    ['realpath', 'learn'], ['missing', 'learn'],
    ['realpath', 'cindy-plugin-creator'], ['missing', 'cindy-plugin-creator'],
  ] as const)(
    'preserves intent across version revisions with case differences (%s, %s)',
    (mode, name) => {
      vi.stubGlobal('process', { ...process, platform: 'win32' });
      const resolve = (value: fs.PathLike) => {
        if (mode === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return path.normalize(String(value));
      };
      vi.mocked(fs.realpathSync).mockImplementation(resolve);
      vi.mocked(fs.realpathSync.native).mockImplementation(resolve);
      const appData = path.join('C:\\', 'Users', 'Example', 'AppData', 'Roaming');
      const sourceRoot = path.join(appData.toLowerCase(), 'cindy', 'shared-system-skills');
      const sources = [
        'v6-0123456789abcdef-11111111-1111-1111-1111-111111111111',
        'v7-fedcba9876543210-22222222-2222-2222-2222-222222222222',
      ].map((version) => path.join(sourceRoot, '.versions', version, name));
      const keys = sources.map((source) => canonicalBuiltInSkillActivationPath(
        source, path.join(appData, 'CindyGlobal'), appData,
      ));
      expect(keys).toEqual([path.join(sourceRoot, name), path.join(sourceRoot, name)]);
    },
  );

  it.each(['drive', 'unc'] as const)('matches a %s namespace realpath with a lexical root', (kind) => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const appData = kind === 'drive'
      ? path.join('C:\\', 'Users', 'Example', 'AppData')
      : path.join('\\\\server\\share', 'Users', 'Example', 'AppData');
    const root = path.join(appData, 'Cindy', 'shared-system-skills');
    const resolve = (value: fs.PathLike) => path.normalize(String(value));
    vi.mocked(fs.realpathSync).mockImplementation(resolve);
    vi.mocked(fs.realpathSync.native).mockImplementation(resolve);
    const sourceRoot = path.toNamespacedPath(root).toLowerCase();
    const source = path.join(sourceRoot, '.active', 'learn');
    expect(canonicalBuiltInSkillActivationPath(source, path.join(appData, 'CindyGlobal'), appData))
      .toBe(path.join(sourceRoot, 'learn'));
    const foreignRoot = path.join(appData, 'project', 'shared-system-skills');
    const foreignSource = path.join(foreignRoot, '.active', 'learn');
    expect(canonicalBuiltInSkillActivationPath(foreignSource, path.join(appData, 'CindyGlobal'), appData))
      .toBe(foreignSource);
  });
});
