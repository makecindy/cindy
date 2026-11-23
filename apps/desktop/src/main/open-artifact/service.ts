/**
 * The one Open Artifact harness of this Cindy process, created on first use.
 *
 * Shortly after launch, {@link OpenArtifactService.resumeAtLaunch} connects to a daemon that already runs for the home
 * (so comments made while Cindy was closed come back), or, when Cindy used this home before and a runtime that can
 * start here is already on disk, starts one (so pages restored in the sidebar load); it never downloads. Otherwise the
 * first tool call prepares a runtime, starts the daemon ({@link startDaemon}, in a utility process) and connects. A
 * daemon Cindy started is asked to stop when Cindy quits ({@link OpenArtifactService.close}). Sessions are attached on
 * their first tool call and report running / idle as their turns start and end, so the daemon knows which tasks are
 * live.
 */
import {
  createHarness,
  readDaemon,
  type Harness,
  type HarnessOptions,
  type OpenRequest,
  type WakeAnswer,
} from '@open-artifact/harness-kit';
import {
  TOOL_DEFINITIONS,
  type SessionParams,
  type ToolCallResult,
  type ToolDefinition,
  type WakeDeliverParams,
} from '@open-artifact/protocol';
import { createLogger } from '../logger.js';
import {
  DAEMON_STOP_WAIT_MS,
  localRuntime,
  prepareRuntime,
  startDaemon,
  stopStartedDaemon,
  usedHomeBefore,
  type CindyDaemonSpawn,
  type PreparedRuntime,
  type RuntimeDeps,
  type StartedDaemon,
} from './runtime.js';
import { ARTIFACTS_SKILL_COMMAND } from './skill.js';

const log = createLogger('open-artifact');

/** What register.ts hands over once its task plumbing exists (see setOpenArtifactSessionBridge). */
export interface OpenArtifactSessionBridge {
  wake: (params: WakeDeliverParams) => Promise<WakeAnswer>;
  isInTurn: (sessionId: string) => boolean;
  observeTurns: (listener: (sessionId: string) => void) => () => void;
  /** The task's title, shown on the page next to the session; `undefined` when it has none. */
  title?: (sessionId: string) => Promise<string | undefined>;
}

export interface OpenArtifactServiceDeps {
  home: string;
  runtime: () => Omit<RuntimeDeps, 'home'>;
  open: (request: OpenRequest) => Promise<boolean>;
  /** Starts the daemon process (the kit's `daemon.spawn`); see openArtifact.desktop.ts. */
  spawn: CindyDaemonSpawn;
  createHarness?: typeof createHarness;
  readDaemon?: typeof readDaemon;
  prepareRuntime?: typeof prepareRuntime;
  localRuntime?: typeof localRuntime;
  usedHomeBefore?: (home: string) => boolean;
  startDaemon?: typeof startDaemon;
  /** How long {@link OpenArtifactService.close} waits for a daemon Cindy started to exit. */
  stopWaitMs?: number;
}

const sessionKey = (caller: SessionParams) => `${caller.session ?? ''}\n${caller.workspace ?? ''}`;

export class OpenArtifactService {
  private harness: Promise<Harness> | null = null;
  private connecting: Promise<Harness> | null = null;
  private bridge: OpenArtifactSessionBridge | null = null;
  private stopObserving: (() => void) | null = null;
  /** Attached sessions → their workspace, so a turn change reports to the right key. */
  private readonly attached = new Map<string, SessionParams>();
  private closed = false;
  /** The daemon process this Cindy started, while it runs; `null` when another app started the daemon. */
  private started: StartedDaemon | null = null;

  constructor(private readonly deps: OpenArtifactServiceDeps) {}

  /** The spawn hook handed to the kit: remembers the process so quit can stop it. */
  private readonly spawnTracked = async (start: Parameters<CindyDaemonSpawn>[0]): Promise<StartedDaemon> => {
    const child = await this.deps.spawn(start);
    this.started = child;
    child.once('exit', () => {
      if (this.started === child) this.started = null;
    });
    return child;
  };

  setSessionBridge(bridge: OpenArtifactSessionBridge | null): void {
    this.stopObserving?.();
    this.stopObserving = null;
    this.bridge = bridge;
    if (bridge) this.stopObserving = bridge.observeTurns((sessionId) => this.reportTurn(sessionId));
  }

  /** The tool definitions: the daemon's when connected, else the ones this kit carries. */
  async tools(): Promise<ToolDefinition[]> {
    const harness = await this.harness?.catch(() => null);
    if (!harness?.connected) return TOOL_DEFINITIONS;
    try {
      return await harness.tools();
    } catch {
      return TOOL_DEFINITIONS;
    }
  }

  /** One tool call for a task; starts what is missing first. */
  async call(name: string, args: Record<string, unknown>, caller: SessionParams): Promise<ToolCallResult> {
    const harness = await this.ensureConnected();
    await this.track(harness, caller);
    return harness.call(name, args, caller);
  }

  /**
   * After launch: connects to a daemon that already runs for the home, or starts one when Cindy used this home before
   * and a runtime that can start here is on disk. Never downloads. Resolves to the daemon's URL when this call started
   * it (pages restored in the sidebar may need a reload), else `null`.
   */
  async resumeAtLaunch(): Promise<string | null> {
    if (this.closed || this.harness || this.connecting) return null;
    const read = this.deps.readDaemon ?? readDaemon;
    if (await read(this.deps.home)) {
      await this.harnessFor({ source: 'running' }).catch((error) =>
        log.warn('Open Artifact connect failed', { error: (error as Error).message }));
      return null;
    }
    if (!(this.deps.usedHomeBefore ?? usedHomeBefore)(this.deps.home)) return null;
    const prepared = await (this.deps.localRuntime ?? localRuntime)({ ...this.deps.runtime(), home: this.deps.home });
    if (!prepared || this.closed || this.harness || this.connecting) return null;
    log.info('Starting the Open Artifact daemon after launch', { source: prepared.source });
    await this.ensureConnected(prepared);
    return (await read(this.deps.home))?.url ?? null;
  }

  /** Forget attached sessions (account switch): the next tool call attaches again under the new account. */
  forgetSessions(): void {
    const harness = this.harness;
    const sessions = [...this.attached.values()];
    this.attached.clear();
    if (!harness) return;
    void harness.then((h) => Promise.all(sessions.map((s) => h.detach(s).catch(() => undefined)))).catch(() => undefined);
  }

  /**
   * App quit: closes the connection and, when this Cindy started the daemon, asks it to stop and waits for its exit
   * (bounded, see {@link stopStartedDaemon}). A daemon another app started keeps running.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.setSessionBridge(null);
    void this.harness?.then((h) => h.close()).catch(() => undefined);
    this.harness = null;
    const child = this.started;
    this.started = null;
    if (!child) return;
    const outcome = await stopStartedDaemon(child, this.deps.stopWaitMs ?? DAEMON_STOP_WAIT_MS);
    log.info('Open Artifact daemon stopped', { outcome });
  }

  private ensureConnected(prepared?: PreparedRuntime): Promise<Harness> {
    if (this.closed) return Promise.reject(new Error('Open Artifact is shutting down.'));
    this.connecting ??= this.connect(prepared).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(chosen?: PreparedRuntime): Promise<Harness> {
    const existing = await this.harness?.catch(() => null);
    if (existing?.connected) return existing;
    const running = await (this.deps.readDaemon ?? readDaemon)(this.deps.home);
    let prepared: PreparedRuntime = { source: 'running' };
    if (!running) {
      prepared = chosen ?? await (this.deps.prepareRuntime ?? prepareRuntime)({ ...this.deps.runtime(), home: this.deps.home });
      if (prepared.source !== 'running') {
        await (this.deps.startDaemon ?? startDaemon)(this.deps.home, prepared, this.spawnTracked);
      }
    }
    const harness = existing ?? await this.harnessFor(prepared);
    await harness.ready();
    return harness;
  }

  private harnessFor(prepared: PreparedRuntime): Promise<Harness> {
    if (this.harness) return this.harness;
    const options: HarnessOptions = {
      harness: 'cindy',
      agentName: 'Cindy',
      // The page names the session "the Cindy session".
      profile: { title: 'Cindy' },
      commands: [ARTIFACTS_SKILL_COMMAND],
      caps: { wake: { resume: true }, tools: 'native' },
      home: this.deps.home,
      // Cindy starts the daemon itself (runtime.ts startDaemon); the client only reads daemon.json and reconnects.
      autoStart: false,
      ...(prepared.source === 'cindy' ? { runtime: prepared.runtime } : {}),
      wake: (params) => this.bridge?.wake(params) ?? 'failed',
      open: (request) => this.deps.open(request),
      log: (line) => log.info(line),
    };
    this.harness = (this.deps.createHarness ?? createHarness)(options);
    this.harness.catch(() => {
      this.harness = null;
    });
    return this.harness;
  }

  private async track(harness: Harness, caller: SessionParams): Promise<void> {
    const session = caller.session;
    if (!session || this.attached.has(session)) return;
    this.attached.set(session, caller);
    try {
      const title = await this.bridge?.title?.(session).catch(() => undefined);
      await harness.attach({
        session,
        workspace: caller.workspace ?? null,
        ...(title ? { title } : {}),
        status: this.bridge?.isInTurn(session) === false ? 'idle' : 'running',
      });
    } catch (error) {
      this.attached.delete(session);
      log.warn('Open Artifact attach failed', { error: (error as Error).message });
    }
  }

  private reportTurn(sessionId: string): void {
    const caller = this.attached.get(sessionId);
    if (!caller || !this.harness) return;
    const status = this.bridge?.isInTurn(sessionId) ? 'running' : 'idle';
    void this.harness
      .then((h) => (h.connected ? h.status(caller, status) : undefined))
      .catch((error) => log.warn('Open Artifact status failed', { key: sessionKey(caller), error: (error as Error).message }));
  }
}
