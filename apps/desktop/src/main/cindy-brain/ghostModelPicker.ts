import { randomUUID } from 'node:crypto';
import {
  connectedProvidersForAgent,
  isModelSelectableForNewRoute,
  type ProviderView,
} from '@cindy/model-providers';
import type { InstalledGhost } from '../../shared/ghost.js';
import {
  isPluginModelPickerRoute,
  type PluginModelPickerRequest,
  type PluginModelPickerResult,
  type PluginModelPickerRoute,
} from '../../shared/pluginModelPicker.js';
import { GHOST_REMOTE_AGENT_MODELS } from './ghostAgentModels.js';

/** Read the exact execution location; an unavailable remote source never borrows local models. */
export async function readPluginModelRouteCatalog(
  route: { agentDeviceId?: string },
  sources: {
    local(): Promise<ProviderView[]>;
    remote?: ((agentDeviceId: string) => Promise<ProviderView[]>) | null;
    localAgents(): readonly string[];
  },
): Promise<{ views: ProviderView[]; agents: readonly string[] }> {
  if (route.agentDeviceId) {
    const views = await sources.remote?.(route.agentDeviceId) ?? [];
    return { views, agents: GHOST_REMOTE_AGENT_MODELS };
  }
  return { views: await sources.local(), agents: sources.localAgents() };
}

// The host supplies a live reader without making the plugin module load Maker.
// Read on confirmation, so an account reset or disabled engine is reflected.
let agentProvider: () => readonly string[] = () => [];
export function setPluginModelPickerAgentProvider(provider: () => readonly string[]): void {
  agentProvider = provider;
}
export function getPluginModelPickerAgents(): readonly string[] {
  return agentProvider();
}

/**
 * 选择器只发给用户看得见的应用窗口:优先当前聚焦的那个。预热的隐藏窗口也是应用窗口,
 * 发给它们时选择器看不见,插件只能等到超时(表现为「点了没反应」)。
 */
export function chooseModelPickerWindow<W>(
  focused: W | null,
  all: readonly W[],
  usable: (win: W) => boolean,
): W | undefined {
  return focused && usable(focused) ? focused : all.find(usable);
}

type AgentBinaryStatus = (agent: string) => Promise<{ binaryReady?: boolean } | null | undefined>;
export type RemotePluginRouteAgentStatus = (agentDeviceId: string, agent: string) => ReturnType<AgentBinaryStatus>;
let agentBinaryStatus: AgentBinaryStatus = async () => null;

export function setPluginRouteAgentStatusProvider(provider: AgentBinaryStatus): void {
  agentBinaryStatus = provider;
}

/**
 * A plugin may route to another Harness. If that Harness is not installed the send gate would stop the
 * message with a dialog, so the route must fall back instead. Only a definite "missing" counts: when the
 * check itself fails, the send gate still has the final say. Local Claude Code ships with the app;
 * a remote route must query its own execution source and never use the plugin computer's status.
 */
export async function isPluginRouteHarnessInstalled(
  agent: string,
  agentDeviceId?: string,
  readRemoteStatus?: RemotePluginRouteAgentStatus | null,
): Promise<boolean> {
  if (!agentDeviceId && agent === 'claude-code') return true;
  try {
    const status = agentDeviceId
      ? await readRemoteStatus?.(agentDeviceId, agent)
      : await agentBinaryStatus(agent);
    return status?.binaryReady !== false;
  } catch {
    return true;
  }
}

export interface PluginModelPickerTarget {
  id: string | number;
  /** Captured from this controller's page-open declaration; absent means a legacy picker. */
  supportsRemoteRoutes?: boolean;
  isCurrent?(): boolean;
  send(request: PluginModelPickerRequest, cancel: () => void): boolean;
  dismiss(requestId: string): void;
}

/** Recheck the exact route without discovery, credential claims or inference. */
export function isPluginModelPickerRouteAvailable(
  route: PluginModelPickerRoute,
  views: ProviderView[],
  agents: readonly string[],
): boolean {
  const agent = route.agentKind === 'cc' ? 'claude-code' : route.agentKind;
  if (!agents.includes(agent)) return false;
  const provider = connectedProvidersForAgent(views, agent).find((p) => p.id === route.providerId);
  const model = provider?.models[agent]?.find((m) => m.id === route.model);
  return (
    !!provider &&
    !!model &&
    isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }) &&
    (!route.effort || model.efforts.includes(route.effort as never)) &&
    (!route.fastMode ||
      (model.supportsFastMode === true &&
        (route.fastMode !== 'ultrafast' ||
          (agent === 'codex' && model.supportsUltrafastMode === true))))
  );
}

/**
 * 卡内模型下拉框选中的模型当前是否可用:本机的按本机目录;带运行位置(另一台电脑或分享来的供应商)的,
 * 那个位置必须是现在可选的,模型也必须在那里允许远程调用的目录里。执行时那台电脑还会再校验一次。
 */
export async function isGhostCardModelRouteAvailable(
  route: PluginModelPickerRoute,
  sources: {
    localViews(): Promise<ProviderView[]>;
    localAgents(): readonly string[];
    locations?: (() => Promise<{ locations: readonly { agentDeviceId: string }[] }>) | null;
    remoteViews?: ((agentDeviceId: string) => Promise<ProviderView[]>) | null;
  },
): Promise<boolean> {
  const { agentDeviceId, ...base } = route;
  if (!agentDeviceId) return isPluginModelPickerRouteAvailable(base, await sources.localViews(), sources.localAgents());
  if (!sources.locations || !sources.remoteViews) return false;
  const { locations } = await sources.locations();
  if (!locations.some((location) => location.agentDeviceId === agentDeviceId)) return false;
  // 远程位置上的引擎是否就绪由那里的目录决定,这里不按本机安装情况过滤。
  return isPluginModelPickerRouteAvailable(base, await sources.remoteViews(agentDeviceId), GHOST_REMOTE_AGENT_MODELS);
}

interface Pending {
  request: PluginModelPickerRequest;
  target: PluginModelPickerTarget;
  current(): boolean;
  finish(result: PluginModelPickerResult): void;
}

/** One Host-owned picker, bound to its originating installation, page and answering window. */
export class GhostModelPicker {
  private pending?: Pending;

  constructor(
    private readonly deps: {
      getGhost(id: string): InstalledGhost | null;
      installation(id: string): string | null;
      target(ghostId: string, mobilePageId?: string): PluginModelPickerTarget | null;
      available(route: PluginModelPickerRoute): Promise<boolean>;
      timeoutMs?: number;
      now?(): number;
    },
  ) {}

  async request(
    ghostId: string,
    raw: unknown = {},
    isCurrent = () => true,
    signal?: AbortSignal,
    pageTarget?: PluginModelPickerTarget,
  ): Promise<PluginModelPickerResult> {
    const fail = (
      errorCode: Extract<PluginModelPickerResult, { ok: false }>['errorCode'],
      message: string,
    ): PluginModelPickerResult => ({ ok: false, errorCode, message });
    const ghost = this.deps.getGhost(ghostId),
      installation = this.deps.installation(ghostId);
    const current = () =>
      isCurrent() &&
      !signal?.aborted &&
      installation !== null &&
      this.deps.installation(ghostId) === installation &&
      this.deps.getGhost(ghostId)?.enabled === true;
    if (!ghost?.enabled || !current())
      return fail('PERMISSION_DENIED', 'Plugin is no longer available');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return fail('INVALID_REQUEST', 'Invalid model picker options');
    const options = raw as Record<string, unknown>;
    if (
      Object.keys(options).some((k) => !['type', 'initial', 'mobilePageId', 'allowRemote'].includes(k)) ||
      (options.allowRemote !== undefined && typeof options.allowRemote !== 'boolean') ||
      (options.initial !== undefined && !isPluginModelPickerRoute(options.initial)) ||
      (!!(options.initial as PluginModelPickerRoute | undefined)?.agentDeviceId && options.allowRemote !== true) ||
      (options.mobilePageId !== undefined &&
        (typeof options.mobilePageId !== 'string' ||
          !options.mobilePageId ||
          options.mobilePageId.length > 128))
    )
      return fail('INVALID_REQUEST', 'Invalid model picker options');
    if (this.pending) return fail('BUSY', 'A model picker is already open');
    // Selection is UI, not inference. The active-request guard prevents overlapping pickers;
    // closing one must not impose a cooldown on the next user interaction.
    const now = this.deps.now?.() ?? Date.now();
    let target: PluginModelPickerTarget | null;
    try {
      target = pageTarget ?? this.deps.target(ghostId, options.mobilePageId as string | undefined);
    } catch {
      target = null;
    }
    if (!target) return fail('UNAVAILABLE', 'No active Host page is available');
    // A legacy controller reconstructs a source-less answer from initial. A local namesake
    // would then pass availability, so do not deliver the remote initial to that controller.
    if ((options.initial as PluginModelPickerRoute | undefined)?.agentDeviceId && target.supportsRemoteRoutes !== true)
      return fail('UNAVAILABLE', 'Update Cindy on the controller to edit a remote model selection');
    const requestCurrent = () => current() && (target.isCurrent?.() ?? true);
    const request: PluginModelPickerRequest = {
      requestId: randomUUID(),
      ghostId,
      ghostName: ghost.manifest.name,
      ...(options.allowRemote === true ? { allowRemote: true } : {}),
      ...(options.initial ? { initial: { ...(options.initial as PluginModelPickerRoute) } } : {}),
      expiresAt: now + (this.deps.timeoutMs ?? 90_000),
    };
    return new Promise((resolve) => {
      const cancel = () => finish(fail('CANCELLED', 'Model selection was cancelled'));
      const timer = setTimeout(cancel, this.deps.timeoutMs ?? 90_000);
      const finish = (result: PluginModelPickerResult) => {
        if (this.pending?.request.requestId !== request.requestId) return;
        this.pending = undefined;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        try {
          target.dismiss(request.requestId);
        } catch {
          /* The page may already have closed. */
        }
        resolve(result);
      };
      this.pending = { request, target, current: requestCurrent, finish };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (!target.send(request, cancel))
          finish(fail('UNAVAILABLE', 'The model picker could not be opened'));
        else if (!requestCurrent()) cancel();
      } catch {
        finish(fail('UNAVAILABLE', 'The model picker could not be opened'));
      }
    });
  }

  async resolve(
    senderId: string | number,
    requestId: string,
    route: unknown,
  ): Promise<{ handled: boolean; accepted: boolean }> {
    const pending = this.pending;
    if (!pending || pending.request.requestId !== requestId || pending.target.id !== senderId)
      return { handled: false, accepted: false };
    if (!pending.current()) {
      pending.finish({
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: 'Plugin or account changed',
      });
      return { handled: true, accepted: false };
    }
    if (route === null) {
      pending.finish({
        ok: false,
        errorCode: 'CANCELLED',
        message: 'Model selection was cancelled',
      });
      return { handled: true, accepted: true };
    }
    if (!isPluginModelPickerRoute(route)) return { handled: true, accepted: false };
    if (route.agentDeviceId && !pending.request.allowRemote) return { handled: true, accepted: false };
    const selection = { ...route };
    let available = false;
    try {
      available = await this.deps.available(selection);
    } catch {
      /* Keep the picker open for retry. */
    }
    if (this.pending !== pending) return { handled: false, accepted: false };
    if (!pending.current()) {
      pending.finish({
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: 'Plugin or account changed',
      });
      return { handled: true, accepted: false };
    }
    if (!available) return { handled: true, accepted: false };
    pending.finish({ ok: true, route: selection });
    return { handled: true, accepted: true };
  }

  cancel(ghostId?: string): void {
    if (this.pending && (ghostId === undefined || this.pending.request.ghostId === ghostId))
      this.pending.finish({
        ok: false,
        errorCode: 'CANCELLED',
        message: 'Model selection was cancelled',
      });
  }
}
