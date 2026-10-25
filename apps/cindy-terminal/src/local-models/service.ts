import {
  purgeCancelledOllamaPull,
  waitForIncompleteBlobsToSettle,
} from "@cindy/model-providers/local-runtime/ollamaPurge";
import { modelDisableKey } from "@cindy/model-providers";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  RemoteResource,
  RemoteResourceRegistry,
  RemoteActionDescriptor,
} from "@cindy/device-link";
import { createDownloadService } from "@cindy/plugin-runtime/download/index";
import {
  MANAGED_OLLAMA_PROVIDER_ID,
  matchesManagedOllamaFingerprint,
  normalizeOllamaPullName,
  type LocalRuntimeInstallProgress,
} from "@cindy/model-providers/localModelRuntime";
import { createManagedOllamaProvider } from "@cindy/model-providers/local-runtime/managedOllamaProvider";
import { supportsManagedOllamaInstall } from "@cindy/model-providers/local-runtime/ollamaRelease";
import { createOllamaRuntime } from "@cindy/model-providers/local-runtime/ollamaRuntime";
import { createOllamaInstall } from "@cindy/model-providers/local-runtime/ollamaInstall";
import {
  createOllamaSidecar,
  findInstalledSidecarBinary,
} from "@cindy/model-providers/local-runtime/ollamaSidecar";
import { detectLocalConnectPresets } from "@cindy/model-providers/local-runtime/localConnectDetect";
import {
  createLocalModelService,
  PullAbortedError,
  type LocalModelListResult,
  type LocalModelServiceDeps,
} from "@cindy/model-providers/local-runtime/service";
import type { TerminalModelConfig } from "../models/config.js";
import { localModelText as t } from "./text.js";
import { extractLinuxOllama } from "./archive.js";
import { TerminalLlamaCpp } from "./llamacpp.js";
import { localModelErrorCode } from "./errors.js";
import { MANAGED_LLAMACPP_PROVIDER_ID } from "@cindy/model-providers/llamaCpp";

export interface LocalModelJob {
  id: string;
  operation: string;
  state: "running" | "completed" | "failed" | "paused" | "cancelled";
  error?: string;
}
export class TerminalLocalModels {
  readonly service;
  readonly managed;
  readonly llamaCpp: TerminalLlamaCpp;
  private readonly sidecar: ReturnType<typeof createOllamaSidecar>;
  private readonly controller = new AbortController();
  private readonly work = new Set<Promise<void>>();
  private readonly jobs = new Map<string, LocalModelJob>();
  private installProgress?: LocalRuntimeInstallProgress;
  private changedTimer?: ReturnType<typeof setTimeout>;
  private modelsChanged = false;
  private unregister?: () => void;
  private snapshot?: { at: number; value: LocalModelListResult };
  private reading?: Promise<LocalModelListResult>;
  constructor(
    private readonly options: {
      root: string;
      models: TerminalModelConfig;
      assertCurrent(): void;
      changed(modelsChanged?: boolean): void;
      log: {
        info(message: string, fields?: Record<string, unknown>): void;
        warn(message: string, fields?: Record<string, unknown>): void;
      };
      /** Host I/O ports; production always uses the same loopback runtime contract. */
      deps?: LocalModelServiceDeps;
      runtimeDiagnostic?(message: string): void;
      llamaCppDeps?: ConstructorParameters<typeof TerminalLlamaCpp>[0]["deps"];
    },
  ) {
    const { models } = options;
    const modelsDir = () => path.join(options.root, "ollama-models");
    this.sidecar = createOllamaSidecar({
      onDiagnostic: options.runtimeDiagnostic,
      env: () => ({
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key.toUpperCase() !== "CINDY_GITHUB_API_TOKEN",
          ),
        ),
        OLLAMA_MODELS: modelsDir(),
      }),
    });
    const read = async (id: string) => {
      this.current();
      return models.snapshot().providers.find((p) => p.id === id) ?? null;
    };
    this.managed = createManagedOllamaProvider({
      getCustomProvider: read,
      createCustomProvider: async (config) => {
        await models.saveProvider(config, {}, true, () => this.current());
        return (await read(config.id))!;
      },
      updateCustomProvider: async (id, config) => {
        if (!(await read(id))) return null;
        await models.saveProvider(config, {}, false, () => this.current());
        return read(id);
      },
    });
    const runtime = createOllamaRuntime({
      log: options.log,
      findInstalledSidecarBinary,
      spawnManagedSidecar: (binary) => this.sidecar.spawnManagedSidecar(binary),
    });
    const install = createOllamaInstall({
      ...createDownloadService(),
      extractArchive: (archive, destination, platform, signal) =>
        platform === "linux"
          ? extractLinuxOllama(archive, destination, signal)
          : install.extractOfficialArchive(
              archive,
              destination,
              platform,
              signal,
            ),
    });
    const binary = () => {
      const managed = findInstalledSidecarBinary(options.root);
      if (managed) return managed;
      const name = process.platform === "win32" ? "ollama.exe" : "ollama";
      const dirs = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean);
      const candidates = dirs.map((dir) => path.join(dir, name));
      if (process.platform === "darwin")
        candidates.push(
          "/Applications/Ollama.app/Contents/Resources/ollama",
          "/usr/local/bin/ollama",
          "/opt/homebrew/bin/ollama",
        );
      if (process.platform === "win32")
        candidates.push(...runtime.windowsOfficialOllamaBinaries());
      return (
        candidates.find((file) => path.isAbsolute(file) && existsSync(file)) ??
        null
      );
    };
    this.service = createLocalModelService(
      {
        userDataDir: options.root,
        modelsDir,
        // An externally running Ollama may use a different store. Its API remains
        // authoritative; filesystem cleanup is limited to this owned sidecar.
        purgeCancelledPull: async (opts) =>
          this.sidecar.managedSidecarRunning()
            ? purgeCancelledOllamaPull({ modelsDir: modelsDir(), ...opts })
            : undefined,
        waitForCancelledBlobs: async (opts) => {
          if (this.sidecar.managedSidecarRunning())
            await waitForIncompleteBlobsToSettle({
              modelsDir: modelsDir(),
              ...opts,
            });
        },
        getLocalCatalog: () => models.localCatalog(),
        ...options.deps,
        beforeInstalledRuntimeStart: () =>
          this.sidecar.stopManagedSidecarAndWait(),
        runtime: {
          ...options.deps?.runtime,
          headless: true,
          installedBinary: binary,
          sidecarRunning: () => this.sidecar.managedSidecarRunning(),
          signal: this.controller.signal,
        },
        onStatus: (status) => {
          options.deps?.onStatus?.(status);
          this.changed();
        },
        onPullProgress: (progress) => {
          options.deps?.onPullProgress?.(progress);
          this.changed();
        },
        onInstallProgress: (progress) => {
          this.installProgress = progress;
          options.deps?.onInstallProgress?.(progress);
          this.changed();
        },
      },
      {
        managedProvider: this.managed,
        runtime,
        install,
        detectLocalConnectPresets,
        log: options.log,
      },
    );
    this.llamaCpp = new TerminalLlamaCpp({
      ...options,
      deps: options.llamaCppDeps,
    });
    models.connectLocalContext({validate: (targets, limit) => this.llamaCpp.validateContext(targets, limit), configure: run => this.llamaCpp.configureContext(run)});
    models.connectLocalRuntime({
      prepare: (id) => this.prepare(id),
      remove: (id, remove) =>
        id === MANAGED_LLAMACPP_PROVIDER_ID
          ? this.llamaCpp.remove(remove)
          : remove(),
      removed: (id) => {
        if (id === MANAGED_OLLAMA_PROVIDER_ID)
          this.managed.markManagedOllamaRemoved();
      },
    });
  }
  private current() {
    this.controller.signal.throwIfAborted();
    this.options.assertCurrent();
  }
  private changed(modelsChanged = false) {
    try {
      this.current();
    } catch {
      return;
    }
    this.modelsChanged ||= modelsChanged;
    if (this.changedTimer) return;
    // Byte-based downloader progress can fire much faster than network UI
    // refresh. Keep only the latest state, not one notification per chunk.
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined;
      const changed = this.modelsChanged;
      this.modelsChanged = false;
      try {
        this.current();
        this.options.changed(changed);
      } catch {
        /* Retired owner cannot publish. */
      }
    }, 250);
    this.changedTimer.unref();
  }
  private owner() {
    return {
      ownerStillActive: () => {
        try {
          this.current();
          return true;
        } catch {
          return false;
        }
      },
    };
  }
  private async list(): Promise<LocalModelListResult> {
    this.current();
    if (this.snapshot && Date.now() - this.snapshot.at < 2000)
      return { ...this.snapshot.value, pulls: this.service.activePulls() };
    if (!this.reading)
      this.reading = this.service
        .list(this.owner())
        .then((value) => {
          this.current();
          this.snapshot = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          this.reading = undefined;
        });
    return this.reading;
  }
  async prepare(providerId: string): Promise<void> {
    if (providerId === MANAGED_LLAMACPP_PROVIDER_ID)
      return this.llamaCpp.prepare();
    if (providerId !== MANAGED_OLLAMA_PROVIDER_ID) return;
    this.current();
    const config = await this.managed.readManagedOllamaProvider();
    if (
      !config ||
      !matchesManagedOllamaFingerprint({
        id: config.id,
        authMethod: config.auth?.method,
        runtimes: config.runtimes,
      })
    )
      throw new Error("LOCAL_OLLAMA_PROVIDER_CHANGED");
    const status = await this.service.start();
    this.current();
    if (status.kind !== "ready") throw new Error("LOCAL_OLLAMA_NOT_READY");
  }
  register(registry: RemoteResourceRegistry) {
    this.unregister = registry.register({
      collection: {
        id: "local-models",
        resourceKind: "local-model",
        title: t.title,
        placement: "settings",
      },
      list: async (context, request) => {
        this.current();
        context.assertCurrent?.();
        const value = await this.list();
        this.current();
        context.assertCurrent?.();
        const names = [
          ...new Set(
            [
              ...value.models.map((m) => m.name),
              ...value.pulls.map((p) => p.name),
              ...this.jobs.keys(),
            ].filter((name) => name !== "ollama"),
          ),
        ];
        let items = [
          this.resource("ollama", value),
          ...(await this.llamaCpp.resources()),
          ...names.map((name) => this.resource(name, value)),
          ...value.catalog
            .filter((m) => !names.includes(m.libraryName))
            .map((m) => this.resource(m.libraryName, value)),
        ];
        if (request.query)
          items = items.filter((item) =>
            JSON.stringify(item.display)
              .toLowerCase()
              .includes(request.query!.toLowerCase()),
          );
        const offset = request.cursor ? Number(request.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error("INVALID_RESOURCE_CURSOR");
        const limit = Math.max(1, Math.min(100, request.limit ?? 100)),
          page = items.slice(offset, offset + limit);
        return {
          collectionId: "local-models",
          revision: String(this.options.models.revision()),
          items: page,
          ...(offset + limit < items.length
            ? { nextCursor: String(offset + limit) }
            : {}),
        };
      },
      get: async (context, request) => {
        this.current();
        context.assertCurrent?.();
        if (
          request.ref.id === "llamacpp" ||
          request.ref.id.startsWith("llamacpp:")
        ) {
          const resource = (await this.llamaCpp.resources()).find(
            (item) => item.ref.id === request.ref.id,
          );
          this.current();
          context.assertCurrent?.();
          if (!resource) throw new Error("RESOURCE_NOT_FOUND");
          return resource;
        }
        const value = await this.list();
        this.current();
        context.assertCurrent?.();
        return this.resource(request.ref.id, value);
      },
      invoke: async (context, request) => {
        this.current();
        context.assertCurrent?.();
        const id = request.resourceRef?.id;
        if (!id) throw new Error("RESOURCE_ID_REQUIRED");
        if (id === "llamacpp" || id.startsWith("llamacpp:")) {
          const result = await this.llamaCpp.invoke(
            id,
            request.actionId,
            request.input,
            () => context.assertCurrent?.(),
          );
          this.current();
          context.assertCurrent?.();
          return result;
        }
        const resource = this.resource(id, await this.list());
        this.current();
        context.assertCurrent?.();
        const action = resource.actions?.find((a) => a.id === request.actionId);
        if (!action || action.disabled)
          throw new Error("ACTION_NOT_AVAILABLE_ON_TARGET");
        const name =
          id === "ollama"
            ? this.modelName((request.input as { name?: unknown })?.name)
            : this.modelName(id);
        const operation = request.actionId;
        if (operation === "download" && !name)
          throw new Error("INVALID_MODEL_NAME");
        if (operation === "pause" || operation === "cancel") {
          if (operation === "cancel" && id === "ollama")
            await this.service.abortInstall();
          else if (operation === "cancel")
            await this.service.discardPaused(name);
          else await this.service.abortPull("pause", name);
          this.snapshot = undefined;
          this.current();
          this.changed();
          return {
            effects: [
              { kind: "refresh-collection", collectionId: "local-models" },
            ],
            result: { ok: true },
          };
        }
        const key =
          id === "ollama" && operation !== "download" ? "ollama" : name;
        const job = this.begin(key, operation, async () => {
          if (operation === "stop" || operation === "restart") {
            await Promise.all(
              this.service
                .activePulls()
                .filter((p) => !p.done)
                .map((p) => this.service.abortPull("pause", p.name)),
            );
            this.current();
            await this.sidecar.stopManagedSidecarAndWait();
            this.current();
            if (
              operation === "restart" &&
              (await this.service.start()).kind !== "ready"
            )
              throw new Error("LOCAL_OLLAMA_NOT_READY");
          } else if (operation === "install" || operation === "start") {
            const status = await (operation === "install"
              ? this.service.installRuntime()
              : this.service.start());
            this.current();
            if (status.kind !== "ready")
              throw new Error("LOCAL_OLLAMA_NOT_READY");
            const result = await this.service.ensureProvider(this.owner());
            if (!result.ok) throw new Error(result.code);
          } else if (operation === "download" || operation === "resume") {
            const status = await this.service.start();
            this.current();
            if (status.kind !== "ready")
              throw new Error("LOCAL_OLLAMA_NOT_READY");
            await this.service.pull(name, this.owner());
          } else if (operation === "enable" || operation === "disable") {
            if (operation === "enable") {
              const result = await this.service.setModelInPicker(
                name,
                true,
                this.owner(),
              );
              if (!result.ok) throw new Error(result.code);
            }
            await this.options.models.setDisabled(
              {
                kind: "model",
                providerId: MANAGED_OLLAMA_PROVIDER_ID,
                modelIds: [name],
                disabled: operation === "disable",
              },
              () => this.current(),
            );
          } else {
            const result =
              operation === "delete"
                ? await this.service.deleteInstalled(name, this.owner())
                : await this.service.setModelInPicker(
                    name,
                    operation === "enable",
                    this.owner(),
                  );
            if (!result.ok) throw new Error(result.code);
          }
        });
        return {
          effects: [
            { kind: "refresh-collection", collectionId: "local-models" },
          ],
          result: job,
        };
      },
    });
  }
  private modelName(value: unknown): string {
    if (value === undefined) return "";
    const name =
      typeof value === "string" ? normalizeOllamaPullName(value) : null;
    if (!name) throw new Error("INVALID_MODEL_NAME");
    return name;
  }
  private begin(
    key: string,
    operation: string,
    action: () => Promise<void>,
  ): LocalModelJob {
    if (this.jobs.get(key)?.state === "running")
      throw new Error("LOCAL_MODEL_OPERATION_IN_PROGRESS");
    const job: LocalModelJob = {
      id: randomUUID(),
      operation,
      state: "running",
    };
    this.jobs.set(key, job);
    const work = (async () => {
      try {
        this.current();
        await action();
        this.current();
        job.state = "completed";
      } catch (error) {
        if (error instanceof PullAbortedError)
          job.state = error.reason === "pause" ? "paused" : "cancelled";
        else {
          job.state = "failed";
          job.error = localModelErrorCode(error);
        }
      } finally {
        this.snapshot = undefined;
        this.changed(true);
      }
    })();
    this.work.add(work);
    void work.finally(() => this.work.delete(work));
    this.changed();
    return { ...job };
  }
  private resource(id: string, value: LocalModelListResult): RemoteResource {
    const found = value.models.find((m) => m.name === id);
    const installed = found
      ? {
          ...found,
          inCindy:
            found.inCindy &&
            !this.options.models.snapshot().disabled?.disabledModels?.[
              modelDisableKey(MANAGED_OLLAMA_PROVIDER_ID, id)
            ],
        }
      : undefined;
    const catalog = value.catalog.find((m) => m.libraryName === id),
      pull = value.pulls.find((p) => p.name === id),
      job = this.jobs.get(id);
    if (id !== "ollama" && !installed && !catalog && !pull && !job)
      throw new Error("RESOURCE_NOT_FOUND");
    const runtime = id === "ollama",
      busy = job?.state === "running",
      active = pull && !pull.done;
    const actions: RemoteActionDescriptor[] = runtime
      ? [
          {
            id: this.sidecar.managedSidecarRunning() ? "restart" : "start",
            label: this.sidecar.managedSidecarRunning()
              ? t.restartOllama
              : t.start,
            disabled: busy,
          },
          ...(this.sidecar.managedSidecarRunning()
            ? [{ id: "stop", label: t.stopOllama, disabled: busy }]
            : []),
          {
            id: "install",
            label: findInstalledSidecarBinary(this.options.root)
              ? t.repairOllama
              : t.install,
            disabled:
              busy ||
              value.pulls.some((p) => !p.done) ||
              (value.status.kind === "ready" &&
                !this.sidecar.managedSidecarRunning()) ||
              !supportsManagedOllamaInstall(process.platform, process.arch),
          },
          {
            id: "download",
            label: t.download,
            disabled: busy,
            fields: [
              { id: "name", label: t.name, kind: "text", required: true },
            ],
          },
          ...(busy && job.operation === "install"
            ? [{ id: "cancel", label: t.cancel }]
            : []),
        ]
      : active
        ? [
            { id: "pause", label: t.pause },
            { id: "cancel", label: t.cancel },
          ]
        : pull?.phase === "paused"
          ? [
              { id: "resume", label: t.resume },
              { id: "cancel", label: t.cancel },
            ]
          : installed
            ? [
                {
                  id: installed.inCindy ? "disable" : "enable",
                  label: installed.inCindy ? t.disable : t.enable,
                  disabled: busy,
                },
                {
                  id: "delete",
                  label: t.remove,
                  disabled: busy,
                  confirmation: {
                    title: t.remove,
                    body: t.confirmDelete,
                    confirmLabel: t.remove,
                  },
                },
              ]
            : [{ id: "download", label: t.download, disabled: busy }];
    const status =
      busy || active
        ? t.busy
        : pull?.phase === "paused"
          ? t.paused
          : job?.state === "failed"
            ? t.error
            : runtime
              ? value.status.kind === "ready"
                ? t.ready
                : value.status.kind === "absent"
                  ? t.absent
                  : value.status.kind === "stopped"
                    ? t.stopped
                    : t.error
              : installed
                ? t.installed
                : undefined;
    const progress = runtime ? this.installProgress : pull;
    const shownProgress = runtime && !busy ? undefined : progress;
    const data = {
      ...(runtime
        ? {
            status: value.status,
            memoryGb: value.memoryGb,
            recommended: value.recommended,
          }
        : { installed, catalog }),
      progress,
      job,
    };
    const bytes =
      shownProgress?.total ?? installed?.sizeBytes ?? catalog?.sizeBytes;
    const summary = [
      runtime ? value.status.version : id,
      bytes
        ? `${shownProgress?.completed !== undefined ? `${(shownProgress.completed / 1024 ** 2).toFixed(0)} / ` : ""}${(bytes / 1024 ** (bytes >= 1024 ** 3 && shownProgress?.completed === undefined ? 3 : 2)).toFixed(1)} ${bytes >= 1024 ** 3 && shownProgress?.completed === undefined ? "GiB" : "MiB"}`
        : "",
      shownProgress?.percent !== undefined ? `${shownProgress.percent}%` : "",
      job?.error,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      ref: { collectionId: "local-models", kind: "local-model", id },
      revision: JSON.stringify(data),
      display: {
        title: runtime ? "Ollama" : (catalog?.name ?? id),
        subtitle: summary,
        ...(status ? { status: { label: status } } : {}),
      },
      actions,
      links: [],
      blocks: [
        {
          id: "local-model",
          primitive: "local-model-status",
          fallbackMarkdown: summary,
          data,
        },
      ],
    };
  }
  async close() {
    this.unregister?.();
    this.controller.abort();
    clearTimeout(this.changedTimer);
    await Promise.allSettled([
      this.llamaCpp.close(),
      this.service.abortInstall(),
      ...this.service
        .activePulls()
        .filter((p) => !p.done)
        .map((p) => this.service.abortPull("pause", p.name)),
    ]);
    await Promise.allSettled(this.work);
    await this.reading?.catch(() => {});
    await this.sidecar.stopManagedSidecarAndWait();
  }
}
