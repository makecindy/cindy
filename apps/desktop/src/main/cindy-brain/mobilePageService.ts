import { MobilePluginPreview, type MobilePreviewReader } from './mobilePreview.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  PLUGIN_COLLECTION,
  PLUGIN_PAGE_MAX_MESSAGE_BYTES,
  isPluginPageSurface,
  parsePluginMobileDeclaration,
  type PluginPageDocument,
  type PluginPagePoll,
  type PluginPageSurface,
  type PluginPageAsset,
  type PluginPageFile,
  type RemoteCollectionItem,
} from '@cindy/device-link';
import type { InstalledGhost } from '../../shared/ghost.js';
import type { GhostConfirmShowParams } from './confirmSlot.js';
import {
  RemoteResourceRegistryError,
  type RemoteResourceProvider,
} from '../device-link/remoteResourceRegistry.js';

interface Page {
  id: string;
  controller: string;
  plugin: string;
  revision: string;
  surface: PluginPageSurface | 'interaction';
  currentOwner(): boolean;
  currentController(): boolean;
  active: boolean;
  sourceHidden?: boolean;
  touchedAt: number;
  unreadAt?: number;
  files: PluginPageFile[];
  confirms: Map<
    string,
    {
      value: PluginPagePoll['confirms'][number];
      answer(value: boolean): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  notices: PluginPagePoll['notifications'];
  answered: Map<string, boolean>;
  directory?: {
    value: import('@cindy/device-link').PluginDirectoryRequest;
    answer(value: string | null): void;
    timer: ReturnType<typeof setTimeout>;
    answering: boolean;
  };
  directoryAnswers?: Map<string, string>;
  intents?: import('@cindy/device-link').PluginNativeIntent[];
  previews?: Map<string, MobilePluginPreview>;
}
interface Dependencies {
  list(): InstalledGhost[];
  revision(ghost: InstalledGhost): string;
  captureOwner(): () => boolean;
  captureController(controllerId: string): () => boolean;
  unread(id: string): { at: number; summary?: string } | null;
  clearUnread(id: string, seenAt: number): void;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  bundle(ghost: InstalledGhost, entry: string): Promise<PluginPageFile[]>;
  asset(ghost: InstalledGhost, file: PluginPageFile, offset: number): Promise<PluginPageAsset>;
  connect(ghost: InstalledGhost, pageId: string, channels: string[]): Promise<void>;
  post(ghost: InstalledGhost, pageId: string, channel: string, data: unknown): Promise<void>;
  poll(ghost: InstalledGhost, pageId: string, after: number): Promise<PluginPagePoll['events']>;
  disconnect(pluginId: string, pageId: string): Promise<void>;
  fetch(
    ghost: InstalledGhost,
    pathname: string,
    method: string,
    body?: string,
    offset?: number,
    revision?: string,
  ): Promise<import('@cindy/device-link').PluginPageFetchResult>;
  fetchPreview?: MobilePreviewReader;
  resolveMedia?(
    ghostId: string,
    url: string,
    current: () => boolean,
  ): Promise<{ path: string; mediaKind: 'image' | 'video' } | null>;
  validateDirectory?(path: string): Promise<string>;
  taskSettings?: {
    read(id: string, revision: string): import('@cindy/device-link').PluginTaskPreferences;
    update(
      id: string,
      revision: string,
      input: Record<string, unknown>,
      assertCurrent: () => void,
    ): Promise<import('@cindy/device-link').PluginTaskPreferences>;
  };
  now?(): number;
}
const fail = (message = 'Plugin page is no longer available'): never => {
  throw new RemoteResourceRegistryError('NOT_FOUND', message);
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A page lease belongs to one authenticated controller, account and installed revision.
 * Writes are never replayed after reconnect. Reading/polling does not acknowledge unread content. */
export class MobilePluginPages {
  private readonly pages = new Map<string, Page>();
  constructor(private readonly deps: Dependencies) {}
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private ghost(id: string) {
    return this.deps.list().find((g) => g.manifest.id === id) ?? fail();
  }
  private check(page: Page, enabled = true): InstalledGhost {
    const ghost = this.ghost(page.plugin);
    if (
      !page.currentOwner() ||
      !page.currentController() ||
      this.deps.revision(ghost) !== page.revision ||
      (enabled && !ghost.enabled)
    ) {
      this.close(page);
      return fail();
    }
    return ghost;
  }
  private page(id: unknown, controller: string): Page {
    if (typeof id !== 'string') return fail();
    const page = this.pages.get(id);
    if (!page || page.controller !== controller) return fail();
    if (this.now() - page.touchedAt > 120_000) {
      this.close(page);
      return fail();
    }
    this.check(page);
    page.touchedAt = this.now();
    return page;
  }
  private close(page: Page) {
    this.pages.delete(page.id);
    this.cancelDirectory(page);
    page.previews?.clear();
    for (const pending of page.confirms.values()) {
      clearTimeout(pending.timer);
      pending.answer(false);
    }
    page.confirms.clear();
    void this.deps.disconnect(page.plugin, page.id).catch(() => {});
  }
  invalidate() {
    for (const page of this.pages.values()) {
      try {
        this.check(page);
      } catch {
        this.close(page);
      }
    }
  }
  private cancelDirectory(page: Page) {
    if (!page.directory) return;
    clearTimeout(page.directory.timer);
    page.directory.answer(null);
    page.directory = undefined;
  }
  captureSource(pageId: unknown, pluginId: string): () => boolean {
    if (typeof pageId !== 'string') return fail();
    const page = this.pages.get(pageId);
    if (!page || page.plugin !== pluginId || !page.active || page.sourceHidden) return fail();
    this.check(page);
    return () => {
      try {
        this.page(pageId, page.controller);
        return page.active && !page.sourceHidden;
      } catch {
        return false;
      }
    };
  }
  async chooseDirectory(
    pageId: string,
    pluginId: string,
    purpose: string | null,
  ): Promise<string | null> {
    const current = this.captureSource(pageId, pluginId),
      page = this.pages.get(pageId)!;
    if (!current() || page.directory || !this.deps.validateDirectory) return fail();
    const ghost = this.check(page),
      id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.cancelDirectory(page), 90_000);
      page.directory = {
        timer,
        answer: resolve,
        answering: false,
        value: {
          id,
          pluginId,
          ghostName: ghost.manifest.name,
          purpose,
          expiresAt: this.now() + 90_000,
        },
      };
    });
  }
  present(
    pageId: string,
    pluginId: string,
    intent:
      | { kind: 'task'; taskId: string }
      | { kind: 'preview'; url: string }
      | { kind: 'schedule'; name: string; prompt: string; intervalMs?: number }
      | { kind: 'media'; path: string; mediaKind: 'image' | 'video' },
  ): boolean {
    try {
      if (!this.captureSource(pageId, pluginId)()) return false;
      const page = this.pages.get(pageId)!,
        ghost = this.check(page);
      if ((page.intents?.length ?? 0) >= 8) return false;
      (page.intents ??= []).push({
        ...intent,
        id: randomUUID(),
        pluginId,
        ghostName: ghost.manifest.name,
      });
      return true;
    } catch {
      return false;
    }
  }
  notify(pageId: string, pluginId: string, text: string): boolean {
    this.sweep();
    const page = this.pages.get(pageId);
    if (
      !page ||
      !page.active ||
      page.sourceHidden ||
      page.plugin !== pluginId ||
      !page.currentOwner()
    )
      return false;
    try {
      this.check(page);
    } catch {
      return false;
    }
    page.notices.push({ id: randomUUID(), text });
    if (page.notices.length > 16) page.notices.shift();
    return true;
  }
  assertInteraction(pageId: unknown, pluginId: string, controllerId: string) {
    const page = this.page(pageId, controllerId);
    if (
      page.plugin !== pluginId ||
      page.surface !== 'interaction' ||
      !page.active ||
      page.sourceHidden
    )
      return fail();
  }
  private sweep() {
    for (const page of this.pages.values()) {
      if (
        !page.currentOwner() ||
        !page.currentController() ||
        this.now() - page.touchedAt > 120_000
      )
        this.close(page);
    }
  }
  /** Explicit page context supplied by a plugin handling that page's business request.
   * A missing/invalid context never falls back to a different phone. */
  async confirm(pageId: string, params: GhostConfirmShowParams): Promise<boolean> {
    const page = this.pages.get(pageId);
    if (!page || !page.active || page.sourceHidden || page.plugin !== params.ghostId) return fail();
    this.check(page);
    if (this.now() - page.touchedAt > 120_000 || page.confirms.size) return fail();
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        page.confirms.delete(id);
        resolve(false);
      }, 90_000);
      page.confirms.set(id, {
        timer,
        answer: resolve,
        value: {
          id,
          pluginId: params.ghostId,
          title: params.ghostName,
          body: params.body,
          confirmText: params.confirmText,
          cancelText: params.cancelText,
          danger: params.danger,
          expiresAt: this.now() + 90_000,
        },
      });
    });
  }
  private item(ghost: InstalledGhost): RemoteCollectionItem {
    const m = ghost.manifest;
    const mobile = parsePluginMobileDeclaration(m.mobile);
    const unread = ghost.enabled ? this.deps.unread(m.id) : null;
    return {
      ref: { collectionId: PLUGIN_COLLECTION, kind: 'plugin', id: m.id },
      revision: this.deps.revision(ghost),
      display: {
        title: m.name,
        subtitle: m.description ?? '',
        preview: unread?.summary,
        ...(unread
          ? { timestamp: unread.at, badges: [{ accessibilityLabel: 'Unread', tone: 'positive' }] }
          : {}),
        ...(ghost.iconDataUrl
          ? {
              avatar: { kind: 'asset', value: ghost.iconDataUrl, fallbackText: m.name.slice(0, 1) },
            }
          : {}),
        status: { label: ghost.enabled ? 'enabled' : 'disabled', tone: 'neutral' },
      },
      links: [],
      actions: [
        ...(['panel', 'mainView', 'settings'] as const).flatMap((surface) => {
          const declared =
            surface === 'panel'
              ? m.panel?.html
              : surface === 'mainView'
                ? m.mainView?.html
                : m.settingsHtml;
          const entry = declared ? (mobile?.[surface] ?? declared) : undefined;
          return mobile && entry
            ? [{ id: `open:${surface}`, label: surface, disabled: !ghost.enabled }]
            : [];
        }),
        { id: ghost.enabled ? 'disable' : 'enable', label: ghost.enabled ? 'Disable' : 'Enable' },
      ],
    };
  }
  provider(): RemoteResourceProvider {
    return {
      collection: {
        id: PLUGIN_COLLECTION,
        resourceKind: 'plugin',
        title: { fallback: 'Plugins', translations: { 'zh-CN': '插件' } },
        icon: { name: 'puzzle', fallbackText: 'P' },
      },
      list: async (_ctx, request) => {
        this.sweep();
        const q = request.query?.toLocaleLowerCase();
        const items = this.deps
          .list()
          .filter(
            (g) =>
              !q ||
              `${g.manifest.name} ${g.manifest.description ?? ''}`.toLocaleLowerCase().includes(q),
          )
          .map((g) => this.item(g));
        return {
          collectionId: PLUGIN_COLLECTION,
          revision: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
          items,
        };
      },
      get: async (_ctx, request) => {
        const ghost = this.ghost(request.ref.id);
        const item = this.item(ghost);
        return {
          ...item,
          blocks: [
            {
              id: 'about',
              primitive: 'markdown',
              fallbackMarkdown: ghost.manifest.description ?? '',
            },
            { id: 'version', primitive: 'status', fallbackMarkdown: ghost.manifest.version },
            {
              id: 'capabilities',
              primitive: 'plugin-capabilities',
              fallbackMarkdown: '',
              data: {
                tools:
                  ghost.manifest.tools?.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                  })) ?? [],
                tasks: Boolean(ghost.manifest.agent?.tasks || ghost.manifest.agent?.errand),
                mobile: parsePluginMobileDeclaration(ghost.manifest.mobile) !== null,
              },
            },
          ],
        };
      },
      invoke: async (context, request) => {
        this.sweep();
        const input = record(request.input);
        const id = request.resourceRef?.id;
        if (!id) return fail();
        if (request.actionId === 'task-settings:get' || request.actionId === 'task-settings:set') {
          const ghost = this.ghost(id),
            settings = this.deps.taskSettings;
          if (
            !settings ||
            !ghost.enabled ||
            !(ghost.manifest.agent?.tasks || ghost.manifest.agent?.errand)
          )
            return fail();
          const revision = this.deps.revision(ghost),
            owner = this.deps.captureOwner(),
            peer = this.deps.captureController(context.controllerDeviceId);
          const assertCurrent = () => {
            const current = this.ghost(id);
            if (!owner() || !peer() || !current.enabled || this.deps.revision(current) !== revision)
              return fail();
          };
          assertCurrent();
          const result =
            request.actionId === 'task-settings:get'
              ? settings.read(id, revision)
              : await settings.update(id, revision, input, assertCurrent);
          assertCurrent();
          return { effects: [], result };
        }
        if (request.actionId === 'open-interaction') {
          const ghost = this.ghost(id);
          if (!ghost.enabled || !ghost.manifest.card || this.pages.size >= 32) return fail();
          const page: Page = {
            id: randomUUID(),
            plugin: id,
            controller: context.controllerDeviceId,
            revision: this.deps.revision(ghost),
            currentOwner: this.deps.captureOwner(),
            currentController: this.deps.captureController(context.controllerDeviceId),
            surface: 'interaction',
            active: true,
            touchedAt: this.now(),
            files: [],
            confirms: new Map(),
            notices: [],
            answered: new Map(),
          };
          this.pages.set(page.id, page);
          return { effects: [], result: { pageId: page.id } };
        }
        if (request.actionId === 'enable' || request.actionId === 'disable') {
          const valid = this.deps.captureOwner();
          this.ghost(id);
          await this.deps.setEnabled(id, request.actionId === 'enable');
          if (!valid()) return fail();
          if (request.actionId === 'disable')
            for (const page of this.pages.values()) if (page.plugin === id) this.close(page);
          return { effects: [{ kind: 'refresh-collection', collectionId: PLUGIN_COLLECTION }] };
        }
        if (request.actionId.startsWith('open:')) {
          const surface = request.actionId.slice(5);
          if (!isPluginPageSurface(surface)) return fail();
          const ghost = this.ghost(id),
            mobile = parsePluginMobileDeclaration(ghost.manifest.mobile);
          const declared =
            surface === 'panel'
              ? ghost.manifest.panel?.html
              : surface === 'mainView'
                ? ghost.manifest.mainView?.html
                : ghost.manifest.settingsHtml;
          const entry = declared ? (mobile?.[surface] ?? declared) : undefined;
          if (!ghost.enabled || !mobile || !entry) return fail('Plugin has no mobile page');
          if (this.pages.size >= 32)
            throw new RemoteResourceRegistryError('INTERNAL', 'Too many open plugin pages');
          const page: Page = {
            id: randomUUID(),
            plugin: id,
            controller: context.controllerDeviceId,
            revision: this.deps.revision(ghost),
            currentOwner: this.deps.captureOwner(),
            currentController: this.deps.captureController(context.controllerDeviceId),
            surface,
            active: true,
            touchedAt: this.now(),
            unreadAt: this.deps.unread(id)?.at,
            files: [],
            confirms: new Map(),
            notices: [],
            answered: new Map(),
          };
          const files = await this.deps.bundle(ghost, entry);
          this.check(page);
          page.files = files;
          try {
            await this.deps.connect(ghost, page.id, mobile.channels);
            this.check(page);
          } catch (error) {
            this.close(page);
            throw error;
          }
          this.pages.set(page.id, page);
          const result: PluginPageDocument = {
            pageId: page.id,
            pluginId: id,
            title: ghost.manifest.name,
            surface,
            entry,
            channels: mobile.channels,
            files,
            unreadAt: page.unreadAt,
          };
          return { effects: [], result };
        }
        const page = this.page(input.pageId, context.controllerDeviceId);
        if (page.plugin !== id) return fail();
        const ghost = this.check(page);
        switch (request.actionId) {
          case 'asset': {
            const file = page.files.find((f) => f.path === input.path);
            if (
              !file ||
              !Number.isSafeInteger(input.offset) ||
              (input.offset as number) < 0 ||
              (input.offset as number) > file.size
            )
              return fail();
            const result = await this.deps.asset(ghost, file, input.offset as number);
            this.check(page);
            return { effects: [], result };
          }
          case 'suspend': {
            page.active = false;
            // Suspension removes native intents; their cover must not survive resume.
            page.sourceHidden = false;
            this.cancelDirectory(page);
            page.intents = [];
            page.previews?.clear();
            for (const pending of page.confirms.values()) {
              clearTimeout(pending.timer);
              pending.answer(false);
            }
            page.confirms.clear();
            page.notices.length = 0;
            return { effects: [] };
          }
          case 'close':
            this.close(page);
            return { effects: [] };
          case 'seen': {
            if (!page.active || page.sourceHidden) return fail();
            if (
              !page.active ||
              page.surface !== 'panel' ||
              typeof input.seenAt !== 'number' ||
              input.seenAt !== page.unreadAt
            )
              return fail();
            this.deps.clearUnread(id, input.seenAt);
            return { effects: [] };
          }
          case 'post': {
            if (!page.active || page.sourceHidden) return fail();
            if (page.surface === 'interaction') return fail();
            const mobile = parsePluginMobileDeclaration(ghost.manifest.mobile);
            if (
              typeof input.channel !== 'string' ||
              !mobile?.channels.includes(input.channel) ||
              Buffer.byteLength(JSON.stringify(input.data) ?? '') > PLUGIN_PAGE_MAX_MESSAGE_BYTES
            )
              return fail();
            await this.deps.post(ghost, page.id, input.channel, input.data);
            this.check(page);
            return { effects: [] };
          }
          case 'poll': {
            page.active = true;
            if (!Number.isSafeInteger(input.after) || (input.after as number) < 0) return fail();
            const events =
              page.surface === 'interaction'
                ? []
                : await this.deps.poll(ghost, page.id, input.after as number);
            this.check(page);
            page.unreadAt = this.deps.unread(id)?.at;
            const result: PluginPagePoll = {
              events,
              confirms: [...page.confirms.values()].map((p) => p.value),
              notifications: page.notices.splice(0),
              unreadAt: page.unreadAt,
              directories: page.directory ? [page.directory.value] : [],
              intents: page.intents ?? [],
            };
            return { effects: [], result };
          }
          case 'cover': {
            if (typeof input.hidden !== 'boolean' || !page.active) return fail();
            page.sourceHidden = input.hidden;
            if (input.hidden) {
              for (const pending of page.confirms.values()) {
                clearTimeout(pending.timer);
                pending.answer(false);
              }
              page.confirms.clear();
            }
            return { effects: [] };
          }
          case 'media:open': {
            if (
              !page.active ||
              page.sourceHidden ||
              !this.deps.resolveMedia ||
              typeof input.url !== 'string'
            )
              return fail();
            const current = this.captureSource(page.id, id);
            const media = await this.deps.resolveMedia(id, input.url, current);
            if (!current() || !media) return fail();
            this.present(page.id, id, { kind: 'media', ...media });
            return { effects: [] };
          }
          case 'preview:fetch': {
            if (!page.active || !this.deps.fetchPreview || typeof input.intentId !== 'string')
              return fail();
            const intent = page.intents?.find(
              (item) => item.id === input.intentId && item.kind === 'preview',
            );
            if (!intent || intent.kind !== 'preview') return fail();
            page.previews ??= new Map();
            let preview = page.previews.get(intent.id);
            if (!preview) {
              preview = new MobilePluginPreview(intent.url, this.deps.fetchPreview);
              page.previews.set(intent.id, preview);
            }
            const result = await preview.fetch(ghost, input, () => {
              this.check(page);
              if (!page.active || !page.intents?.some((item) => item.id === intent.id))
                return fail();
            });
            return { effects: [], result };
          }
          case 'intent:ack': {
            if (!page.active || typeof input.intentId !== 'string') return fail();
            // Receipt acknowledgement only; it never claims that a task or automation was created.
            page.intents = page.intents?.filter((intent) => intent.id !== input.intentId);
            page.previews?.delete(input.intentId);
            return { effects: [] };
          }
          case 'answer-directory': {
            if (
              !page.active ||
              typeof input.requestId !== 'string' ||
              !(
                input.path === null ||
                (typeof input.path === 'string' &&
                  input.path.length > 0 &&
                  input.path.length <= 4096)
              )
            )
              return fail();
            const receipt = createHash('sha256').update(JSON.stringify(input.path)).digest('hex');
            const previous = page.directoryAnswers?.get(input.requestId);
            if (previous) {
              if (previous !== receipt) return fail();
              return { effects: [] };
            }
            const pending = page.directory;
            if (
              !pending ||
              pending.value.id !== input.requestId ||
              pending.answering ||
              pending.value.expiresAt <= this.now()
            )
              return fail();
            pending.answering = true;
            try {
              const path =
                input.path === null
                  ? null
                  : await this.deps.validateDirectory!(input.path as string);
              this.check(page);
              if (
                !page.active ||
                page.directory !== pending ||
                pending.value.expiresAt <= this.now()
              )
                return fail();
              clearTimeout(pending.timer);
              page.directory = undefined;
              page.directoryAnswers ??= new Map();
              page.directoryAnswers.set(input.requestId, receipt);
              if (page.directoryAnswers.size > 32)
                page.directoryAnswers.delete(page.directoryAnswers.keys().next().value!);
              pending.answer(path);
              return { effects: [] };
            } finally {
              pending.answering = false;
            }
          }
          case 'answer': {
            const pending =
              typeof input.confirmId === 'string' ? page.confirms.get(input.confirmId) : null;
            if (
              !pending &&
              typeof input.confirmId === 'string' &&
              typeof input.confirmed === 'boolean' &&
              page.answered.get(input.confirmId) === input.confirmed
            )
              return { effects: [] };
            if (
              !pending ||
              typeof input.confirmed !== 'boolean' ||
              pending.value.expiresAt <= this.now()
            )
              return fail();
            page.confirms.delete(pending.value.id);
            clearTimeout(pending.timer);
            page.answered.set(pending.value.id, input.confirmed);
            if (page.answered.size > 32) page.answered.delete(page.answered.keys().next().value!);
            pending.answer(input.confirmed);
            return { effects: [] };
          }
          case 'fetch': {
            if (page.surface === 'interaction') return fail();
            if (
              typeof input.path !== 'string' ||
              !input.path.startsWith('/') ||
              input.path.startsWith('//') ||
              input.path.length > 2048
            )
              return fail();
            const url = new URL(input.path, 'https://plugin.invalid');
            // Credentials/configuration executors use their dedicated trusted UI, never this page transport.
            const method = input.method ?? 'GET';
            if (method !== 'GET' && (!page.active || page.sourceHidden)) return fail();
            if (
              method !== 'GET' &&
              !(url.pathname === '/kv' && (method === 'PUT' || method === 'POST'))
            )
              return fail();
            const file = /^\/(?:library|media)\/[^/]/.test(url.pathname);
            if (
              !file &&
              !/^\/(?:kv|app-context|agent-models|media-models|gallery)$/.test(url.pathname)
            )
              return fail();
            if (
              input.offset !== undefined &&
              (!file ||
                method !== 'GET' ||
                !Number.isSafeInteger(input.offset) ||
                (input.offset as number) < 0)
            )
              return fail();
            if (
              input.revision !== undefined &&
              (typeof input.revision !== 'string' || input.revision.length > 128)
            )
              return fail();
            if (
              url.pathname.startsWith('/library/') &&
              Number(input.offset) > 0 &&
              typeof input.revision !== 'string'
            )
              return fail();
            if (
              input.body !== undefined &&
              (typeof input.body !== 'string' || input.body.length > 32_000)
            )
              return fail();
            const result = await this.deps.fetch(
              ghost,
              url.pathname + url.search,
              method as string,
              input.body as string | undefined,
              input.offset as number | undefined,
              input.revision as string | undefined,
            );
            this.check(page);
            return { effects: [], result };
          }
          default:
            return fail();
        }
      },
    };
  }
}
