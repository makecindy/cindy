/**
 * Preview-tab casting — main-process side of "this browser tab is being cast
 * to a phone".
 *
 * A cast tab must keep producing frames while the desktop UI hides it (tab in
 * the background, sidebar collapsed, other task, left the chat route). Two
 * things make that safe, both driven from `setCastingTabs`:
 *  1. A registry pin lease per tab, so the renderer pool's LRU never evicts the
 *     guest while someone is watching it.
 *  2. A push to the renderer that actually hosts each guest (the embedded
 *     sidebar or a popped-out tab window), which swaps the tab's hide-by-
 *     `display:none` for a kept-size transparent layer (see the renderer's
 *     `previewCasting` store). Capture itself lives elsewhere.
 *
 * `setCastingTabs` takes the FULL desired set each call (idempotent); the
 * caller never has to diff. Each renderer receives its own full set on change.
 */

import type { WebContents } from 'electron';

import {
  RSB_BROWSER_BRIDGE_PREVIEW_CASTING_CHANNEL,
  type RsbBrowserBridgePreviewCastingPayload,
} from '../../shared/rsbBrowserBridge.js';
import type { TabRegistry } from './registry.js';

interface CastingLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface PreviewCastingControllerOptions {
  registry: TabRegistry;
  /** Renderer that hosts the guest (webview host or native popup owner). */
  resolveOwner: (guest: WebContents) => WebContents | null;
  /**
   * Renderer to tell about a casting tab that has no live guest (never created,
   * destroyed, evicted). That renderer is the only one that can (re)create the
   * guest — it materializes casting tabs even in the background — so without
   * this the cast set would never reach it and a rebuilt tab would stay empty.
   */
  getFallbackHost: () => WebContents | null;
  logger: CastingLogger;
}

interface CastingEntry {
  releaseLease: () => void;
  /** Renderer the tab was last pushed to: its guest's host, else the fallback host. */
  owner: WebContents | null;
}

export interface CastingViewport {
  width: number;
  height: number;
}

export class PreviewCastingController {
  private readonly casting = new Map<string, CastingEntry>();
  /** Phone picture shape per cast tab; only tabs that are casting keep one. */
  private viewports = new Map<string, CastingViewport>();
  private offReport: (() => void) | null = null;

  constructor(private readonly opts: PreviewCastingControllerOptions) {}

  /**
   * A tab can be (re)reported after it was marked casting: the guest was
   * rebuilt (registry.release dropped our lease) or the tab moved between
   * hosts. Re-take the lease and re-target the push. Subscribed on first use,
   * so an idle controller touches nothing on the registry.
   */
  private watchReports(): void {
    if (this.offReport) return;
    const { registry } = this.opts;
    this.offReport = registry.onReport((record) => {
      const entry = this.casting.get(record.tabId);
      if (!entry) return;
      const nextLease = registry.acquirePinLease(record.tabId);
      entry.releaseLease();
      entry.releaseLease = nextLease;
      const previousOwner = entry.owner;
      entry.owner = this.ownerOf(record.tabId);
      this.push(entry.owner);
      if (previousOwner && previousOwner !== entry.owner) this.push(previousOwner);
    });
  }

  /** Replace the casting set. Unknown / unregistered tab ids are allowed (see onReport). */
  setCastingTabs(tabIds: readonly string[]): void {
    const next = new Set(tabIds.filter((id) => typeof id === 'string' && id !== ''));
    const affected = new Set<WebContents>();

    for (const [tabId, entry] of this.casting) {
      if (next.has(tabId)) continue;
      entry.releaseLease();
      this.casting.delete(tabId);
      this.viewports.delete(tabId);
      if (entry.owner) affected.add(entry.owner);
    }
    for (const tabId of next) {
      if (this.casting.has(tabId)) continue;
      this.watchReports();
      const owner = this.ownerOf(tabId);
      this.casting.set(tabId, { releaseLease: this.opts.registry.acquirePinLease(tabId), owner });
      if (owner) affected.add(owner);
    }
    for (const owner of affected) this.push(owner);
  }

  /**
   * Replace the phone picture shapes (full set). A tab that stops being listed gets its own
   * layout back. Shapes of tabs that are not casting are ignored.
   */
  setCastingViewports(viewports: Readonly<Record<string, CastingViewport>>): void {
    const next = new Map<string, CastingViewport>();
    for (const [tabId, viewport] of Object.entries(viewports)) {
      if (
        this.casting.has(tabId) &&
        Number.isFinite(viewport?.width) &&
        Number.isFinite(viewport?.height) &&
        viewport.width > 0 &&
        viewport.height > 0
      )
        next.set(tabId, { width: viewport.width, height: viewport.height });
    }
    const affected = new Set<WebContents>();
    for (const tabId of new Set([...this.viewports.keys(), ...next.keys()])) {
      const before = this.viewports.get(tabId);
      const after = next.get(tabId);
      if (before?.width === after?.width && before?.height === after?.height) continue;
      const owner = this.casting.get(tabId)?.owner;
      if (owner) affected.add(owner);
    }
    this.viewports = next;
    for (const owner of affected) this.push(owner);
  }

  list(): string[] {
    return [...this.casting.keys()];
  }

  /** Phone picture shapes of the casting tabs hosted by `owner`. */
  listViewportsHostedBy(owner: WebContents): Record<string, CastingViewport> {
    const hosted: Record<string, CastingViewport> = {};
    for (const [tabId, viewport] of this.viewports)
      if (this.casting.get(tabId)?.owner === owner) hosted[tabId] = { ...viewport };
    return hosted;
  }

  /** Casting tabs hosted by `owner` — lets a reloaded renderer recover its set on snapshot. */
  listHostedBy(owner: WebContents): string[] {
    return [...this.casting].filter(([, entry]) => entry.owner === owner).map(([id]) => id);
  }

  dispose(): void {
    this.offReport?.();
    this.offReport = null;
    for (const entry of this.casting.values()) entry.releaseLease();
    this.casting.clear();
    this.viewports.clear();
  }

  private ownerOf(tabId: string): WebContents | null {
    const guest = this.opts.registry.getWebContentsByTabId(tabId);
    return (guest && this.opts.resolveOwner(guest)) ?? this.opts.getFallbackHost();
  }

  private push(owner: WebContents | null): void {
    if (!owner || owner.isDestroyed()) return;
    const viewports = this.listViewportsHostedBy(owner);
    const payload: RsbBrowserBridgePreviewCastingPayload = {
      tabIds: this.listHostedBy(owner),
      // Absent when no tab here has a shape: payloads stay what they were without it.
      ...(Object.keys(viewports).length > 0 ? { viewports } : {}),
    };
    try {
      owner.send(RSB_BROWSER_BRIDGE_PREVIEW_CASTING_CHANNEL, payload);
    } catch (err) {
      this.opts.logger.warn('preview-casting push failed', err);
    }
  }
}

let active: PreviewCastingController | null = null;

export function setActivePreviewCastingController(
  controller: PreviewCastingController | null,
): void {
  active?.dispose();
  active = controller;
}

export function getActivePreviewCastingController(): PreviewCastingController | null {
  return active;
}

/**
 * Public API for the Host: mark exactly `tabIds` as being cast. Returns false
 * when the browser bridge is not registered yet (nothing applied), so a stop
 * path never throws.
 */
export function setCastingTabs(tabIds: readonly string[]): boolean {
  if (!active) return false;
  active.setCastingTabs(tabIds);
  return true;
}

/**
 * Public API for the Host: lay exactly these cast tabs out in the given phone picture shapes
 * (CSS px); tabs not listed keep their own layout. Returns false when the browser bridge is
 * not registered yet.
 */
export function setCastingViewports(viewports: Readonly<Record<string, CastingViewport>>): boolean {
  if (!active) return false;
  active.setCastingViewports(viewports);
  return true;
}
