import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkWindowsUpdaterPrerequisites,
  stageBundledWindowsUpdaterRuntime,
  validateBundledWindowsUpdaterRuntime,
  WINDOWS_UPDATER_RUNTIME_DIRECTORY,
  WINDOWS_UPDATER_RUNTIME_FILES,
  windowsUpdaterRuntimeExtraResourceForTarget,
} from '../windowsUpdaterPrerequisites';

let testRoot: string;
let systemDirectory: string;
const committedResources = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'resources',
);

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-updater-prerequisites-'));
  systemDirectory = path.join(testRoot, 'System32');
  fs.mkdirSync(systemDirectory);
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function writeSystemRuntime(fileName: string, contents = 'runtime'): void {
  fs.writeFileSync(path.join(systemDirectory, fileName), contents);
}

describe('checkWindowsUpdaterPrerequisites', () => {
  it('prefers the committed, hash-verified app-local Runtime', () => {
    expect(validateBundledWindowsUpdaterRuntime(committedResources)).toMatchObject({
      version: '14.44.35211.0',
      architecture: 'x64',
    });
    expect(checkWindowsUpdaterPrerequisites('', committedResources)).toEqual({
      satisfied: true,
      missingFiles: [],
    });
  });

  it('accepts two non-empty machine-wide fallback DLL files', () => {
    for (const fileName of WINDOWS_UPDATER_RUNTIME_FILES) writeSystemRuntime(fileName);

    expect(checkWindowsUpdaterPrerequisites(testRoot, '')).toEqual({
      satisfied: true,
      missingFiles: [],
    });
  });

  it.each(WINDOWS_UPDATER_RUNTIME_FILES)(
    'reports %s when that dependency is missing',
    (missingFile) => {
      for (const fileName of WINDOWS_UPDATER_RUNTIME_FILES) {
        if (fileName !== missingFile) writeSystemRuntime(fileName);
      }

      expect(checkWindowsUpdaterPrerequisites(testRoot, '')).toEqual({
        satisfied: false,
        missingFiles: [missingFile],
      });
    },
  );

  it('rejects empty files and directories', () => {
    fs.writeFileSync(path.join(systemDirectory, WINDOWS_UPDATER_RUNTIME_FILES[0]), '');
    fs.mkdirSync(path.join(systemDirectory, WINDOWS_UPDATER_RUNTIME_FILES[1]));

    expect(checkWindowsUpdaterPrerequisites(testRoot, '')).toEqual({
      satisfied: false,
      missingFiles: [...WINDOWS_UPDATER_RUNTIME_FILES],
    });
  });

  it('reports both dependencies when the Windows root is unavailable', () => {
    expect(checkWindowsUpdaterPrerequisites('', '')).toEqual({
      satisfied: false,
      missingFiles: [...WINDOWS_UPDATER_RUNTIME_FILES],
    });
  });

  it('rejects a modified app-local DLL instead of trusting its filename', () => {
    const resourcesPath = path.join(testRoot, 'resources');
    const runtimePath = path.join(resourcesPath, WINDOWS_UPDATER_RUNTIME_DIRECTORY);
    fs.cpSync(
      path.join(committedResources, WINDOWS_UPDATER_RUNTIME_DIRECTORY),
      runtimePath,
      { recursive: true },
    );
    fs.appendFileSync(path.join(runtimePath, WINDOWS_UPDATER_RUNTIME_FILES[0]), 'tampered');

    expect(() => validateBundledWindowsUpdaterRuntime(resourcesPath)).toThrow(/size mismatch/);
    expect(checkWindowsUpdaterPrerequisites('', resourcesPath)).toEqual({
      satisfied: false,
      missingFiles: [...WINDOWS_UPDATER_RUNTIME_FILES],
    });
  });
});

describe('windowsUpdaterRuntimeExtraResourceForTarget', () => {
  it('includes the Runtime only in Windows artifacts', () => {
    expect(windowsUpdaterRuntimeExtraResourceForTarget('win32')).toBe(
      `resources/${WINDOWS_UPDATER_RUNTIME_DIRECTORY}`,
    );
    expect(windowsUpdaterRuntimeExtraResourceForTarget('darwin')).toBeNull();
    expect(windowsUpdaterRuntimeExtraResourceForTarget('mas')).toBeNull();
    expect(windowsUpdaterRuntimeExtraResourceForTarget('linux')).toBeNull();
  });
});

describe('stageBundledWindowsUpdaterRuntime', () => {
  it('copies both verified DLLs beside the temporary updater', () => {
    const destination = path.join(testRoot, 'workdir');
    fs.mkdirSync(destination);

    expect(stageBundledWindowsUpdaterRuntime(committedResources, destination)).toBe('staged');
    for (const fileName of WINDOWS_UPDATER_RUNTIME_FILES) {
      expect(fs.readFileSync(path.join(destination, fileName))).toEqual(
        fs.readFileSync(
          path.join(committedResources, WINDOWS_UPDATER_RUNTIME_DIRECTORY, fileName),
        ),
      );
    }
  });

  it('copies nothing when the bundled Runtime is unavailable', () => {
    const destination = path.join(testRoot, 'workdir');
    fs.mkdirSync(destination);

    expect(stageBundledWindowsUpdaterRuntime('', destination)).toBe('fallback-safe');
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  it('rejects and removes a DLL modified after it is copied', () => {
    const destination = path.join(testRoot, 'workdir');
    fs.mkdirSync(destination);
    const copyFileSync = fs.copyFileSync.bind(fs);
    const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, mode) => {
      copyFileSync(source, target, mode);
      if (path.basename(String(target)) === WINDOWS_UPDATER_RUNTIME_FILES[0]) {
        fs.appendFileSync(target, 'tampered-after-copy');
      }
    });

    try {
      expect(stageBundledWindowsUpdaterRuntime(committedResources, destination)).toBe(
        'fallback-safe',
      );
      expect(fs.readdirSync(destination)).toEqual([]);
    } finally {
      copySpy.mockRestore();
    }
  });

  it('blocks fallback when an invalid staged DLL cannot be removed', () => {
    const destination = path.join(testRoot, 'workdir');
    fs.mkdirSync(destination);
    const copyFileSync = fs.copyFileSync.bind(fs);
    const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, mode) => {
      copyFileSync(source, target, mode);
      if (path.basename(String(target)) === WINDOWS_UPDATER_RUNTIME_FILES[0]) {
        fs.appendFileSync(target, 'tampered-after-copy');
      }
    });
    const rmSync = fs.rmSync.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (path.basename(String(target)) === WINDOWS_UPDATER_RUNTIME_FILES[0]) {
        throw new Error('locked by security software');
      }
      rmSync(target, options);
    });

    try {
      expect(stageBundledWindowsUpdaterRuntime(committedResources, destination)).toBe(
        'blocked',
      );
      expect(fs.existsSync(path.join(destination, WINDOWS_UPDATER_RUNTIME_FILES[0]))).toBe(
        true,
      );
    } finally {
      rmSpy.mockRestore();
      copySpy.mockRestore();
    }
  });
});
