import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface WorkspaceListenerProcess {
  stdout: NodeJS.EventEmitter;
  stderr: NodeJS.EventEmitter;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export interface MacWorkspaceApplicationMonitorDeps {
  spawnListener: () => WorkspaceListenerProcess;
  readSnapshot: () => Promise<readonly string[]>;
  onSnapshot: (bundleIds: ReadonlySet<string>) => void;
  scheduleRestart?: (callback: () => void, delayMs: number) => unknown;
}

type WorkspaceSnapshotLine = { type: 'snapshot'; bundleIds: string[] };
const MAX_BUFFERED_STDOUT_BYTES = 256 * 1024;
const LISTENER_RESTART_DELAY_MS = 1_000;

function parseSnapshotLine(line: string): WorkspaceSnapshotLine | null {
  try {
    const value = JSON.parse(line) as Partial<WorkspaceSnapshotLine>;
    if (value.type !== 'snapshot' || !Array.isArray(value.bundleIds)) return null;
    if (value.bundleIds.some((item) => typeof item !== 'string' || item.length === 0)) return null;
    return { type: 'snapshot', bundleIds: [...new Set(value.bundleIds)] };
  } catch {
    return null;
  }
}

/** Tracks NSWorkspace application changes through one stoppable, long-running JXA process. */
export class MacWorkspaceApplicationMonitor {
  private child: WorkspaceListenerProcess | null = null;
  private bundleIds = new Set<string>();
  private generation = 0;
  private eventGeneration = 0;
  private refreshPromise: Promise<void> | null = null;
  private bufferedOutput = '';
  private restartScheduled = false;

  constructor(private readonly deps: MacWorkspaceApplicationMonitorDeps) {}

  start(): void {
    if (this.child) return;
    const operation = ++this.generation;
    let child: WorkspaceListenerProcess;
    try {
      child = this.deps.spawnListener();
    } catch {
      this.scheduleRestart(operation);
      return;
    }
    this.child = child;
    const consume = (chunk: unknown): void => {
      if (this.child !== child || operation !== this.generation) return;
      this.bufferedOutput += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(this.bufferedOutput, 'utf8') > MAX_BUFFERED_STDOUT_BYTES) {
        this.bufferedOutput = '';
        child.kill();
        return;
      }
      const lines = this.bufferedOutput.split(/\r?\n/);
      this.bufferedOutput = lines.pop() ?? '';
      for (const line of lines) {
        const snapshot = parseSnapshotLine(line.trim());
        if (!snapshot) continue;
        this.eventGeneration += 1;
        this.apply(snapshot.bundleIds);
      }
    };
    child.stdout.on('data', consume);
    // stderr is a diagnostic channel, never part of the JSON protocol. Do not
    // feed it into the stdout buffer: an error without a newline could otherwise
    // grow the protocol buffer forever.
    child.stderr.on('data', () => undefined);
    child.on('error', () => undefined);
    child.on('close', () => {
      if (this.child !== child || operation !== this.generation) return;
      this.child = null;
      this.bufferedOutput = '';
      this.scheduleRestart(operation);
    });
  }

  stop(): void {
    this.generation += 1;
    this.restartScheduled = false;
    const child = this.child;
    this.child = null;
    this.bufferedOutput = '';
    child?.kill();
  }

  private scheduleRestart(operation: number): void {
    if (this.restartScheduled) return;
    this.restartScheduled = true;
    const schedule = this.deps.scheduleRestart ?? ((callback: () => void, delayMs: number) => {
      setTimeout(callback, delayMs);
    });
    schedule(() => {
      this.restartScheduled = false;
      if (operation !== this.generation || this.child) return;
      this.start();
    }, LISTENER_RESTART_DELAY_MS);
  }

  state(): ReadonlySet<string> {
    return new Set(this.bundleIds);
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const operation = this.generation;
    const eventGeneration = this.eventGeneration;
    const refresh = this.deps.readSnapshot()
      .then((bundleIds) => {
        if (operation !== this.generation || eventGeneration !== this.eventGeneration) return;
        if (bundleIds.some((value) => typeof value !== 'string' || value.length === 0)) return;
        this.apply(bundleIds);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.refreshPromise === refresh) this.refreshPromise = null;
      });
    this.refreshPromise = refresh;
    return refresh;
  }

  private apply(bundleIds: readonly string[]): void {
    this.bundleIds = new Set(bundleIds);
    this.deps.onSnapshot(new Set(this.bundleIds));
  }
}

const WORKSPACE_LISTENER_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');
const workspace = $.NSWorkspace.sharedWorkspace;
const center = workspace.notificationCenter;
function publishSnapshot() {
  const applications = workspace.runningApplications;
  const bundleIds = [];
  for (let index = 0; index < applications.count; index += 1) {
    const identifier = applications.objectAtIndex(index).bundleIdentifier;
    if (identifier) bundleIds.push(ObjC.unwrap(identifier));
  }
  const line = JSON.stringify({ type: 'snapshot', bundleIds: bundleIds }) + '\n';
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
}
const callback = ObjC.block('void', ['id'], function () { publishSnapshot(); });
const observers = [
  center.addObserverForNameObjectQueueUsingBlock($.NSWorkspaceDidLaunchApplicationNotification, null, null, callback),
  center.addObserverForNameObjectQueueUsingBlock($.NSWorkspaceDidTerminateApplicationNotification, null, null, callback),
  center.addObserverForNameObjectQueueUsingBlock($.NSWorkspaceDidActivateApplicationNotification, null, null, callback),
];
publishSnapshot();
$.NSRunLoop.currentRunLoop.run;
`;

/** Starts the production NSWorkspace notification listener. */
export function spawnMacWorkspaceApplicationListener(): ChildProcessWithoutNullStreams {
  return spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WORKSPACE_LISTENER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const WORKSPACE_SNAPSHOT_SCRIPT = String.raw`
ObjC.import('AppKit');
const applications = $.NSWorkspace.sharedWorkspace.runningApplications;
const bundleIds = [];
for (let index = 0; index < applications.count; index += 1) {
  const identifier = applications.objectAtIndex(index).bundleIdentifier;
  if (identifier) bundleIds.push(ObjC.unwrap(identifier));
}
JSON.stringify(bundleIds);
`;

/** Reads one authoritative NSWorkspace snapshot for startup/focus recovery. */
export function readMacWorkspaceApplicationSnapshot(): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', WORKSPACE_SNAPSHOT_SCRIPT],
      { timeout: 1_500 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const bundleIds = JSON.parse(stdout) as unknown;
          if (!Array.isArray(bundleIds) || bundleIds.some((value) => typeof value !== 'string')) {
            reject(new Error('invalid workspace application snapshot'));
            return;
          }
          resolve(bundleIds);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
