import { beforeEach, describe, expect, it, vi } from 'vitest';
import { delimiter, join } from 'node:path';
import { resolveJavaRuntimeEnv } from '../../scripts/java-runtime-env.mjs';

const { spawnSync, existsSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawnSync }));
vi.mock('node:fs', () => ({ existsSync }));

const javaBin = (home: string) => join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const configuredHome = join('/toolchains', 'configured-jdk');
const studioHome = join('/toolchains', 'android-studio-jdk');
const path = join('/toolchains', 'path-jdk', 'bin');
const testEnv = { NODE_ENV: 'test' as const, PATH: path };
let versions: Map<string, number>;

beforeEach(() => {
  versions = new Map();
  spawnSync.mockReset().mockImplementation((command: string) => {
    const major = versions.get(command);
    return {
      status: major ? 0 : 1,
      stdout: '',
      stderr: major ? `openjdk version "${major}.0.1"` : '',
    };
  });
  existsSync.mockReset().mockImplementation((file: string) => versions.has(file));
});

describe('Java runtime environment for Gradle', () => {
  it.each([undefined, 11])('discards unusable JAVA_HOME (version %s) when PATH has Java 17', (major) => {
    versions.set('java', 17);
    if (major) versions.set(javaBin(configuredHome), major);
    const baseEnv = { ...testEnv, JAVA_HOME: configuredHome, KEEP: 'unchanged' };

    const result = resolveJavaRuntimeEnv(baseEnv);

    expect(result).toEqual({ ...testEnv, KEEP: 'unchanged' });
    // gradlew.bat must fall back to the already validated PATH Java.
    expect(result).not.toHaveProperty('JAVA_HOME');
    expect(baseEnv.JAVA_HOME).toBe(configuredHome);
  });

  it('keeps a supported JAVA_HOME when PATH also has supported Java', () => {
    versions.set('java', 17);
    versions.set(javaBin(configuredHome), 21);
    const baseEnv = { ...testEnv, JAVA_HOME: configuredHome };

    expect(resolveJavaRuntimeEnv(baseEnv)).toEqual(baseEnv);
  });

  it('keeps a working PATH without requiring JAVA_HOME or a fallback JDK', () => {
    versions.set('java', 21);
    const baseEnv = { ...testEnv };

    const result = resolveJavaRuntimeEnv(baseEnv);

    expect(result).toEqual(baseEnv);
    expect(result).not.toBe(baseEnv);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('uses a supported JAVA_HOME when PATH Java is too old', () => {
    versions.set('java', 11);
    versions.set(javaBin(configuredHome), 17);
    const baseEnv = { ...testEnv, JAVA_HOME: configuredHome };

    expect(resolveJavaRuntimeEnv(baseEnv)).toEqual({
      ...baseEnv,
      PATH: [join(configuredHome, 'bin'), path].join(delimiter),
    });
  });

  it.each([undefined, 11])('uses the Studio JDK when PATH and JAVA_HOME (version %s) are unusable', (major) => {
    versions.set('java', 11);
    if (major) versions.set(javaBin(configuredHome), major);
    versions.set(javaBin(studioHome), 21);
    const baseEnv = { ...testEnv, JAVA_HOME: configuredHome, ANDROID_STUDIO_JDK: studioHome };

    expect(resolveJavaRuntimeEnv(baseEnv)).toEqual({
      ...baseEnv,
      JAVA_HOME: studioHome,
      PATH: [join(studioHome, 'bin'), path].join(delimiter),
    });
    expect(baseEnv.JAVA_HOME).toBe(configuredHome);
  });

  it('preserves the original environment when no supported Java is available', () => {
    versions.set('java', 11);
    versions.set(javaBin(configuredHome), 11);
    const baseEnv = { ...testEnv, JAVA_HOME: configuredHome };

    expect(resolveJavaRuntimeEnv(baseEnv)).toEqual(baseEnv);
  });
});
