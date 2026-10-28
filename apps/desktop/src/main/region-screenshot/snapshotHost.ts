import { app } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { createLogger } from '../logger';
import type { RegionRect, RegionScreenshotBitmap } from '../../shared/regionScreenshot';

/**
 * 框选截图的窗口 / 界面元素识别程序 (native/region-screenshot)。
 *
 * 一次截图起一个进程, 会话结束即退出: 定格时取一次窗口列表, 悬停时按需查指针下
 * 的界面元素。默认只回几何信息 (和 macOS 的进程号), 不读窗口标题或内容。
 * 录制时用户开启「显示按键」后才按帧查询当前按下的物理按键；不读输入框、不存历史，
 * 结束或暂停录制后不再查询。macOS 未授权输入监控时返回不可用，不自行请求权限。
 * Windows 录制只读取 main 已校验的选区像素，留在当前用户会话；不启动提权服务。
 * 打包版随包分发; 源码模式按源码指纹编译一次缓存到 userData。找不到、编译失败、
 * 超时或崩溃一律降级为「不吸附」, 截图本身不受影响。
 */

const log = createLogger('region-screenshot:snapshot');
const exec = promisify(execFile);
const REQUEST_TIMEOUT_MS = 600;

export interface SnapshotWindow {
  /** Windows: HWND; macOS: CGWindowID。只在本次会话内使用。 */
  handle: number;
  pid: number | null;
  /** Windows 为物理像素, macOS 为全局 DIP; [left, top, right, bottom]。 */
  rect: [number, number, number, number];
}

const binaryName =
  process.platform === 'darwin'
    ? 'cindy-macos-screenshot-snapshot'
    : 'cindy-windows-screenshot-snapshot.exe';

let devBuild: Promise<string | null> | null = null;
let devBinary: string | null = null;

function cargoCommand(): string {
  const candidate = path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe');
  return candidate;
}

async function buildFromSource(): Promise<string | null> {
  const root = path.join(app.getAppPath(), 'native', 'region-screenshot');
  const files =
    process.platform === 'darwin'
      ? [path.join(root, 'macos-snapshot.swift')]
      : ['src/main.rs', 'Cargo.toml', 'Cargo.lock'].map((f) =>
          path.join(root, 'windows-snapshot', f),
        );
  const digest = createHash('sha256').update(process.arch).update('v1');
  for (const file of files) digest.update(await fs.readFile(file));
  const directory = path.join(
    app.getPath('userData'),
    'region-screenshot',
    'native',
    digest.digest('hex'),
  );
  const binary = path.join(directory, binaryName);
  try {
    await fs.access(binary);
    return binary;
  } catch {
    /* build this source version */
  }
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${binary}.${process.pid}.tmp`;
  if (process.platform === 'darwin') {
    await exec('swiftc', [files[0], '-O', '-o', temporary], { timeout: 180_000 });
  } else {
    let cargo = cargoCommand();
    try {
      await fs.access(cargo);
    } catch {
      cargo = 'cargo';
    }
    await exec(
      cargo,
      [
        'build',
        '--release',
        '--locked',
        '--manifest-path',
        path.join(root, 'windows-snapshot', 'Cargo.toml'),
        '--target-dir',
        path.join(directory, 'build'),
      ],
      { timeout: 300_000, windowsHide: true },
    );
    await fs.copyFile(path.join(directory, 'build', 'release', binaryName), temporary);
  }
  await fs.rename(temporary, binary);
  return binary;
}

/** 识别程序路径; 不支持的平台或源码模式编译失败返回 null (只尝试一次)。 */
export function resolveSnapshotBinary(waitForBuild = true): Promise<string | null> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return Promise.resolve(null);
  if (app.isPackaged) {
    return Promise.resolve(
      path.join(process.resourcesPath, 'tools', 'region-screenshot', binaryName),
    );
  }
  devBuild ??= buildFromSource()
    .then((binary) => {
      devBinary = binary;
      return binary;
    })
    .catch((error: unknown) => {
      log.warn('snapshot helper build failed; snapping disabled in this run', { error });
      return null;
    });
  return waitForBuild ? devBuild : Promise.resolve(devBinary);
}

interface Pending {
  resolve: (value: Record<string, unknown> | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 一次截图会话内的识别程序进程。所有请求失败都返回空结果, 不抛错。 */
export class SnapshotHelper {
  /** Resolve through input-transparent overlays, but only within the captured windows. */
  async scrollTarget(candidates: readonly SnapshotWindow[], x: number, y: number): Promise<SnapshotWindow | null> {
    const response = await this.request({ op: 'scroll-target', x, y });
    return candidates.find(({ handle, pid, rect }) => handle === response?.hwnd && pid === response?.pid
      && x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3]) ?? null;
  }

  /** One bounded wheel step in the captured window; never an arbitrary input bridge. */
  async scroll(window: SnapshotWindow, x: number, y: number, delta: number): Promise<boolean> {
    const response = await this.request({ op: 'scroll', hwnd: window.handle, pid: window.pid, x, y, delta });
    return response?.ok === true;
  }
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  static async start(waitForBuild = true): Promise<SnapshotHelper> {
    const helper = new SnapshotHelper();
    const binary = await resolveSnapshotBinary(waitForBuild);
    if (binary) helper.spawn(binary);
    return helper;
  }

  private spawn(binary: string): void {
    try {
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      const fail = (error: Error) => {
        if (this.child !== child) return;
        log.warn('snapshot helper failed to run', { error });
        this.dispose();
      };
      child.on('error', fail);
      // 流的 error 不会转发成 ChildProcess.error; 保留监听器接住关闭后的迟到错误。
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      child.on('exit', () => {
        if (this.child === child) this.dispose();
      });
      child.stderr.resume();
      createInterface({ input: child.stdout })
        .on('error', fail)
        .on('line', (line) => this.onLine(line));
    } catch (error) {
      log.warn('snapshot helper spawn threw', { error });
      this.child = null;
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === 'number' ? message.id : NaN;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  }

  private request(payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS) {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        // 顺序协议不能取消 native 当前调用; 超时后结束本次 helper，避免旧查询排队。
        this.dispose();
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
          if (error && this.child === child) this.dispose();
        });
      } catch {
        this.dispose();
      }
    });
  }

  async windows(): Promise<SnapshotWindow[]> {
    const response = await this.request({ op: 'windows' }, 1500);
    const list = Array.isArray(response?.windows) ? response.windows : [];
    const windows: SnapshotWindow[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const { hwnd, pid, rect } = raw as Record<string, unknown>;
      if (typeof hwnd !== 'number' || !isRectTuple(rect)) continue;
      windows.push({ handle: hwnd, pid: typeof pid === 'number' ? pid : null, rect });
    }
    return windows;
  }

  /** 指针下的界面元素 (由内到外), 坐标系同 {@link SnapshotWindow.rect}。 */
  async elements(window: SnapshotWindow, x: number, y: number): Promise<SnapshotWindow['rect'][]> {
    const response = await this.request({
      op: 'elements',
      hwnd: window.handle,
      ...(window.pid !== null ? { pid: window.pid } : {}),
      x: Math.round(x),
      y: Math.round(y),
    });
    const rects = Array.isArray(response?.rects) ? response.rects : [];
    return rects.filter(isRectTuple);
  }

  /** macOS: 截图前的前台应用进程号, 结束后把焦点还给它。 */
  async frontmostPid(): Promise<number | null> {
    if (process.platform !== 'darwin') return null;
    const response = await this.request({ op: 'frontmost' });
    return typeof response?.pid === 'number' ? response.pid : null;
  }

  async activate(pid: number): Promise<void> {
    if (process.platform !== 'darwin') return;
    await this.request({ op: 'activate', pid });
  }

  /** Only requested while the user explicitly enabled key display during recording. Never logged. */
  async keys(): Promise<string[] | null> {
    const response = await this.request({ op: 'keys' });
    if (!Array.isArray(response?.keys)) return null;
    return response.keys.filter((value): value is string => typeof value === 'string' && value.length <= 16).slice(0, 8);
  }

  /** macOS: 每块显示器 (按 Display.id) 顶部被摄像头刘海占用的高度 (DIP)。 */
  async screenInsets(): Promise<Map<number, number>> {
    const insets = new Map<number, number>();
    if (process.platform !== 'darwin') return insets;
    const response = await this.request({ op: 'screens' });
    for (const raw of Array.isArray(response?.screens) ? response.screens : []) {
      const { id, top } = (raw ?? {}) as Record<string, unknown>;
      if (Number.isInteger(id) && typeof top === 'number' && top >= 0 && top < 200) insets.set(id as number, top);
    }
    return insets;
  }

  /** Windows capture in the current user session; no elevated desktop broker. */
  async capture(rect: RegionRect, edge: number): Promise<RegionScreenshotBitmap | null> {
    const response = await this.request({ op: 'frame', ...rect, edge }, 1500);
    if (!response || typeof response.pixels !== 'string') return null;
    const { width, height } = response;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > edge || height > edge || width * height > 32_000_000) return null;
    if (response.pixels.length > Math.ceil(width * height * 4 / 3) * 4) return null;
    const bytes = Buffer.from(response.pixels, 'base64');
    if (bytes.length !== width * height * 4) return null;
    return { width, height, data: new Uint8Array(bytes) };
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pending.clear();
    if (child && child.exitCode === null) {
      child.stdin.destroy();
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

function isRectTuple(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    value[2] > value[0] &&
    value[3] > value[1]
  );
}
