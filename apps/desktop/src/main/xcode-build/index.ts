import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { BrowserWindow, ipcMain, webContents } from 'electron';

import {
  MAX_XCODE_BUILD_OUTPUT_CHARS,
  XCODE_BUILD_INVOKE,
  XCODE_BUILD_PUSH,
  type XcodeBuildDestination,
  type XcodeBuildEvent,
  type XcodeBuildStartRequest,
  type XcodeBuildState,
  type XcodeBuildStatusResult,
  type XcodeContainerKind,
  type XcodeProjectContainer,
  type XcodeProjectDiscovery,
  type XcodeProjectDiscoveryRequest,
} from '../../shared/xcodeBuild.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer.js';
import { throwIpcError, requireObject, requireString } from '../utils/ipcValidate.js';

const execFileAsync = promisify(execFile);
const XCODEBUILD_TIMEOUT_MS = 30_000;
const XCODEBUILD_MAX_BUFFER = 4 * 1024 * 1024;
const XCODE_BUILD_TIMEOUT_MS = 30 * 60_000;
const XCODE_BUILD_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_RETAINED_BUILDS = 12;
const XCODE_CONTAINER_SCAN_DEPTH = 4;
const XCODE_CONTAINER_SCAN_LIMIT = 2_000;
const SKIPPED_XCODE_SCAN_DIRS = new Set([
  '.git',
  '.cindy-worktrees',
  '.xdt-worktrees',
  '.build',
  'build',
  'DerivedData',
  'node_modules',
  'Pods',
  'vendor',
]);

interface XcodeCommandResult {
  stdout: string;
  stderr: string;
}

interface XcodeCommandOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface XcodeBuildDependencies {
  platform: NodeJS.Platform;
  readdir: typeof fs.readdir;
  realpath: typeof fs.realpath;
  stat: typeof fs.stat;
  execFile: (
    command: string,
    args: readonly string[],
    options?: XcodeCommandOptions,
  ) => Promise<XcodeCommandResult>;
  spawn: typeof spawn;
  now: () => number;
  createBuildId: () => string;
}

const defaultDependencies: XcodeBuildDependencies = {
  platform: process.platform,
  readdir: fs.readdir,
  realpath: fs.realpath,
  stat: fs.stat,
  execFile: (command, args, options) =>
    execFileAsync(command, [...args], {
      encoding: 'utf8',
      timeout: options?.timeoutMs ?? XCODEBUILD_TIMEOUT_MS,
      maxBuffer: options?.maxBuffer ?? XCODEBUILD_MAX_BUFFER,
      env: process.env,
      signal: options?.signal,
    }),
  spawn,
  now: Date.now,
  createBuildId: randomUUID,
};

function commandErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) {
      return stderr.trim().slice(-1_500);
    }
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim()) {
      return stdout.trim().slice(-1_500);
    }
  }
  const raw = error instanceof Error ? error.message : String(error);
  return raw.trim().slice(-1_500) || 'xcodebuild failed';
}

function containerKindForName(name: string): XcodeContainerKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xcworkspace')) return 'workspace';
  if (lower.endsWith('.xcodeproj')) return 'project';
  return null;
}

function containerName(name: string): string {
  return name.replace(/\.(?:xcworkspace|xcodeproj)$/i, '');
}

/** flutter run 的工作目录：自容器目录向上找最近的 pubspec.yaml，找不到就用容器目录。 */
async function resolveFlutterAppRoot(
  absoluteContainer: string,
  workdir: string,
  deps: XcodeBuildDependencies,
): Promise<string> {
  const containerDir = path.dirname(absoluteContainer);
  const stopAt = path.resolve(workdir);
  let current = containerDir;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const info = await deps.stat(path.join(current, 'pubspec.yaml'));
      if (!info.isDirectory()) return current;
    } catch {
      // 这一层没有 pubspec.yaml，继续向上。
    }
    const parent = path.dirname(current);
    if (parent === current || parent.length < stopAt.length) break;
    current = parent;
  }
  return containerDir;
}

async function findXcodeContainers(
  workdir: string,
  deps: XcodeBuildDependencies,
): Promise<XcodeProjectContainer[]> {
  let realWorkdir: string;
  let info: { isDirectory(): boolean };
  try {
    realWorkdir = await deps.realpath(workdir);
    info = await deps.stat(realWorkdir);
  } catch (error) {
    throwIpcError('NOT_FOUND', commandErrorMessage(error));
  }
  if (!info.isDirectory()) throwIpcError('INVALID_PARAMS', 'workdir is not a directory');

  const containers: XcodeProjectContainer[] = [];
  const queue: Array<{ absolutePath: string; depth: number }> = [
    { absolutePath: realWorkdir, depth: 0 },
  ];
  let scannedDirectories = 0;

  while (queue.length > 0 && scannedDirectories < XCODE_CONTAINER_SCAN_LIMIT) {
    const current = queue.shift()!;
    scannedDirectories += 1;
    let entries;
    try {
      entries = await deps.readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      if (current.depth === 0) throwIpcError('NOT_FOUND', commandErrorMessage(error));
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const kind = containerKindForName(entry.name);
      const absolutePath = path.join(current.absolutePath, entry.name);
      if (kind) {
        const containerPath = path.relative(realWorkdir, absolutePath).split(path.sep).join('/');
        containers.push({
          containerPath,
          containerKind: kind,
          name: containerName(entry.name),
        });
        continue;
      }
      if (
        current.depth + 1 < XCODE_CONTAINER_SCAN_DEPTH &&
        !SKIPPED_XCODE_SCAN_DIRS.has(entry.name)
      ) {
        queue.push({ absolutePath, depth: current.depth + 1 });
      }
    }
  }

  return containers.sort((a, b) => {
    if (a.containerKind !== b.containerKind) return a.containerKind === 'workspace' ? -1 : 1;
    return (
      a.containerPath.split('/').length - b.containerPath.split('/').length ||
      a.name.localeCompare(b.name)
    );
  });
}

function parseJsonSchemes(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throwIpcError('PRECONDITION_FAILED', 'xcodebuild returned invalid scheme data');
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const root = parsed as Record<string, unknown>;
  const container =
    root.workspace && typeof root.workspace === 'object'
      ? root.workspace
      : root.project && typeof root.project === 'object'
        ? root.project
        : root;
  const rawSchemes = (container as Record<string, unknown>).schemes;
  if (!Array.isArray(rawSchemes)) return [];
  return [
    ...new Set(rawSchemes.filter((value): value is string => typeof value === 'string')),
  ].sort((a, b) => a.localeCompare(b));
}

export function parseXcodeBuildDestinations(output: string): XcodeBuildDestination[] {
  const destinations: XcodeBuildDestination[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.includes('platform:')) continue;
    const platform = line.match(/\bplatform:([^,}]+)/)?.[1]?.trim();
    const id = line.match(/\bid:([^,}]+)/)?.[1]?.trim();
    const name = line.match(/\bname:([^}]+)\}/)?.[1]?.trim();
    if (!platform || !id || !name) continue;
    if (!['iOS', 'iOS Simulator'].includes(platform) || id.startsWith('dvtdevice-')) {
      continue;
    }
    const key = `${platform}\0${id}`;
    if (seen.has(key) || destinations.length >= 200) continue;
    seen.add(key);
    destinations.push({
      id,
      platform,
      name,
      osVersion: line.match(/\bOS:([^,}]+)/)?.[1]?.trim() ?? null,
      kind: /simulator/i.test(platform) ? 'simulator' : 'device',
    });
  }

  return destinations.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'device' ? -1 : 1;
    return a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform);
  });
}

export interface XcodeAppBuildSettings {
  appPath: string;
  bundleId: string;
  flutterRoot: string | null;
}

export function parseXcodeAppBuildSettings(output: string): XcodeAppBuildSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('xcodebuild returned invalid build settings');
  }
  if (!Array.isArray(parsed)) throw new Error('xcodebuild returned no build settings');

  const section = parsed.find((item) => {
    if (!item || typeof item !== 'object') return false;
    const settings = (item as { buildSettings?: unknown }).buildSettings;
    if (!settings || typeof settings !== 'object') return false;
    return (settings as Record<string, unknown>).WRAPPER_EXTENSION === 'app';
  }) as { buildSettings?: Record<string, unknown> } | undefined;
  const settings = section?.buildSettings;
  const targetBuildDir = settings?.TARGET_BUILD_DIR;
  const productName = settings?.FULL_PRODUCT_NAME;
  const bundleId = settings?.PRODUCT_BUNDLE_IDENTIFIER;
  const configuration = settings?.CONFIGURATION;
  const flutterRoot = settings?.FLUTTER_ROOT;
  if (
    typeof targetBuildDir !== 'string' ||
    typeof productName !== 'string' ||
    typeof bundleId !== 'string' ||
    !targetBuildDir ||
    !productName ||
    !bundleId
  ) {
    throw new Error('xcodebuild did not return an app build product');
  }
  if (typeof configuration === 'string' && configuration.toLowerCase() !== 'debug') {
    throw new Error(`xcodebuild resolved ${configuration} instead of Debug`);
  }
  return {
    appPath: path.join(targetBuildDir, productName),
    bundleId,
    flutterRoot: typeof flutterRoot === 'string' && flutterRoot ? flutterRoot : null,
  };
}

function parseDeviceLaunchPid(output: string): number | null {
  const jsonStart = output.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(output.slice(jsonStart)) as {
      result?: { process?: { processIdentifier?: unknown } };
    };
    const pid = parsed.result?.process?.processIdentifier;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function parseSimulatorLaunchPid(output: string): number | null {
  const match = output.match(/:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

async function listSchemes(
  container: XcodeProjectContainer,
  workdir: string,
  deps: XcodeBuildDependencies,
): Promise<string[]> {
  const containerArg = container.containerKind === 'workspace' ? '-workspace' : '-project';
  const { stdout } = await deps.execFile('/usr/bin/xcrun', [
    'xcodebuild',
    '-list',
    '-json',
    containerArg,
    path.join(workdir, container.containerPath),
  ]);
  return parseJsonSchemes(stdout);
}

async function listDestinations(
  container: XcodeProjectContainer,
  scheme: string,
  workdir: string,
  deps: XcodeBuildDependencies,
): Promise<XcodeBuildDestination[]> {
  const containerArg = container.containerKind === 'workspace' ? '-workspace' : '-project';
  const { stdout } = await deps.execFile('/usr/bin/xcrun', [
    'xcodebuild',
    '-showdestinations',
    containerArg,
    path.join(workdir, container.containerPath),
    '-scheme',
    scheme,
  ]);
  return parseXcodeBuildDestinations(stdout);
}

function defaultScheme(
  container: XcodeProjectContainer,
  schemes: readonly string[],
): string | null {
  if (schemes.length === 0) return null;
  return (
    schemes.find((scheme) => scheme.toLocaleLowerCase() === container.name.toLocaleLowerCase()) ??
    schemes[0]
  );
}

async function discoverXcodeProject(
  request: XcodeProjectDiscoveryRequest,
  deps: XcodeBuildDependencies,
): Promise<XcodeProjectDiscovery> {
  if (deps.platform !== 'darwin') {
    return {
      status: 'none',
      projects: [],
      selectedContainerPath: null,
      schemes: [],
      selectedScheme: null,
      destinations: [],
      error: null,
    };
  }

  let projects: XcodeProjectContainer[];
  try {
    projects = await findXcodeContainers(request.workdir, deps);
  } catch (error) {
    return {
      status: 'error',
      projects: [],
      selectedContainerPath: null,
      schemes: [],
      selectedScheme: null,
      destinations: [],
      error: commandErrorMessage(error),
    };
  }
  if (projects.length === 0) {
    return {
      status: 'none',
      projects,
      selectedContainerPath: null,
      schemes: [],
      selectedScheme: null,
      destinations: [],
      error: null,
    };
  }

  const selectedContainer =
    projects.find((project) => project.containerPath === request.containerPath) ?? projects[0];
  let schemes: string[];
  try {
    schemes = await listSchemes(selectedContainer, request.workdir, deps);
  } catch (error) {
    return {
      status: 'error',
      projects,
      selectedContainerPath: selectedContainer.containerPath,
      schemes: [],
      selectedScheme: null,
      destinations: [],
      error: commandErrorMessage(error),
    };
  }

  const selectedScheme =
    request.scheme && schemes.includes(request.scheme)
      ? request.scheme
      : defaultScheme(selectedContainer, schemes);
  let destinations: XcodeBuildDestination[] = [];
  let destinationError: string | null = null;
  if (selectedScheme) {
    try {
      destinations = await listDestinations(
        selectedContainer,
        selectedScheme,
        request.workdir,
        deps,
      );
    } catch (error) {
      destinationError = commandErrorMessage(error);
    }
  }
  return {
    status: 'available',
    projects,
    selectedContainerPath: selectedContainer.containerPath,
    schemes,
    selectedScheme,
    destinations,
    error: destinationError,
  };
}

interface BuildRecord {
  ownerId: number;
  state: XcodeBuildState;
  output: string;
  destinationId: string;
  destinationPlatform: string;
  bundleId: string | null;
  launchedPid: number | null;
  flutterProcess: ChildProcessWithoutNullStreams | null;
  abortController: AbortController;
  stopRequested: boolean;
}

export interface XcodeBuildManagerOptions {
  emit(ownerId: number, event: XcodeBuildEvent): void;
  dependencies?: Partial<XcodeBuildDependencies>;
}

export class XcodeBuildManager {
  private readonly deps: XcodeBuildDependencies;
  private readonly records = new Map<string, BuildRecord>();
  /** `${ownerId}\0${workdir}`：扫描/解析阶段还没写 records，用它挡住连点。 */
  private readonly pendingStarts = new Set<string>();

  constructor(private readonly options: XcodeBuildManagerOptions) {
    this.deps = { ...defaultDependencies, ...options.dependencies };
  }

  async discover(request: XcodeProjectDiscoveryRequest): Promise<XcodeProjectDiscovery> {
    return discoverXcodeProject(request, this.deps);
  }

  async start(request: XcodeBuildStartRequest & { ownerId: number }): Promise<XcodeBuildState> {
    const normalizedWorkdir = path.resolve(request.workdir);
    // 第一次 start 在扫描目录、解析容器时还没写入 records，只查运行记录挡不住第二次点击：
    // 两个构建会同时跑同一条 scheme。占位按「工作目录 + 目标」而不是窗口划分，否则同一份
    // checkout 开在两个窗口里时，各自都能起一个构建抢同一个产物。
    const startKey = `${normalizedWorkdir}\u0000${request.destinationId}`;
    if (this.pendingStarts.has(startKey)) {
      throwIpcError('PRECONDITION_FAILED', 'an Xcode build is already starting');
    }
    this.pendingStarts.add(startKey);
    try {
      return await this.startReserved(request, normalizedWorkdir);
    } finally {
      this.pendingStarts.delete(startKey);
    }
  }

  private async startReserved(
    request: XcodeBuildStartRequest & { ownerId: number },
    normalizedWorkdir: string,
  ): Promise<XcodeBuildState> {
    const otherOwnerBuild = [...this.records.values()].find(
      (record) =>
        record.ownerId !== request.ownerId &&
        record.state.workdir === normalizedWorkdir &&
        record.destinationId === request.destinationId &&
        record.state.status === 'running',
    );
    if (otherOwnerBuild) {
      throwIpcError('PRECONDITION_FAILED', 'another window is already building this target');
    }
    const active = [...this.records.values()].find(
      (record) =>
        record.ownerId === request.ownerId &&
        record.state.workdir === normalizedWorkdir &&
        record.state.status === 'running',
    );
    if (active) {
      // 原生 iOS/Android 产物启动后没有热重载通道(Flutter 才有),所以再点「编译」
      // 的语义是「重新编译并安装」:允许顶掉已启动的旧记录,先按「停止」同样方式
      // 结束旧 App 进程,再走一遍 build/install/launch。构建/安装/启动中的运行
      // 仍然拒绝并发。
      if (active.state.phase !== 'launched' || active.flutterProcess) {
        throwIpcError('PRECONDITION_FAILED', 'an Xcode build is already running');
      }
      await this.terminateLaunchedApp(active);
      this.appendOutput(active, 'Replaced by a new build.\n');
      this.finish(active, null, 'cancelled');
    }

    const projects = await findXcodeContainers(normalizedWorkdir, this.deps);
    const container = projects.find(
      (project) =>
        project.containerPath === request.containerPath &&
        project.containerKind === request.containerKind,
    );
    if (!container) throwIpcError('NOT_FOUND', 'Xcode project not found');

    let absoluteContainer: string;
    try {
      absoluteContainer = await this.deps.realpath(
        path.join(normalizedWorkdir, container.containerPath),
      );
    } catch (error) {
      throwIpcError('NOT_FOUND', commandErrorMessage(error));
    }
    const buildId = this.deps.createBuildId();
    const state: XcodeBuildState = {
      buildId,
      workdir: normalizedWorkdir,
      status: 'running',
      phase: 'building',
      supportsHotReload: false,
      exitCode: null,
      startedAt: this.deps.now(),
      endedAt: null,
    };
    const record: BuildRecord = {
      ownerId: request.ownerId,
      state,
      output: '',
      destinationId: request.destinationId,
      destinationPlatform: request.destinationPlatform,
      bundleId: null,
      launchedPid: null,
      flutterProcess: null,
      abortController: new AbortController(),
      stopRequested: false,
    };
    this.records.set(buildId, record);
    this.pruneFinishedRecords();
    this.appendOutput(
      record,
      `Building ${request.scheme} for ${request.destinationName} in Debug…\n`,
    );
    void this.runBuild(record, request, absoluteContainer, container.name);
    return state;
  }

  async stop(buildId: string, ownerId: number): Promise<void> {
    const record = this.records.get(buildId);
    if (!record || record.state.status !== 'running') return;
    if (record.ownerId !== ownerId) {
      throwIpcError('PERMISSION_DENIED', 'build belongs to another window');
    }
    if (record.flutterProcess) {
      record.stopRequested = true;
      record.abortController.abort();
      record.flutterProcess.kill('SIGINT');
      this.finish(record, null, 'cancelled');
      return;
    }
    if (record.state.phase !== 'launched') {
      record.stopRequested = true;
      record.abortController.abort();
      this.finish(record, null, 'cancelled');
      return;
    }

    await this.terminateLaunchedApp(record);
    this.finish(record, null, 'cancelled');
  }

  /**
   * 所有者窗口销毁时的收尾:构建不能比承载它的窗口活得更久。副窗口(右侧栏独立窗)
   * 关掉不退出应用,推送目标随之消失,再没人能停这条 Flutter 进程。
   */
  releaseOwner(ownerId: number): void {
    for (const record of [...this.records.values()]) {
      if (record.ownerId !== ownerId || record.state.status !== 'running') continue;
      record.stopRequested = true;
      record.abortController.abort();
      if (record.flutterProcess) record.flutterProcess.kill('SIGINT');
      if (record.state.phase === 'launched') void this.terminateLaunchedApp(record).catch(() => undefined);
      this.appendOutput(record, 'Owner window closed; build cancelled.\n');
      this.finish(record, null, 'cancelled');
    }
  }

  /**
   * 终止已启动 App 的进程(模拟器走 simctl terminate,真机走 devicectl)。
   * 「停止」和「已启动状态下的重新编译」共用:后者必须先把旧进程结束掉,
   * 否则重新 install/launch 会和正在运行的实例抢同一个 bundle。
   */
  private async terminateLaunchedApp(record: BuildRecord): Promise<void> {
    try {
      if (record.destinationPlatform === 'iOS Simulator' && record.bundleId) {
        await this.deps.execFile(
          '/usr/bin/xcrun',
          ['simctl', 'terminate', record.destinationId, record.bundleId],
          { timeoutMs: 30_000 },
        );
      } else if (record.launchedPid !== null) {
        await this.deps.execFile(
          '/usr/bin/xcrun',
          [
            'devicectl',
            'device',
            'process',
            'terminate',
            '--device',
            record.destinationId,
            '--pid',
            String(record.launchedPid),
          ],
          { timeoutMs: 30_000 },
        );
      }
    } catch (error) {
      this.appendOutput(record, `Could not confirm app termination: ${commandErrorMessage(error)}\n`);
    }
  }

  async flutterAction(
    buildId: string,
    ownerId: number,
    action: 'reload' | 'restart',
  ): Promise<void> {
    const record = this.records.get(buildId);
    if (!record || record.ownerId !== ownerId) {
      throwIpcError('PERMISSION_DENIED', 'build belongs to another window');
    }
    if (
      record.state.status !== 'running' ||
      record.state.phase !== 'launched' ||
      !record.state.supportsHotReload ||
      !record.flutterProcess?.stdin.writable
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Flutter run is not ready');
    }
    try {
      record.flutterProcess.stdin.write(action === 'reload' ? 'r\n' : 'R\n');
    } catch (error) {
      throwIpcError('INTERNAL', commandErrorMessage(error));
    }
  }

  status(workdir: string, ownerId: number): XcodeBuildStatusResult {
    const normalizedWorkdir = path.resolve(workdir);
    // 同一 workdir 的记录取最新一条;startedAt 相同时(同一毫秒内重新编译)按插入
    // 顺序取后写入的那条,否则会读到刚被顶掉的旧记录。
    const record = [...this.records.values()]
      .filter(
        (candidate) =>
          candidate.ownerId === ownerId && candidate.state.workdir === normalizedWorkdir,
      )
      .reduce<BuildRecord | null>(
        (latest, candidate) =>
          !latest || candidate.state.startedAt >= latest.state.startedAt ? candidate : latest,
        null,
      );
    return record
      ? { state: { ...record.state }, output: record.output }
      : { state: null, output: '' };
  }

  private finish(
    record: BuildRecord,
    exitCode: number | null,
    status: XcodeBuildState['status'],
  ): void {
    record.state = {
      ...record.state,
      status,
      phase: null,
      exitCode,
      endedAt: this.deps.now(),
    };
    const event: XcodeBuildEvent = { type: 'state', state: { ...record.state } };
    this.options.emit(record.ownerId, event);
    this.pruneFinishedRecords();
  }

  private appendOutput(record: BuildRecord, chunk: string): void {
    if (!chunk) return;
    record.output = (record.output + chunk).slice(-MAX_XCODE_BUILD_OUTPUT_CHARS);
    this.options.emit(record.ownerId, {
      type: 'output',
      buildId: record.state.buildId,
      chunk: chunk.slice(-MAX_XCODE_BUILD_OUTPUT_CHARS),
    });
  }

  private setPhase(record: BuildRecord, phase: XcodeBuildState['phase']): void {
    if (record.state.status !== 'running') return;
    record.state = { ...record.state, phase };
    this.options.emit(record.ownerId, { type: 'state', state: { ...record.state } });
  }

  private async exec(
    record: BuildRecord,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<XcodeCommandResult> {
    return this.deps.execFile('/usr/bin/xcrun', args, {
      timeoutMs,
      maxBuffer: XCODE_BUILD_MAX_BUFFER,
      signal: record.abortController.signal,
    });
  }

  private async runBuild(
    record: BuildRecord,
    request: XcodeBuildStartRequest,
    absoluteContainer: string,
    defaultSchemeName: string,
  ): Promise<void> {
    const containerArg = request.containerKind === 'workspace' ? '-workspace' : '-project';
    const destination = `id=${record.destinationId}`;
    try {
      const settingsResult = await this.exec(
        record,
        [
          'xcodebuild',
          '-showBuildSettings',
          '-json',
          containerArg,
          absoluteContainer,
          '-scheme',
          request.scheme,
          '-configuration',
          'Debug',
          '-destination',
          destination,
        ],
        XCODEBUILD_TIMEOUT_MS,
      );
      const settings = parseXcodeAppBuildSettings(settingsResult.stdout);
      record.bundleId = settings.bundleId;
      if (settings.flutterRoot) {
        const appRoot = await resolveFlutterAppRoot(absoluteContainer, record.state.workdir, this.deps);
        await this.runFlutter(record, request, settings.flutterRoot, appRoot, defaultSchemeName);
        return;
      }

      const build = await this.exec(
        record,
        [
          'xcodebuild',
          containerArg,
          absoluteContainer,
          '-scheme',
          request.scheme,
          '-configuration',
          'Debug',
          '-destination',
          destination,
          'build',
        ],
        XCODE_BUILD_TIMEOUT_MS,
      );
      this.appendOutput(record, `${build.stdout}${build.stderr}`);
      const product = await this.deps.stat(settings.appPath);
      if (!product.isDirectory()) throw new Error('Xcode did not produce an app bundle');

      this.setPhase(record, 'installing');
      if (request.destinationPlatform === 'iOS Simulator') {
        const boot = await this.exec(
          record,
          ['simctl', 'bootstatus', record.destinationId, '-b'],
          120_000,
        );
        this.appendOutput(record, `${boot.stdout}${boot.stderr}`);
        const install = await this.exec(
          record,
          ['simctl', 'install', record.destinationId, settings.appPath],
          120_000,
        );
        this.appendOutput(record, `${install.stdout}${install.stderr}`);
        this.setPhase(record, 'launching');
        const launch = await this.exec(
          record,
          [
            'simctl',
            'launch',
            '--terminate-running-process',
            record.destinationId,
            settings.bundleId,
          ],
          60_000,
        );
        this.appendOutput(record, `${launch.stdout}${launch.stderr}`);
        record.launchedPid = parseSimulatorLaunchPid(launch.stdout);
        await this.deps
          .execFile(
            '/usr/bin/open',
            ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', record.destinationId],
            { timeoutMs: 20_000 },
          )
          .catch(() => undefined);
      } else {
        const install = await this.exec(
          record,
          [
            'devicectl',
            'device',
            'install',
            'app',
            '--device',
            record.destinationId,
            settings.appPath,
          ],
          180_000,
        );
        this.appendOutput(record, `${install.stdout}${install.stderr}`);
        this.setPhase(record, 'launching');
        const launch = await this.exec(
          record,
          [
            'devicectl',
            'device',
            'process',
            'launch',
            '--device',
            record.destinationId,
            '--terminate-existing',
            '--json-output',
            '-',
            settings.bundleId,
          ],
          60_000,
        );
        this.appendOutput(record, `${launch.stdout}${launch.stderr}`);
        record.launchedPid = parseDeviceLaunchPid(launch.stdout);
      }

      if (record.stopRequested) return;
      this.setPhase(record, 'launched');
      this.appendOutput(record, `Launched ${settings.bundleId}.\n`);
    } catch (error) {
      if (record.stopRequested || record.abortController.signal.aborted) return;
      this.appendOutput(record, `${commandErrorMessage(error)}\n`);
      this.finish(record, null, 'failed');
    }
  }

  private async runFlutter(
    record: BuildRecord,
    request: XcodeBuildStartRequest,
    flutterRoot: string,
    appRoot: string,
    defaultSchemeName: string,
  ): Promise<void> {
    record.state = { ...record.state, supportsHotReload: true };
    this.options.emit(record.ownerId, { type: 'state', state: { ...record.state } });
    this.appendOutput(
      record,
      `Running flutter run --debug on ${request.destinationName}…\n`,
    );
    // 非默认 scheme 就是 Flutter 的 flavor(如 staging / production):漏传会跑成默认配置。
    // 默认 scheme 与容器同名(Runner / Recipes…),那种情况传 --flavor 反而会被 Flutter 拒。
    const flavor =
      request.scheme.toLowerCase() === defaultSchemeName.toLowerCase() ? null : request.scheme;
    const child = this.deps.spawn(path.join(flutterRoot, 'bin', 'flutter'), [
      'run',
      '--debug',
      '-d',
      record.destinationId,
      '--device-timeout',
      '30',
      ...(flavor ? ['--flavor', flavor] : []),
    ], {
      // flutter run 必须站在 pubspec.yaml 所在目录：嵌套工程（apps/mobile/ios/Runner.xcworkspace）
      // 从会话根目录跑会找不到 pubspec。
      cwd: appRoot,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    });
    record.flutterProcess = child;
    let observed = '';
    let stderrTail = '';
    const consume = (chunk: Buffer | string, stderr = false) => {
      const text = chunk.toString();
      this.appendOutput(record, text);
      const scan = observed + text;
      if (stderr) stderrTail = (stderrTail + text).slice(-4_000);
      if (scan.includes('Xcode build done')) this.setPhase(record, 'installing');
      if (
        scan.includes('Syncing files to device') ||
        scan.includes('Installing and launching')
      ) {
        this.setPhase(record, 'launching');
      }
      if (
        scan.includes('Flutter run key commands') ||
        scan.includes('A Dart VM Service on')
      ) {
        this.setPhase(record, 'launched');
      }
      if (scan.includes('Performing hot reload')) this.setPhase(record, 'reloading');
      if (scan.includes('Performing hot restart')) this.setPhase(record, 'restarting');
      if (
        scan.includes('Reloaded ') ||
        scan.includes('Hot reload failed')
      ) {
        this.setPhase(record, 'launched');
      }
      if (
        scan.includes('Restarted application') ||
        scan.includes('Hot restart failed')
      ) {
        this.setPhase(record, 'launched');
      }
      observed = text.slice(-128);
    };

    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer | string) => consume(chunk));
      child.stderr.on('data', (chunk: Buffer | string) => consume(chunk, true));
      child.once('error', (error) => {
        record.flutterProcess = null;
        reject(error);
      });
      child.once('close', (code) => {
        record.flutterProcess = null;
        if (!record.stopRequested && record.state.status === 'running') {
          if (stderrTail && record.state.phase !== 'launched') {
            this.appendOutput(record, stderrTail);
          }
          this.finish(record, code, code === 0 ? 'succeeded' : 'failed');
        }
        resolve();
      });
    });
  }

  private pruneFinishedRecords(): void {
    if (this.records.size <= MAX_RETAINED_BUILDS) return;
    const finished = [...this.records.values()]
      .filter((record) => record.state.status !== 'running')
      .sort((a, b) => a.state.startedAt - b.state.startedAt);
    for (const record of finished) {
      if (this.records.size <= MAX_RETAINED_BUILDS) break;
      this.records.delete(record.state.buildId);
    }
  }
}

function parseDiscoveryRequest(value: unknown): XcodeProjectDiscoveryRequest {
  const raw = requireObject(value);
  const workdir = requireString(raw.workdir, 'workdir');
  const containerPath = typeof raw.containerPath === 'string' ? raw.containerPath : null;
  const scheme = typeof raw.scheme === 'string' ? raw.scheme : null;
  return { sessionId: requireString(raw.sessionId, 'sessionId'), workdir, containerPath, scheme };
}

function parseStartRequest(value: unknown): XcodeBuildStartRequest {
  const raw = requireObject(value);
  const containerKind = raw.containerKind;
  if (containerKind !== 'workspace' && containerKind !== 'project') {
    throwIpcError('INVALID_PARAMS', 'invalid Xcode container kind');
  }
  const containerPath = requireString(raw.containerPath, 'containerPath');
  if (
    containerPath.includes('\0') ||
    path.isAbsolute(containerPath) ||
    containerPath.split('/').includes('..')
  ) {
    throwIpcError('INVALID_PARAMS', 'invalid Xcode container path');
  }
  const scheme = requireString(raw.scheme, 'scheme');
  const destinationId = requireString(raw.destinationId, 'destinationId');
  const destinationPlatform = requireString(raw.destinationPlatform, 'destinationPlatform');
  const destinationName = requireString(raw.destinationName, 'destinationName');
  const destinationOsVersion =
    typeof raw.destinationOsVersion === 'string' ? raw.destinationOsVersion : null;
  if (
    scheme.length > 512 ||
    destinationId.length > 512 ||
    destinationPlatform.length > 128 ||
    destinationName.length > 512 ||
    (destinationOsVersion !== null && destinationOsVersion.length > 64) ||
    [scheme, destinationId, destinationPlatform, destinationName, destinationOsVersion ?? ''].some(
      (part) => /[\0\r\n]/.test(part),
    )
  ) {
    throwIpcError('INVALID_PARAMS', 'invalid Xcode build setting');
  }
  return {
    sessionId: requireString(raw.sessionId, 'sessionId'),
    workdir: requireString(raw.workdir, 'workdir'),
    containerPath,
    containerKind,
    scheme,
    destinationId,
    destinationPlatform,
    destinationName,
    destinationOsVersion,
  };
}

export function registerXcodeBuildIpc(options: {
  dependencies?: Partial<XcodeBuildDependencies>;
  assertSessionWorkdir: (sessionId: string, workdir: string) => Promise<void>;
}): XcodeBuildManager {
  const manager: XcodeBuildManager = new XcodeBuildManager({
    dependencies: options.dependencies,
    emit: (ownerId, event) => {
      const target = webContents.fromId(ownerId);
      if (!target || target.isDestroyed()) return;
      const ownerWindow = BrowserWindow.fromWebContents(target);
      if (!isTrustedAppRendererWindow(ownerWindow)) return;
      target.send(XCODE_BUILD_PUSH.EVENT, event);
    },
  });

  const ownerId = (event: Electron.IpcMainInvokeEvent): number => {
    assertTrustedAppRendererEvent(event);
    return event.sender.id;
  };

  // 承载窗口销毁 = 这条构建的推送与停止入口都消失了,由 main 侧收尾（关副窗口不会退出应用）。
  const watchedOwners = new Set<number>();
  const watchOwnerLifetime = (event: Electron.IpcMainInvokeEvent): void => {
    const sender = event.sender;
    if (watchedOwners.has(sender.id)) return;
    watchedOwners.add(sender.id);
    sender.once('destroyed', () => {
      watchedOwners.delete(sender.id);
      manager.releaseOwner(sender.id);
    });
  };

  ipcMain.handle(XCODE_BUILD_INVOKE.DISCOVER, async (event, request: unknown) => {
    ownerId(event);
    const parsed = parseDiscoveryRequest(request);
    await options.assertSessionWorkdir(parsed.sessionId, parsed.workdir);
    return manager.discover(parsed);
  });
  ipcMain.handle(XCODE_BUILD_INVOKE.START, async (event, request: unknown) => {
    const requesterId = ownerId(event);
    watchOwnerLifetime(event);
    const parsed = parseStartRequest(request);
    await options.assertSessionWorkdir(parsed.sessionId, parsed.workdir);
    // 校验工作目录要等一次主进程读库:这期间窗口可能已经关了,再 start 就是一个
    // 没有主人、也停不掉的构建(releaseOwner 在还没记录时就跑过了)。
    if (event.sender.isDestroyed()) {
      throwIpcError('PRECONDITION_FAILED', 'owner window closed');
    }
    return manager.start({ ...parsed, ownerId: requesterId });
  });
  ipcMain.handle(XCODE_BUILD_INVOKE.STOP, async (event, buildId: unknown) => {
    const requesterId = ownerId(event);
    await manager.stop(requireString(buildId, 'buildId'), requesterId);
  });
  ipcMain.handle(
    XCODE_BUILD_INVOKE.FLUTTER_ACTION,
    async (event, buildId: unknown, action: unknown) => {
      const requesterId = ownerId(event);
      const parsedAction = requireString(action, 'action');
      if (parsedAction !== 'reload' && parsedAction !== 'restart') {
        throwIpcError('INVALID_PARAMS', 'invalid Flutter action');
      }
      await manager.flutterAction(requireString(buildId, 'buildId'), requesterId, parsedAction);
    },
  );
  ipcMain.handle(XCODE_BUILD_INVOKE.STATUS, async (event, request: unknown) => {
    const requesterId = ownerId(event);
    const raw = requireObject(request);
    const workdir = requireString(raw.workdir, 'workdir');
    await options.assertSessionWorkdir(requireString(raw.sessionId, 'sessionId'), workdir);
    return manager.status(workdir, requesterId);
  });

  return manager;
}
