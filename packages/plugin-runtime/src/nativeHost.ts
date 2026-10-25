import { GhostManager, type GhostManagerOptions } from './store/ghostManager.js';
import { GhostNodeRuntimeBroker, type GhostNodeRuntimeBrokerDeps } from './nodeRuntimeBroker.js';
import { createNativeNodeWorkerProcess, type NativeNodeWorkerOptions } from './nativeProcess.js';
import { createNativeSnapshotMutation } from './nativeSnapshot.js';
import { bindDeviceAuthorizationTarget, bindPluginAuthorizationTarget } from './authorization/targetPolicy.js';
import { ghostInstallApprovalToken, type GhostManifest, type InstalledGhost } from './shared/ghost.js';
import { HeadlessGhostSandbox, type HeadlessSandboxOptions } from './headlessSandbox.js';
import { GhostRuntime } from './GhostRuntime.js';
import { GhostPipeDispatcher } from './pipeDispatcher.js';
import { isGhostOwnerScopeUsable } from './ghostOwnerScope.js';
import { resolvePluginInstanceQuery, installedGhostStoragePart } from './shared/pluginIdentity.js';

export interface NativePluginHostOptions {
  /** Allow the owner host to compose its task/settings ports before residents run. */
  deferStart?: boolean;
  manager: GhostManagerOptions;
  web?: Omit<HeadlessSandboxOptions, 'capture' | 'receive'> & { receive(instanceId: string, payload: unknown): Promise<unknown> };
  node: NativeNodeWorkerOptions & { snapshotWorkerPath: string };
  withNodeRequest?(instanceId: string, payload: unknown, run: (payload: unknown) => Promise<unknown>): Promise<unknown>;
  broker: Omit<GhostNodeRuntimeBrokerDeps, 'getGhost' | 'instanceId' | 'spawnProcess' | 'spawnChildProcess' | 'bindDeviceAuthorizationTarget' | 'bindPluginAuthorizationTarget'>;
}

/** Shared installed/approved store and published Node ABI, without Electron.
 * An optional native Chromium adapter runs main.js through the same dispatcher.
 * Core startup does not launch a browser; only enabled resident/called plugins do. */
export class NativePluginHost {
  readonly manager: GhostManager;
  readonly node: GhostNodeRuntimeBroker;
  readonly web?: HeadlessGhostSandbox;
  readonly runtime?: GhostRuntime;
  readonly dispatcher?: GhostPipeDispatcher;
  private installed = new Map<string, InstalledGhost>();
  private refreshTail: Promise<void> = Promise.resolve();
  private closed = false;
  private opened = false;
  private activated: boolean;

  constructor(private readonly options: NativePluginHostOptions) {
    this.activated = !options.deferStart;
    this.manager = new GhostManager({ ...options.manager,
      mutateSnapshot: options.manager.mutateSnapshot ?? createNativeSnapshotMutation({ nodePath: options.node.nodePath, workerPath: options.node.snapshotWorkerPath }),
      onChanged: ghosts => { options.manager.onChanged?.(ghosts); if(this.opened)void this.refresh().catch(error => options.manager.log?.warn('plugin runtime refresh failed', { code: error instanceof Error ? error.name : 'Error' })); },
    });
    if (options.web) {
      this.web = new HeadlessGhostSandbox({ ...options.web,
        capture: ghost => {
          const id = installedGhostStoragePart(ghost), approval = ghostInstallApprovalToken(ghost.approval);
          const owner = options.broker.ownerScope?.capture();
          return () => {
            const current = this.installed.get(id);
            return !this.closed && !!current?.enabled && current.dir === ghost.dir &&
              ghostInstallApprovalToken(current.approval) === approval && isGhostOwnerScopeUsable(options.broker.ownerScope, owner);
          };
        },
        receive: async (id, payload) => {
          const type = (payload as {type?:unknown} | null)?.type;
          if (type === 'tool-result') { this.dispatcher!.handleToolResult(id, payload); return { ok: true }; }
          if (type === 'tool-progress') { this.dispatcher!.handleToolProgress(id, payload); return { ok: true }; }
          // The browser route already binds this identity to its owner and
          // approval. Never re-resolve a plugin-supplied identity here.
          if (type === 'node-request') return this.handleNodeRequest(id, payload);
          return options.web!.receive(id, payload);
        },
      });
      this.runtime = new GhostRuntime({ adapter: this.web, log: options.manager.log,
        onStateChanged: (id, state) => this.dispatcher?.onRuntimeState(id, state),
      });
      this.dispatcher = new GhostPipeDispatcher({
        ownerScope: options.broker.ownerScope, log: options.manager.log,
        getGhost: (id, namespace) => {
          if (this.closed) return null;
          const result = resolvePluginInstanceQuery([...this.installed.values()], id, namespace);
          return result.status === 'unique' && result.ghost.approval?.state === 'approved' ? result.ghost : null;
        },
        runtimeStateOf: id => this.runtime!.stateOf(id),
        spawn: async ghost => {
          const result = await this.runtime!.spawn(ghost);
          if (!result.ok) return result;
          return await this.runtime!.waitUntilRunning(installedGhostStoragePart(ghost)) ? { ok: true } : { ok: false, reason: 'PLUGIN_BRIDGE_NOT_READY' };
        },
        sendToGhost: (id, payload) => this.web!.send(id, payload),
      });
    }
    const spawnProcess = (entry: string, cwd: string, id: string, args?: string[]) => createNativeNodeWorkerProcess(options.node, entry, cwd, id, args);
    this.node = new GhostNodeRuntimeBroker({ ...options.broker,
      instanceId: installedGhostStoragePart,
      ...(this.dispatcher ? { getCallSignal: (id: string, callId: string) => this.dispatcher!.getPendingCallSignal(id, callId), getCallSessionId: (id: string, callId: string) => this.dispatcher!.getPendingCallSessionId(id, callId) } : {}),
      getGhost: id => this.closed ? null : this.installed.get(id) ?? null,
      spawnProcess, spawnChildProcess: spawnProcess,
      sendToGhost: (id, payload) => { this.web?.send(id, payload); options.broker.sendToGhost?.(id, payload); },
      bindDeviceAuthorizationTarget: (manifest, url) => { const assertTarget = bindDeviceAuthorizationTarget(manifest as GhostManifest, url); return current => assertTarget(current as GhostManifest); },
      bindPluginAuthorizationTarget: (manifest, request) => { const assertTarget = bindPluginAuthorizationTarget(manifest as GhostManifest, request); return current => assertTarget(current as GhostManifest); },
    });
  }

  async open(beforeStart?:()=>void|Promise<void>): Promise<void> {
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED');
    await this.manager.migrateLegacyApprovalsOnce();
    const ghosts=await this.manager.listAsync();
    if(this.closed)throw new Error('PLUGIN_HOST_CLOSED');
    this.installed=new Map(ghosts.map(ghost=>[installedGhostStoragePart(ghost),ghost]));
    await beforeStart?.();
    if(this.closed)throw new Error('PLUGIN_HOST_CLOSED');
    this.opened=true;
    await this.refresh();
  }

  list(): InstalledGhost[] { return [...this.installed.values()].map(ghost => structuredClone(ghost)); }

  async start(): Promise<void> {
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED');
    if (!this.opened) throw new Error('PLUGIN_HOST_NOT_READY');
    if (this.activated) return;
    this.activated = true;
    await this.refresh();
  }

  refresh(): Promise<void> {
    const next = this.refreshTail.catch(() => {}).then(async () => {
      if (this.closed) return;
      const ghosts = await this.manager.listAsync();
      if (this.closed) return;
      const current = new Map(ghosts.map(ghost => [installedGhostStoragePart(ghost), ghost]));
      for (const [id, previous] of this.installed) {
        const replacement = current.get(id);
        if (!replacement?.enabled || ghostInstallApprovalToken(previous.approval) !== ghostInstallApprovalToken(replacement.approval) || previous.dir !== replacement.dir) { this.runtime?.stop(id); await this.node.stopAndWait(id); }
      }
      if (this.closed) return;
      this.installed = current;
      if (!this.activated) return;
      for (const ghost of ghosts) {
        if (this.closed) return;
        if (!ghost.enabled || ghost.approval?.state !== 'approved') continue;
        if (ghost.manifest.node?.lifecycle === 'resident') await this.node.startResident(ghost);
        if (this.runtime && (ghost.manifest.launch === 'resident' || ghost.manifest.routineEvents !== undefined)) await this.runtime.spawn(ghost);
      }
    });
    this.refreshTail = next;
    return next;
  }

  /** Wire only to the existing authenticated logic-page node-request pipe. */
  async handleNodeRequest(instanceId: string, payload: unknown) {
    await this.refreshTail;
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED');
    const run = (request: unknown) => this.node.handleRequest(instanceId, request);
    return this.options.withNodeRequest ? this.options.withNodeRequest(instanceId, payload, run) : run(payload);
  }

  async close(): Promise<void> {
    this.closed = true;
    // Clear lookup authority before awaiting pending work or process teardown.
    const ids = [...this.installed.keys()]; this.installed.clear();
    this.runtime?.destroyAll();
    await this.web?.close();
    await this.refreshTail.catch(() => {});
    for (const id of ids) await this.node.stopAndWait(id);
    this.node.destroyAll();
  }
}
