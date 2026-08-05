import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import {
  createDefaultAgentIslandDisplayConfig,
  createEmptyAgentIslandPillSnapshot,
  type AgentIslandDisplayState,
} from '../../../shared/agentIsland.js';
import type { AgentIslandNativeFrame } from '../MacAgentIslandNativeHost.js';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  isPackaged: true,
  getAppPath: vi.fn(),
  getPath: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.isPackaged;
    },
    getAppPath: h.getAppPath,
    getPath: h.getPath,
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

type FakeNativeProcess = ChildProcessByStdio<Writable, Readable, Readable> & {
  emit(event: 'exit', code: number | null, signal: NodeJS.Signals | null): boolean;
  emit(event: 'error', error: Error): boolean;
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'resourcesPath', {
    value: '/tmp/XDMaker.app/Contents/Resources',
    configurable: true,
  });
  h.spawn.mockReset();
  h.execFile.mockReset();
  h.isPackaged = true;
  h.getAppPath.mockReset();
  h.getPath.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MacAgentIslandNativeHost', () => {
  it('renders the idle brand from main-provided display strings', () => {
    const sourceUrl = new URL(
      '../../../../native/agent-island/macos-agent-island-helper.swift',
      import.meta.url,
    );
    if (!fs.existsSync(sourceUrl)) {
      throw new Error(`macos-agent-island-helper.swift 未找到: ${sourceUrl.pathname}`);
    }
    const source = fs.readFileSync(sourceUrl, 'utf8');

    expect(source).toContain('Text(strings.displayAppName)');
    expect(source).not.toContain('Text("XD Maker")');
  });

  it('keeps the native panel nonactivating during pointer interaction', () => {
    const sourceUrl = new URL(
      '../../../../native/agent-island/macos-agent-island-helper.swift',
      import.meta.url,
    );
    const source = fs.readFileSync(sourceUrl, 'utf8');

    expect(source).toContain('styleMask: [.borderless, .nonactivatingPanel]');
    expect(source).toContain('override var canBecomeKey: Bool { false }');
    expect(source).toContain('override var canBecomeMain: Bool { false }');
    expect(source).not.toContain('makeKey()');
  });

  it('refreshes native display metrics after macOS wakes from sleep', () => {
    const source = fs.readFileSync(
      new URL('../../../../native/agent-island/macos-agent-island-helper.swift', import.meta.url),
      'utf8',
    );

    const wakeObserver = source.match(
      /workspaceWakeObserver\s*=\s*NSWorkspace\.shared\.notificationCenter\.addObserver\(\s*forName:\s*NSWorkspace\.didWakeNotification,[\s\S]*?self\?\.scheduleScreenMetricsPublish\(forceRefresh:\s*true\)\s*\n\s*}/,
    )?.[0];

    expect(wakeObserver).toBeTruthy();
    expect(wakeObserver).toContain('NSWorkspace.didWakeNotification');
    expect(wakeObserver).toContain('scheduleScreenMetricsPublish(forceRefresh: true)');
    expect(source).toContain('payload["forceRefresh"] = true');
  });

  it('keeps native Agent marks aligned with the renderer icons', () => {
    const nativeSource = fs.readFileSync(
      new URL('../../../../native/agent-island/macos-agent-island-helper.swift', import.meta.url),
      'utf8',
    );
    const claudeSource = fs.readFileSync(
      new URL('../../../renderer/components/icons/ClaudeMark.tsx', import.meta.url),
      'utf8',
    );
    const codexSource = fs.readFileSync(
      new URL('../../../renderer/components/icons/CodexMark.tsx', import.meta.url),
      'utf8',
    );
    const claudePath = claudeSource.match(/<path[\s\S]*?\bd="([^"]+)"/)?.[1];
    const codexOutline = codexSource.match(/const FLOWER_OUTLINE =\s*'([^']+)'/)?.[1];
    const codexPrompt = codexSource.match(/const PROMPT_GLYPHS =\s*'([^']+)'/)?.[1];
    const codexSmallStrokeWidth = codexSource.match(
      /const monoStrokeWidth = size <= 14 \? ([\d.]+) : [\d.]+;/,
    )?.[1];
    const nativeCodexSvg = nativeSource.match(
      /private let agentIslandCodexMarkSVG = """([\s\S]*?)"""/,
    )?.[1];
    const nativeCodexOutlineStrokeWidth = nativeCodexSvg?.match(
      /<path fill="none" stroke="black" stroke-width="([^"]+)"/,
    )?.[1];

    expect(claudePath).toBeTruthy();
    expect(codexOutline).toBeTruthy();
    expect(codexPrompt).toBeTruthy();
    expect(codexSmallStrokeWidth).toBeTruthy();
    expect(nativeCodexOutlineStrokeWidth).toBeTruthy();
    expect(nativeSource).toContain(`d="${claudePath}"`);
    expect(nativeSource).toContain(`d="${codexOutline}z"`);
    expect(nativeSource).toContain(`d="${codexPrompt}"`);
    expect(nativeCodexOutlineStrokeWidth).toBe(codexSmallStrokeWidth);
    expect(nativeSource).not.toContain('agentIslandXDIncMarkSVG');
  });

  it('uses semantic icons for expanded terminal and interaction rows', () => {
    const source = fs
      .readFileSync(
        new URL('../../../../native/agent-island/macos-agent-island-helper.swift', import.meta.url),
        'utf8',
      )
      // Windows CRLF 检出下 \n 字面量正则会失配,统一归一化成 LF 再匹配。
      .replace(/\r\n/g, '\n');
    const expandedHeader = source.match(
      /struct ExpandedSessionHeaderLine: View \{([\s\S]*?)\n\}\n\nstruct ExpandedSessionMetaLine/,
    )?.[1];

    expect(expandedHeader).toBeTruthy();
    expect(expandedHeader).toContain('case "needs-interaction", "completed":');
    expect(expandedHeader).toContain('return false');
    expect(expandedHeader).toContain('showsRunningAnimation: showsMascot');
  });

  it('restarts the helper when it exits before ready', async () => {
    const children: FakeNativeProcess[] = [];
    h.spawn.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    expect(host.publish(createDisplayState(), createFrame())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    children[0].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(host.failed).toBe(false);
  });

  it('restarts the helper when spawning emits an error before ready', async () => {
    const children: FakeNativeProcess[] = [];
    h.spawn.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    expect(host.publish(createDisplayState(), createFrame())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    children[0].emit('error', new Error('spawn EACCES'));
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(host.failed).toBe(false);
  });

  it('keeps later publishes from bypassing the scheduled restart backoff', async () => {
    const children: FakeNativeProcess[] = [];
    h.spawn.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    expect(host.publish(createDisplayState(), createFrame())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    children[0].emit('exit', 1, null);
    expect(host.publish({ ...createDisplayState(), updatedAt: 1 }, createFrame())).toBe(true);
    expect(host.playSound({ type: 'custom', path: '/tmp/done.wav', name: 'done.wav' })).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it('restarts the helper when stdin emits an async error after ready', async () => {
    const children: FakeNativeProcess[] = [];
    h.spawn.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    expect(host.publish(createDisplayState(), createFrame())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    (children[0].stdout as PassThrough).write(`${JSON.stringify({ type: 'ready' })}\n`);
    await vi.advanceTimersByTimeAsync(0);

    children[0].stdin.emit('error', new Error('write EPIPE'));
    expect(children[0].kill).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(host.failed).toBe(false);
  });

  it('does not reset crash-loop attempts as soon as the helper reports ready', async () => {
    const children: FakeNativeProcess[] = [];
    h.spawn.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    expect(host.publish(createDisplayState(), createFrame())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(1);

    (children[0].stdout as PassThrough).write(`${JSON.stringify({ type: 'ready' })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    children[0].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(2);

    (children[1].stdout as PassThrough).write(`${JSON.stringify({ type: 'ready' })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    children[1].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(3);

    (children[2].stdout as PassThrough).write(`${JSON.stringify({ type: 'ready' })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    children[2].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).toHaveBeenCalledTimes(4);

    (children[3].stdout as PassThrough).write(`${JSON.stringify({ type: 'ready' })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    children[3].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(host.failed).toBe(true);
    expect(h.spawn).toHaveBeenCalledTimes(4);
  });

  it('forwards permission action events from the helper', async () => {
    const child = createFakeChild();
    h.spawn.mockReturnValue(child);
    const options = createOptions();
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(options);

    expect(host.publish(createDisplayState(), createFrame())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    (child.stdout as PassThrough).write(`${JSON.stringify({ type: 'ready' })}\n`);
    (child.stdout as PassThrough).write(`${JSON.stringify({
      type: 'permission-action',
      requestId: 'req-1',
      action: 'allowForSession',
    })}\n`);
    await vi.advanceTimersByTimeAsync(0);

    expect(options.onPermissionAction).toHaveBeenCalledWith({
      requestId: 'req-1',
      action: 'allowForSession',
    });
  });

  it('copies builtin sounds when building the dev helper', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-island-dev-assets-'));
    const appPath = path.join(tempDir, 'app');
    const userData = path.join(tempDir, 'user-data');
    const nativeDir = path.join(appPath, 'native', 'agent-island');
    fs.mkdirSync(path.join(nativeDir, 'mascots'), { recursive: true });
    fs.mkdirSync(path.join(nativeDir, 'sounds'), { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'macos-agent-island-helper.swift'), 'print("ok")\n');
    fs.writeFileSync(path.join(nativeDir, 'running-agent.gif'), 'gif');
    fs.writeFileSync(path.join(nativeDir, 'mascots', 'annie.png'), 'png');
    fs.writeFileSync(path.join(nativeDir, 'sounds', 'task-start.mp3'), 'mp3');
    h.isPackaged = false;
    h.getAppPath.mockReturnValue(appPath);
    h.getPath.mockImplementation((name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`);
      return userData;
    });
    h.execFile.mockImplementation((_file, args: string[], _options, callback) => {
      const outputIndex = args.indexOf('-o');
      fs.mkdirSync(path.dirname(args[outputIndex + 1]), { recursive: true });
      fs.writeFileSync(args[outputIndex + 1], 'binary');
      callback(null, '', '');
      return new EventEmitter();
    });
    h.spawn.mockImplementation(() => createFakeChild());
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    try {
      expect(host.publish(createDisplayState(), createFrame())).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(fs.existsSync(path.join(userData, 'agent-island', 'sounds', 'task-start.mp3'))).toBe(true);
      expect(fs.existsSync(path.join(userData, 'agent-island', 'mascots', 'annie.png'))).toBe(true);
      expect(fs.existsSync(path.join(userData, 'agent-island', 'running-agent.gif'))).toBe(true);
      expect(fs.existsSync(path.join(userData, 'agent-island', 'xdt-macos-agent-island-helper.sha256'))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prepares the dev helper without spawning the native process', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-island-dev-prepare-'));
    const appPath = path.join(tempDir, 'app');
    const userData = path.join(tempDir, 'user-data');
    const nativeDir = path.join(appPath, 'native', 'agent-island');
    fs.mkdirSync(path.join(nativeDir, 'mascots'), { recursive: true });
    fs.mkdirSync(path.join(nativeDir, 'sounds'), { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'macos-agent-island-helper.swift'), 'print("ok")\n');
    fs.writeFileSync(path.join(nativeDir, 'running-agent.gif'), 'gif');
    fs.writeFileSync(path.join(nativeDir, 'mascots', 'annie.png'), 'png');
    fs.writeFileSync(path.join(nativeDir, 'sounds', 'task-start.mp3'), 'mp3');
    h.isPackaged = false;
    h.getAppPath.mockReturnValue(appPath);
    h.getPath.mockImplementation((name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`);
      return userData;
    });
    h.execFile.mockImplementation((_file, args: string[], _options, callback) => {
      const outputIndex = args.indexOf('-o');
      fs.mkdirSync(path.dirname(args[outputIndex + 1]), { recursive: true });
      fs.writeFileSync(args[outputIndex + 1], 'binary');
      callback(null, '', '');
      return new EventEmitter();
    });
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    try {
      host.prepare();
      await vi.advanceTimersByTimeAsync(0);

      expect(h.execFile).toHaveBeenCalledTimes(1);
      expect(h.spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(userData, 'agent-island', 'xdt-macos-agent-island-helper'))).toBe(true);
      expect(fs.existsSync(path.join(userData, 'agent-island', 'xdt-macos-agent-island-helper.sha256'))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reuses the prepared dev helper path when starting later', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-island-dev-prewarm-'));
    const appPath = path.join(tempDir, 'app');
    const userData = path.join(tempDir, 'user-data');
    const nativeDir = path.join(appPath, 'native', 'agent-island');
    fs.mkdirSync(path.join(nativeDir, 'mascots'), { recursive: true });
    fs.mkdirSync(path.join(nativeDir, 'sounds'), { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'macos-agent-island-helper.swift'), 'print("ok")\n');
    fs.writeFileSync(path.join(nativeDir, 'running-agent.gif'), 'gif');
    fs.writeFileSync(path.join(nativeDir, 'mascots', 'annie.png'), 'png');
    fs.writeFileSync(path.join(nativeDir, 'sounds', 'task-start.mp3'), 'mp3');
    h.isPackaged = false;
    h.getAppPath.mockReturnValue(appPath);
    h.getPath.mockImplementation((name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`);
      return userData;
    });
    h.execFile.mockImplementation((_file, args: string[], _options, callback) => {
      const outputIndex = args.indexOf('-o');
      fs.mkdirSync(path.dirname(args[outputIndex + 1]), { recursive: true });
      fs.writeFileSync(args[outputIndex + 1], 'binary');
      callback(null, '', '');
      return new EventEmitter();
    });
    h.spawn.mockImplementation(() => createFakeChild());
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    try {
      host.prepare();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.execFile).toHaveBeenCalledTimes(1);

      expect(host.publish(createDisplayState(), createFrame())).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.execFile).toHaveBeenCalledTimes(1);
      expect(h.spawn).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rebuilds the dev helper when the source hash changed', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-island-dev-hash-'));
    const appPath = path.join(tempDir, 'app');
    const userData = path.join(tempDir, 'user-data');
    const nativeDir = path.join(appPath, 'native', 'agent-island');
    const helperDir = path.join(userData, 'agent-island');
    const sourceContent = 'print("new helper")\n';
    fs.mkdirSync(path.join(nativeDir, 'mascots'), { recursive: true });
    fs.mkdirSync(path.join(nativeDir, 'sounds'), { recursive: true });
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'macos-agent-island-helper.swift'), sourceContent);
    fs.writeFileSync(path.join(nativeDir, 'running-agent.gif'), 'gif');
    fs.writeFileSync(path.join(nativeDir, 'mascots', 'annie.png'), 'png');
    fs.writeFileSync(path.join(nativeDir, 'sounds', 'task-start.mp3'), 'mp3');
    fs.writeFileSync(path.join(helperDir, 'xdt-macos-agent-island-helper'), 'old binary');
    fs.writeFileSync(path.join(helperDir, 'xdt-macos-agent-island-helper.sha256'), 'old-source-hash\n');
    h.isPackaged = false;
    h.getAppPath.mockReturnValue(appPath);
    h.getPath.mockImplementation((name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`);
      return userData;
    });
    h.execFile.mockImplementation((_file, args: string[], _options, callback) => {
      const outputIndex = args.indexOf('-o');
      fs.writeFileSync(args[outputIndex + 1], 'new binary');
      callback(null, '', '');
      return new EventEmitter();
    });
    h.spawn.mockImplementation(() => createFakeChild());
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    try {
      expect(host.publish(createDisplayState(), createFrame())).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.execFile).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(path.join(helperDir, 'xdt-macos-agent-island-helper'), 'utf8')).toBe('new binary');
      expect(fs.readFileSync(path.join(helperDir, 'xdt-macos-agent-island-helper.sha256'), 'utf8').trim())
        .toBe(sha256(sourceContent));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reuses the dev helper when the source hash still matches', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-island-dev-hash-'));
    const appPath = path.join(tempDir, 'app');
    const userData = path.join(tempDir, 'user-data');
    const nativeDir = path.join(appPath, 'native', 'agent-island');
    const helperDir = path.join(userData, 'agent-island');
    const sourceContent = 'print("same helper")\n';
    fs.mkdirSync(path.join(nativeDir, 'mascots'), { recursive: true });
    fs.mkdirSync(path.join(nativeDir, 'sounds'), { recursive: true });
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'macos-agent-island-helper.swift'), sourceContent);
    fs.writeFileSync(path.join(nativeDir, 'running-agent.gif'), 'gif');
    fs.writeFileSync(path.join(nativeDir, 'mascots', 'annie.png'), 'png');
    fs.writeFileSync(path.join(nativeDir, 'sounds', 'task-start.mp3'), 'mp3');
    fs.writeFileSync(path.join(helperDir, 'xdt-macos-agent-island-helper'), 'current binary');
    fs.writeFileSync(path.join(helperDir, 'xdt-macos-agent-island-helper.sha256'), `${sha256(sourceContent)}\n`);
    h.isPackaged = false;
    h.getAppPath.mockReturnValue(appPath);
    h.getPath.mockImplementation((name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`);
      return userData;
    });
    h.spawn.mockImplementation(() => createFakeChild());
    const { MacAgentIslandNativeHost } = await import('../MacAgentIslandNativeHost.js');
    const host = new MacAgentIslandNativeHost(createOptions());

    try {
      expect(host.publish(createDisplayState(), createFrame())).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.execFile).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(helperDir, 'xdt-macos-agent-island-helper'), 'utf8')).toBe('current binary');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function createFakeChild(): FakeNativeProcess {
  const child = new EventEmitter() as FakeNativeProcess & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function createOptions(): ConstructorParameters<typeof import('../MacAgentIslandNativeHost.js').MacAgentIslandNativeHost>[0] {
  return {
    onPointerZones: vi.fn(),
    onExpand: vi.fn(),
    onFocusSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onNewMessage: vi.fn(),
    onToggleSound: vi.fn(),
    onPermissionAction: vi.fn(),
    onOutsideClick: vi.fn(),
    onLayoutDragActive: vi.fn(),
    onLayoutPreference: vi.fn(),
    onContentHeight: vi.fn(),
    onScreenMetrics: vi.fn(),
  };
}

function createDisplayState(): AgentIslandDisplayState {
  const defaults = createDefaultAgentIslandDisplayConfig();
  return {
    visible: true,
    mode: 'compact',
    displayPolicy: 'closed',
    displaySurface: 'collapsed',
    layoutMode: 'normal',
    notchStatus: 'closed',
    shadowVisible: false,
    currentSessionId: null,
    expandedDisplayId: null,
    sessions: [],
    totalCount: 0,
    pillSnapshot: createEmptyAgentIslandPillSnapshot(),
    strings: defaults.strings,
    appFocused: false,
    smartSuppressed: false,
    soundSettings: defaults.soundSettings,
    mascotSkin: defaults.mascotSkin,
    measuredContentHeight: 0,
    updatedAt: 0,
  };
}

function createFrame(): AgentIslandNativeFrame {
  return {
    displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1200, height: 800 },
    x: 0,
    y: 0,
    width: 680,
    height: 580,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
