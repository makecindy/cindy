import path from "node:path";
import { createHash } from "node:crypto";
import {createBotModelChainSettings} from "@cindy/app-runtime/botModelChainSettings";
import type {Logger} from "@cindy/maker-core";
import {rename} from "node:fs/promises";
import { normalizeModelRoute } from "@cindy/maker-shared/model-route";
import {
  modelSupportsFastMode,
  resolveRoute,
  type ProviderView,
  type ResolvedRoute,
} from "@cindy/model-providers";
import {
  ENGINES,
  parseSelection,
  type ModelSelection,
  type TerminalModelConfig,
} from "../../models/config.js";
import {readPrivateFile} from "../../platform.js";

export type CompanionModel = ModelSelection & {
  fastMode: boolean | "ultrafast";
  agentDeviceId?: string;
};
export function parseCompanionModel(value: unknown): CompanionModel {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_MODEL_SELECTION");
  const input = value as Record<string, unknown>;
  const agentKind =
    input.agentKind ??
    (input.harness === "claude" ? "claude-code" : input.harness);
  const normalized = normalizeModelRoute({
    ...input,
    harness: agentKind === "claude-code" ? "claude" : agentKind,
  });
  if (!normalized || !normalized.providerId)
    throw new Error("INVALID_MODEL_SELECTION");
  if (
    input.fastMode !== undefined &&
    typeof input.fastMode !== "boolean" &&
    input.fastMode !== "ultrafast"
  )
    throw new Error("INVALID_FAST_MODE");
  return {
    ...parseSelection({
      ...input,
      agentKind,
      providerId: normalized.providerId,
      effort: normalized.effort || undefined,
    }),
    fastMode: normalized.fastMode,
    ...(normalized.agentDeviceId
      ? { agentDeviceId: normalized.agentDeviceId }
      : {}),
  };
}
export type CompanionModelResolution = Awaited<
  ReturnType<TerminalModelConfig["select"]>
> & {
  agentDeviceId?: string;
  groupBinding?: import("@cindy/remote-agent/groups/bindings").ProviderGroupBinding;
};
export const companionModelKey = (route: CompanionModel) =>
  JSON.stringify([
    route.agentDeviceId ?? "",
    route.agentKind,
    route.providerId,
    route.model,
  ]);
export type CompanionModelOption = {
  id: string;
  label: string;
  choice: CompanionModel;
  efforts: string[];
  fast: boolean;
  ultrafast: boolean;
  available: boolean;
};

/** An independent companion default, never the last selection in a task. */
export class TerminalCompanionModels {
  readonly original:ReturnType<typeof createBotModelChainSettings>;
  private pending: Promise<void>;
  readonly ready: Promise<void>;
  private generation = 0;
  private availableAgents: ModelSelection["agentKind"][]=[];
  private originalRoute(choice:CompanionModel){return {...choice,harness:choice.agentKind==='claude-code'?'claude' as const:choice.agentKind,effort:choice.effort??''};}
  private async settings(){
    this.availableAgents=(await Promise.all(ENGINES.map(async kind=>await this.options.binary(kind)?kind:null))).filter((kind):kind is ModelSelection["agentKind"]=>kind!==null);
    this.options.guard();return this.original.readBotModelChainSettingsState();
  }
  constructor(
    private readonly options: {
      original?():ReturnType<typeof createBotModelChainSettings>;
      root: string;
      ownerRoot: string;
      logger:Logger;
      models: TerminalModelConfig;
      guard(): void;
      binary(kind: ModelSelection["agentKind"]): Promise<string | null>;
      views?(device?: string): Promise<ProviderView[]>;
      locations?(): Promise<Array<{ agentDeviceId: string; name: string }>>;
      isGrouped?(providerId: string): boolean;
      resolve?(
        choice: CompanionModel,
        sessionId: string,
        workingDir: string,
      ): Promise<CompanionModelResolution>;
    },
  ) {
    const original=this.original=options.original?new Proxy({} as ReturnType<typeof createBotModelChainSettings>,{get:(_target,key)=>Reflect.get(options.original!(),key)}):createBotModelChainSettings({
      userDataPath:()=>options.ownerRoot,ownerScopedUserDataPath:()=>options.ownerRoot,
      hasDataOwner:()=>true,activeOwnerScopeKey:()=>{options.guard();return options.ownerRoot;},
      // Reads below supply the current installed engines, after their asynchronous scan.
      listAvailableAgents:()=>this.availableAgents,
      getDesktopProviderService:()=>({listProviders:read=>options.models.views(read)}),
      getModelVisibilityOverride:(...args)=>options.models.visibility.mirror.getModelVisibilityOverride(...args),
      waitForModelVisibilityMirror:()=>options.models.waitForModelVisibility(),log:options.logger,
    });
    const file=path.join(options.root,'model-defaults.json');
    this.ready=(async()=>{
      const data=await readPrivateFile(file);if(!data)return;
      const value=JSON.parse(data.toString());
      if(value.version!==1 || !Array.isArray(value.models))throw new Error('INVALID_COMPANION_MODEL_DEFAULTS');
      const chain=this.parseChain(value.models);
      const state=await original.readBotModelChainSettingsState();options.guard();
      if(chain.length && !state.isCustomized)await original.writeBotModelChainSettings(chain.map(choice=>this.originalRoute(choice)));
      options.guard();await rename(file,`${file}.migrated`);
    })();
    this.pending = Promise.resolve();
  }
  revision() {
    return this.generation;
  }
  parseChain(value: unknown): CompanionModel[] {
    if (!Array.isArray(value) || value.length > 5)
      throw new Error("INVALID_MODEL_CHAIN");
    const result = value.map(parseCompanionModel);
    const seen = new Set<string>();
    for (const route of result) {
      const key = companionModelKey(route);
      if (seen.has(key)) throw new Error("DUPLICATE_MODEL_ROUTE");
      seen.add(key);
    }
    return result;
  }
  async defaults() {
    await this.ready;
    await this.pending;
    this.options.guard();
    const state=await this.settings();this.options.guard();
    return state.value.modelChain.map(parseCompanionModel);
  }

  async resolve(
    choice: CompanionModel,
    sessionId: string,
    workingDir: string,
  ): Promise<CompanionModelResolution> {
    this.options.guard();
    if (choice.agentDeviceId && !this.options.resolve)
      throw new Error("REMOTE_AGENT_UNAVAILABLE");
    const resolved = this.options.resolve
      ? await this.options.resolve(choice, sessionId, workingDir)
      : await this.options.models.select(choice);
    this.options.guard();
    this.validateTuning(choice, resolved.route);
    return resolved;
  }
  private validateTuning(choice: CompanionModel, route: ResolvedRoute) {
    if (choice.effort && !route.model.efforts.includes(choice.effort))
      throw new Error("INVALID_MODEL_EFFORT");
    if (
      choice.fastMode &&
      !modelSupportsFastMode(route.provider, choice.model, choice.agentKind)
    )
      throw new Error("FAST_MODE_UNAVAILABLE");
    if (choice.fastMode === "ultrafast" && !route.model.supportsUltrafastMode)
      throw new Error("ULTRAFAST_MODE_UNAVAILABLE");
  }
  async validate(choice: CompanionModel) {
    this.options.guard();
    if (choice.agentDeviceId && !this.options.views)
      throw new Error("REMOTE_AGENT_UNAVAILABLE");
    const views = await (this.options.views?.(choice.agentDeviceId) ??
      this.options.models.views());
    const route = resolveRoute(
      views,
      choice.providerId,
      choice.model,
      choice.agentKind,
    );
    if (
      !route ||
      !route.provider.connected ||
      route.provider.suspended ||
      route.model.disabled
    )
      throw new Error("MODEL_ROUTE_UNAVAILABLE");
    if (
      !choice.agentDeviceId &&
      !this.options.isGrouped?.(choice.providerId) &&
      !(await this.options.binary(choice.agentKind))
    )
      throw new Error("ENGINE_NOT_INSTALLED");
    this.options.guard();
    this.validateTuning(choice, route);
    return route;
  }
  async state() {
    await this.ready;
    await this.pending;
    this.options.guard();
    const state=await this.settings();
    const configured=state.isCustomized ? state.value.modelChain.map(parseCompanionModel) : [];
    return {
      configured,
      revision: createHash("sha256")
        .update(JSON.stringify(configured))
        .digest("hex"),
      effective: state.value.modelChain.map(parseCompanionModel),
    };
  }
  /** Catalog reads never reserve a provider-group member or start an agent. */
  async choices(selected: CompanionModel[] = []) {
    await this.ready;
    this.options.guard();
    const locations = (await this.options.locations?.()) ?? [];
    const sources = new Map<string | undefined, string>([[undefined, ""]]);
    for (const location of locations)
      sources.set(location.agentDeviceId, location.name);
    for (const choice of selected)
      if (choice.agentDeviceId && !sources.has(choice.agentDeviceId))
        sources.set(choice.agentDeviceId, choice.agentDeviceId);
    const installed = new Set(
      (
        await Promise.all(
          ENGINES.map(async (kind) =>
            (await this.options.binary(kind)) ? kind : null,
          ),
        )
      ).filter(Boolean),
    );
    const result = new Map<string, CompanionModelOption>();
    const queue = [...sources.entries()];
    const read = async () => {
      for (;;) {
        const source = queue.shift();
        if (!source) return;
        const [device, name] = source;
        let providers: ProviderView[];
        try {
          providers = await (this.options.views?.(device) ??
            (device
              ? Promise.reject(new Error("REMOTE_AGENT_UNAVAILABLE"))
              : this.options.models.views()));
        } catch {
          this.options.guard();
          continue;
        }
        this.options.guard();
        for (const provider of providers)
          for (const kind of ENGINES)
            for (const model of provider.models[kind] ?? []) {
              if (
                !provider.connected ||
                provider.suspended ||
                model.disabled ||
                (!device &&
                  !this.options.isGrouped?.(provider.id) &&
                  !installed.has(kind))
              )
                continue;
              // A native Claude subscription is never transferred to another harness.
              if (
                provider.id === "anthropic" &&
                provider.source !== "user" &&
                kind !== "claude-code"
              )
                continue;
              const choice: CompanionModel = {
                agentKind: kind,
                providerId: provider.id,
                model: model.id,
                fastMode: false,
                ...(device ? { agentDeviceId: device } : {}),
              };
              const id = companionModelKey(choice);
              result.set(id, {
                id,
                label: [name, provider.name, kind, model.name]
                  .filter(Boolean)
                  .join(" · "),
                choice,
                efforts: model.efforts,
                fast: modelSupportsFastMode(provider, model.id, kind),
                ultrafast: Boolean(model.supportsUltrafastMode),
                available: true,
              });
            }
      }
    };
    await Promise.all([read(), read()]);
    this.options.guard();
    for (const choice of selected) {
      const id = companionModelKey(choice);
      if (!result.has(id))
        result.set(id, {
          id,
          label: [
            choice.agentDeviceId,
            choice.providerId,
            choice.agentKind,
            choice.model,
          ]
            .filter(Boolean)
            .join(" · "),
          choice,
          efforts: [],
          fast: false,
          ultrafast: false,
          available: false,
        });
    }
    return [...result.values()];
  }
  async saveDefaults(
    value: unknown,
    guard: () => void = () => {},
    expectedRevision?: string,
  ) {
    const chain = this.parseChain(value);
    const write = this.pending.then(async () => {
      await this.ready;
      this.options.guard();
      guard();
      const current=await this.settings();
      const configured=current.isCustomized?current.value.modelChain.map(parseCompanionModel):[];
      if (
        expectedRevision !== undefined &&
        expectedRevision !==
          createHash("sha256")
            .update(JSON.stringify(configured))
            .digest("hex")
      )
        throw new Error("COMPANION_MODEL_DEFAULTS_CHANGED");
      for (const choice of chain) await this.validate(choice);
      this.options.guard();
      guard();
      if(chain.length)await this.original.writeBotModelChainSettings(chain.map(choice=>this.originalRoute(choice)));
      else await this.original.resetBotModelChainSettings();
      this.generation++;
    });
    this.pending = write.catch(() => {});
    return write;
  }
}
