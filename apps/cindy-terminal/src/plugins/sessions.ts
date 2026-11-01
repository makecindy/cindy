import { createPluginTaskReviewContextReader } from '@cindy/app-runtime/pluginTaskReviewContextReader';
import { availableAppDefaultModels } from "@cindy/model-providers/availableTaskModels";
import { resolvePluginWorkerDirectory, assertPluginWorkerDirectoryScope } from '@cindy/plugin-runtime/pluginWorkerDirectory';
import { readTerminalWorkerCompletion } from '../tasks/orca-completion.js';
import type { OrcaWorkerCreationPlanValidator } from '@cindy/orca-workflow/host/orcaWorkerCreationService';
import { ENGINES } from "../models/config.js";
import {
  createPluginTaskService,
  PluginTaskError,
  readPluginTaskPlanReceipt,
  isPluginTaskPermissionAllowed,
  ownsTaskReceipt,
  type PluginTaskService,
  type PluginTaskStore,
} from "@cindy/plugin-runtime/pluginTaskService";
import {
  handlePluginTaskRequest,
  type PLUGIN_TASK_OPERATIONS,
} from "@cindy/plugin-runtime/taskSlot";
import { hasPluginTaskApproval } from "@cindy/plugin-runtime/taskCapability";
import {
  ghostDeclaresHiddenTasks,
  ghostInstallApprovalToken,
} from "@cindy/plugin-runtime/shared/ghost";
import { createPluginTaskReviewResolver } from "@cindy/plugin-runtime/pluginTaskReviewContext";
import type {
  PluginTaskRequest,
  PluginTaskRoute,
  PluginTaskRun,
} from "@cindy/plugin-runtime/shared/pluginTasks";
import type { AutoReviewRequest } from "@cindy/maker-core";
import type { Submission } from "../tasks/storage.js";
import type { TerminalTaskHost } from "../tasks/host.js";
import type { TerminalPlugins } from "./host.js";
import type {
  TerminalPluginSessionHooks,
  TerminalPluginSessionPort,
} from "./session-contract.js";
import { TerminalPluginTaskStore } from "./task-store.js";
import { PluginWriteAccessGate } from "@cindy/plugin-runtime/pluginWriteAccessGate";

const operations: readonly (typeof PLUGIN_TASK_OPERATIONS)[number][] = [
  "capabilities",
  "models",
  "setModel",
  "readMessages",
  "create",
  "list",
  "get",
  "send",
  "getRun",
  "listRuns",
  "cancel",
  "setHidden",
  "requestWriteAccess",
  "setTeamPlan",
  "startTeam",
  "getTeam",
  "releaseWorker",
];
const policy = (value: unknown) =>
  ["ask", "plan", "acceptEdits", "auto"].includes(String(value))
    ? (value as "ask" | "plan" | "acceptEdits" | "auto")
    : "ask";
function fail(code: string, message: string): never {
  throw new PluginTaskError(code, message);
}

/** Host-owned adapter to the same receipt, authorization and dispatch service as
 * Desktop. Sandbox payloads never supply Session ownership or user intent. */
export class TerminalPluginSessions implements TerminalPluginSessionHooks {
  readonly ready: Promise<void>;
  private readonly store: TerminalPluginTaskStore;
  private readonly port: TerminalPluginSessionPort;
  private service?: PluginTaskService;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly writeGate = new PluginWriteAccessGate();
  private writeRequestPending = false;
  constructor(
    private readonly options: {
      root: string;
      host: TerminalPlugins;
      tasks: TerminalTaskHost;
      guard(): void;
      translate?(key: string): string;
    },
  ) {
    this.port = options.tasks.configurePluginSessions(this);
    this.store = new TerminalPluginTaskStore({
      database: options.tasks.database.then(db => db.getDbClient()),
      guard: () => this.guard(),
    });
    this.ready = this.open();
  }
  private guard() {
    if (this.closed) throw new Error("PLUGIN_TASKS_CLOSED");
    this.options.guard();
  }
  private authorized(id: string) {
    this.guard();
    if (!hasPluginTaskApproval(this.options.host.installed(id)))
      fail("PERMISSION_DENIED", "Plugin task capability is unavailable");
  }
  private config(id: string) {
    this.guard();
    return this.options.host.models!.currentConfig(id);
  }
  private async refresh(id: string) {
    this.authorized(id);
    if (!this.options.host.models)
      fail("HOST_NOT_READY", "Plugin model settings are unavailable");
    await this.options.host.models!.config(id);
    this.authorized(id);
  }
  private writeIdentity(id: string) {
    this.authorized(id);
    const ghost = this.options.host.installed(id)!;
    return JSON.stringify([
      ghost.dir,
      ghostInstallApprovalToken(ghost.approval),
    ]);
  }
  private async requestWriteAccess(
    id: string,
    taskId: string,
    mode: "acceptEdits" | "auto",
    explicit = false,
    caller = () => {},
  ) {
    const service = this.service!;
    const task = await service.get(id, taskId),
      config = this.config(id),
      identity = this.writeIdentity(id);
    const check = () => {
      caller();
      if (identity !== this.writeIdentity(id))
        fail("PERMISSION_DENIED", "Plugin installation changed");
    };
    const assertPlan = () => {
      check();
      const live = this.port.live(taskId);
      if (
        live &&
        (!live.stablePlanModeState || live.stablePlanModeState.enabled)
      )
        fail(
          "PERMISSION_DENIED",
          "Exit Plan Mode before requesting write access",
        );
    };
    if (task.status !== "active")
      fail("TASK_BUSY", "Archived tasks cannot request write access");
    assertPlan();
    if (task.planModeEnabled)
      fail(
        "PERMISSION_DENIED",
        "Exit Plan Mode before requesting write access",
      );
    if (
      isPluginTaskPermissionAllowed(
        task.permissionMode,
        config.permissionMode,
      ) &&
      (mode === "auto"
        ? task.permissionMode === "auto"
        : ["acceptEdits", "auto"].includes(task.permissionMode ?? "ask"))
    )
      return { granted: true, task };
    if (this.writeRequestPending)
      fail("TASK_BUSY", "A permission request is already open");
    const assertIdle = async () => {
      if (
        mode === "acceptEdits" &&
        (await service.listRuns(id, taskId)).items.length
      )
        fail("TASK_BUSY", "Only an unstarted task can request write access");
      await this.port.assertIdle(taskId, mode === "acceptEdits", check);
    };
    this.writeRequestPending = true;
    try {
      await this.port.withTaskLock(taskId, assertIdle);
      check();
      return await this.writeGate.request(
        JSON.stringify([id, taskId]),
        identity,
        mode,
        explicit,
        async () => {
          const t = (key: string) =>
            this.options.translate?.(`pluginTaskWriteAccess.${key}`) ?? key;
          const allowed = await this.port.confirmPermission(
            taskId,
            {
              title: t(mode === "auto" ? "autoTitle" : "title"),
              message: t(mode === "auto" ? "autoMessage" : "message").replace(
                "{{name}}",
                this.options.host.installed(id)!.manifest.name,
              ),
              detail: `${task.title}\n\n${t(mode === "auto" ? "autoDetail" : "detail")}`,
            },
            check,
            this.abort.signal,
          );
          if (!allowed) return { granted: false };
          return this.port.withPermissionLock(taskId, () =>
            service.completeOperation(() =>
              this.port.withTaskLock(taskId, async () => {
                check();
                if (JSON.stringify(config) !== JSON.stringify(this.config(id)))
                  fail("PERMISSION_DENIED", "Plugin settings changed");
                const fresh = await service.get(id, taskId);
                if (
                  fresh.status !== "active" ||
                  fresh.revision !== task.revision
                )
                  fail("TASK_BUSY", "Task changed while awaiting permission");
                if (fresh.planModeEnabled)
                  fail(
                    "PERMISSION_DENIED",
                    "Exit Plan Mode before requesting write access",
                  );
                await assertIdle();
                assertPlan();
                await this.port.changePermission(taskId, mode, assertPlan, () =>
                  this.options.host.models!.setPermission(
                    id,
                    mode,
                    config,
                    assertPlan,
                  ),
                );
                check();
                assertPlan();
                return { granted: true, task: await service.get(id, taskId) };
              }),
            ),
          );
        },
      );
    } finally {
      this.writeRequestPending = false;
    }
  }
  async recoverWriteAccess(
    taskId: string,
    retry: boolean,
    current: () => void,
  ) {
    await this.ready;
    current();
    this.guard();
    const row = await (await this.store.get()).get(taskId);
    if (!row || row.operation !== "create")
      return { granted: false, available: false };
    await this.refresh(row.pluginId);
    await this.service!.get(row.pluginId, taskId);
    current();
    const mode = this.writeGate.recoverable(
      JSON.stringify([row.pluginId, taskId]),
      this.writeIdentity(row.pluginId),
    );
    if (!retry || !mode) return { granted: false, available: !!mode };
    const result = await this.requestWriteAccess(
      row.pluginId,
      taskId,
      mode,
      true,
      current,
    );
    return { granted: result.granted, available: !result.granted, mode };
  }
  private capture(id: string) {
    this.authorized(id);
    const ghost = this.options.host.installed(id)!;
    const revision = JSON.stringify([
      ghost.dir,
      ghostInstallApprovalToken(ghost.approval),
      this.config(id),
    ]);
    return () => {
      this.authorized(id);
      const next = this.options.host.installed(id)!;
      if (
        JSON.stringify([
          next.dir,
          ghostInstallApprovalToken(next.approval),
          this.config(id),
        ]) !== revision
      )
        fail("PERMISSION_DENIED", "Plugin configuration changed");
    };
  }
  private async resolve(
    id: string,
    requested?: PluginTaskRoute,
    callId?: string,
  ): Promise<PluginTaskRoute> {
    await this.refresh(id);
    const config = this.config(id),
      selection = { ...config, ...requested };
    const sourceId = callId
      ? this.options.host.native.dispatcher?.getPendingCallSessionId(id, callId)
      : null;
    const source = sourceId
      ? await this.options.tasks.storage.get(sourceId)
      : null;
    this.authorized(id);
    if (
      callId &&
      !source &&
      !(selection.agentKind && selection.providerId && selection.model)
    )
      fail("ROUTE_UNAVAILABLE", "The originating task is unavailable");
    const inherited = source
      ? {
          agentKind:
            source.agentKind === "claude-code"
              ? ("cc" as const)
              : source.agentKind,
          providerId: source.providerId,
          model: source.model,
          effort: source.effort ?? "",
          fastMode: source.fastMode ?? false,
        }
      : {};
    try {
      const route = await this.port.resolve({ ...inherited, ...selection });
      this.authorized(id);
      return route;
    } catch {
      return fail("ROUTE_UNAVAILABLE", "The selected model is unavailable");
    }
  }
  private async open() {
    await Promise.all([this.options.tasks.ready, this.store.ready]);
    this.guard();
    const store = await this.store.get();
    this.service = createPluginTaskService({
      store,
      assertCurrent: () => this.guard(),
      assertAuthorized: (id) => this.authorized(id),
      readPermissionMode: (id) => policy(this.config(id).permissionMode),
      readModelPreference: (id) => {
        const config = this.config(id);
        return {
          ...config,
          inheritedDefault:
            config.agentKind && config.model && config.providerId
              ? undefined
              : JSON.stringify(
                  this.options.tasks.models.snapshot().defaultSelection ?? null,
                ),
        };
      },
      resolveRoute: (...args) => this.resolve(...args),
      setModel: (...args) => this.port.setModel(...args),
      readLiveSession: (id) => this.port.live(id),
      readSession: (id) => this.port.read(id),
      createSession: async (
        id,
        taskId,
        title,
        route,
        isolated,
        requested,
        onPersistenceStarted,
        callId,
        hidden,
        target,
      ) => {
        const current = await this.resolve(id, requested, callId);
        const config = this.config(id),
          check = this.capture(id);
        if (JSON.stringify(current) !== JSON.stringify(route))
          fail("ROUTE_UNAVAILABLE", "Plugin model selection changed");
        await this.port.create(
          {
            id: taskId,
            title,
            route,
            permissionMode: policy(config.permissionMode),
            hidden,
            workingDir:
              target?.workingDir ?? (!isolated ? config.workingDir : undefined),
          },
          () => {
            check();
            target?.assertCurrent();
          },
          onPersistenceStarted,
        );
      },
      assertHiddenTasksAllowed: (id) => {
        this.authorized(id);
        if (
          !ghostDeclaresHiddenTasks(this.options.host.installed(id)?.manifest)
        )
          fail(
            "PERMISSION_DENIED",
            "Background tasks require agent.hiddenTasks",
          );
      },
      setHidden: (...args) => this.port.hidden(...args),
      revealPluginTasks: async (id) => {
        let cursor = "";
        for (;;) {
          const rows = await store.list(id, "create", null, cursor, 100);
          this.guard();
          for (const row of rows) {
            const task = await this.port.read(row.id);
            if (task?.hidden)
              await this.port.hidden(row.id, false, () => this.guard());
          }
          if (rows.length < 100) break;
          cursor = rows.at(-1)!.id;
        }
      },
      dispatch: async (id, taskId, clientId, text, images = []) => {
        const check = this.capture(id);
        return this.port.dispatch(
          { id, name: this.options.host.installed(id)!.manifest.name },
          taskId,
          clientId,
          text,
          images,
          check,
        );
      },
      inspect: (id) => this.port.inspect(id),
      assertTeamPlanUnstarted: taskId => this.port.assertIdle(taskId, true, () => this.guard()),
      cancel: async (id, taskId, clientIds, execution) =>
        this.port.cancel(taskId, clientIds, execution, this.capture(id)),
    });
  }
  async targetStore() { await this.ready; this.guard(); return this.store.targets(); }
  async createTarget(pluginId: string, taskId: string, project: string, title: string, route: PluginTaskRoute | undefined, guard: () => void) {
    await this.ready; await this.refresh(pluginId); guard();
    await this.service!.create(pluginId, { requestKey: `target-project:${taskId}`, title, route }, { taskId, workingDir: project, assertCurrent: guard });
    guard();
  }
  async receive(id: string, value: unknown) {
    await this.ready;
    this.guard();
    return handlePluginTaskRequest(id, value, {
      getGhost: (key) => this.options.host.installed(key),
      isCurrent: () => !this.closed,
      operations,
      sourceCallContext: true,
      handler: async (key, request) => {
        await this.refresh(key);
        return this.handle(key, request);
      },
    });
  }
  async models(): Promise<
    Array<{
      id: string;
      label: string;
      route: PluginTaskRoute;
      efforts: readonly string[];
      supportsFastMode: boolean;
      supportsUltrafastMode: boolean;
    }>
  > {
    this.guard();
    const views = await this.options.tasks.models.views();
    const available = await Promise.all(
      ENGINES.map(
        async (kind) =>
          [kind, await this.options.tasks.isAgentAvailable(kind)] as const,
      ),
    );
    this.guard();
    return availableAppDefaultModels({
      providers: views,
      availableAgents: new Set(
        available
          .filter(([, ready]) => ready)
          .map(([kind]) => (kind === "claude-code" ? "cc" : kind)),
      ),
      enabled: (kind, providerId, model) => {
        const provider = views.find((p) => p.id === providerId);
        return (
          provider?.models[kind]?.some(
            (candidate) =>
              candidate.id === model.id &&
              !candidate.disabled &&
              (provider.source === "user" ||
                candidate.defaultEnabled !== false),
          ) === true
        );
      },
    }).map((option) => ({
      id: option.id,
      label: [
        views.find((p) => p.id === option.route.providerId)?.name ??
          option.route.providerId,
        { claude: "Claude Code", codex: "Codex", pi: "Pi" }[
          option.route.harness
        ],
        views
          .find((p) => p.id === option.route.providerId)
          ?.models[
            option.route.harness === "claude"
              ? "claude-code"
              : option.route.harness
          ]?.find((model) => model.id === option.route.model)?.name ??
          option.route.model,
      ].join(" / "),
      route: {
        agentKind:
          option.route.harness === "claude" ? "cc" : option.route.harness,
        providerId: option.route.providerId!,
        model: option.route.model,
        effort: option.route.effort,
        fastMode: option.route.fastMode,
      },
      efforts: option.efforts,
      supportsFastMode: option.supportsFastMode,
      supportsUltrafastMode: option.supportsUltrafastMode,
    }));
  }
  private async handle(
    id: string,
    request: PluginTaskRequest,
  ): Promise<unknown> {
    const service = this.service!;
    switch (request.kind) {
      case 'startTeam': return service.completeOperation(() => this.port.withTaskLock(request.taskId, async () => {
        const task = await service.get(id, request.taskId), check = this.capture(id);
        const authority = await this.captureOrcaAuthority(request.taskId);
        const admission = (value: typeof task) => JSON.stringify([value.resolvedConfig, value.permissionMode, value.planModeEnabled, value.workingDir, value.status]);
        const expected = admission(task);
        const current = async () => {
          check(); await authority.assertCurrent();
          const fresh = await service.get(id, request.taskId);
          check();
          if (admission(fresh) !== expected) fail('STALE_REVISION', 'Task changed during team activation');
        };
        await current();
        const result = await this.options.tasks.orcaLifecycle.startTeam({ leadSessionId: request.taskId }, current);
        if (!result.ok) fail(result.errorCode, result.message);
        return result;
      }));
      case 'getTeam': {
        const host = this.options.tasks, check = this.capture(id);
        await service.get(id, request.taskId);
        const team = await host.orcaTools.api.getWorkspaceInfo({ leadSessionId: request.taskId });
        if (!team.ok) fail('HOST_NOT_READY', 'Collaboration state unavailable');
        const workers = await Promise.all(team.workers.map(async worker => {
          const completion = await readTerminalWorkerCompletion(host, worker.session_id, worker.status);
          const row = completion.row;
          return { ...worker, acceptedAt: completion.acceptedAt, startedAt: completion.firstActivityAt, timingBasis: 'host-message-window',
            createdAt: row.createdAt, lastTurnStartedAt: completion.startedAt, lastTurnEndedAt: completion.endedAt,
            waitingForUser: !!this.port.live(worker.session_id)?.getTurnControlSnapshot().pendingInteractionCount,
            usage: { scope: 'session-total', tokens: row.totalTokenUsage ?? null,
              costUSD: row.totalCostCurrency === 'USD' && row.totalCostAmount > 0 ? row.totalCostAmount : null,
              approximate: row.totalCostIsApproximate ?? false,
              reason: row.totalCostCurrency === 'USD' && row.totalCostAmount > 0 ? null : 'No confirmed USD cost; subscription value and other currencies are not a bill' },
            status: completion.status, permissionMode: row.permissionMode, providerId: row.providerId, fastMode: row.fastMode, completedAt: completion.completedAt };
        }));
        const receipt = await (await this.store.get()).get(request.taskId), plan = receipt ? readPluginTaskPlanReceipt(receipt.payload).teamPlan : undefined;
        const occupiedSlots = team.workflow ? await host.orcaStore.occupiedSlots(team.workflow.workflow_id) : 0;
        const hardLimit = Math.min(host.orcaStore.settings().workerHardLimit, plan?.concurrency ?? Infinity);
        const lead = await host.storage.get(request.taskId), pending = await host.storage.queued(request.taskId);
        const waitingForUser = !!this.port.live(request.taskId)?.getTurnControlSnapshot().pendingInteractionCount;
        await service.get(id, request.taskId); check();
        return { ...team, workers, capacity: { hardLimit, occupiedSlots, remainingSlots: Math.max(0, hardLimit - occupiedSlots), advisory: true },
          coordinatorUsage: { scope: 'session-total', tokens: lead?.usage?.tokenUsage ?? null, costUSD: null, approximate: false },
          waitingForUser, leadWorking: host.isTurnRunning(request.taskId) || waitingForUser || pending.length > 0 };
      }
      case 'releaseWorker': return service.completeOperation(async () => {
        const host = this.options.tasks, check = this.capture(id);
        await service.get(id, request.taskId);
        const record = await host.orcaStore.workerForLead(request.taskId, request.workerId);
        if (!record) fail('TASK_NOT_FOUND', 'Worker not found');
        const receipt = await (await this.store.get()).get(request.taskId), plan = receipt ? readPluginTaskPlanReceipt(receipt.payload).teamPlan : undefined;
        if (plan && !plan.items.some(item => item.label === record.label)) fail('INVALID_REQUEST', 'Worker is not in team plan');
        const validate = async () => {
          check(); await service.get(id, request.taskId);
          const latest = await host.orcaStore.workerForLead(request.taskId, request.workerId);
          if (!latest || latest.sessionId !== record.sessionId) fail('TASK_NOT_FOUND', 'Worker not found');
          const completion = await readTerminalWorkerCompletion(host, record.sessionId, latest.status);
          check(); await service.get(id, request.taskId);
          if (completion.completedAt === null || completion.completedAt !== request.completedAt) fail('STALE_REVISION', 'Worker has no matching successful completion');
        };
        const row = await host.storage.get(record.sessionId);
        if (row?.archived) {
          await validate();
          if (plan) await service.settleWorkerLabel(id, request.taskId, record.label!);
          return { ok: true, workerId: record.id };
        }
        const result = await host.orcaTeamService.archiveWorker({ callerLeadSessionId: request.taskId, workerId: record.id, onlyIfIdle: true, beforeArchive: validate });
        if (!result.ok) fail(result.errorCode, result.message);
        if (plan) await service.settleWorkerLabel(id, request.taskId, record.label!);
        return result;
      });
      case 'setTeamPlan': return this.port.withTaskLock(request.taskId, async () => {
        const task = await service.get(id, request.taskId);
        const config = this.config(id), current = this.capture(id);
        const items = [];
        for (const item of request.plan.items) {
          const workingDir = await resolvePluginWorkerDirectory({
            requested: item.workingDir, leadDirectory: task.workingDir,
            configuredDirectory: config.workingDir,
            // Directory handover tickets are scoped to one call, not persistent picker grants.
            isPickedDirectory: () => false, assertCurrent: current,
          });
          items.push({ ...item, workingDir });
        }
        const fresh = await service.get(id, request.taskId);
        current();
        if (fresh.revision !== task.revision) fail('STALE_REVISION', 'Task changed during directory validation');
        return service.setTeamPlan(id, request.taskId, { ...request.plan, items });
      });
      case "requestWriteAccess":
        return this.requestWriteAccess(
          id,
          request.taskId,
          request.mode ?? "acceptEdits",
        );
      case "models": {
        const models = await this.models();
        this.authorized(id);
        return { models };
      }
      case "readMessages": {
        await service.get(id, request.taskId);
        let cursor = null;
        if (request.after) {
          try {
            cursor = JSON.parse(request.after);
            if (
              !cursor ||
              typeof cursor.id !== "string" ||
              !Number.isSafeInteger(cursor.createdAt) ||
              (cursor.rowid !== undefined &&
                !Number.isSafeInteger(cursor.rowid))
            )
              throw new Error();
          } catch {
            fail("INVALID_REQUEST", "Invalid message cursor");
          }
        }
        const page = (await this.options.tasks.invoke(
          "local-db:history:messages",
          [
            {
              sessionId: request.taskId,
              workdir: null,
              fromMs: null,
              toMs: null,
              agentKind: null,
              roles: null,
              includeRewound: false,
              limit: request.limit ?? 50,
              cursor,
              order: "asc",
            },
          ],
        )) as {
          items: Array<{
            id: string;
            clientId?: string;
            role: string;
            content: unknown;
            createdAt: number;
          }>;
          nextCursor: unknown;
        };
        await service.get(id, request.taskId);
        this.authorized(id);
        return {
          items: page.items.map(
            ({ id, clientId, role, content, createdAt }) => ({
              id: clientId ?? id,
              role,
              content,
              createdAt,
            }),
          ),
          nextCursor: page.nextCursor ? JSON.stringify(page.nextCursor) : null,
        };
      }
      case "setModel":
        return service.setModel(id, request);
      case "create":
        return service.create(id, request);
      case "get":
        return service.get(id, request.taskId);
      case "list":
        return service.list(id, request.after, request.limit);
      case "send":
        return service.send(id, request);
      case "getRun":
        return service.getRun(id, request.runId);
      case "listRuns":
        return service.listRuns(
          id,
          request.taskId,
          request.after,
          request.limit,
        );
      case "cancel":
        return service.cancel(id, request.runId);
      case "setHidden":
        return service.setHidden(id, request);
      default:
        return Promise.reject(
          new PluginTaskError(
            "UNSUPPORTED_CAPABILITY",
            "Task operation is unavailable",
          ),
        );
    }
  }
  async assertDispatch(id: string, taskId: string) {
    await this.ready;
    await this.refresh(id);
    await this.service!.assertDispatch(id, taskId);
  }
  async captureOrcaAuthority(taskId: string, acceptedInputId?: string) {
    await this.ready;
    const store = await this.store.get(), receipt = await store.get(taskId);
    const input = acceptedInputId ? await this.options.tasks.storage.submission(taskId, acceptedInputId) : undefined;
    const owner = receipt && ownsTaskReceipt(receipt, receipt.pluginId) ? receipt.pluginId : null;
    // A pending/retried plugin input cannot become an owner command after uninstall.
    if (input?.plugin && input.plugin.id !== owner) fail('PERMISSION_DENIED', 'Plugin input ownership changed');
    if (receipt?.operation === 'create' && !owner && (input || this.port.live(taskId)?.isTurnRunning())) {
      // A revoked plugin turn cannot become an owner command because its
      // runtime survived uninstall. Only a new host-stamped human input can.
      const history = await this.port.history(taskId);
      const accepted = input ? history.find(row => row.clientId === input.requestId) : undefined;
      const meta = accepted?.agentMeta;
      const authored = meta?.autoReviewUserText;
      if (!accepted || input?.plugin || input?.collaboration || meta?.origin || !['turn', 'steer'].includes(String(meta?.delivery))
        || typeof authored !== 'string' || !authored.trim() || authored.startsWith('[UI_ACTION_TRIGGER]')) {
        fail('PERMISSION_DENIED', 'Orca input provenance unavailable');
      }
    }
    const check = owner ? this.capture(owner) : () => this.guard();
    const assertCurrent = async () => {
      check();
      const latest = await store.get(taskId);
      const nextOwner = latest && ownsTaskReceipt(latest, latest.pluginId) ? latest.pluginId : null;
      if (nextOwner !== owner) fail('PERMISSION_DENIED', 'Orca task ownership changed');
      if (owner) {
        const task = await this.service!.get(owner, taskId);
        check();
        if (task.status !== 'active' || task.planModeEnabled || task.permissionMode !== 'auto' || this.config(owner).permissionMode !== 'auto') {
          fail('PERMISSION_DENIED', 'Authorize Auto for the plugin coordinator before creating Workers');
        }
      }
      check();
    };
    await assertCurrent();
    return { ...(owner ? { permissionMode: 'auto' as const } : {}), assertCurrent };
  }
  isWorkerLabelLockedByPlan = async ({ leadSessionId, labels }: { leadSessionId: string; labels: string[] }) => {
    await this.ready;
    const receipt = await (await this.store.get()).get(leadSessionId);
    const plan = receipt ? readPluginTaskPlanReceipt(receipt.payload).teamPlan : undefined;
    return plan?.items.some(item => labels.includes(item.label)) ?? false;
  };
  validateWorkerPlan: OrcaWorkerCreationPlanValidator = async (params, resolvedDirectory, resolvedRoute, current) => {
    await this.ready;
    const store = await this.store.get(), receipt = await store.get(params.leadSessionId);
    await current?.();
    if (!receipt || receipt.operation !== 'create' || !ownsTaskReceipt(receipt, receipt.pluginId)) return undefined;
    const id = receipt.pluginId, authority = await this.captureOrcaAuthority(params.leadSessionId);
    const task = await this.service!.get(id, params.leadSessionId), config = this.config(id), check = this.capture(id);
    if (params.executionDeviceId !== undefined) fail('PERMISSION_DENIED', 'Plugin-owned tasks cannot create Workers on another device');
    const lead = await this.options.tasks.storage.get(params.leadSessionId);
    if (params.agentDeviceId && params.agentDeviceId !== lead?.agentDeviceId) fail('PERMISSION_DENIED', 'Plugin-owned tasks cannot change the Worker Agent location');
    const resolve = (requested: string) => resolvePluginWorkerDirectory({ requested, leadDirectory: task.workingDir,
      configuredDirectory: config.workingDir, isPickedDirectory: () => false, assertCurrent: check });
    const directory = await resolve(params.workingDir ?? task.workingDir ?? '');
    if (resolvedDirectory !== undefined && directory !== await resolve(resolvedDirectory)) fail('PERMISSION_DENIED', 'Worker directory changed');
    await this.service!.get(id, params.leadSessionId);
    const latest = await store.get(params.leadSessionId);
    if (!latest || !ownsTaskReceipt(latest, id)) fail('PERMISSION_DENIED', 'Task ownership changed');
    const data = readPluginTaskPlanReceipt(latest!.payload), item = data.teamPlan?.items.find(item => item.label === params.label);
    const plannedDirectory = item && resolvedRoute ? await resolve(item.workingDir) : undefined;
    const fresh = await this.service!.get(id, params.leadSessionId);
    await authority.assertCurrent(); await current?.(); check();
    if (fresh.revision !== task.revision) fail('STALE_REVISION', 'Task changed during Worker admission');
    assertPluginWorkerDirectoryScope({ requested: directory, leadDirectory: fresh.workingDir,
      configuredDirectory: this.config(id).workingDir, isPickedDirectory: () => false });
    if (!data.teamPlan) return undefined;
    if (!item || data.settledLabels?.includes(params.label)) fail('INVALID_REQUEST', 'Worker is not pending in the registered plan');
    if (resolvedRoute && (directory !== plannedDirectory || resolvedRoute.model !== item!.route.model
      || resolvedRoute.providerId !== item!.route.providerId || (resolvedRoute.effort ?? '') !== item!.route.effort
      || resolvedRoute.fastMode !== item!.route.fastMode || params.agent !== (item!.route.agentKind === 'cc' ? 'claude-code' : item!.route.agentKind))) {
      fail('INVALID_REQUEST', 'Worker configuration differs from registered plan');
    }
    return data.teamPlan.concurrency;
  };
  async accept(
    id: string,
    taskId: string,
    clientId: string,
    execution: Parameters<PluginTaskService["accept"]>[2],
  ) {
    await this.assertDispatch(id, taskId);
    await this.service!.accept(taskId, { clientId }, execution);
  }
  async onSubmission(receipt: Submission) {
    if (
      this.closed ||
      !this.service ||
      !["completed", "failed", "interrupted"].includes(receipt.status)
    )
      return;
    const store = await this.store.get();
    for (const row of await store.forSession(receipt.sessionId)) {
      const run = JSON.parse(row.payload) as PluginTaskRun;
      if (
        run.inputMessageId !== receipt.requestId &&
        !run.inputClientIds?.includes(receipt.requestId)
      )
        continue;
      if (run.execution)
        await this.service.settle(
          receipt.sessionId,
          run.execution,
          receipt.status === "interrupted"
            ? receipt.error === "INPUT_STOPPED"
              ? "cancelled"
              : "interrupted"
            : (receipt.status as "completed" | "failed"),
        );
      else
        await this.service.discard(
          receipt.sessionId,
          { clientId: receipt.requestId },
          receipt.status === "interrupted" ? "cancelled" : "failed",
        );
    }
  }
  async review(request: AutoReviewRequest) {
    await this.ready;
    const database = await this.options.tasks.database;
    return createPluginTaskReviewResolver(createPluginTaskReviewContextReader({
      getCurrentDbClientSnapshot: () => { this.guard(); return database.getCurrentDbClientSnapshot(); },
      drainPersistQueue: async () => {
        await this.options.tasks.storage.flush();
        await (await this.options.tasks.conversations).persistence.drainPersistQueue();
      },
      assertTaskOwnership: async (pluginId, taskId) => {
        await this.refresh(pluginId);
        return this.service!.get(pluginId, taskId);
      },
      readPluginTaskConfig: id => ({ permissionMode: policy(this.config(id).permissionMode) }),
      isPluginTaskAuthorized: id => { this.guard(); return hasPluginTaskApproval(this.options.host.installed(id)); },
      pluginTaskAuthorizationRevision: id => {
        this.guard();
        const ghost = this.options.host.installed(id);
        return hasPluginTaskApproval(ghost) ? JSON.stringify([ghost!.dir, ghostInstallApprovalToken(ghost!.approval)]) : null;
      },
    }))(request);
  }
  async withUninstall(id: string, remove: () => Promise<void>) {
    await this.ready;
    await this.service!.withUninstall(id, remove);
  }
  /** Owner transparency remains available when a plugin is disabled. */
  async background(id: string) {
    await this.ready;
    this.guard();
    if (!this.options.host.installed(id)) throw new Error("PLUGIN_NOT_FOUND");
    const store = await this.store.get(),
      items = [];
    let cursor = "";
    for (;;) {
      const rows = await store.list(id, "create", null, cursor, 100);
      this.guard();
      for (const row of rows) {
        if (row.payload !== "" && !ownsTaskReceipt(row, id)) continue;
        const task = await this.options.tasks.storage.get(row.id);
        this.guard();
        if (
          task?.source === "plugin" &&
          task.hiddenAt != null &&
          !task.deleted &&
          !task.agentDeviceId
        )
          items.push({
            taskId: task.id,
            title: task.title ?? "",
            status: task.archived ? ("archived" as const) : ("active" as const),
            updatedAt: task.updatedAt,
            running: this.options.tasks.isTurnRunning(task.id),
          });
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.id;
    }
    if (!this.options.host.installed(id)) throw new Error("PLUGIN_NOT_FOUND");
    return items.sort(
      (a, b) => b.updatedAt - a.updatedAt || b.taskId.localeCompare(a.taskId),
    );
  }
  async revealBackground(id: string, taskId: string, current: () => void) {
    await this.ready;
    const check = () => {
      this.guard();
      current();
      if (!this.options.host.installed(id)) throw new Error("PLUGIN_NOT_FOUND");
    };
    check();
    await this.port.withTaskLock(taskId, async () => {
      const receipt = await (await this.store.get()).get(taskId);
      check();
      if (!ownsTaskReceipt(receipt, id)) return;
      const task = await this.port.read(taskId);
      check();
      if (task?.hidden && task.status !== "deleted")
        await this.port.hidden(taskId, false, check);
    });
  }
  async relocate(from: string, to: string) {
    await this.ready;
    await this.service!.relocatePlugin(from, to);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    await this.ready.catch(() => {});
    await this.service?.drain();
    await this.store.close();
  }
}
