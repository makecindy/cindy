import { HeadlessConfigStore } from './config.js';
import { HeadlessControlService } from './control-service.js';
import { ControlSocketServer } from './control-socket.js';
import { ensureHeadlessDirectories, resolveHeadlessPaths, type HeadlessPaths } from './paths.js';
import { HeadlessSessionStorage } from './session-storage.js';
import { NativeHeadlessSessionRuntime } from './session-runtime.js';
import { HeadlessLogger } from './session-runtime.js';
import { EncryptedFileSecretStore, ResilientSecretStore, SecretToolSecretStore } from './secret-store.js';
import { HeadlessCindyAccountService } from './cindy-account.js';
import { HeadlessDeviceLinkService } from './device-link-service.js';
import { HeadlessProviderRouter } from './provider-router.js';
import { HeadlessClaudeProxy } from './claude-proxy.js';
import { HeadlessCodexProxy } from './codex-proxy.js';
import { HeadlessFileBrowserService } from './file-browser-service.js';
import { HeadlessAttachmentService } from './attachment-service.js';
import { HeadlessScheduleStorage } from './schedule-storage.js';
import { HeadlessScheduleRunner } from './schedule-runner.js';
import { HeadlessSchedulerService } from './scheduler-service.js';
import { Scheduler } from '@cindy/maker-scheduler';
import { MakerMemoryManager, type McpProvider } from '@cindy/maker-core';
import { createCindyMemoryMcpServer } from '@cindy/mcps/memory';
import { resolveLiziMcpSessionContext } from '@cindy/mcps/session-context';
import { createOrcaMcpServer, type OrcaMcpDeps } from '@cindy/mcps/orca';
import Database from 'better-sqlite3';
import path from 'node:path';
import { HeadlessMcpService } from './mcp-service.js';
import { HeadlessOrcaService } from './orca-service.js';
import { HeadlessProviderCatalog } from './provider-catalog.js';
import type { HeadlessSessionEvent, HeadlessSessionMeta } from './session-types.js';
import { HeadlessInputQueue } from './input-queue.js';
import { HeadlessGoalService } from './goal-service.js';
import { HeadlessHistoryService } from './history-service.js';
import { HeadlessGitHistory } from './git-history.js';
import { HeadlessMediaService } from './media-service.js';

export class HeadlessDaemon {
  private readonly storage: HeadlessSessionStorage;
  private readonly socket: ControlSocketServer;
  private readonly runtime: NativeHeadlessSessionRuntime;
  private readonly config: HeadlessConfigStore;
  private readonly deviceLink: HeadlessDeviceLinkService;
  private readonly claudeProxy: HeadlessClaudeProxy;
  private readonly codexProxy: HeadlessCodexProxy;
  private readonly scheduleStorage: HeadlessScheduleStorage;
  private readonly scheduler: HeadlessSchedulerService;
  private readonly memory: MakerMemoryManager;
  private readonly mcp: HeadlessMcpService;
  private readonly orca: HeadlessOrcaService;
  private readonly catalog = new HeadlessProviderCatalog();
  private readonly account: HeadlessCindyAccountService;
  private readonly inputQueue: HeadlessInputQueue;
  private readonly goal: HeadlessGoalService;
  private readonly history: HeadlessHistoryService;
  private readonly media: HeadlessMediaService;
  private readonly attachments: HeadlessAttachmentService;

  constructor(readonly paths: HeadlessPaths = resolveHeadlessPaths()) {
    this.storage = new HeadlessSessionStorage(paths.databaseFile);
    this.config = new HeadlessConfigStore(paths.configFile);
    const logger = new HeadlessLogger();
    this.memory = new MakerMemoryManager({
      basePath: paths.stateDir,
      sqliteFactory: (filePath) => {
        const db = new Database(filePath);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
        return db;
      },
      agents: {},
      logger: logger.child('maker-memory'),
      initialEnabled: true,
    });
    const mcpProviders: McpProvider[] = [{
      name: 'cindy_memory',
      isEnabled: () => this.memory.isEnabled(),
      toClaudeSdkConfig: (context) => ({
        type: 'sdk',
        name: 'cindy_memory',
        instance: createCindyMemoryMcpServer({
          getManager: () => this.memory,
          workdir: context.workingDir,
          getSessionContext: () => resolveLiziMcpSessionContext(context),
          logger: logger.child('cindy_memory'),
        }),
      }),
    }, {
      name: 'cindy_orca',
      toClaudeSdkConfig: (context) => ({
        type: 'sdk',
        name: 'cindy_orca',
        instance: createOrcaMcpServer(this.orcaMcpDeps(logger), {
          agentKind: context.agentKind,
          workingDir: context.workingDir,
          sessionId: context.sessionId,
          vendorOptions: context.vendorOptions,
        }),
      }),
    }];
    this.mcp = new HeadlessMcpService(mcpProviders, logger.child('mcp'));
    const secrets = new ResilientSecretStore(
      new SecretToolSecretStore(),
      new EncryptedFileSecretStore(
        path.join(paths.stateDir, 'credentials', 'vault.v1.json'),
        path.join(paths.stateDir, 'credentials', 'vault.key'),
      ),
    );
    // Account refresh material stays in the encrypted credential store. The
    // non-secret config remains safe to inspect and package on a server.
    this.account = new HeadlessCindyAccountService(this.config, fetch, secrets);
    const providerRouter = new HeadlessProviderRouter(this.storage, this.config, secrets, process.env, this.account);
    this.claudeProxy = new HeadlessClaudeProxy(providerRouter);
    this.codexProxy = new HeadlessCodexProxy(providerRouter);
    this.runtime = new NativeHeadlessSessionRuntime(
      this.storage, paths.stateDir, process.env, logger, 4, providerRouter, mcpProviders, this.memory, this.mcp,
    );
    this.media = new HeadlessMediaService(path.join(paths.stateDir, 'media', 'blobs'), {
      deviceLinkApiBase: () => this.account.getDeviceLinkApiBase(),
      getAccessToken: () => this.account.getRelayToken(),
    });
    this.attachments = new HeadlessAttachmentService(path.join(paths.stateDir, 'attachments'), {
      deviceLinkApiBase: () => this.account.getDeviceLinkApiBase(),
      getAccessToken: () => this.account.getRelayToken(),
    }, this.media);
    this.inputQueue = new HeadlessInputQueue(
      this.storage,
      this.runtime,
      (sessionId, payload) => this.attachments.normalizeQueued(sessionId, payload),
      (content) => this.attachments.toDisplayContent(content),
    );
    this.orca = new HeadlessOrcaService(paths.databaseFile, this.storage, this.runtime);
    this.goal = new HeadlessGoalService(paths.databaseFile, this.storage, this.runtime);
    this.history = new HeadlessHistoryService(this.storage, this.runtime, async (sessionId, reason) => {
      // A queued input or autonomous goal must never land after a destructive
      // history operation and silently recreate the discarded context.
      await this.inputQueue.stopSession(sessionId);
      await this.goal.pause(sessionId, `paused: ${reason}`);
    }, new HeadlessGitHistory(paths.databaseFile), async () => {
      await this.media.prune((await this.storage.listAllHistoryMessages()).map((message) => message.content));
    });
    this.scheduleStorage = new HeadlessScheduleStorage(paths.databaseFile);
    this.scheduler = new HeadlessSchedulerService(new Scheduler({
      storage: this.scheduleStorage,
      runner: new HeadlessScheduleRunner(this.storage, this.runtime, paths.stateDir, this.scheduleStorage),
      maxConcurrentRuns: 2,
      processId: process.pid,
    }), this.scheduleStorage);
    const files = new HeadlessFileBrowserService(this.config, this.storage);
    const service = new HeadlessControlService(
      this.storage,
      this.config,
      this.runtime,
      undefined,
      secrets,
      undefined,
      files,
      this.attachments,
      this.scheduler,
      this.orca,
      this.account,
      async () => this.deviceLink.restart(),
    );
    service.setGoalService(this.goal);
    service.setHistoryService(this.history);
    this.deviceLink = new HeadlessDeviceLinkService(
      this.storage, service, this.config, secrets, '0.1.0', undefined,
      this.account, this.inputQueue, logger.child('device-link'), this.media,
    );
    service.setDeviceLinkStatusReader(() => this.deviceLink.status());
    this.socket = new ControlSocketServer(paths.socketFile, service, this.storage);
  }

  async start(): Promise<void> {
    await ensureHeadlessDirectories(this.paths);
    await this.account.restore();
    await this.migrateLegacyAttachmentHistory();
    const claudeEndpoint = await this.claudeProxy.start();
    const codexEndpoint = await this.codexProxy.start();
    await this.mcp.start();
    await this.runtime.initialize(claudeEndpoint, codexEndpoint);
    this.history.start();
    await this.goal.start();
    await this.inputQueue.start();
    await this.scheduler.start();
    await this.socket.start();
    await this.deviceLink.start();
  }

  private async migrateLegacyAttachmentHistory(): Promise<void> {
    for (const message of await this.storage.listAllHistoryMessages()) {
      const migrated = await this.attachments.migrateDisplayContent(message.content);
      if (JSON.stringify(migrated) !== JSON.stringify(message.content)) {
        await this.storage.replaceHistoryContent(message.sessionId, message.clientId, migrated);
      }
    }
    await this.media.prune((await this.storage.listAllHistoryMessages()).map((message) => message.content));
  }

  async stop(): Promise<void> {
    this.deviceLink.stop();
    this.inputQueue.stop();
    this.history.stop();
    await this.goal.stop();
    await this.socket.stop();
    await this.scheduler.stop();
    await this.runtime.close();
    this.orca.close();
    await this.mcp.stop();
    await this.memory.dispose();
    await this.codexProxy.stop();
    await this.claudeProxy.stop();
    this.storage.close();
    this.scheduleStorage.close();
  }

  private orcaMcpDeps(logger: HeadlessLogger): OrcaMcpDeps {
    const ok = <T>(value: T) => ({ ok: true as const, ...value });
    const missing = (message: string) => ({ ok: false as const, errorCode: 'HOST_NOT_READY' as const, message });
    const deps: OrcaMcpDeps = {
      logger: logger.child('cindy_orca'),
      startTeam: async ({ leadSessionId }) => ok({ teamId: (await this.orca.startTeam(leadSessionId)).id }),
      createWorker: async (input) => {
        const worker = await this.orca.createWorker({
          leadSessionId: input.leadSessionId, label: input.label, role: input.role,
          agentKind: input.agent, model: input.model, effort: input.effort, initialTask: input.initialTask,
        });
        return ok({ workerId: worker.id, workerSessionId: worker.sessionId, dispatched: worker.status === 'running' });
      },
      listWorkers: async ({ leadSessionId }) => ok({ workers: await Promise.all(this.orca.listWorkers(leadSessionId)
        .map(async (worker) => this.toMcpWorker(worker))) }),
      switchFocus: async ({ leadSessionId, workerIdOrLabel }) => ok({ workerId: (await this.orca.switchFocus(leadSessionId, workerIdOrLabel)).id }),
      sendToWorker: async ({ callerLeadSessionId, targetSessionId, message }) => {
        const result = await this.orca.sendToWorker(callerLeadSessionId, targetSessionId, message);
        return ok({ agentKind: (await this.storage.get(result.worker.sessionId))!.agentKind, wakeKind: 'queued' as const, targetTitle: result.worker.label, targetLastUserSendAt: null });
      },
      listWorkerQueuedMessages: async () => missing('Headless Orca uses the normal per-session queue; queued-message mutation is unavailable'),
      updateWorkerQueuedMessage: async () => missing('Headless Orca uses the normal per-session queue; queued-message mutation is unavailable'),
      cancelWorkerQueuedMessage: async () => missing('Headless Orca uses the normal per-session queue; queued-message mutation is unavailable'),
      idleWorker: async ({ callerLeadSessionId, workerId }) => ok({ workerId: (await this.orca.idleWorker(callerLeadSessionId, workerId)).id }),
      endTeam: async ({ leadSessionId }) => { await this.orca.endTeam(leadSessionId); return ok({}); },
      archiveWorker: async ({ callerLeadSessionId, workerId }) => ok({ workerId: (await this.orca.archiveWorker(callerLeadSessionId, workerId)).id }),
      listAvailableModels: async ({ agent }) => {
        const config = await this.config.read();
        const modelsFor = (agentKind: 'codex' | 'claude-code') => this.catalog
          .listModels(config, agentKind)
          .map((model) => ({ id: model.id, label: model.name }));
        return ok({
          ...(agent === undefined || agent === 'codex' ? { codex: modelsFor('codex') } : {}),
          ...(agent === undefined || agent === 'claude-code' ? { claude_code: modelsFor('claude-code') } : {}),
        });
      },
      getWorkspaceInfo: async ({ leadSessionId }) => {
        const team = this.orca.getTeam(leadSessionId);
        const workers = this.orca.listWorkers(leadSessionId);
        return ok({ workflow: team ? { workflow_id: team.id, lead_session_id: team.leadSessionId, status: team.status } : null, ui_capacity: 4, worker_count: workers.length, workers: await Promise.all(workers.map(async (worker) => {
          const session = await this.requireWorkerSession(worker.sessionId);
          return this.toWorkspaceWorker(worker, session);
        })) });
      },
      getWorkerStatus: async ({ leadSessionId, workerId }) => {
        const worker = this.orca.listWorkers(leadSessionId).find((item) => item.id === workerId);
        return worker ? ok({ worker_id: worker.id, session_id: worker.sessionId, status: worker.status, session_status: worker.status, idle_ms: null, restored_from_storage: true }) : missing('Worker not found');
      },
      readWorker: async ({ leadSessionId, workerId }) => {
        const worker = this.orca.listWorkers(leadSessionId).find((item) => item.id === workerId);
        if (!worker) return missing('Worker not found');
        const events = await this.storage.listEvents(worker.sessionId, 0, 100);
        return ok({ worker_id: worker.id, session_id: worker.sessionId, status: worker.status, session_status: worker.status, idle_ms: null, restored_from_storage: true, result: workerOutput(events) });
      },
    };
    return deps;
  }

  private async toMcpWorker(worker: ReturnType<HeadlessOrcaService['listWorkers']>[number]) {
    const session = await this.requireWorkerSession(worker.sessionId);
    return {
      workerId: worker.id,
      sessionId: worker.sessionId,
      label: worker.label,
      role: worker.role,
      status: worker.status === 'archived' ? 'done' as const : worker.status,
      focused: worker.focused,
      agent: session.agentKind,
      model: session.model,
      effort: session.effort ?? null,
      idleSince: null,
    };
  }

  private toWorkspaceWorker(worker: ReturnType<HeadlessOrcaService['listWorkers']>[number], session: HeadlessSessionMeta) {
    return {
      worker_id: worker.id,
      session_id: worker.sessionId,
      status: worker.status,
      session_status: worker.status,
      idle_ms: null,
      restored_from_storage: true,
      label: worker.label,
      role: worker.role,
      agent_kind: session.agentKind,
      model: session.model,
      effort: session.effort ?? null,
      focused: worker.focused,
      working_dir: session.workDir,
    };
  }

  private async requireWorkerSession(sessionId: string): Promise<HeadlessSessionMeta> {
    const session = await this.storage.get(sessionId);
    if (!session) throw new Error(`Orca worker session is missing: ${sessionId}`);
    return session;
  }
}

function workerOutput(events: HeadlessSessionEvent[]): string {
  const text = events.flatMap((event) => {
    if (event.type !== 'agent_event' || !event.data || typeof event.data !== 'object') return [];
    const data = event.data as { type?: unknown; data?: unknown };
    return data.type === 'text' && typeof data.data === 'string' ? [data.data] : [];
  }).join('');
  return text.slice(-20_000);
}
