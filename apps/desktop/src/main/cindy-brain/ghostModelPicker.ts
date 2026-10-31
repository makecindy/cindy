import { randomUUID } from 'node:crypto';
import {
  connectedProvidersForAgent,
  isModelSelectableForNewRoute,
  type ProviderView,
} from '@cindy/model-providers';
import { GHOST_PICK_MIN_INTERVAL_MS, type InstalledGhost } from '../../shared/ghost.js';
import {
  isPluginModelPickerRoute,
  type PluginModelPickerRequest,
  type PluginModelPickerResult,
} from '../../shared/pluginModelPicker.js';
import type { PluginTaskRoute } from '../../shared/pluginTasks.js';

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

export interface PluginModelPickerTarget {
  id: string | number;
  isCurrent?(): boolean;
  send(request: PluginModelPickerRequest, cancel: () => void): boolean;
  dismiss(requestId: string): void;
}

/** Recheck the exact route without discovery, credential claims or inference. */
export function isPluginModelPickerRouteAvailable(
  route: PluginTaskRoute,
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

interface Pending {
  request: PluginModelPickerRequest;
  target: PluginModelPickerTarget;
  current(): boolean;
  finish(result: PluginModelPickerResult): void;
}

/** One Host-owned picker, bound to its originating installation, page and answering window. */
export class GhostModelPicker {
  private pending?: Pending;
  private readonly lastAttempt = new Map<string, number>();

  constructor(
    private readonly deps: {
      getGhost(id: string): InstalledGhost | null;
      installation(id: string): string | null;
      target(ghostId: string, mobilePageId?: string): PluginModelPickerTarget | null;
      available(route: PluginTaskRoute): Promise<boolean>;
      timeoutMs?: number;
      now?(): number;
    },
  ) {}

  async request(
    ghostId: string,
    raw: unknown = {},
    isCurrent = () => true,
    signal?: AbortSignal,
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
      Object.keys(options).some((k) => !['type', 'initial', 'mobilePageId'].includes(k)) ||
      (options.initial !== undefined && !isPluginModelPickerRoute(options.initial)) ||
      (options.mobilePageId !== undefined &&
        (typeof options.mobilePageId !== 'string' ||
          !options.mobilePageId ||
          options.mobilePageId.length > 128))
    )
      return fail('INVALID_REQUEST', 'Invalid model picker options');
    if (this.pending) return fail('BUSY', 'A model picker is already open');
    const now = this.deps.now?.() ?? Date.now(),
      last = this.lastAttempt.get(ghostId);
    this.lastAttempt.set(ghostId, now);
    if (last !== undefined && now - last < GHOST_PICK_MIN_INTERVAL_MS)
      return fail('RATE_LIMITED', 'Please wait before opening the model picker again');
    let target: PluginModelPickerTarget | null;
    try {
      target = this.deps.target(ghostId, options.mobilePageId as string | undefined);
    } catch {
      target = null;
    }
    if (!target) return fail('UNAVAILABLE', 'No active Host page is available');
    const requestCurrent = () => current() && (target.isCurrent?.() ?? true);
    const request: PluginModelPickerRequest = {
      requestId: randomUUID(),
      ghostId,
      ghostName: ghost.manifest.name,
      ...(options.initial ? { initial: { ...(options.initial as PluginTaskRoute) } } : {}),
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
