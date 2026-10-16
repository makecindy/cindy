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
  PLUGIN_SETTINGS_ACTION,
  type PluginSettingsRequest,
  type PluginOauthAction,
  type RemoteCollectionItem,
  type PluginConfigurationSummary,
} from '@cindy/device-link';
import { ghostContentKeys, ghostInstallApprovalToken, ghostPermissionItems, ghostTrustLabelKey, type GhostSetupAssessment, type InstalledGhost } from '../../shared/ghost.js';
import { getRemoteOauthContext, notifyOauthCardClosed } from '../plugin-oauth/context.js';
import type { OauthCardBinding } from '../plugin-oauth/transactions.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { resolvePreferredSystemLocale } from '../../shared/locale.js';
import { t } from '../i18n.js';
import { mobilePluginUsage } from './mobilePluginUsage.js';
import { mobilePluginConfiguration } from './mobilePluginConfiguration.js';
import type { GhostConfirmShowParams } from './confirmSlot.js';
import {
  RemoteResourceRegistryError,
  type RemoteResourceProvider,
} from '../device-link/remoteResourceRegistry.js';

interface Page {
  desktopSettings?: true;
  channels?: string[];
  authorizations?: Map<string, { path: string; body?: string; running: boolean; result?: import('@cindy/device-link').PluginPageFetchResult }>;
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
  management?: import('./remotePluginManagement.js').RemotePluginManagement;
  list(): InstalledGhost[];
  listOrder?(): ReadonlyMap<string, NonNullable<RemoteCollectionItem['pluginOrder']>>;
  setupAssessment?(id: string): GhostSetupAssessment;
  configuration?(id: string, assessment?: GhostSetupAssessment): PluginConfigurationSummary;
  runtimeState?(id: string): string;
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
  settingsFetch?(ghost: InstalledGhost, path: string, method: string, body: string | undefined, current: () => boolean, confirmConnection?: (label: string, host: string) => Promise<boolean>): Promise<import('@cindy/device-link').PluginPageFetchResult>;
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
    return this.deps.list().find((g) => installedGhostStoragePart(g) === id) ?? fail();
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
    for (const id of page.authorizations?.keys() ?? []) notifyOauthCardClosed(id);
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
  settingsBinding(action: PluginOauthAction): OauthCardBinding | null {
    if (action.actionId !== PLUGIN_SETTINGS_ACTION || action.expectedRevision !== 0) return null;
    const page = this.pages.get(action.requestId);
    if (!page?.desktopSettings) return null;
    return {
      ghostId: page.plugin,
      controllerDeviceId: page.controller,
      settingsPage: true,
      current: () => {
        try {
          this.page(page.id, page.controller);
          return true;
        } catch {
          return false;
        }
      },
    };
  }
  settingsAuthorizationBinding(action: PluginOauthAction): OauthCardBinding | null {
    if (action.actionId !== 'settings-oauth' || action.expectedRevision !== 0) return null;
    const page = [...this.pages.values()].find(
      (p) => p.desktopSettings && p.authorizations?.has(action.requestId),
    );
    if (!page) return null;
    return {
      ghostId: page.plugin,
      controllerDeviceId: page.controller,
      current: () => {
        try {
          this.page(page.id, page.controller);
          return page.authorizations!.has(action.requestId);
        } catch {
          return false;
        }
      },
    };
  }
  runSettingsAuthorization(action: PluginOauthAction): boolean {
    const binding = this.settingsAuthorizationBinding(action),
      remote = getRemoteOauthContext();
    if (!binding?.current() || !remote || remote.peer !== binding.controllerDeviceId) return false;
    const page = [...this.pages.values()].find((p) => p.authorizations?.has(action.requestId))!;
    const authorization = page.authorizations!.get(action.requestId)!;
    if (authorization.running) return false;
    authorization.running = true;
    const ghost = this.check(page);
    void (async () => {
      try {
        // The original endpoint owns OAuth validation, exchange and persistence.
        const result = await this.deps.settingsFetch!(
          ghost,
          authorization.path,
          'POST',
          authorization.body,
          binding.current,
        );
        if (!binding.current()) throw new Error('PLUGIN_PAGE_CLOSED');
        authorization.result = result;
        remote.finish(
          result.status === 200 &&
            JSON.parse(Buffer.from(result.base64, 'base64').toString()).ok === true,
        );
      } catch {
        if (binding.current())
          authorization.result = {
            status: 200,
            mime: 'application/json',
            base64: Buffer.from(JSON.stringify({ ok: false, error: 'CANCELLED' })).toString(
              'base64',
            ),
          };
        remote.finish(false);
      } finally {
        authorization.body = undefined;
      }
    })();
    return true;
  }
  async settingsRequest(controller: string, request: PluginSettingsRequest): Promise<unknown> {
    const page = this.page(request.id, controller);
    if (!page.desktopSettings) return fail();
    const ghost = this.check(page),
      command = request.command;
    const current = () => {
      try {
        return this.page(page.id, controller) === page;
      } catch {
        return false;
      }
    };
    const done = <T>(value: T): T => {
      if (!current()) return fail();
      return value;
    };
    switch (command.kind) {
      case 'close':
        this.close(page);
        return {};
      case 'asset': {
        const file = page.files.find((f) => f.path === command.path);
        if (!file || command.offset > file.size) return fail();
        return done(await this.deps.asset(ghost, file, command.offset));
      }
      case 'subscribe': {
        const channels = [...new Set([...(page.channels ?? []), ...command.channels])];
        if (channels.length > 16) return fail();
        await this.deps.connect(ghost, page.id, channels);
        page.channels = channels;
        return done({});
      }
      case 'post':
        if (!page.channels?.includes(command.channel)) return fail();
        await this.deps.post(ghost, page.id, command.channel, command.data);
        return done({});
      case 'unsubscribe': {
        const channels = (page.channels ?? []).filter((name) => name !== command.channel);
        await this.deps.connect(ghost, page.id, channels);
        page.channels = channels;
        return done({});
      }
      case 'poll':
        return done({
          events: page.channels?.length ? await this.deps.poll(ghost, page.id, command.after) : [],
          confirms: [...page.confirms.values()].map((p) => p.value),
          notifications: page.notices.splice(0),
          directories: page.directory ? [page.directory.value] : [],
        });
      case 'confirm': {
        const pending = page.confirms.get(command.requestId);
        if (!pending || pending.value.expiresAt <= this.now()) return fail();
        clearTimeout(pending.timer);
        page.confirms.delete(command.requestId);
        pending.answer(command.accepted);
        return {};
      }
      case 'answer-directory':
        await this.answerDirectory(page, command);
        return done({});
      case 'authorization-result': {
        const authorization = page.authorizations?.get(command.requestId);
        if (!authorization?.result) return fail();
        const result = authorization.result;
        page.authorizations!.delete(command.requestId);
        return result;
      }
      case 'authorize': {
        const match = /^\/oauth\/([a-zA-Z0-9_-]+)\/connect$/.exec(command.path);
        if (
          !match ||
          !ghost.manifest.network?.secrets?.some((s) => s.key === match[1] && s.source === 'oauth')
        )
          return fail();
        page.authorizations ??= new Map();
        if (page.authorizations.size >= 4) return fail();
        const id = randomUUID();
        page.authorizations.set(id, { path: command.path, body: command.body, running: false });
        return { requestId: id, actionId: 'settings-oauth', expectedRevision: 0 };
      }
      case 'fetch': {
        if (!command.path.startsWith('/') || command.path.startsWith('//')) return fail();
        const url = new URL(command.path, 'https://plugin.invalid');
        if (
          url.origin !== 'https://plugin.invalid' ||
          url.hash ||
          !/^\/(?:kv|app-context|agent-models|media-models|secrets(?:\/[^/]+)?|oauth(?:\/[^/]+\/(?:client|default|insufficient-scopes|accounts\/[^/]+))?|connections(?:\/[^/]+(?:\/[^/]+)?)?|wake)$/.test(
            url.pathname,
          )
        )
          return fail();
        return done(
          await this.deps.settingsFetch!(
            ghost,
            url.pathname + url.search,
            command.method,
            command.body,
            current,
            (label, host) =>
              this.confirm(page.id, {
                ghostId: page.plugin,
                ghostName: ghost.manifest.name,
                iconDataUrl: ghost.iconDataUrl,
                body:
                  t('settings.ghosts.connections.confirmMessage')
                    .replaceAll('{{name}}', ghost.manifest.name)
                    .replaceAll('{{host}}', host) +
                  '\n\n' +
                  t('settings.ghosts.connections.confirmDetail').replaceAll('{{label}}', label),
                confirmText: t('settings.ghosts.connections.confirmAllow'),
                cancelText: t('settings.ghosts.connections.confirmCancel'),
                danger: false,
              }),
          ),
        );
      }
    }
  }
  private async answerDirectory(
    page: Page,
    input: { requestId?: unknown; path?: unknown },
  ): Promise<void> {
    if (
      !page.active ||
      typeof input.requestId !== 'string' ||
      !(
        input.path === null ||
        (typeof input.path === 'string' && input.path.length > 0 && input.path.length <= 4096)
      )
    )
      return fail();
    const receipt = createHash('sha256').update(JSON.stringify(input.path)).digest('hex');
    const previous = page.directoryAnswers?.get(input.requestId);
    if (previous) {
      if (previous !== receipt) return fail();
      return;
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
        input.path === null ? null : await this.deps.validateDirectory!(input.path as string);
      this.check(page);
      if (!page.active || page.directory !== pending || pending.value.expiresAt <= this.now())
        return fail();
      clearTimeout(pending.timer);
      page.directory = undefined;
      page.directoryAnswers ??= new Map();
      page.directoryAnswers.set(input.requestId, receipt);
      if (page.directoryAnswers.size > 32)
        page.directoryAnswers.delete(page.directoryAnswers.keys().next().value!);
      pending.answer(path);
      return;
    } finally {
      pending.answering = false;
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
  private item(
    ghost: InstalledGhost,
    order?: RemoteCollectionItem['pluginOrder'],
  ): RemoteCollectionItem {
    const m = ghost.manifest;
    const id = installedGhostStoragePart(ghost);
    const mobile = parsePluginMobileDeclaration(m.mobile);
    const unread = ghost.enabled ? this.deps.unread(id) : null;
    return {
      ref: { collectionId: PLUGIN_COLLECTION, kind: 'plugin', id },
      revision: this.deps.revision(ghost),
      ...(order ? { pluginOrder: order } : {}),
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
        {
          id: ghost.enabled ? 'disable' : 'enable',
          label: ghost.enabled ? 'Disable' : 'Enable',
          ...(!ghost.enabled && (ghost.approval.state !== 'approved' || ghost.retirement)
            ? { disabled: true }
            : {}),
        },
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
        ...(this.deps.management
          ? { actions: [{ id: 'management:snapshot', label: 'Manage plugins' }] }
          : {}),
      },
      list: async (_ctx, request) => {
        this.sweep();
        let order: ReturnType<NonNullable<Dependencies['listOrder']>> | undefined;
        try {
          order = this.deps.listOrder?.();
        } catch {
          /* Optional ordering cannot block the list. */
        }
        const q = request.query?.toLocaleLowerCase();
        const items = this.deps
          .list()
          .filter(
            (g) =>
              !q ||
              `${g.manifest.name} ${g.manifest.description ?? ''}`.toLocaleLowerCase().includes(q),
          )
          .map((g) => this.item(g, order?.get(installedGhostStoragePart(g))));
        return {
          collectionId: PLUGIN_COLLECTION,
          revision: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
          items,
        };
      },
      get: async (_ctx, request) => {
        const ghost = this.ghost(request.ref.id);
        const item = this.item(ghost);
        const locale = resolvePreferredSystemLocale([request.client.locale ?? 'en']);
        // Read-only declaration facts and copy shared with PC; no saved values leave Host.
        const permissionText = (key: string, args?: Record<string, string>) =>
          t(`settings.ghosts.perm.${key}`, locale).replace(
            /\{\{(\w+)\}\}/g,
            (match, name: string) => args?.[name] ?? match,
          );
        const permissions = ghostPermissionItems(ghost.manifest)
          .filter((permission) => permission.kind !== 'tool')
          .map((permission) => ({
            title: permissionText(permission.labelKey, permission.labelArgs),
            description: [
              permission.detailKey
                ? permissionText(permission.detailKey, permission.detailArgs)
                : '',
              permission.detail ?? '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          }));
        const detailFacts = [
          {
            key: 'version',
            title: t('settings.ghosts.detail.infoVersion', locale),
            value: 'v' + ghost.manifest.version,
          },
          ...(ghost.manifest.author
            ? [
                {
                  key: 'author',
                  title: t('settings.ghosts.detail.infoAuthor', locale),
                  value: ghost.manifest.author,
                },
              ]
            : []),
          {
            key: 'trust',
            title: t('settings.ghosts.detail.infoTrust', locale),
            value: t('settings.ghosts.trust.' + ghostTrustLabelKey(ghost.trust), locale).replaceAll(
              '{{publisher}}',
              ghost.trust?.publisherName ?? t('settings.ghosts.trust.unknownPublisher', locale),
            ),
          },
          {
            key: 'identifier',
            title: t('settings.ghosts.detail.infoId', locale),
            value: ghost.manifest.id,
          },
          {
            key: 'contents',
            title: t('settings.ghosts.detail.infoContents', locale),
            value: ghostContentKeys(ghost.manifest)
              .map((key) => t('settings.ghosts.contents.' + key, locale))
              .join(' · '),
          },
          {
            key: 'panel',
            title: t('settings.ghosts.detail.infoPanel', locale),
            value: t(
              ghost.manifest.panel
                ? 'settings.ghosts.contents.panel'
                : 'settings.ghosts.detail.panelNone',
              locale,
            ),
          },
          ...(ghost.dir
            ? [
                {
                  key: 'location',
                  title: t('settings.ghosts.detail.infoLocation', locale),
                  value: ghost.dir,
                },
              ]
            : []),
        ];
        let assessment: GhostSetupAssessment | undefined;
        try {
          assessment = this.deps.setupAssessment?.(installedGhostStoragePart(ghost));
        } catch {
          // A failed read is unknown, never a fabricated missing configuration.
        }
        let configuration = mobilePluginConfiguration(ghost.manifest, undefined, assessment);
        try {
          configuration =
            this.deps.configuration?.(installedGhostStoragePart(ghost), assessment) ??
            configuration;
        } catch {
          // A failed configuration read retains declarations with unknown status.
        }
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
                    description: tool.description ?? '',
                  })) ?? [],
                permissions,
                details: detailFacts,
                tasks: Boolean(ghost.manifest.agent?.tasks || ghost.manifest.agent?.errand),
                mobile: parsePluginMobileDeclaration(ghost.manifest.mobile) !== null,
                usage: mobilePluginUsage(
                  ghost,
                  assessment,
                  this.deps.runtimeState?.(installedGhostStoragePart(ghost)),
                  configuration,
                ),
              },
            },
          ],
        };
      },
      invoke: async (context, request) => {
        this.sweep();
        if (request.actionId.startsWith('management:')) {
          if (!this.deps.management)
            throw new RemoteResourceRegistryError(
              'UNSUPPORTED_CAPABILITY',
              'Update Cindy on the target computer',
            );
          return this.deps.management.invoke(context.controllerDeviceId, request);
        }
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
        if (request.actionId === 'settings:open') {
          const ghost = this.ghost(id);
          if (
            !this.deps.settingsFetch ||
            !ghost.enabled ||
            !ghost.manifest.settingsHtml ||
            input.expectedInstalledApproval !== ghostInstallApprovalToken(ghost.approval) ||
            this.pages.size >= 32
          )
            return fail();
          const page: Page = {
            id: randomUUID(),
            plugin: id,
            controller: context.controllerDeviceId,
            revision: this.deps.revision(ghost),
            currentOwner: this.deps.captureOwner(),
            currentController: this.deps.captureController(context.controllerDeviceId),
            surface: 'settings',
            desktopSettings: true,
            active: true,
            touchedAt: this.now(),
            files: [],
            confirms: new Map(),
            notices: [],
            answered: new Map(),
          };
          this.check(page);
          page.files = await this.deps.bundle(ghost, ghost.manifest.settingsHtml);
          this.check(page);
          if (this.pages.size >= 32) return fail();
          this.pages.set(page.id, page);
          return {
            effects: [],
            result: {
              pageId: page.id,
              pluginId: id,
              manifestId: ghost.manifest.id,
              name: ghost.manifest.name,
              entry: ghost.manifest.settingsHtml,
              files: page.files,
            },
          };
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
            pluginId: installedGhostStoragePart(ghost),
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
        // Desktop configuration values only cross the authenticated encrypted bridge.
        if (page.desktopSettings) return fail();
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
          case 'answer-directory':
            await this.answerDirectory(page, input);
            return { effects: [] };
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
