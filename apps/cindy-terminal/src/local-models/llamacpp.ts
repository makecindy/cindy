import { llamaCppModelPreset, llamaCppMaxContextSize } from '@cindy/model-providers/llamaCpp';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import os from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  RemoteResource,
  RemoteActionDescriptor,
  RemoteActionInvokeResponse,
} from "@cindy/device-link";
import { modelDisableKey } from "@cindy/model-providers";
import {
  MANAGED_LLAMACPP_PROVIDER_ID,
  validLlamaCppRepo,
  validLlamaCppFile,
  type LlamaCppSnapshot,
  type LlamaCppDownloadInput,
} from "@cindy/model-providers/llamaCpp";
import { resolveLlamaCppModelLists } from "@cindy/model-providers/llamaCppCatalog";
import {
  createLlamaCppRuntime,
  managedModelId,
  type LlamaCppHost,
} from "@cindy/model-providers/local-runtime/llamaCppService";
import {
  createLlamaCppDownloads,
  selectGgufShards,
} from "@cindy/model-providers/local-runtime/llamaCppDownloads";
import { createManagedLlamaCppProvider } from "@cindy/model-providers/local-runtime/managedLlamaCppProvider";
import { killProcessTree } from "@cindy/maker-scheduler/proc-util";
import {
  startReviewOwnerLiveness,
  probeReviewOwnerLiveness,
} from "@cindy/maker-scheduler/owner-liveness";
import { withCrossProcessLock } from "@cindy/remote-agent/crossProcessLock";
import type { TerminalModelConfig } from "../models/config.js";
import type { LocalModelJob } from "./service.js";
import { localModelText as t } from "./text.js";
import { localModelErrorCode } from './errors.js';

type Candidate = LlamaCppDownloadInput & { name: string; size: number };
/** The selected host owns downloads and its router. Controller disconnect is
 * independent of runtime cancellation; owner retirement joins both. */
export class TerminalLlamaCpp {
  readonly service;
  readonly managed;
  private readonly controller = new AbortController();
  private readonly work = new Set<Promise<void>>();
  private readonly repositories = new Map<string, Candidate[]>();
  private job?: LocalModelJob & { model?: LlamaCppDownloadInput };
  private readonly downloads;
  constructor(
    private readonly options: {
      root: string;
      models: TerminalModelConfig;
      assertCurrent(): void;
      changed(modelsChanged?: boolean): void;
      /** Same host ports used by Desktop; native integration tests supply transport only. */
      deps?: Partial<LlamaCppHost> & { fetch?: typeof fetch };
    },
  ) {
    const { models } = options;
    this.downloads = createLlamaCppDownloads(options.deps?.fetch ?? fetch);
    const mismatch = new Error("PROVIDER_COMPARE_FAILED");
    this.managed = createManagedLlamaCppProvider({
      getCustomProvider: async (id) => {
        this.current();
        return models.snapshot().providers.find((p) => p.id === id) ?? null;
      },
      createCustomProvider: (config) =>
        models.saveProvider(config, {}, true, () => this.current()),
      updateCustomProviderIfUnchanged: async (id, expected, config) => {
        try {
          await models.saveProvider(config, {}, false, () => {
            this.current();
            if (
              !isDeepStrictEqual(
                models.snapshot().providers.find((p) => p.id === id),
                expected,
              )
            )
              throw mismatch;
          });
          return true;
        } catch (error) {
          if (error === mismatch) return false;
          throw error;
        }
      },
    });
    const runtime = createLlamaCppRuntime({
      ...this.downloads,
      killProcessTree,
      withCrossProcessLock,
      startReviewOwnerLiveness,
      probeReviewOwnerLiveness,
      ...options.deps,
    });
    this.service = runtime.createLlamaCppService(
      options.root,
      () => models.contextLimits.readModelContextLimits(),
      async () => {
        this.current();
        await this.managed.assertManagedLlamaCppProvider();
      },
    );
  }
  async validateContext(targets: readonly import('@cindy/app-runtime/modelPriceOverride').ModelPriceOverrideTarget[], limit: number) {
    this.current();
    const {models} = await this.service.snapshot();
    this.current();
    for (const target of targets) {
      const model = models.find(entry => entry.id === target.modelId);
      if (!model) throwIpcError('INVALID_PARAMS', 'Local model is not installed');
      try {llamaCppModelPreset(model, {[`${target.agent}:${target.providerId}:${target.modelId}`]: limit});}
      catch {throwIpcError('INVALID_PARAMS', `This local model supports context up to ${llamaCppMaxContextSize(model)} tokens`);}
    }
  }
  async configureContext(write: () => Promise<void>) {
    return this.service.configure(async () => {
      this.current();
      await this.managed.assertManagedLlamaCppProvider();
      this.current();
      await write();
    });
  }
  private current() {
    this.controller.signal.throwIfAborted();
    this.options.assertCurrent();
  }
  private active = () => {
    try {
      this.current();
      return true;
    } catch {
      return false;
    }
  };
  private async publish(snapshot: LlamaCppSnapshot) {
    const { catalog } = this.catalog();
    const changed = await this.managed.ensureManagedLlamaCppProvider(
      snapshot.models,
      this.active,
      catalog,
    );
    this.current();
    if (changed) this.options.changed(true);
  }
  private catalog() {
    return resolveLlamaCppModelLists(
      {
        platform: process.platform,
        arch: process.arch,
        totalmemBytes: os.totalmem(),
      },
      this.options.models.localCatalog(),
    );
  }
  async prepare() {
    this.current();
    await this.managed.assertManagedLlamaCppProvider();
    await this.service.start();
    this.current();
  }
  async remove(remove: () => Promise<void>) {
    this.current();
    await this.service.remove(remove);
  }
  async resources(): Promise<RemoteResource[]> {
    this.current();
    const snapshot = await this.service.snapshot();
    await this.publish(snapshot);
    const { catalog, recommendation } = this.catalog();
    const candidates = new Map<string, Candidate>();
    const add = (model: Candidate) =>
      candidates.set(managedModelId(model.repo, model.file), model);
    for (const entry of catalog)
      for (const variant of entry.variants)
        add({
          ...variant,
          size: variant.sizeBytes,
          name: `${entry.name} · ${variant.quantization}`,
        });
    for (const model of snapshot.models)
      if (!candidates.has(model.id)) add({ ...model, name: model.file });
    if (
      this.job?.model &&
      !candidates.has(managedModelId(this.job.model.repo, this.job.model.file))
    )
      add({ ...this.job.model, size: 0, name: this.job.model.file });
    return [
      this.resource("llamacpp", snapshot, undefined, recommendation),
      ...[...this.repositories].map(([repo, files]): RemoteResource => ({
        ref: {
          collectionId: "local-models",
          kind: "local-model",
          id: `llamacpp:repo:${repo}`,
        },
        revision: JSON.stringify(files),
        display: { title: repo },
        links: [],
        actions: [
          {
            id: "download",
            label: t.download,
            disabled:
              !files.length ||
              this.job?.state === "running" ||
              snapshot.canConfigure === false,
            fields: [
              {
                id: "file",
                label: t.ggufFile,
                kind: "select",
                required: true,
                options: files.map((file) => ({
                  value: file.file,
                  label: `${file.name} · ${(file.size / 1024 ** 2).toFixed(0)} MiB`,
                })),
              },
            ],
          },
        ],
        blocks: [
          {
            id: "gguf-repository",
            primitive: "text",
            fallbackMarkdown: repo,
            data: { repo },
          },
        ],
      })),
      ...[...candidates].map(([id, model]) =>
        this.resource(`llamacpp:${id}`, snapshot, model),
      ),
    ];
  }
  private resource(
    id: string,
    snapshot: LlamaCppSnapshot,
    model?: Candidate,
    recommendation?: unknown,
  ): RemoteResource {
    const runtime = !model;
    const modelId = model && managedModelId(model.repo, model.file);
    const installed = snapshot.models.find((item) => item.id === modelId);
    const job =
      runtime ||
      (this.job?.model &&
        managedModelId(this.job.model.repo, this.job.model.file) === modelId)
        ? this.job
        : undefined;
    const busy = this.job?.state === "running";
    const operation =
      runtime ||
      (snapshot.operation?.model &&
        managedModelId(
          snapshot.operation.model.repo,
          snapshot.operation.model.file,
        ) === modelId)
        ? snapshot.operation
        : undefined;
    const hidden = !!(
      modelId &&
      this.options.models.snapshot().disabled?.disabledModels?.[
        modelDisableKey(MANAGED_LLAMACPP_PROVIDER_ID, modelId)
      ]
    );
    const fields: NonNullable<RemoteActionDescriptor["fields"]> = [
      { id: "repo", label: t.repository, kind: "text", required: true },
      { id: "file", label: t.ggufFile, kind: "text", required: true },
    ];
    const actions: RemoteActionDescriptor[] = runtime
      ? [
          ...(!snapshot.installed
            ? [
                {
                  id: "install",
                  label: t.installLlama,
                  disabled:
                    busy ||
                    snapshot.installed ||
                    !snapshot.supported ||
                    snapshot.canConfigure === false,
                },
              ]
            : []),
          ...(snapshot.installed
            ? [
                {
                  id: "repair",
                  label: t.repairLlama,
                  disabled:
                    busy || snapshot.running || snapshot.canConfigure === false,
                },
              ]
            : []),
          {
            id: "start",
            label: snapshot.canManageRuntime ? t.restartLlama : t.startLlama,
            disabled:
              busy || !snapshot.installed || snapshot.canConfigure === false,
          },
          {
            id: "stop",
            label: t.stopLlama,
            disabled: !snapshot.canManageRuntime,
          },
          { id: "files", label: t.browseGguf, fields: fields.slice(0, 1) },
          {
            id: "download",
            label: t.download,
            fields,
            disabled: busy || snapshot.canConfigure === false,
          },
        ]
      : installed
        ? [
            {
              id: hidden ? "enable" : "disable",
              label: hidden ? t.enable : t.disable,
              disabled: busy || snapshot.canConfigure === false,
            },
            {
              id: "delete",
              label: t.remove,
              disabled:
                busy || snapshot.running || snapshot.canConfigure === false,
              confirmation: {
                title: t.remove,
                body: t.confirmDelete,
                confirmLabel: t.remove,
              },
            },
          ]
        : [
            {
              id: "download",
              label: t.download,
              disabled: busy || snapshot.canConfigure === false,
            },
          ];
    if (busy && operation) {
      if (operation.kind === "download")
        actions.unshift({
          id: operation.paused ? "resume" : "pause",
          label: operation.paused ? t.resume : t.pause,
        });
      actions.push({ id: "cancel", label: t.cancel });
    }
    const status = operation?.paused
      ? t.paused
      : job?.state === "running"
        ? t.busy
        : job?.state === "failed"
          ? t.error
          : runtime
            ? snapshot.running
              ? t.ready
              : snapshot.installed
                ? t.stopped
                : t.absent
            : installed
              ? t.installed
              : undefined;
    const summary = [
      runtime ? snapshot.version : model?.repo,
      model?.file,
      operation?.total
        ? `${(operation.completed / 1024 ** 2).toFixed(0)} / ${(operation.total / 1024 ** 2).toFixed(0)} MiB · ${Math.floor((operation.completed / operation.total) * 100)}%`
        : model?.size
          ? `${(model.size / 1024 ** 3).toFixed(2)} GiB`
          : undefined,
      job?.error,
    ]
      .filter(Boolean)
      .join(" · ");
    const data = {
      ...(runtime
        ? { ...snapshot, recommendation }
        : { model, installed, hidden }),
      job,
      operation,
    };
    return {
      ref: { collectionId: "local-models", kind: "local-model", id },
      revision: JSON.stringify(data),
      display: {
        title: runtime ? "llama.cpp" : model!.name,
        subtitle: summary,
        ...(status ? { status: { label: status } } : {}),
      },
      actions,
      links: [],
      blocks: [
        {
          id: "llamacpp-status",
          primitive: "local-model-status",
          fallbackMarkdown: summary,
          data,
        },
      ],
    };
  }
  async invoke(
    id: string,
    operation: string,
    input: unknown,
    assertCurrent: () => void = () => {},
  ): Promise<RemoteActionInvokeResponse> {
    this.current();
    const resources = await this.resources();
    assertCurrent();
    const resource = resources.find((item) => item.ref.id === id);
    const action = resource?.actions?.find((item) => item.id === operation);
    if (!resource || !action || action.disabled)
      throw new Error("ACTION_NOT_AVAILABLE_ON_TARGET");
    const raw = input as { repo?: unknown; file?: unknown } | undefined;
    const value = {
      repo: typeof raw?.repo === "string" ? raw.repo.trim() : raw?.repo,
      file: typeof raw?.file === "string" ? raw.file.trim() : raw?.file,
    };
    const effects: RemoteActionInvokeResponse["effects"] = [
      { kind: "refresh-collection", collectionId: "local-models" },
    ];
    if (operation === "files") {
      if (!validLlamaCppRepo(value?.repo)) throw new Error("INVALID_MODEL");
      const repo = value.repo;
      const result = await this.downloads.resolveHfRepository(
        repo,
        AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]),
      );
      this.current();
      assertCurrent();
      const files = result.files
        .filter(
          (file) =>
            !/-\d{5}-of-\d{5}\.gguf$/.test(file.name) ||
            /-00001-of-\d{5}\.gguf$/.test(file.name),
        )
        .map((file) => ({
          repo,
          file: file.name,
          name: file.name,
          size: selectGgufShards(result.files, file.name).reduce(
            (n, shard) => n + shard.size,
            0,
          ),
        }));
      this.repositories.set(repo, files);
      effects.push({
        kind: "navigate",
        target: {
          kind: "resource",
          ref: {
            collectionId: "local-models",
            kind: "local-model",
            id: `llamacpp:repo:${repo}`,
          },
        },
      });
      return { effects, result: files };
    }
    if (
      operation === "cancel" ||
      operation === "pause" ||
      operation === "resume"
    ) {
      if (operation === "cancel") this.service.cancel();
      else if (operation === "pause") this.service.pause();
      else this.service.resume();
      this.options.changed();
      return { effects, result: { ok: true } };
    }
    const model = id.startsWith("llamacpp:repo:")
      ? { repo: id.slice("llamacpp:repo:".length), file: value.file }
      : id === "llamacpp"
        ? value
        : (resource.blocks?.[0]?.data as { model?: Candidate })?.model;
    if (
      operation === "download" &&
      (!validLlamaCppRepo(model?.repo) || !validLlamaCppFile(model?.file))
    )
      throw new Error("INVALID_MODEL");
    if (this.job?.state === "running" && operation !== "stop")
      throw new Error("BUSY");
    const job: NonNullable<TerminalLlamaCpp["job"]> = {
      id: randomUUID(),
      operation,
      state: "running",
      ...(operation === "download"
        ? {
            model: { repo: model!.repo as string, file: model!.file as string },
          }
        : {}),
    };
    this.job = job;
    const work = (async () => {
      try {
        this.current();
        if (operation === "stop") await this.service.stop();
        else {
          await this.managed.ensureManagedLlamaCppProvider(
            undefined,
            this.active,
          );
          this.current();
          if (operation === "install" || operation === "repair")
            await this.service.install(operation === "repair");
          else if (operation === "start") await this.service.start(true);
          else if (operation === "download")
            await this.service.download(job.model!);
          else if (operation === "delete")
            await this.service.deleteModel(id.slice("llamacpp:".length));
          else if (operation === "enable" || operation === "disable") {
            await this.options.models.setDisabled(
              {
                kind: "model",
                providerId: MANAGED_LLAMACPP_PROVIDER_ID,
                modelIds: [id.slice("llamacpp:".length)],
                disabled: operation === "disable",
              },
              () => this.current(),
            );
          }
        }
        await this.publish(await this.service.snapshot());
        this.current();
        job.state = "completed";
      } catch (error) {
        job.state =
          this.controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
            ? "cancelled"
            : "failed";
        if (job.state === "failed")
          job.error = localModelErrorCode(error);
      } finally {
        if (this.active()) this.options.changed(true);
      }
    })();
    this.work.add(work);
    void work.finally(() => this.work.delete(work));
    this.options.changed();
    return { effects, result: { ...job } };
  }
  async close() {
    this.controller.abort();
    await this.service.dispose();
    await Promise.allSettled(this.work);
  }
}
