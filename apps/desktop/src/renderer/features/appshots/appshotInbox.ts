import type { AppshotCaptureResult } from '../../../shared/appshots';
import type { AttachedFile } from '@/lib/fileTypes';
import {
  getDraft as getComposerDraft,
  saveDraft as saveComposerDraft,
  type ComposerDraft,
} from '@/lib/composerDraftStore';
import { patchDraft as patchNewMakerDraft } from '@/state/newMakerDraft';
import { NEW_MAKER_DRAFT_KEY } from '../cc-agent/newMakerDraftKeys';

export interface AppshotRouteState {
  writable: boolean;
  local: boolean;
  agentKind: 'cc' | 'codex' | 'pi' | null | undefined;
  sessionId?: string | null;
  remoteHostId?: string | null;
  deviceLinkDeviceId?: string | null;
}

export interface AppshotRouteContext {
  route: AppshotRouteState;
  getDraft: (key: string) => ComposerDraft | undefined;
  saveDraft: (key: string, draft: ComposerDraft) => void;
  patchDraft: (patch: {
    vendor: 'codex';
    workingDir: null;
    remoteHostId: null;
    deviceLinkDeviceId: null;
    deviceLinkDeviceName: null;
    extraDirs: [];
  }) => void;
  navigate: (path: string) => void;
}

export interface AppshotBridgeForInbox {
  listPending: () => Promise<AppshotCaptureResult[]>;
  ack: (captureId: string) => Promise<{ acknowledged: boolean }>;
  onCaptured: (callback: (result: AppshotCaptureResult) => void) => () => void;
}

export function toAppshotAttachment(result: AppshotCaptureResult): AttachedFile {
  const filename = result.image.filename.trim() || `${result.captureId}.png`;
  return {
    id: result.captureId,
    name: filename,
    path: `appshot://${result.captureId}`,
    ext: '.png',
    size: result.image.size,
    category: 'image',
    mimeType: 'image/png',
    url: result.image.url,
    originalName: filename,
    appshot: result.metadata,
  };
}

export function appshotThumbnailLabel(
  metadata: AppshotCaptureResult['metadata'],
  fallbackName: string,
): string {
  const app = metadata.applicationName.trim();
  const title = metadata.windowTitle?.trim() ?? '';
  if (app && title) return `${app} · ${title}`;
  return app || title || fallbackName;
}

export interface ComposerAppshotCaptureContext {
  platform: string | undefined;
  sessionId: string | undefined;
  runtimeAgentKind: 'cc' | 'claude-code' | 'codex' | 'pi' | null | undefined;
  vendorKey: 'cc' | 'codex' | 'pi' | undefined;
  remoteHostId: string | null | undefined;
  deviceLinkDeviceId: string | null | undefined;
  composerMutationLocked: boolean;
}

/**
 * Existing sessions must use their runtime identity. The vendor selector is
 * authoritative only for the explicit `/cc-agent/new` draft route.
 */
export function canCaptureAppshotFromComposer(context: ComposerAppshotCaptureContext): boolean {
  const agentKind = (context.runtimeAgentKind === 'claude-code' ? 'cc' : context.runtimeAgentKind) ?? (
    !context.sessionId && context.vendorKey === 'codex' ? 'codex' : null
  );
  return (
    context.platform === 'darwin' &&
    agentKind === 'codex' &&
    !context.remoteHostId &&
    !context.deviceLinkDeviceId &&
    !context.composerMutationLocked
  );
}

function isCurrentWritableLocalCodex(route: AppshotRouteState): boolean {
  return (
    route.writable === true &&
    route.local === true &&
    route.agentKind === 'codex' &&
    !route.remoteHostId &&
    !route.deviceLinkDeviceId &&
    typeof route.sessionId === 'string' &&
    route.sessionId.length > 0
  );
}

function appendCapture(draft: ComposerDraft | undefined, attachment: AttachedFile): ComposerDraft {
  const existing = draft ?? { text: null, attachments: [] };
  if (
    existing.attachments.some(
      (file) => file.id === attachment.id || file.appshot?.captureId === attachment.appshot?.captureId,
    )
  ) {
    return existing;
  }
  return {
    ...existing,
    attachments: [...existing.attachments, attachment],
    quotes: existing.quotes ?? [],
    browserComments: existing.browserComments ?? [],
  };
}

export async function routeAppshotCapture(
  result: AppshotCaptureResult,
  context: AppshotRouteContext,
): Promise<boolean> {
  const attachment = toAppshotAttachment(result);
  const direct = isCurrentWritableLocalCodex(context.route);
  const key = direct ? context.route.sessionId as string : NEW_MAKER_DRAFT_KEY;
  const current = context.getDraft(key);
  const next = appendCapture(current, attachment);
  if (next === current) return false;

  if (!direct) {
    context.patchDraft({
      vendor: 'codex',
      workingDir: null,
      remoteHostId: null,
      deviceLinkDeviceId: null,
      deviceLinkDeviceName: null,
      extraDirs: [],
    });
  }
  context.saveDraft(key, next);
  if (!direct) context.navigate('/cc-agent/new');
  return true;
}

export interface InstallAppshotInboxOptions {
  api?: AppshotBridgeForInbox;
  route?: (result: AppshotCaptureResult) => Promise<boolean | void>;
  context?: AppshotRouteContext;
}

export interface AppshotInboxHandle {
  ready: Promise<void>;
  flush: () => Promise<void>;
  dispose: () => void;
}

export function installAppshotInbox({
  api = window.electronAPI.appshots,
  route = (result) => routeAppshotCapture(result, {
    route: { writable: false, local: false, agentKind: null },
    getDraft: getComposerDraft,
    saveDraft: saveComposerDraft,
    patchDraft: patchNewMakerDraft,
    navigate: (path) => { window.location.hash = path; },
  }),
}: InstallAppshotInboxOptions = {}): AppshotInboxHandle {
  const acked = new Set<string>();
  const queued = new Map<string, AppshotCaptureResult>();
  const processing = new Set<string>();
  let draining: Promise<void> = Promise.resolve();
  let disposed = false;

  const enqueue = (result: AppshotCaptureResult) => {
    if (disposed || acked.has(result.captureId) || processing.has(result.captureId)) return;
    queued.set(result.captureId, result);
    draining = draining.then(async () => {
      const next = queued.get(result.captureId);
      if (!next || acked.has(next.captureId)) return;
      processing.add(next.captureId);
      try {
        await route(next);
        const acknowledgement = await api.ack(next.captureId);
        if (acknowledgement.acknowledged !== true) {
          return;
        }
        acked.add(next.captureId);
        queued.delete(next.captureId);
      } catch {
        // Keep it queued and unacknowledged. The next bridge event or reload can retry it.
      } finally {
        processing.delete(next.captureId);
      }
    });
  };

  const unsubscribe = api.onCaptured(enqueue);
  const ready = api.listPending().then((pending) => {
    for (const result of pending) enqueue(result);
    return draining;
  });

  return {
    ready,
    flush: () => draining,
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}
