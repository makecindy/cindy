import path from 'node:path';
import {
  resolveHeadlessDefaults,
  type HeadlessConfig,
  type HeadlessConfigStore,
  type HeadlessDefaults,
  type HeadlessProviderProfile,
} from './config.js';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type {
  HeadlessAgentKind,
  HeadlessEffort,
  HeadlessPermissionMode,
  HeadlessSessionMeta,
  HeadlessSessionStatus,
  HeadlessSessionEventStorage,
  HeadlessSessionStorageContract,
  HeadlessWorkspaceKind,
} from './session-types.js';
import type { InteractionDecision } from '@cindy/maker-core';
import type { HeadlessSessionRuntime } from './session-runtime.js';
import { HeadlessProviderCatalog } from './provider-catalog.js';
import { DeviceCodeAuthManager } from './device-code-auth.js';
import { SecretToolSecretStore, type HeadlessSecretStore } from './secret-store.js';
import type { HeadlessFileBrowserService } from './file-browser-service.js';
import type { HeadlessAttachmentService } from './attachment-service.js';
import type { HeadlessSchedulerService } from './scheduler-service.js';
import type { HeadlessOrcaService } from './orca-service.js';
import type { HeadlessCindyAccountService } from './cindy-account.js';
import type { HeadlessGoalService } from './goal-service.js';
import type { HeadlessHistoryService } from './history-service.js';
import {
  applyTemplateParams,
  type CreateScheduleInput,
  type ScheduleTemplate,
  type UpdateScheduleInput,
} from '@cindy/maker-scheduler';
import { isRemoteWorkdirAllowed } from './workdir-guard.js';

type ControlStorage = HeadlessSessionStorageContract & HeadlessSessionEventStorage;

export interface ControlRequest {
  id: string;
  method: string;
  params?: unknown;
  /** Reserved for transport metadata; session writes follow legacy Device Link semantics. */
  controller?: unknown;
}

export type ControlResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Shared local control surface. */
export class HeadlessControlService {
  private readonly deviceCodes: DeviceCodeAuthManager;
  private deviceLinkStatusReader: (() => { status: string; issue: unknown }) | null = null;
  private goal: HeadlessGoalService | null = null;
  private history: HeadlessHistoryService | null = null;

  constructor(
    private readonly sessions: ControlStorage,
    private readonly config: HeadlessConfigStore,
    private readonly runtime?: HeadlessSessionRuntime,
    private readonly catalog: HeadlessProviderCatalog = new HeadlessProviderCatalog(),
    private readonly secrets: HeadlessSecretStore = new SecretToolSecretStore(),
    deviceCodes?: DeviceCodeAuthManager,
    private readonly files?: HeadlessFileBrowserService,
    private readonly attachments?: HeadlessAttachmentService,
    private readonly scheduler?: HeadlessSchedulerService,
    private readonly orca?: HeadlessOrcaService,
    private readonly account?: HeadlessCindyAccountService,
    private readonly refreshDeviceLink?: () => Promise<void>,
  ) {
    this.deviceCodes = deviceCodes ?? new DeviceCodeAuthManager(this.secrets);
  }

  setDeviceLinkStatusReader(reader: (() => { status: string; issue: unknown }) | null): void {
    this.deviceLinkStatusReader = reader;
  }

  setGoalService(goal: HeadlessGoalService | null): void { this.goal = goal; }
  setHistoryService(history: HeadlessHistoryService | null): void { this.history = history; }

  async handle(request: ControlRequest): Promise<ControlResponse> {
    try {
      const result = await this.dispatch(request.method, request.params);
      return { id: request.id, ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: request.id, ok: false, error: { code: 'BAD_REQUEST', message } };
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const p = record(params) ?? {};
    switch (method) {
      case 'daemon.ping':
        return { ok: true };
      case 'account.status':
        return this.account?.getState() ?? { authenticated: false, error: 'Cindy account service is not available' };
      case 'account.login.complete':
        return this.completeAccountLogin(p);
      case 'account.logout':
        await this.requireAccount().clearLogin();
        await this.refreshDeviceLink?.();
        return { authenticated: false };
      case 'session.list':
        return this.listSessions();
      case 'session.get':
        return this.getSession(requiredString(p, 'sessionId'));
      case 'session.create.preview':
        return this.resolveSessionCreate(p);
      case 'session.create':
        return this.createSession(p);
      case 'session.configure':
        return this.configureSession(p);
      case 'session.patch-meta':
        return this.patchSessionMeta(p);
      case 'session.set-extra-dirs':
        return this.setSessionExtraDirs(p);
      case 'session.regenerate-title':
        return this.regenerateSessionTitle(requiredString(p, 'sessionId'));
      case 'session.steer':
        return this.steerSession(p);
      case 'session.close':
        return this.closeSession(p);
      case 'catalog.providers':
        return this.listProviders(await this.config.read(), optionalAgentKind(p.agentKind) ?? undefined);
      case 'catalog.models':
        return this.catalog.listModels(await this.config.read(), requiredAgentKind(p.agentKind), optionalString(p.providerId) ?? undefined);
      case 'catalog.providers.display':
        return this.listDisplayProvidersForDeviceLink(await this.config.read());
      case 'provider.secret.import':
        return this.importProviderSecret(p);
      case 'provider.add':
        return this.addCustomProvider(p);
      case 'provider.set-enabled':
        return this.setProviderEnabled(p);
      case 'provider.device-code.start':
        return this.startDeviceCode(p);
      case 'provider.device-code.status':
        return this.deviceCodes.getStatus(requiredString(p, 'attemptId'));
      case 'device-link.status': {
        const config = await this.config.read();
        const accountConnected = this.account?.getState().authenticated === true
          && Boolean(this.account.getDeviceLinkApiBase());
        const accountDevice = accountConnected ? config.account : undefined;
        return {
          configured: Boolean(config.deviceLink) || accountConnected,
          source: accountConnected ? 'cindy-account' : config.deviceLink ? 'manual-token' : 'none',
          remoteControlEnabled: config.remoteControlEnabled,
          ...(config.deviceName ? { deviceName: config.deviceName } : {}),
          ...(this.deviceLinkStatusReader ? this.deviceLinkStatusReader() : { status: 'stopped', issue: null }),
          ...(accountDevice
            ? { deviceId: accountDevice.deviceId, apiBaseUrl: this.account!.getDeviceLinkApiBase()! }
            : config.deviceLink ? { deviceId: config.deviceLink.deviceId, apiBaseUrl: config.deviceLink.apiBaseUrl } : {}),
        };
      }
      case 'device-link.set-name':
        return this.setDeviceLinkName(p);
      case 'device-link.token.import':
        return this.importDeviceLinkToken(p);
      case 'device-link.set-enabled': {
        if (typeof p.enabled !== 'boolean') throw new Error('enabled must be a boolean');
        const config = await this.config.read();
        await this.config.write({ ...config, remoteControlEnabled: p.enabled });
        await this.refreshDeviceLink?.();
        return { remoteControlEnabled: p.enabled };
      }
      case 'workdir.list':
        return (await this.config.read()).workdirRoots ?? [];
      case 'workdir.allow':
        return this.allowWorkdir(requiredString(p, 'path'));
      case 'session.events':
        return this.sessions.listEvents(requiredString(p, 'sessionId'), nonNegativeInt(p.afterSequence, 'afterSequence', 0), boundedLimit(p.limit));
      case 'history.delete':
        return this.requireHistory().deleteMessage(requiredString(p, 'sessionId'), requiredString(p, 'clientId'));
      case 'history.fork':
        return this.requireHistory().fork(requiredString(p, 'sessionId'), requiredString(p, 'clientId'));
      case 'history.rewind.preview':
        return this.requireHistory().previewRewind(requiredString(p, 'sessionId'), requiredString(p, 'clientId'));
      case 'history.rewind.commit':
        return this.requireHistory().commitRewind(requiredString(p, 'sessionId'), requiredString(p, 'clientId'));
      case 'file.remote-op':
        return this.requireFiles().remoteOp(p);
      case 'file.preview':
        return this.requireFiles().preview(p.path);
      case 'file.list-dir':
        return this.requireFiles().listLegacyDirectory(requiredString(p, 'path'));
      case 'file.stat-path':
        return this.requireFiles().statLegacyPath(requiredString(p, 'path'));
      case 'file.mkdir-p':
        return this.requireFiles().mkdirLegacyPath(requiredString(p, 'path'));
      case 'schedule.list':
        return this.requireScheduler().list();
      case 'schedule.get':
        return this.requireScheduler().get(requiredString(p, 'scheduleId'));
      case 'schedule.create':
        return this.createSchedule(p);
      case 'schedule.update':
        return this.requireScheduler().update(requiredString(p, 'scheduleId'), schedulePatch(p));
      case 'schedule.delete':
        return this.requireScheduler().delete(requiredString(p, 'scheduleId'));
      case 'schedule.pause':
        return this.requireScheduler().pause(requiredString(p, 'scheduleId'));
      case 'schedule.resume':
        return this.requireScheduler().resume(requiredString(p, 'scheduleId'));
      case 'schedule.run-now':
        return this.requireScheduler().runNow(requiredString(p, 'scheduleId'));
      case 'schedule.runs':
        return this.requireScheduler().listRuns(requiredString(p, 'scheduleId'), p.limit === undefined ? undefined : boundedLimit(p.limit));
      case 'schedule.delete-run':
        return this.requireScheduler().deleteRun(requiredString(p, 'runId'));
      case 'schedule.list-templates':
        return this.requireScheduler().listTemplates();
      case 'schedule.create-from-template':
        return this.createScheduleFromTemplate(p);
      case 'schedule.inflight-count':
        return this.requireScheduler().getInflightCount(requiredString(p, 'scheduleId'));
      case 'schedule.mark-run-read':
        await this.requireScheduler().markRunRead(requiredString(p, 'runId'));
        return undefined;
      case 'schedule.mark-schedule-runs-read':
        return this.requireScheduler().markScheduleRunsRead(requiredString(p, 'scheduleId'));
      case 'schedule.runtime-state':
        return this.requireScheduler().runtimeState();
      case 'schedule.unread-count':
        return this.requireScheduler().unreadCount();
      case 'agent.list-commands':
        return this.listAgentCommands(p);
      case 'agent.list-skills':
        return this.listAgentSkills(p);
      case 'agent.scan-at-resources':
        return this.scanAtResources(p);
      case 'account.api-key-present':
        // A Cindy SSO session owns an ephemeral gateway key in memory.  This
        // endpoint deliberately returns only presence, never credential data.
        return { present: Boolean(this.account?.getGatewayKey() ?? this.account?.getState().authenticated) };
      case 'usage.model-pricing':
        // Linux has no desktop pricing-cache service.  `null` is the desktop
        // contract's documented unavailable value and keeps the client UI in
        // its no-price state instead of treating the host as disconnected.
        return null;
      case 'schedule.project-remove':
        return this.removeProjectSchedule(p);
      case 'model.set-session-preference':
        return this.setModelPreference(p, true);
      case 'model.apply-draft-preference':
        return this.setModelPreference(p, false);
      case 'goal.set':
        return this.requireGoal().set({
          sessionId: requiredString(p, 'sessionId'),
          objective: requiredString(p, 'objective'),
          ...(p.limits === undefined ? {} : { limits: goalLimits(record(p.limits) ?? {}) }),
        });
      case 'goal.clear':
        return this.requireGoal().clear(requiredString(p, 'sessionId'));
      case 'goal.status':
        return this.requireGoal().getStatus(requiredString(p, 'sessionId'));
      case 'goal.pause':
        return this.requireGoal().pause(requiredString(p, 'sessionId'));
      case 'goal.resume':
        return this.requireGoal().resume(requiredString(p, 'sessionId'));
      case 'goal.update':
        return this.requireGoal().update(requiredString(p, 'sessionId'), goalUpdate(record(p.patch) ?? {}));
      case 'orca.team.start':
        return this.requireOrca().startTeam(requiredString(p, 'leadSessionId'));
      case 'orca.team.get':
        return this.requireOrca().getTeam(requiredString(p, 'leadSessionId'));
      case 'orca.team.end':
        return this.requireOrca().endTeam(requiredString(p, 'leadSessionId'));
      case 'orca.worker.list':
        return this.requireOrca().listWorkers(requiredString(p, 'leadSessionId'));
      case 'orca.worker.create':
        return this.requireOrca().createWorker({
          leadSessionId: requiredString(p, 'leadSessionId'),
          label: requiredString(p, 'label'),
          role: requiredString(p, 'role'),
          ...(optionalAgentKind(p.agentKind) ? { agentKind: optionalAgentKind(p.agentKind)! } : {}),
          ...(optionalString(p.providerId) ? { providerId: optionalString(p.providerId)! } : {}),
          ...(optionalString(p.model) ? { model: optionalString(p.model)! } : {}),
          ...(optionalString(p.effort) ? { effort: requiredEffort(p.effort) } : {}),
          ...(optionalString(p.initialTask) ? { initialTask: optionalString(p.initialTask)! } : {}),
        });
      case 'orca.worker.send':
        return this.requireOrca().sendToWorker(requiredString(p, 'leadSessionId'), requiredString(p, 'workerRef'), requiredString(p, 'content'));
      case 'orca.worker.idle':
        return this.requireOrca().idleWorker(requiredString(p, 'leadSessionId'), requiredString(p, 'workerRef'));
      case 'orca.worker.archive':
        return this.requireOrca().archiveWorker(requiredString(p, 'leadSessionId'), requiredString(p, 'workerRef'));
      case 'orca.worker.focus':
        return this.requireOrca().switchFocus(requiredString(p, 'leadSessionId'), requiredString(p, 'workerRef'));
      case 'session.is-busy':
        return { busy: this.runtime?.isSessionBusy(requiredString(p, 'sessionId')) ?? false };
      case 'runtime.any-session-in-turn':
        return { busy: this.runtime?.isAnySessionBusy() ?? false };
      case 'session.send':
        return this.sendSession(p);
      case 'session.abort':
        return this.abortSession(p);
      case 'session.interaction.resolve':
        return this.resolveInteraction(p);
      case 'config.get':
        return this.config.read();
      case 'config.defaults.get': {
        const config = await this.config.read();
        return { user: config.defaults, effective: resolveHeadlessDefaults(config) };
      }
      case 'config.defaults.set':
        return this.setUserDefaults(p);
      case 'config.defaults.reset':
        return this.resetUserDefaults(p);
      case 'config.project-defaults.get': {
        const config = await this.config.read();
        const workDir = absoluteWorkdir(requiredString(p, 'workDir'));
        return { workDir, project: config.projectDefaults?.[workDir] ?? {}, effective: resolveHeadlessDefaults(config, workDir) };
      }
      case 'config.project-defaults.set':
        return this.setProjectDefaults(p);
      case 'config.project-defaults.reset':
        return this.resetProjectDefaults(p);
      case 'config.set': {
        const config = p.config as HeadlessConfig;
        await this.config.write(config);
        return this.config.read();
      }
      default:
        throw new Error(`Unsupported control method: ${method}`);
    }
  }

  private async createSession(params: Record<string, unknown>) {
    const resolved = await this.resolveSessionCreate(params);
    const created = await this.sessions.create({
      id: optionalString(params.id) ?? randomUUID(),
      agentKind: resolved.agentKind,
      providerId: resolved.providerId,
      workDir: resolved.workDir,
      title: optionalString(params.title) ?? 'New Cindy session',
      model: resolved.model,
      workspaceKind: resolved.workspaceKind,
      effort: resolved.effort,
      permissionMode: resolved.permissionMode,
      fastMode: resolved.fastMode,
    });
    await this.sessions.appendEvent(created.id, 'session_created', { session: created });
    return created;
  }

  /** One source of truth for Terminal, Desktop and Mobile "new session" defaults. */
  private async resolveSessionCreate(params: Record<string, unknown>) {
    const config = await this.config.read();
    const workspaceKind = enumValue(params.workspaceKind, ['project', 'dialogue'] as const) ?? 'project';
    const workDir = optionalString(params.workDir) ?? '';
    const defaults = resolveHeadlessDefaults(config, workDir || undefined);
    const requestedAgent = enumValue(params.agentKind, ['claude-code', 'codex'] as const);
    const agentKind = requestedAgent ?? defaults.agentKind;
    // Agent-specific provider/model defaults cannot safely cross an explicit
    // agent switch (for example `cindy --agent claude-code`).
    const useAgentDefaults = !requestedAgent || requestedAgent === defaults.agentKind;
    const requestedProvider = optionalString(params.providerId) ?? (useAgentDefaults ? defaults.providerId : undefined)
      ?? this.readyManagedProvider(config, agentKind);
    const providerId = requestedProvider ?? (await this.listProviders(config, agentKind))
      .find((provider) => provider.credentialConfigured)?.id;
    const model = optionalString(params.model) ?? (useAgentDefaults ? defaults.model : undefined)
      ?? preferredFallbackModel(this.catalog.listModels(config, agentKind, providerId));
    if (!model) throw new Error('No usable default model. Run `cindy chat setup` or set one with `cindy config set-default --model <id>`.');
    const preference = modelPreference(config, agentKind, providerId, model);
    const effort = enumValue(params.effort, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const) ?? preference?.effort ?? defaults.effort;
    const permissionMode = enumValue(params.permissionMode, ['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const) ?? defaults.permissionMode;
    this.catalog.assertSelection(config, agentKind, providerId, model);
    if (providerId) await this.assertProviderReady(config, providerId);
    return {
      agentKind, providerId, model, workDir, workspaceKind, effort, permissionMode,
      fastMode: typeof params.fastMode === 'boolean' ? params.fastMode : (preference?.fastMode ?? false),
      sources: {
        agentKind: params.agentKind !== undefined ? 'request' : defaults.agentKind === config.defaults.agentKind ? 'user-or-product' : 'project',
        providerId: optionalString(params.providerId) ? 'request' : requestedProvider ? 'default' : 'first-ready',
        model: optionalString(params.model) ? 'request' : defaults.model ? 'default' : 'first-ready',
      },
    };
  }

  /**
   * Device Link clients from older desktop/mobile builds may send a model but
   * omit providerId. Once this host has a Cindy account, route that safe
   * implicit choice through its account-managed XD gateway instead of any
   * stale local Codex/Claude CLI credential.
   */
  private readyManagedProvider(config: HeadlessConfig, agentKind: HeadlessAgentKind): string | undefined {
    if (!this.account?.getState().authenticated || !config.account) return undefined;
    return config.managedModels?.some((model) => model.agents?.includes(agentKind) ?? agentKind === 'claude-code')
      ? 'xd'
      : undefined;
  }

  /** Backfills pre-title Linux sessions on their next read, without overwriting named sessions. */
  private async listSessions(): Promise<HeadlessSessionMeta[]> {
    return Promise.all((await this.sessions.list()).map((session) => this.ensureSessionTitle(session)));
  }

  private async getSession(sessionId: string): Promise<HeadlessSessionMeta | null> {
    const session = await this.sessions.get(sessionId);
    return session ? this.ensureSessionTitle(session) : null;
  }

  private async ensureSessionTitle(session: HeadlessSessionMeta): Promise<HeadlessSessionMeta> {
    if (session.title !== 'New Cindy session') return session;
    const events = await this.sessions.listEvents(session.id, 0, 1_000);
    const userEvent = events.find((event) => event.type === 'user_message');
    const content = record(userEvent?.data)?.content;
    const title = firstMessageTitle(content);
    if (!title) return session;
    const updated = await this.sessions.update(session.id, { title });
    await this.sessions.appendEvent(session.id, 'session_configured', { patch: { title } });
    return updated;
  }

  /** Remote title preview mirrors Desktop's Magic action; persistence stays the explicit metadata write. */
  private async regenerateSessionTitle(sessionId: string): Promise<{ title: string | null }> {
    if (!await this.sessions.get(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    const events = await this.sessions.listEvents(sessionId, 0, 1_000);
    const userEvent = events.find((event) => event.type === 'user_message');
    return { title: firstMessageTitle(record(userEvent?.data)?.content) };
  }

  private async completeAccountLogin(params: Record<string, unknown>) {
    const account = this.requireAccount();
    const region = enumValue(params.region, ['cn', 'global'] as const);
    if (!region) throw new Error('region must be cn or global');
    const state = await account.activateLogin({
      region,
      deviceId: requiredString(params, 'deviceId'),
      accessToken: requiredString(params, 'accessToken'),
      refreshToken: requiredString(params, 'refreshToken'),
    });
    if (state.authenticated) await this.refreshDeviceLink?.();
    return state;
  }

  private requireAccount(): HeadlessCindyAccountService {
    if (!this.account) throw new Error('Cindy account service is not available');
    return this.account;
  }

  private requireHistory(): HeadlessHistoryService {
    if (!this.history) throw new Error('Session history service is unavailable');
    return this.history;
  }

  private async createSchedule(params: Record<string, unknown>): Promise<unknown> {
    const config = await this.config.read();
    const workDir = optionalString(params.workingDir);
    const defaults = resolveHeadlessDefaults(config, workDir ?? undefined);
    const agentKind = enumValue(params.agentKind, ['claude-code', 'codex'] as const) ?? defaults.agentKind;
    const providerId = optionalString(params.providerId) ?? defaults.providerId ?? undefined;
    const model = optionalString(params.model) ?? defaults.model;
    if (!model) throw new Error('model is required until a default model is configured');
    this.catalog.assertSelection(config, agentKind, providerId, model);
    if (providerId) await this.assertProviderReady(config, providerId);
    const input: CreateScheduleInput = {
      ...schedulePatch(params),
      name: requiredString(params, 'name'),
      prompt: requiredString(params, 'prompt'),
      kind: 'cron',
      cronExpr: requiredString(params, 'cronExpr'),
      timezone: optionalString(params.timezone) ?? 'UTC',
      recurring: params.recurring !== false,
      agentKind,
      model,
      ...(providerId ? { providerId } : {}),
      useWorktree: params.useWorktree === true,
      notify: { desktop: false, feishu: false },
    };
    return this.requireScheduler().create(input);
  }

  private async createScheduleFromTemplate(params: Record<string, unknown>): Promise<unknown> {
    const templateId = requiredString(params, 'templateId');
    const template = this.requireScheduler().listTemplates().find((item) => item.id === templateId);
    if (!template) throw new Error(`template ${templateId} not found`);
    const paramValues = stringRecord(params.paramValues, 'paramValues');
    const overrides = record(params.overrides) ?? {};
    const prompt = applyTemplateParams(template.prompt ?? '', paramValues, template.parameters);

    // Route through createSchedule rather than calling Scheduler directly: it
    // applies the server's provider/model defaults and performs the same
    // credential/catalog validation as a manually created automation.
    return this.createSchedule({
      ...templateScheduleFields(template),
      ...overrides,
      name: optionalString(overrides.name) ?? template.name,
      prompt: optionalString(overrides.prompt) ?? prompt,
      cronExpr: optionalString(overrides.cronExpr) ?? template.cronExpr,
      timezone: optionalString(overrides.timezone) ?? template.timezone,
      recurring: typeof overrides.recurring === 'boolean' ? overrides.recurring : (template.recurring ?? true),
      agentKind: optionalString(overrides.agentKind) ?? template.agentKind,
      model: optionalString(overrides.model) ?? template.model,
      useWorktree: typeof overrides.useWorktree === 'boolean' ? overrides.useWorktree : (template.useWorktree ?? false),
      persistentSession: typeof overrides.persistentSession === 'boolean' ? overrides.persistentSession : template.persistentSession,
      silentWhenIdle: typeof overrides.silentWhenIdle === 'boolean' ? overrides.silentWhenIdle : template.silentWhenIdle,
    });
  }

  private listAgentCommands(params: Record<string, unknown>): unknown {
    const runtime = this.runtime?.listAgentCommands;
    if (!runtime || !this.runtime) throw new Error('Agent palette discovery is unavailable');
    return { success: true, commands: runtime.call(this.runtime, requiredAgentKind(params.agentKind)) };
  }

  private async listAgentSkills(params: Record<string, unknown>): Promise<unknown> {
    const runtime = this.runtime?.listAgentSkills;
    if (!runtime || !this.runtime) throw new Error('Agent palette discovery is unavailable');
    const workingDir = await this.requireAllowedPaletteWorkdir(params);
    const result = await runtime.call(this.runtime, requiredAgentKind(params.agentKind), {
      workingDir,
      ...(params.forceReload === true ? { forceReload: true } : {}),
    });
    return { success: true, ...(record(result) ?? { skills: result }) };
  }

  private async scanAtResources(params: Record<string, unknown>): Promise<unknown> {
    const runtime = this.runtime?.scanAtResources;
    if (!runtime || !this.runtime) throw new Error('Agent palette discovery is unavailable');
    const workingDir = await this.requireAllowedPaletteWorkdir(params);
    const cap = params.cap === undefined ? undefined : boundedPaletteCap(params.cap);
    const query = params.query === undefined ? undefined : optionalString(params.query) ?? '';
    const result = await runtime.call(this.runtime, requiredAgentKind(params.agentKind), {
      workingDir,
      ...(cap === undefined ? {} : { cap }),
      ...(query === undefined ? {} : { query }),
    });
    return { success: true, ...(record(result) ?? { items: result }) };
  }

  private async requireAllowedPaletteWorkdir(params: Record<string, unknown>): Promise<string> {
    const workingDir = absoluteWorkdir(requiredString(params, 'workingDir'));
    if (!await isRemoteWorkdirAllowed(this.config, workingDir)) {
      throw new Error(`workingDir is outside an allowed remote project root: ${workingDir}`);
    }
    return workingDir;
  }

  private async removeProjectSchedule(params: Record<string, unknown>): Promise<void> {
    const workingDir = await this.requireAllowedPaletteWorkdir(params);
    const scheduleId = requiredString(params, 'scheduleId');
    const schedule = record(await this.requireScheduler().get(scheduleId));
    if (!schedule) throw new Error(`Unknown schedule: ${scheduleId}`);
    if (path.normalize(String(schedule.workingDir ?? '')) !== workingDir) {
      throw new Error('schedule does not belong to the requested project');
    }
    await this.requireScheduler().delete(scheduleId);
  }

  private async setModelPreference(
    params: Record<string, unknown>,
    sessionScoped: boolean,
  ): Promise<{ agent: HeadlessAgentKind; providerId: string | null; model: string; effort?: HeadlessEffort; fastMode?: boolean }> {
    if (sessionScoped) {
      const sessionId = requiredString(params, 'sessionId');
      if (!await this.sessions.get(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    }
    const agent = requiredAgentKind(params.agent);
    const model = requiredString(params, sessionScoped ? 'model' : 'modelId');
    const providerId = params.providerId === null || params.providerId === undefined
      ? null
      : requiredString(params, 'providerId');
    if (params.effort !== undefined && typeof params.effort !== 'string') throw new Error('effort is invalid');
    if (params.fast !== undefined && typeof params.fast !== 'boolean') throw new Error('fast must be a boolean');
    const effort = params.effort === undefined ? undefined : requiredEffort(params.effort);
    const fastMode = params.fast === undefined ? undefined : params.fast;
    const config = await this.config.read();
    const key = modelPreferenceKey(agent, providerId, model);
    const modelPreferences = {
      ...(config.modelPreferences ?? {}),
      [key]: {
        ...(config.modelPreferences?.[key] ?? {}),
        ...(effort === undefined ? {} : { effort }),
        ...(fastMode === undefined ? {} : { fastMode }),
      },
    };
    const defaults = params.active === true
      ? { ...config.defaults, agentKind: agent, providerId, model, ...(effort === undefined ? {} : { effort }) }
      : config.defaults;
    await this.config.write({ ...config, modelPreferences, defaults });
    return { agent, providerId, model, ...(effort === undefined ? {} : { effort }), ...(fastMode === undefined ? {} : { fastMode }) };
  }

  private async configureSession(params: Record<string, unknown>) {
    const sessionId = requiredString(params, 'sessionId');
    const current = await this.sessions.get(sessionId);
    if (!current) throw new Error(`Unknown session: ${sessionId}`);
    if (this.runtime?.isSessionBusy(sessionId)) {
      throw new Error('Session has a running turn; wait for it to finish or stop it before changing its agent, provider, or model');
    }
    const config = await this.config.read();
    const patch: Partial<typeof current> = {};
    if ('agentKind' in params) patch.agentKind = requiredAgentKind(params.agentKind);
    if ('providerId' in params) patch.providerId = nullableString(params.providerId, 'providerId') ?? undefined;
    if ('model' in params) patch.model = requiredString(params, 'model');
    if ('effort' in params) patch.effort = requiredEffort(params.effort);
    if ('permissionMode' in params) patch.permissionMode = requiredPermissionMode(params.permissionMode);
    if ('fastMode' in params) {
      if (typeof params.fastMode !== 'boolean') throw new Error('fastMode must be a boolean');
      patch.fastMode = params.fastMode;
    }
    const preference = modelPreference(config, patch.agentKind ?? current.agentKind, patch.providerId ?? current.providerId, patch.model ?? current.model);
    if (!('effort' in params) && preference?.effort) patch.effort = preference.effort;
    if (!('fastMode' in params) && preference?.fastMode !== undefined) patch.fastMode = preference.fastMode;
    const next = { ...current, ...patch };
    this.catalog.assertSelection(config, next.agentKind, next.providerId, next.model);
    await this.runtime?.reconfigure(sessionId);
    const updated = await this.sessions.update(sessionId, patch);
    await this.sessions.appendEvent(sessionId, 'session_configured', { patch });
    return updated;
  }

  /** Narrow remote-safe metadata mutation: archive/restore, rename, and pin only. */
  private async patchSessionMeta(params: Record<string, unknown>): Promise<HeadlessSessionMeta> {
    const sessionId = requiredString(params, 'sessionId');
    const current = await this.sessions.get(sessionId);
    if (!current) throw new Error(`Unknown session: ${sessionId}`);
    const rawPatch = record(params.patch);
    if (!rawPatch) throw new Error('patch must be an object');
    const keys = Object.keys(rawPatch);
    if (keys.length === 0 || keys.some((key) => key !== 'status' && key !== 'title' && key !== 'pinnedAt')) {
      throw new Error('patch may only contain status, title, or pinnedAt');
    }
    const patch: Partial<HeadlessSessionMeta> = {};
    if ('status' in rawPatch) patch.status = requiredSessionStatus(rawPatch.status);
    if ('title' in rawPatch) {
      const title = requiredString(rawPatch, 'title').trim();
      if (title.length > 256) throw new Error('title must be at most 256 characters');
      patch.title = title;
    }
    if ('pinnedAt' in rawPatch) patch.pinnedAt = isoToMs(rawPatch.pinnedAt);
    const updated = await this.sessions.update(sessionId, patch);
    await this.sessions.appendEvent(sessionId, 'session_configured', { patch });
    return updated;
  }

  private async setSessionExtraDirs(params: Record<string, unknown>): Promise<HeadlessSessionMeta> {
    const sessionId = requiredString(params, 'sessionId');
    const rawDirs = params.dirs;
    if (!Array.isArray(rawDirs) || rawDirs.some((dir) => typeof dir !== 'string')) {
      throw new Error('dirs must be an array of absolute directory paths');
    }
    const dirs = [...new Set(rawDirs.map((dir) => dir.trim()).filter(Boolean))];
    for (const dir of dirs) {
      if (!path.isAbsolute(dir) || !await isRemoteWorkdirAllowed(this.config, dir)) {
        throw new Error(`extra directory is outside an allowed remote project root: ${dir}`);
      }
    }
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (session.agentKind !== 'claude-code') {
      throw new Error('extra directories are supported only by Claude Code on Linux');
    }
    if (this.runtime?.isSessionBusy(sessionId)) {
      throw new Error('Session has a running turn; wait for it to finish or stop it before changing extra directories');
    }
    await this.runtime?.setExtraDirs?.(sessionId, dirs);
    const updated = await this.sessions.update(sessionId, { extraDirs: dirs });
    await this.sessions.appendEvent(sessionId, 'session_configured', { patch: { extraDirs: dirs } });
    return updated;
  }

  private async setUserDefaults(params: Record<string, unknown>) {
    const patch = defaultsPatch(params);
    const config = await this.config.read();
    const next = { ...config, defaults: { ...config.defaults, ...patch } };
    await this.config.write(next);
    return { user: next.defaults, effective: resolveHeadlessDefaults(next) };
  }

  private async resetUserDefaults(params: Record<string, unknown>) {
    const fields = defaultFields(params.fields);
    const config = await this.config.read();
    const defaults = { ...config.defaults };
    for (const field of fields) delete defaults[field];
    const next = { ...config, defaults };
    await this.config.write(next);
    return { user: next.defaults, effective: resolveHeadlessDefaults(next) };
  }

  private async setProjectDefaults(params: Record<string, unknown>) {
    const workDir = absoluteWorkdir(requiredString(params, 'workDir'));
    const patch = defaultsPatch(params);
    const config = await this.config.read();
    const projectDefaults = { ...(config.projectDefaults ?? {}), [workDir]: { ...(config.projectDefaults?.[workDir] ?? {}), ...patch } };
    const next = { ...config, projectDefaults };
    await this.config.write(next);
    return { workDir, project: projectDefaults[workDir], effective: resolveHeadlessDefaults(next, workDir) };
  }

  private async resetProjectDefaults(params: Record<string, unknown>) {
    const workDir = absoluteWorkdir(requiredString(params, 'workDir'));
    const fields = defaultFields(params.fields);
    const config = await this.config.read();
    const existing = { ...(config.projectDefaults?.[workDir] ?? {}) };
    for (const field of fields) delete existing[field];
    const projectDefaults = { ...(config.projectDefaults ?? {}) };
    if (Object.keys(existing).length === 0) delete projectDefaults[workDir];
    else projectDefaults[workDir] = existing;
    const next = { ...config, projectDefaults };
    await this.config.write(next);
    return { workDir, project: projectDefaults[workDir] ?? {}, effective: resolveHeadlessDefaults(next, workDir) };
  }

  private async importProviderSecret(params: Record<string, unknown>): Promise<{ stored: true }> {
    const profile = await this.requireProviderProfile(requiredString(params, 'providerId'));
    if (!profile.secretRef) throw new Error(`Provider ${profile.id} has no configured secretRef`);
    await this.secrets.set(profile.secretRef, requiredString(params, 'secret'));
    return { stored: true };
  }

  private async addCustomProvider(params: Record<string, unknown>) {
    const id = requiredString(params, 'id');
    const name = requiredString(params, 'name');
    const agentKind = requiredAgentKind(params.agentKind);
    const baseUrl = requiredString(params, 'baseUrl');
    const model = requiredString(params, 'model');
    const modelName = optionalString(params.modelName) ?? model;
    const deviceCode = deviceCodeConfig(params);
    const config = await this.config.read();
    if (this.catalog.listProviders(config).some((provider) => provider.id === id)) {
      throw new Error(`Provider ${id} already exists`);
    }
    const profile: HeadlessProviderProfile = {
      id,
      enabled: true,
      secretRef: `provider_${id}_${agentKind.replace('-', '_')}`,
      ...(deviceCode ? { deviceCode } : {}),
      custom: {
        id,
        name,
        runtimes: {
          [agentKind]: { baseUrl, models: [{ id: model, name: modelName }] },
        },
      },
    };
    const next = { ...config, providerProfiles: [...(config.providerProfiles ?? []), profile] };
    await this.config.write(next);
    return (await this.listProviders(next, agentKind)).find((provider) => provider.id === id);
  }

  private async setProviderEnabled(params: Record<string, unknown>) {
    const providerId = requiredString(params, 'providerId');
    if (typeof params.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    const config = await this.config.read();
    const known = this.catalog.listProviders(config).some((provider) => provider.id === providerId);
    if (!known) throw new Error(`Unknown provider: ${providerId}`);
    const profiles = [...(config.providerProfiles ?? [])];
    const index = profiles.findIndex((profile) => profile.id === providerId);
    if (index >= 0) profiles[index] = { ...profiles[index], enabled: params.enabled };
    else profiles.push({ id: providerId, enabled: params.enabled, secretRef: `provider_${providerId}` });
    const next = { ...config, providerProfiles: profiles };
    await this.config.write(next);
    return (await this.listProviders(next)).find((provider) => provider.id === providerId);
  }

  private async startDeviceCode(params: Record<string, unknown>) {
    const profile = await this.requireProviderProfile(requiredString(params, 'providerId'));
    if (!profile.secretRef || !profile.deviceCode) {
      throw new Error(`Provider ${profile.id} does not declare device-code credentials`);
    }
    return this.deviceCodes.start(profile.deviceCode, profile.secretRef);
  }

  private async importDeviceLinkToken(params: Record<string, unknown>): Promise<{ stored: true; deviceId: string }> {
    const token = requiredString(params, 'token');
    const config = await this.config.read();
    const deviceLink = config.deviceLink ?? {
      deviceId: randomUUID(),
      tokenRef: 'cindy_device_link',
      apiBaseUrl: optionalString(params.apiBaseUrl) ?? 'https://device-link.cindy.com.cn',
      ...(optionalString(params.deviceName) ? { deviceName: optionalString(params.deviceName)! } : {}),
    };
    await this.secrets.set(deviceLink.tokenRef, token);
    await this.config.write({ ...config, deviceLink });
    await this.refreshDeviceLink?.();
    return { stored: true, deviceId: deviceLink.deviceId };
  }

  private async setDeviceLinkName(params: Record<string, unknown>): Promise<{ deviceName: string }> {
    const deviceName = requiredString(params, 'deviceName').trim();
    if (deviceName.length > 64) throw new Error('deviceName must be 64 characters or fewer');
    const config = await this.config.read();
    await this.config.write({ ...config, deviceName });
    await this.refreshDeviceLink?.();
    return { deviceName };
  }

  private async allowWorkdir(input: string): Promise<string[]> {
    const root = await realpath(input);
    if (!root.startsWith('/')) throw new Error('workdir root must resolve to an absolute path');
    const config = await this.config.read();
    const roots = [...new Set([...(config.workdirRoots ?? []), root])];
    await this.config.write({ ...config, workdirRoots: roots });
    return roots;
  }

  private async requireProviderProfile(providerId: string) {
    const config = await this.config.read();
    const profile = (config.providerProfiles ?? []).find((entry) => entry.id === providerId);
    if (!profile) throw new Error(`Unknown configured provider: ${providerId}`);
    return profile;
  }

  private async listProviders(config: HeadlessConfig, agent?: HeadlessAgentKind) {
    const base = this.catalog.listProviders(config, agent);
    const availability = await this.providerAvailability(config);
    return base.map((provider) => ({ ...provider, credentialConfigured: availability.get(provider.id) ?? false }));
  }

  private async listDisplayProvidersForDeviceLink(config: HeadlessConfig) {
    const availability = await this.providerAvailability(config);
    return { providers: this.catalog.listDisplayProviders(config, availability) };
  }

  private async providerAvailability(config: HeadlessConfig): Promise<Map<string, boolean>> {
    const availability = new Map<string, boolean>();
    if (this.account?.getState().authenticated) availability.set('xd', true);
    for (const profile of config.providerProfiles ?? []) {
      // XD is account-managed: its credential is the in-memory gateway key,
      // never a per-provider Secret Service entry. Do not overwrite the
      // authenticated account result merely because the profile has no key.
      if (profile.id === 'xd' && this.account?.getState().authenticated) continue;
      if (!profile.enabled) {
        availability.set(profile.id, false);
        continue;
      }
      if (profile.custom) {
        availability.set(profile.id, Boolean(profile.secretRef && await this.secretExists(profile.secretRef)));
        continue;
      }
      // Managed/OAuth providers may own their credentials outside Secret Service;
      // only claim connected here when this host has an explicit secret reference.
      availability.set(profile.id, Boolean(profile.secretRef && await this.secretExists(profile.secretRef)));
    }
    return availability;
  }

  private async assertProviderReady(config: HeadlessConfig, providerId: string): Promise<void> {
    const profile = (config.providerProfiles ?? []).find((entry) => entry.id === providerId);
    if (profile?.custom && (!profile.enabled || !profile.secretRef || !await this.secretExists(profile.secretRef))) {
      throw new Error(`Provider ${providerId} has no imported credential`);
    }
  }

  private async secretExists(ref: string): Promise<boolean> {
    try {
      return Boolean(await this.secrets.get(ref));
    } catch {
      return false;
    }
  }

  private async sendSession(params: Record<string, unknown>): Promise<{ accepted: true }> {
    const sessionId = requiredString(params, 'sessionId');
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (!this.runtime) throw new Error('Agent runtime is unavailable');
    const content = this.attachments
      ? await this.attachments.normalize(sessionId, params.content)
      : requiredString(params, 'content');
    await this.runtime.send(session, content, { kind: 'user' }, undefined,
      this.attachments ? this.attachments.toDisplayContent(content) : content);
    // Headless has no renderer-side title generator. Replace only the generic
    // draft label once the first real user message has been accepted.
    const title = firstMessageTitle(content);
    if (session.title === 'New Cindy session' && title) {
      await this.sessions.update(sessionId, { title });
      await this.sessions.appendEvent(sessionId, 'session_configured', { patch: { title } });
    }
    return { accepted: true };
  }

  private async abortSession(params: Record<string, unknown>): Promise<{ aborted: true }> {
    const sessionId = requiredString(params, 'sessionId');
    if (!this.runtime) throw new Error('Agent runtime is unavailable');
    await this.runtime.abort(sessionId);
    return { aborted: true };
  }

  private async steerSession(params: Record<string, unknown>): Promise<{ steered: true }> {
    const sessionId = requiredString(params, 'sessionId');
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (!this.runtime) throw new Error('Agent runtime is unavailable');
    await this.runtime.steer(session, requiredString(params, 'content'));
    return { steered: true };
  }

  private async closeSession(params: Record<string, unknown>): Promise<{ closed: true }> {
    const sessionId = requiredString(params, 'sessionId');
    if (!this.runtime) throw new Error('Agent runtime is unavailable');
    if (!await this.sessions.get(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    await this.runtime.closeSession(sessionId);
    // Metadata has archive/delete lifecycle states; the runtime protocol's
    // `closed` value remains an event, while a closed session leaves the
    // active list as an archived record.
    await this.sessions.update(sessionId, { status: 'archived' });
    await this.sessions.appendEvent(sessionId, 'session_status', { status: 'closed' });
    return { closed: true };
  }

  private async resolveInteraction(params: Record<string, unknown>): Promise<{ resolved: boolean }> {
    const sessionId = requiredString(params, 'sessionId');
    if (!this.runtime) throw new Error('Agent runtime is unavailable');
    return {
      resolved: await this.runtime.resolveInteraction(
        sessionId,
        requiredString(params, 'requestId'),
        parseInteractionDecision(params.decision),
      ),
    };
  }

  private requireFiles(): HeadlessFileBrowserService {
    if (!this.files) throw new Error('File browser is unavailable');
    return this.files;
  }

  private requireScheduler(): HeadlessSchedulerService {
    if (!this.scheduler) throw new Error('Scheduler is unavailable');
    return this.scheduler;
  }

  private requireGoal(): HeadlessGoalService {
    if (!this.goal) throw new Error('Goal service is unavailable');
    return this.goal;
  }

  private requireOrca(): HeadlessOrcaService {
    if (!this.orca) throw new Error('Orca is unavailable');
    return this.orca;
  }
}

/** Pick a usable conversational/coding model only when the user has no explicit default. */
function preferredFallbackModel(models: Array<{ id: string; name?: string; description?: string }>): string | undefined {
  const usable = models.filter((model) => !/(?:embedding|transcribe|realtime|audio|video|image|asr|scribe|voyage)/i
    .test(`${model.id} ${model.name ?? ''} ${model.description ?? ''}`));
  const ranked = (usable.length > 0 ? usable : models).map((model) => ({
    model,
    score: (/(?:codex|code|coding)/i.test(`${model.id} ${model.name ?? ''} ${model.description ?? ''}`) ? 100 : 0)
      + (/(?:gpt-5\.6|gpt-5\.5|gpt-5\.4)/i.test(model.id) ? 10 : 0),
  }));
  ranked.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
  return ranked[0]?.model.id;
}

function schedulePatch(params: Record<string, unknown>): UpdateScheduleInput {
  const keys = ['name', 'prompt', 'cronExpr', 'timezone', 'recurring', 'manual', 'intervalMs', 'agentKind', 'model', 'providerId', 'effort', 'fastMode', 'workspaceKind', 'workingDir', 'useWorktree', 'targetSessionId', 'persistentSession', 'silentWhenIdle'] as const;
  const patch: Record<string, unknown> = {};
  for (const key of keys) if (key in params) patch[key] = params[key];
  return patch as UpdateScheduleInput;
}

function templateScheduleFields(template: ScheduleTemplate): Record<string, unknown> {
  return {
    ...(template.providerId ? { providerId: template.providerId } : {}),
    ...(template.effort ? { effort: template.effort } : {}),
    ...(template.fastMode !== undefined ? { fastMode: template.fastMode } : {}),
  };
}

function modelPreferenceKey(agent: HeadlessAgentKind, providerId: string | undefined | null, model: string): string {
  // JSON preserves separators inside user-provided model/provider identifiers.
  return JSON.stringify([agent, providerId ?? null, model]);
}

function modelPreference(
  config: HeadlessConfig,
  agent: HeadlessAgentKind,
  providerId: string | undefined | null,
  model: string,
) {
  return config.modelPreferences?.[modelPreferenceKey(agent, providerId, model)];
}

function goalLimitValue(value: unknown, key: string): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  throw new Error(`${key} must be a number or null`);
}

function goalLimits(value: Record<string, unknown>): { maxTurns: number | null; budgetTokens: number | null; noProgressLimit: number | null } {
  return {
    maxTurns: goalLimitValue(value.maxTurns, 'maxTurns'),
    budgetTokens: goalLimitValue(value.budgetTokens, 'budgetTokens'),
    noProgressLimit: goalLimitValue(value.noProgressLimit, 'noProgressLimit'),
  };
}

function goalUpdate(value: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ('objective' in value) patch.objective = requiredString(value, 'objective');
  for (const key of ['maxTurns', 'budgetTokens', 'noProgressLimit']) {
    if (key in value) patch[key] = goalLimitValue(value[key], key);
  }
  return patch;
}

function stringRecord(value: unknown, key: string): Record<string, string> {
  if (value === undefined) return {};
  const item = record(value);
  if (!item) throw new Error(`${key} must be an object`);
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(item)) {
    if (typeof entry !== 'string') throw new Error(`${key}.${name} must be a string`);
    result[name] = entry;
  }
  return result;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || !item.trim()) throw new Error(`${key} must be a non-empty string`);
  return item;
}

function positiveInt(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}

function nonNegativeInt(value: unknown, key: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  return value;
}

function boundedLimit(value: unknown): number {
  if (value === undefined) return 100;
  return Math.min(positiveInt(value, 'limit'), 1_000);
}

function boundedPaletteCap(value: unknown): number {
  return Math.min(positiveInt(value, 'cap'), 2_000);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : null;
}

function optionalAgentKind(value: unknown): HeadlessAgentKind | null {
  return enumValue(value, ['claude-code', 'codex'] as const);
}

function requiredAgentKind(value: unknown): HeadlessAgentKind {
  const agent = optionalAgentKind(value);
  if (!agent) throw new Error('agentKind must be claude-code or codex');
  return agent;
}

function requiredEffort(value: unknown): HeadlessEffort {
  const effort = enumValue(value, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const);
  if (!effort) throw new Error('effort is invalid');
  return effort;
}

function requiredPermissionMode(value: unknown): HeadlessPermissionMode {
  const permissionMode = enumValue(value, ['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const);
  if (!permissionMode) throw new Error('permissionMode is invalid');
  return permissionMode;
}

function requiredSessionStatus(value: unknown): HeadlessSessionStatus {
  const status = enumValue(value, ['active', 'archived', 'deleted'] as const);
  if (!status) throw new Error('status must be active, archived, or deleted');
  return status;
}

function isoToMs(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('pinnedAt must be an ISO timestamp or null');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('pinnedAt must be a valid ISO timestamp or null');
  return ms;
}

function nullableString(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`${key} must be a non-empty string or null`);
}

const DEFAULT_FIELDS = ['agentKind', 'providerId', 'model', 'effort', 'permissionMode'] as const;
type DefaultField = typeof DEFAULT_FIELDS[number];

function defaultsPatch(params: Record<string, unknown>): Partial<HeadlessDefaults> {
  const patch: Partial<HeadlessDefaults> = {};
  if ('agentKind' in params) patch.agentKind = requiredAgentKind(params.agentKind);
  if ('providerId' in params) patch.providerId = nullableString(params.providerId, 'providerId');
  if ('model' in params) patch.model = nullableString(params.model, 'model');
  if ('effort' in params) patch.effort = requiredEffort(params.effort);
  if ('permissionMode' in params) patch.permissionMode = requiredPermissionMode(params.permissionMode);
  if (Object.keys(patch).length === 0) throw new Error('At least one default field is required');
  return patch;
}

function defaultFields(value: unknown): readonly DefaultField[] {
  if (value === undefined) return DEFAULT_FIELDS;
  if (!Array.isArray(value) || value.length === 0 || value.some((field) => typeof field !== 'string' || !DEFAULT_FIELDS.includes(field as DefaultField))) {
    throw new Error(`fields must be a non-empty array containing only ${DEFAULT_FIELDS.join(', ')}`);
  }
  return value as DefaultField[];
}

function absoluteWorkdir(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('workDir must be an absolute path');
  return path.normalize(value);
}

function deviceCodeConfig(params: Record<string, unknown>) {
  const keys = ['deviceAuthorizationUrl', 'tokenUrl', 'clientId', 'scopes'] as const;
  const supplied = keys.filter((key) => key in params);
  if (supplied.length === 0) return undefined;
  for (const key of ['deviceAuthorizationUrl', 'tokenUrl', 'clientId'] as const) {
    if (!(key in params)) throw new Error(`Device-code provider requires ${key}`);
  }
  return {
    deviceAuthorizationUrl: requiredString(params, 'deviceAuthorizationUrl'),
    tokenUrl: requiredString(params, 'tokenUrl'),
    clientId: requiredString(params, 'clientId'),
    ...(typeof params.scopes === 'string' && params.scopes.trim() ? { scopes: params.scopes } : {}),
  };
}

function parseInteractionDecision(value: unknown): InteractionDecision {
  const decision = record(value);
  if (!decision || typeof decision.kind !== 'string') throw new Error('decision must include a kind');
  if ((decision.kind === 'permission' || decision.kind === 'plan_review') && (decision.behavior === 'allow' || decision.behavior === 'deny')) {
    return decision as InteractionDecision;
  }
  if (decision.kind === 'ask_user_question' && record(decision.answers)) {
    return decision as InteractionDecision;
  }
  throw new Error('Invalid interaction decision');
}

/** Deterministic title fallback for a Linux session without a Desktop renderer. */
function firstMessageTitle(content: unknown): string | null {
  let text = typeof content === 'string' ? content : '';
  if (!text && content && typeof content === 'object') {
    const message = content as { type?: unknown; content?: unknown };
    if (message.type === 'user' && Array.isArray(message.content)) {
      text = message.content
        .map((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '')
        .join(' ');
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? Array.from(normalized).slice(0, 48).join('') : null;
}
