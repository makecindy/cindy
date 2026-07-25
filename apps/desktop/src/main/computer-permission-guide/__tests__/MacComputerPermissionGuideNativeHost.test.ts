import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: vi.fn(),
    getPath: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: h.spawn,
  execFile: h.execFile,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

type FakeNativeProcess = Omit<
  ChildProcessByStdio<Writable, Readable, Readable>,
  'stdin' | 'stdout' | 'stderr'
> & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  emit(event: 'exit', code: number | null, signal: NodeJS.Signals | null): boolean;
  emit(event: 'error', error: Error): boolean;
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Object.defineProperty(process, 'resourcesPath', {
    value: '/Applications/XDMaker.app/Contents/Resources',
    configurable: true,
  });
  h.spawn.mockReset();
  h.execFile.mockReset();
});

afterEach(() => {
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MacComputerPermissionGuideNativeHost', () => {
  it('keeps the native app row below the title and names the setup action', () => {
    const source = fs.readFileSync(
      new URL(
        '../../../../native/computer-permission-guide/macos-computer-permission-guide-helper.swift',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).toContain('hostSize = NSSize(width: 500, height: 226)');
    expect(source).toContain('cardFrame = NSRect(x: 68, y: 12, width: 432, height: 152)');
    expect(source).toContain('"Open computer automation"');
    expect(source).toContain('setAccessibilityLabel("CuaDriver")');
    expect(source).not.toContain('setAccessibilityLabel("Computer Use")');
    expect(source).not.toContain('"Computer Use · Step');
    expect(source).toContain(
      'if let desiredFrame = attachedSwitchGuideFrame(settingsFrame: settingsFrame)',
    );
    expect(source).toContain(
      '// until a precise switch target becomes available.',
    );
    expect(source).not.toContain(
      'guard let desiredFrame = attachedSwitchGuideFrame(settingsFrame: settingsFrame) else',
    );
  });

  it('detects auth modals from AX modal relationships instead of window count', () => {
    const source = fs.readFileSync(
      new URL(
        '../../../../native/computer-permission-guide/macos-computer-permission-guide-helper.swift',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).toContain('kAXChildrenAttribute');
    expect(source).toContain('kAXSheetRole');
    expect(source).toContain('kAXModalAttribute');
    expect(source).toContain('AXIsProcessTrusted()');
    expect(source).toContain('systemSettingsAttachedSheetCandidates');
    expect(source).toContain('didEstablishFallbackWindowBaseline');
    expect(source).toContain('presentation == .switchGuide');
    expect(source).toContain('intersectionArea >= area * 0.9');
    expect(source).toContain('didEncounterUnavailableAttribute = true');
    expect(source).toContain('return didEncounterUnavailableAttribute ? nil : false');
    expect(source).not.toContain('attribute: kAXChildrenAttribute as CFString\n        ) ?? []');
    expect(source).not.toContain('layerZeroCount');

    const resolver = source.slice(
      source.indexOf('private func resolveModalSheetState'),
      source.indexOf('private func attachedPanelFrame'),
    );
    expect(resolver).toContain(
      'fallbackModalWindowIDs = info.attachedSheetCandidateWindowIDs',
    );
    expect(resolver).toContain(
      'if !hadTrackedFallbackModal && fallbackModalWindowIDs.isEmpty',
    );
    expect(resolver.indexOf('if authSheetVisible')).toBeLessThan(
      resolver.indexOf('if !didEstablishFallbackWindowBaseline'),
    );
  });

  it('uses app locale copy and appearance-aware colors in the native helper', () => {
    const source = fs.readFileSync(
      new URL(
        '../../../../native/computer-permission-guide/macos-computer-permission-guide-helper.swift',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).toContain('case ja');
    expect(source).toContain('case ko');
    expect(source).toContain('GuideLocale(rawValue: CommandLine.arguments[2])');
    expect(source).not.toContain('usesChineseCopy');
    expect(source).toContain('NSColor.controlBackgroundColor.cgColor');
    expect(source).toContain('NSColor.separatorColor.cgColor');
    expect(source).toContain('viewDidChangeEffectiveAppearance()');
    expect(source).not.toContain('layer?.backgroundColor = NSColor.white.cgColor');
  });

  it('quotes bundle paths passed from find to both macOS signing flows', () => {
    const source = fs.readFileSync(
      new URL('../../../../scripts/ci/lib.mjs', import.meta.url),
      'utf8',
    );

    expect(source).toContain('${signBase} "{}" \\\\;');
    expect(source).toContain('"${helperEntitlementsPath}" "{}" \\\\;');
    expect(source).not.toContain('${signBase} {} \\\\;');
    expect(source).not.toContain('"${helperEntitlementsPath}" {} \\\\;');
  });

  it('starts the packaged helper and sends permission state after ready', async () => {
    const child = createFakeChild();
    const writes: string[] = [];
    child.stdin.on('data', (chunk) => writes.push(chunk.toString()));
    h.spawn.mockReturnValue(child);
    const { MacComputerPermissionGuideNativeHost } = await import(
      '../MacComputerPermissionGuideNativeHost.js'
    );
    const host = new MacComputerPermissionGuideNativeHost(createOptions());
    const showPromise = host.show('/tmp/Computer Use.app', {
      accessibilityGranted: false,
      screenRecordingGranted: false,
      draggedAccessibility: true,
      draggedScreenRecording: false,
    }, 'ja');

    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledWith(
      // 实现用 path.join 拼 helper 路径,分隔符跟随宿主平台;这里同样用 path.join,
      // 让本用例在 Windows 开发机上跑单测门禁时不因 '/' vs '\\' 假红。
      path.join(
        '/Applications/XDMaker.app/Contents/Resources',
        'tools',
        'computer-permission-guide',
        'xdt-macos-computer-permission-guide-helper',
      ),
      ['/tmp/Computer Use.app', 'ja'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdout.write('{"type":"ready"}\n');
    await expect(showPromise).resolves.toBe(true);
    expect(writes).toContain(`${JSON.stringify({
      type: 'update',
      accessibilityGranted: false,
      screenRecordingGranted: false,
      draggedAccessibility: true,
      draggedScreenRecording: false,
    })}\n`);
  });

  it('forwards native drag lifecycle and close events', async () => {
    const child = createFakeChild();
    h.spawn.mockReturnValue(child);
    const options = createOptions();
    const { MacComputerPermissionGuideNativeHost } = await import(
      '../MacComputerPermissionGuideNativeHost.js'
    );
    const host = new MacComputerPermissionGuideNativeHost(options);
    const showPromise = host.show('/tmp/Computer Use.app', emptyState());
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write('{"type":"ready"}\n');
    await showPromise;

    child.stdout.write('{"type":"drag-began","permission":"accessibility"}\n');
    child.stdout.write('{"type":"drag-ended","permission":"accessibility","operation":1}\n');
    child.stdout.write('{"type":"attached","systemX":10,"systemY":20,"systemWidth":900,"systemHeight":600}\n');
    child.stdout.write('{"type":"close-requested"}\n');

    expect(options.onDragBegan).toHaveBeenCalledWith('accessibility');
    expect(options.onDragEnded).toHaveBeenCalledWith('accessibility', 1);
    expect(options.onAttached).toHaveBeenCalledOnce();
    expect(options.onCloseRequested).toHaveBeenCalledOnce();
  });

  it('fails closed when the helper never becomes ready', async () => {
    const child = createFakeChild();
    h.spawn.mockReturnValue(child);
    const { MacComputerPermissionGuideNativeHost } = await import(
      '../MacComputerPermissionGuideNativeHost.js'
    );
    const host = new MacComputerPermissionGuideNativeHost(createOptions());
    const showPromise = host.show('/tmp/Computer Use.app', emptyState());

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(showPromise).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('joins concurrent dev helper preparation and retries after a failed build', async () => {
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(app.getAppPath).mockReturnValue('/tmp/cindy-app');
    vi.mocked(app.getPath).mockReturnValue('/tmp/cindy-user-data');
    vi.spyOn(fs, 'existsSync').mockImplementation((target) => String(target).endsWith('.swift'));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('swift-source'));
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    let finishBuild:
      | ((error: Error | null, stdout?: string, stderr?: string) => void)
      | null = null;
    h.execFile.mockImplementation((_command, _args, _options, callback) => {
      finishBuild = callback as (error: Error | null, stdout?: string, stderr?: string) => void;
      return new EventEmitter();
    });
    const child = createFakeChild();
    h.spawn.mockReturnValue(child);
    const { MacComputerPermissionGuideNativeHost, prewarmMacComputerPermissionGuideHelper } =
      await import('../MacComputerPermissionGuideNativeHost.js');

    prewarmMacComputerPermissionGuideHelper();
    const showPromise = new MacComputerPermissionGuideNativeHost(createOptions()).show(
      '/tmp/Computer Use.app',
      emptyState(),
    );
    expect(h.execFile).toHaveBeenCalledOnce();
    const buildCallback = finishBuild as unknown as ((
      error: Error | null,
      stdout?: string,
      stderr?: string,
    ) => void);
    buildCallback(new Error('swiftc failed'), '', '');
    await expect(showPromise).resolves.toBe(false);

    prewarmMacComputerPermissionGuideHelper();
    expect(h.execFile).toHaveBeenCalledTimes(2);
  });

  it('does not spawn a helper after dismissal while binary preparation is pending', async () => {
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(app.getAppPath).mockReturnValue('/tmp/cindy-app');
    vi.mocked(app.getPath).mockReturnValue('/tmp/cindy-user-data');
    vi.spyOn(fs, 'existsSync').mockImplementation((target) => String(target).endsWith('.swift'));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('swift-source'));
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    let finishBuild:
      | ((error: Error | null, stdout?: string, stderr?: string) => void)
      | null = null;
    h.execFile.mockImplementation((_command, _args, _options, callback) => {
      finishBuild = callback as (error: Error | null, stdout?: string, stderr?: string) => void;
      return new EventEmitter();
    });
    const { MacComputerPermissionGuideNativeHost } = await import(
      '../MacComputerPermissionGuideNativeHost.js'
    );
    const host = new MacComputerPermissionGuideNativeHost(createOptions());
    const showPromise = host.show('/tmp/Computer Use.app', emptyState());
    await Promise.resolve();
    expect(h.execFile).toHaveBeenCalledOnce();

    host.dismiss();
    const buildCallback = finishBuild as unknown as ((
      error: Error | null,
      stdout?: string,
      stderr?: string,
    ) => void);
    buildCallback(null, '', '');

    await expect(showPromise).resolves.toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

function emptyState() {
  return {
    accessibilityGranted: false,
    screenRecordingGranted: false,
    draggedAccessibility: false,
    draggedScreenRecording: false,
  };
}

function createOptions() {
  return {
    onCloseRequested: vi.fn(),
    onCompleted: vi.fn(),
    onAttached: vi.fn(),
    onDragBegan: vi.fn(),
    onDragEnded: vi.fn(),
  };
}

function createFakeChild(): FakeNativeProcess {
  const emitter = new EventEmitter() as FakeNativeProcess;
  Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => {
      Object.assign(emitter, { killed: true });
      return true;
    }),
  });
  return emitter;
}
