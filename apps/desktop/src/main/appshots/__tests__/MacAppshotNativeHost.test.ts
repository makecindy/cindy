import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

const tempRoots = new Set<string>();
const originalArch = process.arch;
const originalPlatform = process.platform;
const BUILD_RECIPE_VERSION = 'v1';
const DEPLOYMENT_TARGET = 'macos14.0';
const SWIFTC_FLAGS = ['-O'];

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: vi.fn(),
    getPath: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  execFile: h.execFile,
}));

beforeEach(() => {
  vi.resetModules();
  h.execFile.mockReset();
  vi.mocked(app.getAppPath).mockReset();
  vi.mocked(app.getPath).mockReset();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  Object.defineProperty(process, 'resourcesPath', {
    value: '/Applications/Cindy.app/Contents/Resources',
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
  Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
  return Promise.all([...tempRoots].map((root) => fs.rm(root, { recursive: true, force: true })));
});

function mockHelperStdout(stdout: string): void {
  h.execFile.mockImplementation((_binary, _args, _options, callback) => {
    callback(null, stdout, 'captured stderr must not be exposed');
    return new EventEmitter();
  });
}

function capturePayload(): string {
  return JSON.stringify({
    type: 'capture',
    pngPath: '/tmp/cindy-appshot/capture.png',
    applicationName: 'Example App',
    bundleIdentifier: 'com.example.app',
    windowTitle: null,
    accessibilityText: null,
    accessibilityTruncated: false,
  });
}

async function unpackagedFixture(source = 'import Foundation\n'): Promise<{
  appRoot: string;
  sourcePath: string;
  userData: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-appshot-host-'));
  tempRoots.add(root);
  const appRoot = path.join(root, 'app');
  const sourcePath = path.join(appRoot, 'native', 'appshots', 'macos-appshot-helper.swift');
  const userData = path.join(root, 'user-data');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(sourcePath, source);
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  vi.mocked(app.getAppPath).mockReturnValue(appRoot);
  vi.mocked(app.getPath).mockReturnValue(userData);
  return { appRoot, sourcePath, userData };
}

function targetForArch(arch: string): string {
  return `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-${DEPLOYMENT_TARGET}`;
}

function expectedDevBinary(userData: string, sourceBytes: Buffer, arch = process.arch): string {
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const cacheKey = createHash('sha256').update(JSON.stringify({
    buildRecipeVersion: BUILD_RECIPE_VERSION,
    architecture: arch,
    deploymentTarget: DEPLOYMENT_TARGET,
    sourceHash,
    target: targetForArch(arch),
    flags: SWIFTC_FLAGS,
  })).digest('hex');
  return path.join(userData, 'appshots', `xdt-macos-appshot-helper-${cacheKey}`);
}

interface DevExecMockOptions {
  compileError?: boolean;
  beforeCompileRead?: (input: string, output: string) => Promise<void>;
  selfTestStdout?: (binary: string, contents: string) => string;
  afterCombinedLaunch?: (binary: string) => void;
}

function installDevExecMock(options: DevExecMockOptions = {}) {
  const compiledInputs: string[] = [];
  const compiledInputBytes: Buffer[] = [];
  const compiledOutputs: string[] = [];
  const compilerArgs: string[][] = [];
  const selfTestedBinaries: string[] = [];
  const captureBinaries: string[] = [];
  const captureArguments: string[][] = [];
  const capturedBinaryContents: string[] = [];
  h.execFile.mockImplementation((command, args, _execOptions, callback) => {
    const child = new EventEmitter();
    if (command === 'swiftc') {
      const input = args[0];
      const output = args[args.indexOf('-o') + 1];
      compiledInputs.push(input);
      compiledOutputs.push(output);
      compilerArgs.push([...args]);
      void (async () => {
        await options.beforeCompileRead?.(input, output);
        compiledInputBytes.push(await fs.readFile(input));
        if (!options.compileError) await fs.writeFile(output, 'valid compiled helper');
        callback(options.compileError ? new Error('compile failed') : null, '', 'compiler detail');
      })();
      return child;
    }
    if (args[0] === '--self-test') {
      selfTestedBinaries.push(command);
      void (async () => {
        const contents = await fs.readFile(command, 'utf8');
        const stdout = options.selfTestStdout?.(command, contents)
          ?? (contents.startsWith('valid ')
            ? JSON.stringify({ type: 'self-test', ok: true })
            : '{"type":"self-test","ok":false}');
        callback(null, stdout, 'self-test detail must not be exposed');
      })();
      return child;
    }
    if (args[0] === '--self-test-and-capture') {
      captureBinaries.push(command);
      captureArguments.push([...args]);
      capturedBinaryContents.push(fsSync.readFileSync(command, 'utf8'));
      options.afterCombinedLaunch?.(command);
      callback(null, capturePayload(), '');
      return child;
    }
    callback(new Error('unexpected helper arguments'), '', '');
    return child;
  });
  return {
    compiledInputs,
    compiledInputBytes,
    compiledOutputs,
    compilerArgs,
    selfTestedBinaries,
    captureBinaries,
    captureArguments,
    capturedBinaryContents,
  };
}

describe('MacAppshotNativeHost helper response boundary', () => {
  it.each([
    ['missing capture type', {}],
    ['wrong capture type', { type: 'self-test' }],
  ])('rejects %s without exposing helper output', async (label, override) => {
    const result = {
      type: 'capture',
      pngPath: '/tmp/cindy-appshot/capture.png',
      applicationName: 'Example App',
      bundleIdentifier: 'com.example.app',
      windowTitle: 'Secret title',
      accessibilityText: 'secret captured content',
      accessibilityTruncated: false,
      ...override,
    };
    if (label === 'missing capture type') delete (result as { type?: string }).type;
    mockHelperStdout(JSON.stringify(result));
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await expect(new MacAppshotNativeHost().capture('/tmp/cindy-appshot')).rejects.toMatchObject({
      code: 'native-failure',
    });
    expect(h.execFile).toHaveBeenCalledWith(
      path.join(process.resourcesPath, 'tools', 'appshots', 'xdt-macos-appshot-helper'),
      ['--output-dir', '/tmp/cindy-appshot'],
      expect.objectContaining({ timeout: 10_000, maxBuffer: 1024 * 1024 }),
      expect.any(Function),
    );
  });

  it('rejects malformed raw helper JSON without surfacing captured content', async () => {
    mockHelperStdout('{"type":"capture","accessibilityText":"secret captured content"');
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await expect(new MacAppshotNativeHost().capture('/tmp/cindy-appshot')).rejects.toMatchObject({
      code: 'native-failure',
    });
  });

  it('rejects raw helper output with malformed required fields', async () => {
    mockHelperStdout(JSON.stringify({
      type: 'capture',
      pngPath: '/tmp/cindy-appshot/capture.png',
      applicationName: '',
      bundleIdentifier: 'com.example.app',
      windowTitle: 'Secret title',
      accessibilityText: 'secret captured content',
      accessibilityTruncated: false,
    }));
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await expect(new MacAppshotNativeHost().capture('/tmp/cindy-appshot')).rejects.toMatchObject({
      code: 'native-failure',
    });
  });

  it('maps helper launch failure to stable native-failure without exposing process detail', async () => {
    h.execFile.mockImplementation((_binary, _args, _options, callback) => {
      callback(new Error('secret launch path'), '', 'secret helper stderr');
      return new EventEmitter();
    });
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    const rejection = new MacAppshotNativeHost().capture('/tmp/cindy-appshot').catch((error) => error);
    await expect(rejection).resolves.toMatchObject({ code: 'native-failure', message: 'native-failure' });
    await expect(rejection).resolves.not.toMatchObject({ message: expect.stringContaining('secret') });
  });
});

describe('MacAppshotNativeHost unpackaged helper cache', () => {
  it('does not delete a replacement whose BigInt identity only collides after Number conversion', async () => {
    const firstIdentity = 9_007_199_254_740_992n;
    const replacementIdentity = 9_007_199_254_740_993n;
    expect(Number(firstIdentity)).toBe(Number(replacementIdentity));
    const filePath = path.join(os.tmpdir(), 'identity-only-test-helper');
    let quarantinedPath = '';
    vi.spyOn(fsSync, 'renameSync').mockImplementation((source, destination) => {
      expect(source).toBe(filePath);
      quarantinedPath = destination.toString();
    });
    vi.spyOn(fsSync, 'lstatSync').mockImplementation((candidate, options) => {
      expect(options).toEqual({ bigint: true });
      expect(candidate).toBe(quarantinedPath);
      return {
        dev: replacementIdentity,
        ino: replacementIdentity,
        isFile: () => true,
        isSymbolicLink: () => false,
      } as fsSync.BigIntStats;
    });
    vi.spyOn(fsSync, 'accessSync').mockImplementation(() => undefined);
    const linkSpy = vi.spyOn(fsSync, 'linkSync').mockImplementation(() => undefined);
    const unlinkSpy = vi.spyOn(fsSync, 'unlinkSync').mockImplementation(() => undefined);
    const hostModule = await import('../MacAppshotNativeHost.js') as typeof import('../MacAppshotNativeHost.js') & {
      __testOnlyRemoveCandidateIfUnchanged: (
        target: string,
        observed: { dev: bigint; ino: bigint },
      ) => boolean;
    };

    const removed = hostModule.__testOnlyRemoveCandidateIfUnchanged(filePath, {
      dev: firstIdentity,
      ino: firstIdentity,
    });

    expect(removed).toBe(false);
    expect(linkSpy).toHaveBeenCalledWith(quarantinedPath, filePath);
    expect(unlinkSpy).toHaveBeenCalledWith(quarantinedPath);
    expect(linkSpy.mock.invocationCallOrder[0]).toBeLessThan(unlinkSpy.mock.invocationCallOrder[0]);
  });

  it('compiles a private source snapshot into an immutable build-recipe cache key on miss', async () => {
    const { sourcePath, userData } = await unpackagedFixture('source-v1');
    const sourceBytes = await fs.readFile(sourcePath);
    const {
      compiledInputs,
      compiledInputBytes,
      compiledOutputs,
      compilerArgs,
      selfTestedBinaries,
      captureBinaries,
      captureArguments,
    } = installDevExecMock();
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await new MacAppshotNativeHost().capture('/tmp/cindy-appshot');

    const finalBinary = expectedDevBinary(userData, sourceBytes, 'arm64');
    expect(captureBinaries).toEqual([finalBinary]);
    expect(captureArguments).toEqual([
      ['--self-test-and-capture', '--output-dir', '/tmp/cindy-appshot'],
    ]);
    expect(selfTestedBinaries).toEqual([compiledOutputs[0]]);
    expect(compiledInputs).toHaveLength(1);
    expect(compiledInputs[0]).not.toBe(sourcePath);
    expect(compiledInputs[0]).toMatch(/\.swift$/);
    expect(compiledInputBytes).toEqual([sourceBytes]);
    expect(compiledOutputs).toHaveLength(1);
    expect(compiledOutputs[0]).not.toBe(finalBinary);
    expect(compilerArgs[0]).toEqual([
      compiledInputs[0],
      '-O',
      '-target',
      'arm64-apple-macos14.0',
      '-o',
      compiledOutputs[0],
    ]);
    await expect(fs.stat(finalBinary)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(fs.stat(compiledInputs[0])).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(compiledOutputs[0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.dirname(finalBinary))).toEqual([path.basename(finalBinary)]);
  });

  it('self-tests a complete cache hit before capture without invoking swiftc', async () => {
    const { sourcePath, userData } = await unpackagedFixture('source-v1');
    const finalBinary = expectedDevBinary(userData, await fs.readFile(sourcePath), 'arm64');
    await fs.mkdir(path.dirname(finalBinary), { recursive: true });
    await fs.writeFile(finalBinary, 'valid cached helper', { mode: 0o755 });
    const { compiledOutputs, selfTestedBinaries, captureBinaries } = installDevExecMock();
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await new MacAppshotNativeHost().capture('/tmp/cindy-appshot');

    expect(compiledOutputs).toEqual([]);
    expect(selfTestedBinaries).toEqual([finalBinary]);
    expect(captureBinaries).toEqual([finalBinary]);
  });

  it('uses a different immutable binary after the helper source changes', async () => {
    const { sourcePath } = await unpackagedFixture('source-v1');
    const { captureBinaries } = installDevExecMock();
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');
    const host = new MacAppshotNativeHost();

    await host.capture('/tmp/cindy-appshot');
    await fs.writeFile(sourcePath, 'source-v2');
    await host.capture('/tmp/cindy-appshot');

    expect(captureBinaries).toHaveLength(2);
    expect(captureBinaries[0]).not.toBe(captureBinaries[1]);
  });

  it('compiles the original source snapshot when the live source mutates after build starts', async () => {
    const originalSource = Buffer.from('source-before-build');
    const { sourcePath, userData } = await unpackagedFixture(originalSource.toString());
    let notifyCompileStarted!: () => void;
    let releaseCompile!: () => void;
    const compileStarted = new Promise<void>((resolve) => { notifyCompileStarted = resolve; });
    const compileGate = new Promise<void>((resolve) => { releaseCompile = resolve; });
    const { compiledInputs, compiledInputBytes, captureBinaries } = installDevExecMock({
      beforeCompileRead: async () => {
        notifyCompileStarted();
        await compileGate;
      },
    });
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    const capture = new MacAppshotNativeHost().capture('/tmp/cindy-appshot');
    await compileStarted;
    await fs.writeFile(sourcePath, 'source-after-build-started');
    releaseCompile();
    await capture;

    expect(compiledInputs[0]).not.toBe(sourcePath);
    expect(compiledInputBytes).toEqual([originalSource]);
    expect(captureBinaries).toEqual([expectedDevBinary(userData, originalSource, 'arm64')]);
  });

  it('uses architecture-specific targets and cache paths for arm64 and x64', async () => {
    const { sourcePath, userData } = await unpackagedFixture('source-v1');
    const sourceBytes = await fs.readFile(sourcePath);
    const { compilerArgs, captureBinaries } = installDevExecMock();
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');
    const host = new MacAppshotNativeHost();

    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    await host.capture('/tmp/cindy-appshot-arm64');
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    await host.capture('/tmp/cindy-appshot-x64');

    expect(compilerArgs[0]).toContain('arm64-apple-macos14.0');
    expect(compilerArgs[1]).toContain('x86_64-apple-macos14.0');
    expect(captureBinaries).toEqual([
      expectedDevBinary(userData, sourceBytes, 'arm64'),
      expectedDevBinary(userData, sourceBytes, 'x64'),
    ]);
    expect(captureBinaries[0]).not.toBe(captureBinaries[1]);
  });

  it('does not launch a partial final binary while concurrent captures wait for compilation', async () => {
    await unpackagedFixture('source-v1');
    let finishCompile!: () => void;
    const compileGate = new Promise<void>((resolve) => { finishCompile = resolve; });
    const captureBinaries: string[] = [];
    let compileCalls = 0;
    h.execFile.mockImplementation((command, args, _execOptions, callback) => {
      const child = new EventEmitter();
      if (command === 'swiftc') {
        compileCalls += 1;
        const output = args[args.indexOf('-o') + 1];
        void (async () => {
          await fs.writeFile(output, 'partial');
          await compileGate;
          await fs.writeFile(output, 'valid complete');
          callback(null, '', '');
        })();
      } else if (args[0] === '--self-test') {
        void (async () => {
          const contents = await fs.readFile(command, 'utf8');
          callback(null, contents === 'valid complete'
            ? JSON.stringify({ type: 'self-test', ok: true })
            : JSON.stringify({ type: 'self-test', ok: false }), '');
        })();
      } else if (args[0] === '--self-test-and-capture') {
        captureBinaries.push(command);
        callback(null, capturePayload(), '');
      }
      return child;
    });
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');
    const first = new MacAppshotNativeHost().capture('/tmp/cindy-appshot-1');
    const second = new MacAppshotNativeHost().capture('/tmp/cindy-appshot-2');

    await vi.waitFor(() => expect(compileCalls).toBe(1));
    expect(captureBinaries).toEqual([]);
    finishCompile();
    await Promise.all([first, second]);
    expect(captureBinaries).toHaveLength(2);
    expect(new Set(captureBinaries).size).toBe(1);
    await expect(fs.readFile(captureBinaries[0], 'utf8')).resolves.toBe('valid complete');
  });

  it('rebuilds a cache hit that fails self-test before launching capture', async () => {
    const { sourcePath, userData } = await unpackagedFixture('source-v1');
    const finalBinary = expectedDevBinary(userData, await fs.readFile(sourcePath), 'arm64');
    await fs.mkdir(path.dirname(finalBinary), { recursive: true });
    await fs.writeFile(finalBinary, 'corrupt cached helper', { mode: 0o755 });
    const {
      compiledOutputs,
      selfTestedBinaries,
      captureBinaries,
      capturedBinaryContents,
    } = installDevExecMock();
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await new MacAppshotNativeHost().capture('/tmp/cindy-appshot');

    expect(compiledOutputs).toHaveLength(1);
    expect(selfTestedBinaries).toContain(finalBinary);
    expect(captureBinaries).toEqual([finalBinary]);
    expect(capturedBinaryContents).toEqual(['valid compiled helper']);
  });

  it('binds dev self-test and capture to one launched process despite a later path replacement', async () => {
    const { sourcePath, userData } = await unpackagedFixture('source-v1');
    const finalBinary = expectedDevBinary(userData, await fs.readFile(sourcePath), 'arm64');
    await fs.mkdir(path.dirname(finalBinary), { recursive: true });
    await fs.writeFile(finalBinary, 'valid cached helper', { mode: 0o755 });
    const {
      compiledOutputs,
      selfTestedBinaries,
      captureBinaries,
      captureArguments,
      capturedBinaryContents,
    } = installDevExecMock({
      afterCombinedLaunch: (binary) => {
        fsSync.writeFileSync(binary, 'corrupt replacement', { mode: 0o755 });
      },
    });
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await new MacAppshotNativeHost().capture('/tmp/cindy-appshot');

    expect(compiledOutputs).toEqual([]);
    expect(selfTestedBinaries).toEqual([finalBinary]);
    expect(captureBinaries).toEqual([finalBinary]);
    expect(captureArguments).toEqual([
      ['--self-test-and-capture', '--output-dir', '/tmp/cindy-appshot'],
    ]);
    expect(capturedBinaryContents).toEqual(['valid cached helper']);
    await expect(fs.readFile(finalBinary, 'utf8')).resolves.toBe('corrupt replacement');
  });

  it('uses an explicit valid EEXIST winner after self-test', async () => {
    await unpackagedFixture('source-v1');
    const { compiledOutputs, selfTestedBinaries, captureBinaries, capturedBinaryContents } = installDevExecMock();
    let winningBinary = '';
    vi.spyOn(fsSync, 'linkSync').mockImplementationOnce((_temporary, destination) => {
      winningBinary = destination.toString();
      fsSync.writeFileSync(winningBinary, 'valid EEXIST winner', { mode: 0o755 });
      throw Object.assign(new Error('publish race'), { code: 'EEXIST' });
    });
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await new MacAppshotNativeHost().capture('/tmp/cindy-appshot');

    expect(compiledOutputs).toHaveLength(1);
    expect(selfTestedBinaries).toEqual([compiledOutputs[0], winningBinary]);
    expect(captureBinaries).toEqual([winningBinary]);
    expect(capturedBinaryContents).toEqual(['valid EEXIST winner']);
  });

  it('never launches an invalid EEXIST winner as capture and publishes the validated temp', async () => {
    await unpackagedFixture('source-v1');
    const { compiledOutputs, selfTestedBinaries, captureBinaries, capturedBinaryContents } = installDevExecMock();
    let invalidWinner = '';
    vi.spyOn(fsSync, 'linkSync').mockImplementationOnce((_temporary, destination) => {
      invalidWinner = destination.toString();
      fsSync.writeFileSync(invalidWinner, 'corrupt EEXIST winner', { mode: 0o755 });
      throw Object.assign(new Error('publish race'), { code: 'EEXIST' });
    });
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await new MacAppshotNativeHost().capture('/tmp/cindy-appshot');

    expect(compiledOutputs).toHaveLength(1);
    expect(selfTestedBinaries).toContain(invalidWinner);
    expect(captureBinaries).toEqual([invalidWinner]);
    expect(capturedBinaryContents).toEqual(['valid compiled helper']);
  });

  it('does not publish a compiled temp whose self-test response has extra fields', async () => {
    const { userData } = await unpackagedFixture('source-v1');
    const { compiledInputs, compiledOutputs, captureBinaries } = installDevExecMock({
      selfTestStdout: () => JSON.stringify({ type: 'self-test', ok: true, extra: 'rejected' }),
    });
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await expect(new MacAppshotNativeHost().capture('/tmp/cindy-appshot')).rejects.toMatchObject({
      code: 'native-failure',
    });

    expect(captureBinaries).toEqual([]);
    await expect(fs.stat(compiledInputs[0])).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(compiledOutputs[0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.join(userData, 'appshots'))).toEqual([]);
  });

  it('maps compile failure to native-failure and removes temporary source and binary outputs', async () => {
    const { userData } = await unpackagedFixture('source-v1');
    const { compiledInputs, compiledOutputs, captureBinaries } = installDevExecMock({ compileError: true });
    const { MacAppshotNativeHost } = await import('../MacAppshotNativeHost.js');

    await expect(new MacAppshotNativeHost().capture('/tmp/cindy-appshot')).rejects.toMatchObject({
      code: 'native-failure',
    });
    expect(captureBinaries).toEqual([]);
    expect(compiledInputs).toHaveLength(1);
    expect(compiledOutputs).toHaveLength(1);
    await expect(fs.stat(compiledInputs[0])).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(compiledOutputs[0])).rejects.toMatchObject({ code: 'ENOENT' });
    const cacheEntries = await fs.readdir(path.join(userData, 'appshots'));
    expect(cacheEntries).toEqual([]);
  });
});
