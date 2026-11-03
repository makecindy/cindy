import { randomUUID } from 'node:crypto';
import type { GhostPipeCompanionsChanged } from '../../shared/ghost.js';
import type { PluginCompanion, PluginCompanionAvatar, PluginCompanionReply } from '../../shared/pluginCompanions.js';

export interface PluginCompanionAdapter {
  list(guard: () => void): Promise<PluginCompanion[]>;
  avatar(companionId: string, guard: () => void): Promise<PluginCompanionAvatar>;
  reply(companionId: string, guard: () => void): Promise<PluginCompanionReply | null>;
  /** Rejects with TARGET_UNAVAILABLE for a companion or request the plugin could not list. */
  open(companionId: string, interactionRef: string | undefined, guard: () => void): Promise<void>;
}

/** The approved plugin making the request; the pipe checks agent.companions before it reaches here. */
export interface PluginCompanionContext {
  ghostId: string;
  /** Re-checks the owner, the logic page and the approval revision; call after every await. */
  assertAuthorized(): void;
}

const COMPANION_ERROR_CODES = new Set(['PERMISSION_DENIED', 'HOST_NOT_READY', 'INVALID_PARAMS', 'TARGET_UNAVAILABLE']);
const MAX_ID_LENGTH = 4096;

const fail = (code: string) => ({ ok: false as const, error: { code, message: code, retryable: false } });
const idParam = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' && value.length <= MAX_ID_LENGTH ? value : null;

/** `cindy.companions` (agent.companions): roster, live status, pending request summaries and the latest reply. */
export async function handlePluginCompanionRequest(
  adapter: PluginCompanionAdapter | null,
  hub: CompanionWatchHub | null,
  payload: unknown,
  ctx: PluginCompanionContext,
) {
  if (!adapter || !hub) return fail('HOST_NOT_READY');
  const request = payload as { kind?: unknown; companionId?: unknown; interactionRef?: unknown; subscriptionId?: unknown } | null;
  try {
    switch (request?.kind) {
      case 'capabilities':
        return { ok: true as const, data: { version: 1 } };
      case 'list': {
        const companions = await adapter.list(ctx.assertAuthorized);
        ctx.assertAuthorized();
        return { ok: true as const, data: { companions, observedAt: Date.now() } };
      }
      case 'avatar': {
        const companionId = idParam(request.companionId);
        if (!companionId) return fail('INVALID_PARAMS');
        const avatar = await adapter.avatar(companionId, ctx.assertAuthorized);
        ctx.assertAuthorized();
        return { ok: true as const, data: avatar };
      }
      case 'reply': {
        const companionId = idParam(request.companionId);
        if (!companionId) return fail('INVALID_PARAMS');
        const reply = await adapter.reply(companionId, ctx.assertAuthorized);
        ctx.assertAuthorized();
        return { ok: true as const, data: { reply } };
      }
      case 'open': {
        const companionId = idParam(request.companionId);
        const ref = request.interactionRef === undefined ? undefined : idParam(request.interactionRef);
        if (!companionId || ref === null) return fail('INVALID_PARAMS');
        await adapter.open(companionId, ref, ctx.assertAuthorized);
        return { ok: true as const, data: { opened: true } };
      }
      case 'watch':
        return { ok: true as const, data: { subscriptionId: hub.watch(ctx.ghostId) } };
      case 'unwatch': {
        const subscriptionId = idParam(request.subscriptionId);
        if (!subscriptionId) return fail('INVALID_PARAMS');
        return { ok: true as const, data: { stopped: hub.unwatch(ctx.ghostId, subscriptionId) } };
      }
      default:
        return fail('INVALID_PARAMS');
    }
  } catch (error) {
    const code = (error as { code?: unknown })?.code ?? (error instanceof Error ? error.message : '');
    return fail(COMPANION_ERROR_CODES.has(String(code)) ? String(code) : 'HOST_NOT_READY');
  }
}

/** At most one change notice per plugin per second; a heartbeat covers roster edits nothing else signals. */
export const COMPANION_PUSH_INTERVAL_MS = 1000;
export const COMPANION_HEARTBEAT_MS = 5000;

/**
 * One subscription per plugin. Changes from anywhere (island activity, homes, other computers, the heartbeat)
 * are merged into `companions-changed` notices that carry no content; the plugin re-reads with `list`.
 * A plugin that lost its approval or its logic page is dropped.
 */
export function createCompanionWatchHub(deps: {
  send(ghostId: string, payload: GhostPipeCompanionsChanged): boolean;
  approved(ghostId: string): boolean;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const watchers = new Map<string, { subscriptionId: string; seq: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let lastFlush = 0;

  const refresh = () => {
    if (watchers.size && !heartbeat) {
      heartbeat = setInterval(() => hub.invalidate(), COMPANION_HEARTBEAT_MS);
      heartbeat.unref?.();
    } else if (!watchers.size && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const flush = () => {
    timer = null;
    lastFlush = now();
    for (const [ghostId, watcher] of watchers) {
      const delivered = deps.approved(ghostId) &&
        deps.send(ghostId, { type: 'companions-changed', subscriptionId: watcher.subscriptionId, seq: ++watcher.seq });
      if (!delivered) watchers.delete(ghostId);
    }
    refresh();
  };

  const hub = {
    watch(ghostId: string): string {
      const watcher = { subscriptionId: randomUUID(), seq: 0 };
      watchers.set(ghostId, watcher);
      refresh();
      return watcher.subscriptionId;
    },
    unwatch(ghostId: string, subscriptionId: string): boolean {
      if (watchers.get(ghostId)?.subscriptionId !== subscriptionId) return false;
      watchers.delete(ghostId);
      refresh();
      return true;
    },
    /** Something a watcher may show changed. */
    invalidate(): void {
      if (!watchers.size || timer) return;
      timer = setTimeout(flush, Math.max(0, lastFlush + COMPANION_PUSH_INTERVAL_MS - now()));
      timer.unref?.();
    },
    /** Approvals or the account changed: drop plugins that may no longer watch. */
    revalidate(): void {
      for (const ghostId of [...watchers.keys()]) if (!deps.approved(ghostId)) watchers.delete(ghostId);
      refresh();
    },
    dispose(): void {
      watchers.clear();
      if (timer) clearTimeout(timer);
      timer = null;
      refresh();
    },
  };
  return hub;
}

export type CompanionWatchHub = ReturnType<typeof createCompanionWatchHub>;
