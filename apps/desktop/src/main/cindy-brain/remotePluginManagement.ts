import { extractIpcError } from '../../shared/ipcError.js';
import { createHash, randomUUID } from 'node:crypto';
import { isSharedTaskPeer, isProviderSharePeer, type RemoteActionInvokeRequest, type RemoteActionInvokeResponse } from '@cindy/device-link';
import { parseLocalPluginShareSnapshot, type LocalPluginShareSnapshot } from '@cindy/plugin-protocol';
import {
  isGhostInstallApprovalToken,
  ghostInstallApprovalToken,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { projectPluginUiConsent } from '../../shared/pluginUiConsent.js';
import type {
  PluginMarketDetail,
  PluginMarketInstallOptions,
  PluginMarketSnapshot,
  PluginMarketQuery,
  PluginMarketPage,
  PluginMarketItem,
} from '../../shared/pluginMarket.js';
import { projectInstalledOperationAttribution } from '../../shared/pluginMarket.js';
import type {
  PluginManagementProject,
  PluginManagementProjectState,
  PluginManagementReceipt,
  RemotePluginPublicationStatus,
} from '../../shared/pluginManagement.js';
import type {
  ContributionInstallationBinding,
  ContributionTransferView,
  PreparedPluginContribution,
} from '../../shared/pluginContributions.js';
import type { GhostInstallConsentPrompt } from './ghostInstallConsent.js';
import { RemoteResourceRegistryError } from '../device-link/remoteResourceRegistry.js';
import type { RemotePluginPreferences } from './remotePluginPreferences.js';
import type { RemotePluginProject } from './remotePluginProjects.js';

interface Operation {
  peer: string;
  fingerprint: string;
  receipt: PluginManagementReceipt;
  current(): boolean;
  visible(): boolean;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  answer?: (accepted: boolean) => void;
}
interface PublicationPreview {
  peer: string;
  current(): boolean;
  visible(): boolean;
  expiresAt: number;
  submission?: Promise<RemotePluginPublicationStatus>;
  transferId?: string;
  discarded?: boolean;
}
function publicationStatus(transfer: ContributionTransferView): RemotePluginPublicationStatus {
  if (transfer.stage !== 'complete') return { stage: 'pending' };
  if (transfer.operation?.status === 'succeeded' && transfer.operation.receipt) return { stage: 'submitted' };
  return { stage: 'failed', errorCode: transfer.operation?.failure?.code ?? transfer.errorCode ?? 'INTERNAL' };
}
export interface RemotePluginManagementDeps {
  list(): InstalledGhost[];
  /**
   * 契约 V2.10：按实例键读当前实例（不重扫全部安装）。只用于目录、推荐、详情对本控制端 `'self'` 候选的复核；
   * 读不到（含实例注册表答不了）返回 undefined，调用方按未证实处理，不回退到整份列表。
   */
  instance?(instanceKey: string): InstalledGhost | undefined;
  preferences?: RemotePluginPreferences;
  settingsPage?: true;
  ui?: {
    suppressed(ghost: InstalledGhost): boolean;
    approve(id: string, prompt: GhostInstallConsentPrompt, assertCurrent: () => void): Promise<boolean>;
    defer(id: string, assertCurrent: () => void): void;
  };
  projects?: {
    list(): Promise<Array<PluginManagementProject & { workdir: string }>>;
    resolve?(workdir: string): Promise<RemotePluginProject>;
    disabled(workdir: string): string[];
    setDisabled(
      workdir: string,
      instance: string,
      disabled: boolean,
      assertCurrent: () => void,
    ): void;
  };
  publication?: {
    prepare(instanceId: string, expected: ContributionInstallationBinding): Promise<PreparedPluginContribution>;
    submit(preparedId: string, assertCaller: () => Promise<void>): Promise<ContributionTransferView>;
    status(transferId: string): Promise<ContributionTransferView> | ContributionTransferView;
    discard(preparedId: string): Promise<void>;
  };
  capture(peer: string): () => boolean;
  captureReceipt(peer: string): () => boolean;
  market: {
    snapshot(legacyCatalog?: boolean): Promise<PluginMarketSnapshot>;
    query?(input: PluginMarketQuery): Promise<PluginMarketPage>;
    recommendations?(): Promise<PluginMarketItem[]>;
    detail(id: string): Promise<PluginMarketDetail>;
    install(
      id: string,
      options: PluginMarketInstallOptions,
      prompt: GhostInstallConsentPrompt,
      assertCurrent: () => void,
      assertScope: () => void,
      /** 契约 V2.9：发起这次安装的远程操作与控制端（设备身份），提交成功时记作操作级证据。 */
      remoteOperation?: { operationId: string; controller: string },
    ): Promise<void>;
    /**
     * 契约 V2.9／V2.10：按 `controller` 给已装条目定归属：它自己那次操作装的给 `'self'` + `installedOperationId`，
     * 其余 `'unattributed'`。缺省时远程响应里的已装条目一律 `'unattributed'`。
     */
    installedOperations?<T extends PluginMarketItem>(
      items: readonly T[],
      controller: string,
      /** 契约 V2.10：复核用的实例列表（最后一个 await 之后同步读取，出口原样放进同一响应）与换装回调。 */
      live?: {
        ghosts?(): readonly InstalledGhost[];
        instance?(instanceKey: string): InstalledGhost | undefined;
        onChanged?(): void;
      },
    ): Promise<T[]>;
  };
  setEnabled(
    id: string,
    enabled: boolean,
    approval: string,
    assertCurrent: () => void,
  ): Promise<void>;
  uninstall(id: string, approval: string, assertCurrent: () => void): Promise<void>;
  installShare?(
    snapshot: LocalPluginShareSnapshot,
    prompt: GhostInstallConsentPrompt,
    assertScope: () => void,
  ): Promise<void>;
  installFile?(
    peer: string,
    attachment: string,
    target: string | undefined,
    approval: string | undefined,
    prompt: GhostInstallConsentPrompt,
    /** Owner/peer/cancellation only; the installer binds approval under its lock. */
    assertScope: () => void,
  ): Promise<void>;
}
const invalid = (): never => {
  throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid plugin management request');
};
const unavailable = (): never => {
  throw new RemoteResourceRegistryError(
    'NOT_FOUND',
    'Plugin management request is no longer available',
  );
};
const str = (v: unknown, max = 256): string =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : invalid();
const approval = (v: unknown): string =>
  isGhostInstallApprovalToken(v) ? (v as string) : invalid();

/** Project display metadata; mutations use Host-owned instance identity, never the displayed path. */
export function projectManagedGhost(g: InstalledGhost): InstalledGhost {
  return {
    manifest: g.manifest,
    dir: g.dir,
    instanceKey: installedGhostStoragePart(g),
    namespace: g.namespace,
    namespaceState: g.namespaceState,
    enabled: g.enabled,
    approval: g.approval,
    trust: g.trust,
    installationSource: g.installationSource,
    iconDataUrl: g.iconDataUrl,
    builtin: g.builtin,
    retirement: g.retirement,
    ...(g.uiCapabilityApproved === true ? { uiCapabilityApproved: true as const } : {}),
    taskCapabilityApproved: g.taskCapabilityApproved,
    targetCapabilityApproved: g.targetCapabilityApproved,
    delegationCapabilityApproved: g.delegationCapabilityApproved,
    observeCapabilityApproved: g.observeCapabilityApproved,
    companionsCapabilityApproved: g.companionsCapabilityApproved,
    oauthScopeStale: g.oauthScopeStale,
    oauthAuthorizationExpired: g.oauthAuthorizationExpired,
  };
}

/** Per-controller receipts reuse the installer; permission prompts wait outside its lock. */
export class RemotePluginManagement {
  private readonly operations = new Map<string, Operation>();
  private readonly publicationPreviews = new Map<string, PublicationPreview>();
  // A browsed directory is a transient scope, like the local picker. Do not add a task or recent project.
  private readonly browsedProjects = new Map<string, { project: RemotePluginProject; current(): boolean }>();
  constructor(private readonly deps: RemotePluginManagementDeps) {}
  private find(id: string): InstalledGhost {
    return this.deps.list().find((g) => installedGhostStoragePart(g) === id) ?? unavailable();
  }
  private operation(peer: string, id: string): Operation {
    const op = this.operations.get(id);
    if (!op || op.peer !== peer || !op.visible()) return unavailable();
    return op;
  }
  private assertScope(op: Operation): void {
    if (!op.current() || op.abort.signal.aborted) return unavailable();
  }
  private async project(id: string, peer: string): Promise<RemotePluginProject> {
    const browsed = this.browsedProjects.get(peer);
    if (browsed?.project.id === id && browsed.current() && this.deps.projects?.resolve) {
      const resolved = await this.deps.projects.resolve(browsed.project.workdir);
      if (!browsed.current() || resolved.id !== id) return unavailable();
      return resolved;
    }
    return (
      (await this.deps.projects?.list())?.find((project) => project.id === id) ?? unavailable()
    );
  }
  private projectState(projectId: string, workdir: string): PluginManagementProjectState {
    const disabled = [...new Set(this.deps.projects!.disabled(workdir))].sort();
    const visible = new Set(this.deps.list().map(installedGhostStoragePart));
    return {
      projectId,
      revision: createHash('sha256').update(JSON.stringify(disabled)).digest('hex'),
      disabled: disabled.filter((id) => visible.has(id)),
    };
  }
  private async publish(peer: string, request: RemoteActionInvokeRequest): Promise<unknown> {
    const publication = this.deps.publication;
    if (!publication) throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Update Cindy on the target computer');
    const input = request.input ?? {};
    const target = request.resourceRef?.id;

    if (request.actionId === 'management:publish-prepare') {
      if (!target || Object.keys(input).some(key => key !== 'expectedInstalledApproval' && key !== 'expectedVersion'))
        return invalid();
      const current = this.deps.capture(peer);
      const visible = this.deps.captureReceipt(peer);
      if (!current() || !visible() || this.publicationPreviews.size >= 128) return unavailable();
      const installed = this.find(target);
      const expectedApproval = approval(input.expectedInstalledApproval);
      const expectedVersion = str(input.expectedVersion, 32);
      if (installed.publishingSource?.kind !== 'local' ||
        ghostInstallApprovalToken(installed.approval) !== expectedApproval || installed.manifest.version !== expectedVersion)
        return { errorCode: 'CONTRIBUTION_PACKAGE_CHANGED' };
      const preview = await publication.prepare(target, { directory: installed.dir, approvalToken: expectedApproval })
        .catch((error: unknown) => ({ errorCode: extractIpcError(error)?.code ?? 'INTERNAL' }));
      if ('errorCode' in preview) return preview;
      if (!current() || !visible() || this.publicationPreviews.size >= 128) {
        await publication.discard(preview.preparedId).catch(() => undefined);
        return unavailable();
      }
      if (preview.instanceId !== target || preview.version !== expectedVersion) {
        await publication.discard(preview.preparedId).catch(() => undefined);
        return { errorCode: 'CONTRIBUTION_PACKAGE_CHANGED' };
      }
      this.publicationPreviews.set(preview.preparedId, { peer, current, visible, expiresAt: Date.parse(preview.expiresAt) });
      return { preview };
    }

    if (target || Object.keys(input).some(key => key !== 'preparedId')) return invalid();
    const id = str(input.preparedId);
    const preview = this.publicationPreviews.get(id);
    if (!preview || preview.peer !== peer || !preview.visible()) return unavailable();

    const action = request.actionId;
    if (action !== 'management:publish-submit' && action !== 'management:publish-status' && action !== 'management:publish-discard')
      return invalid();
    if (preview.submission) {
      if (action === 'management:publish-discard') return { discarded: false };
      const status = preview.transferId
        ? publicationStatus(await publication.status(preview.transferId))
        : await preview.submission;
      return preview.visible() ? status : unavailable();
    }
    if (action !== 'management:publish-submit') {
      // Reconcile a lost submit response without leaving an unclaimed preview writable.
      if (!preview.discarded) {
        preview.discarded = true;
        await publication.discard(id).catch(() => undefined);
      }
      return action === 'management:publish-status'
        ? { stage: 'failed', errorCode: 'MUTATION_CANCELLED' }
        : { discarded: true };
    }
    if (preview.discarded) return unavailable();

    const assertCaller = async () => {
      if (!preview.current() || !preview.visible()) return unavailable();
    };
    if (!preview.current() || !preview.visible()) return unavailable();
    preview.expiresAt = Date.now() + 30 * 60_000;
    preview.submission = publication.submit(id, assertCaller).then(transfer => {
      preview.transferId = transfer.localId;
      return publicationStatus(transfer);
    }).catch((error: unknown) => ({ stage: 'failed', errorCode: extractIpcError(error)?.code ?? 'INTERNAL' }));
    const status = await preview.submission;
    return preview.visible() ? status : unavailable();
  }

  private prune(): void {
    for (const [id, preview] of this.publicationPreviews) {
      if (preview.expiresAt > Date.now() && preview.visible()) continue;
      this.publicationPreviews.delete(id);
      if (!preview.submission && !preview.discarded) void this.deps.publication?.discard(id).catch(() => undefined);
    }
    for (const [peer, selection] of this.browsedProjects) {
      if (!selection.current()) this.browsedProjects.delete(peer);
    }
    for (const [id, op] of this.operations) {
      if (!op.visible()) {
        op.abort.abort();
        op.answer?.(false);
        clearTimeout(op.timer);
        this.operations.delete(id);
      } else if (!op.current() && ['running', 'confirmation'].includes(op.receipt.phase)) {
        // A lost connection invalidates further writes, but a reconnect must still
        // be able to query whether the original request actually committed.
        op.abort.abort();
        op.answer?.(false);
      }
    }
  }
  invalidate(): void {
    this.prune();
  }
  /**
   * 契约 V2.9／V2.10：远程响应里「当前安装归属」的出口。
   * - 服务层按请求方给出结论，并在最后一个 await 之后同步复核：`'self'` 只给仍是当前安装的那次安装。
   *   - `withGhosts`（返回 `ghosts[]` 的快照）：整份列表在复核那一刻读一次，出口随后原样放进同一响应，中间没有 await。
   *   - 其它出口（目录、推荐、详情）不读整份列表：只对本控制端的 `'self'` 候选按实例读（deps.instance），
   *     没有候选时零额外读取；读不到即降为 `'unattributed'`。
   * - 这里再经同一个 projectInstalledOperationAttribution 收口：只有 `'self'` 且带合法操作号的才保留，已装条目
   *   其余一律 `'unattributed'`。服务层不支持归属时同样得到 `'unattributed'`。
   * - `changed` 表示复核时发现换装、已降级，由调用方决定是否整次重读一次。
   */
  private async withOperations<T extends PluginMarketItem>(
    peer: string,
    items: readonly T[],
    withGhosts: boolean,
  ): Promise<{ items: T[]; ghosts: InstalledGhost[] | undefined; changed: boolean }> {
    let ghosts: InstalledGhost[] | undefined;
    let changed = false;
    const onChanged = () => { changed = true; };
    const projected = this.deps.market.installedOperations
      ? await this.deps.market.installedOperations(items, peer, withGhosts
        ? { ghosts: () => (ghosts = this.deps.list()), onChanged }
        : { instance: (instanceKey) => this.deps.instance?.(instanceKey), onChanged })
      : items.map((item) => projectInstalledOperationAttribution(item, null));
    return {
      items: projected.map((item) => projectInstalledOperationAttribution(
        item,
        item.installedOperationAttribution === 'self' ? item.installedOperationId : null,
      )),
      // 快照出口要返回整份列表：服务层已在复核时读过就用那一份，否则（没有条目）在这里读一次。
      ghosts: withGhosts ? ghosts ?? this.deps.list() : undefined,
      changed,
    };
  }

  /**
   * 读市场数据并投影归属。复核发现换装时整次重读一次；第二次仍发现换装就用已降级的结果（宁可不给「打开」）。
   * 重读最多一次，频繁换装时也不会循环。`current()` 失效返回 null。
   */
  private async readAttributed<V>(
    peer: string,
    current: () => boolean,
    read: () => Promise<V>,
    itemsOf: (value: V) => readonly PluginMarketItem[],
    withGhosts = false,
  ): Promise<{ value: V; items: PluginMarketItem[]; ghosts: InstalledGhost[] | undefined } | null> {
    for (let attempt = 0; ; attempt++) {
      const value = await read();
      if (!current()) return null;
      const projected = await this.withOperations(peer, itemsOf(value), withGhosts);
      if (!current()) return null;
      if (!projected.changed || attempt >= 1) return { value, items: projected.items, ghosts: projected.ghosts };
    }
  }
  async invoke(
    peer: string,
    request: RemoteActionInvokeRequest,
  ): Promise<RemoteActionInvokeResponse> {
    if (isSharedTaskPeer(peer) || isProviderSharePeer(peer)) return unavailable();
    this.prune();
    const input = request.input ?? {};
    const result = (value: unknown): RemoteActionInvokeResponse => ({ effects: [], result: value });
    if (request.actionId.startsWith('management:publish-')) return result(await this.publish(peer, request));
    if (request.actionId === 'management:ui-consent') {
      if (Object.keys(input).length) return invalid();
      const current = this.deps.capture(peer);
      if (!current()) return unavailable();
      const snapshot = projectPluginUiConsent(this.deps.list(), !!this.deps.ui,
        ghost => this.deps.ui?.suppressed(ghost) === true);
      if (!current()) return unavailable();
      return result(snapshot);
    }
    if (request.actionId === 'management:snapshot') {
      const read = input.read;
      if (Object.keys(input).some(key => key !== 'read' && key !== 'query')) return invalid();
      if (read !== undefined && !['capabilities', 'installed', 'catalog', 'recommendations'].includes(String(read))) return invalid();
      const current = this.deps.capture(peer);
      if (!current()) return unavailable();
      if (read === 'capabilities') return result({ catalogPaging: !!this.deps.market.query && !!this.deps.market.recommendations });
      if (read === 'catalog' || read === 'recommendations') {
        const read$ = async (): Promise<PluginMarketPage | PluginMarketItem[] | null> =>
          read === 'catalog' && this.deps.market.query
            ? await this.deps.market.query(input.query as PluginMarketQuery ?? {})
            : read === 'recommendations' && this.deps.market.recommendations
              ? await this.deps.market.recommendations() : null;
        const attributed = await this.readAttributed(peer, current, read$,
          (value) => !value ? [] : Array.isArray(value) ? value : value.items);
        if (!attributed) return unavailable();
        const { value, items } = attributed;
        return result(!value ? value : Array.isArray(value) ? items : { ...value, items });
      }
      const attributed = await this.readAttributed(peer, current,
        () => Promise.all([this.deps.market.snapshot(read === undefined), this.deps.projects?.list()]),
        ([snapshot]) => snapshot.items, true);
      if (!attributed) return unavailable();
      const { value: [snapshot, projects] } = attributed;
      const ghosts = attributed.ghosts ?? this.deps.list();
      const market = { ...snapshot, items: attributed.items };
      const browsed = this.browsedProjects.get(peer)?.project;
      const scopeProjects = browsed && projects
        ? [browsed, ...projects.filter((project) => project.id !== browsed.id)]
        : projects;
      return result({
        version: 1,
        // 与上面归属复核时是同一份实例列表（契约 V2.10：带 'self' 的条目与这里的对应实例出自同一次安装）。
        ghosts: ghosts.map(ghost => ({ ...projectManagedGhost(ghost),
          ...(this.deps.publication && ghost.publishingSource?.kind === 'local' ? { publishingSource: ghost.publishingSource } : {}),
          ...(this.deps.ui?.suppressed(ghost) ? { uiPromptSuppressed: true } : {}),
        })),
        ...(this.deps.ui ? { uiCapabilityApproval: true } : {}),
        market,
        ...(this.deps.preferences ? { hostPreferences: true } : {}),
        ...(this.deps.settingsPage ? { settingsPage: true } : {}),
        ...(this.deps.installShare ? { localShares: true } : {}),
        ...(this.deps.publication ? { communityPublication: true } : {}),
        ...(scopeProjects ? { projects: scopeProjects.map(({ id, name, path }) => ({ id, name, ...(path ? { path } : {}) })) } : {}),
        ...(this.deps.projects?.resolve ? { projectBrowse: true } : {}),
      });
    }
    if (request.actionId === 'management:project-select') {
      if (Object.keys(input).some((key) => key !== 'path')) return invalid();
      if (!this.deps.projects?.resolve) return unavailable();
      const current = this.deps.capture(peer);
      if (!current()) return unavailable();
      const project = await this.deps.projects.resolve(str(input.path, 32768));
      if (!current()) return unavailable();
      this.browsedProjects.set(peer, { project, current });
      return result({ id: project.id, name: project.name, path: project.path });
    }
    if (
      request.actionId === 'management:preferences' ||
      request.actionId === 'management:preferences-set'
    ) {
      const settings = this.deps.preferences;
      if (
        !settings ||
        !request.resourceRef?.id ||
        Object.keys(input).some(
          (key) =>
            ![
              'expectedInstalledApproval',
              'expectedRevision',
              'kind',
              'patch',
              'visible',
            ].includes(key),
        )
      )
        return invalid();
      const id = str(request.resourceRef.id);
      const expected = approval(input.expectedInstalledApproval);
      const current = this.deps.capture(peer);
      const assertCurrent = () => {
        const ghost = this.find(id);
        if (!current() || !ghost.enabled || ghostInstallApprovalToken(ghost.approval) !== expected)
          return unavailable();
      };
      assertCurrent();
      const ghost = this.find(id);
      const value =
        request.actionId === 'management:preferences'
          ? settings.read(id, ghost)
          : await settings.update(id, ghost, input, assertCurrent);
      assertCurrent();
      return result(value);
    }
    if (request.actionId === 'management:project-state') {
      if (Object.keys(input).some((key) => key !== 'projectId')) return invalid();
      const current = this.deps.capture(peer);
      if (!current()) return unavailable();
      const project = await this.project(str(input.projectId), peer);
      if (!current()) return unavailable();
      return result(this.projectState(project.id, project.workdir));
    }
    if (request.actionId === 'management:market-detail') {
      if (Object.keys(input).some((k) => k !== 'pluginId')) return invalid();
      const current = this.deps.capture(peer);
      if (!current()) return unavailable();
      const pluginId = str(input.pluginId, 1024);
      const attributed = await this.readAttributed(peer, current, () => this.deps.market.detail(pluginId), (detail) => [detail]);
      if (!attributed) return unavailable();
      return result(attributed.items[0]);
    }
    if (request.actionId === 'management:operation') {
      if (Object.keys(input).some((k) => k !== 'operationId')) return invalid();
      return result(this.operation(peer, str(input.operationId)).receipt);
    }
    if (request.actionId === 'management:answer') {
      if (
        Object.keys(input).some((k) => !['operationId', 'requestId', 'confirmed'].includes(k)) ||
        typeof input.confirmed !== 'boolean'
      )
        return invalid();
      const op = this.operation(peer, str(input.operationId));
      if (!op.answer || op.receipt.consent?.requestId !== input.requestId) return unavailable();
      this.assertScope(op);
      const answer = op.answer;
      delete op.answer;
      delete op.receipt.consent;
      op.receipt.phase = 'running';
      answer(input.confirmed);
      return result(op.receipt);
    }
    if (request.actionId === 'management:cancel') {
      if (Object.keys(input).some((k) => k !== 'operationId')) return invalid();
      const op = this.operation(peer, str(input.operationId));
      // A committed result stays committed; cancellation cannot undo an installation.
      if (op.receipt.phase === 'running' || op.receipt.phase === 'confirmation') {
        op.abort.abort();
        op.answer?.(false);
      }
      return result(op.receipt);
    }
    if (request.actionId !== 'management:begin') return invalid();
    if (
      Object.keys(input).some(
        (k) =>
          ![
            'operationId',
            'uiConsentVersion',
            'kind',
            'pluginId',
            'expectedReleaseId',
            'expectedInstalledApproval',
            'expectedManifest',
            'expectedSnapshot',
            'attachment',
            'projectId',
            'expectedProjectRevision',
          ].includes(k),
      )
    )
      return invalid();
    const id = str(input.operationId, 128);
    const kind = str(input.kind, 32);
    if (!['install', 'enable', 'disable', 'uninstall', 'install-file', 'install-share', 'approve-ui', 'defer-ui'].includes(kind))
      return invalid();
    if (input.uiConsentVersion !== undefined && input.uiConsentVersion !== 1) return invalid();
    if (['approve-ui', 'defer-ui'].includes(kind) && (!this.deps.ui || input.uiConsentVersion !== 1)) return invalid();
    const projectId = input.projectId === undefined ? undefined : str(input.projectId);
    const projectRevision =
      input.expectedProjectRevision === undefined ? undefined : str(input.expectedProjectRevision);
    if (
      projectId
        ? !projectRevision || !['enable', 'disable'].includes(kind)
        : projectRevision !== undefined
    )
      return invalid();
    const target = request.resourceRef?.id;
    let sharedSnapshot: LocalPluginShareSnapshot | undefined;
    if (kind === 'install-share') {
      if (!this.deps.installShare || target || Object.keys(input).some(key =>
        !['operationId', 'kind', 'expectedSnapshot'].includes(key))) return invalid();
      try { sharedSnapshot = parseLocalPluginShareSnapshot(input.expectedSnapshot); }
      catch { return invalid(); }
    } else if (input.expectedSnapshot !== undefined) return invalid();
    const fingerprint = JSON.stringify([target ?? null, input]);
    const previous = this.operations.get(id);
    if (previous) {
      if (previous.peer !== peer || previous.fingerprint !== fingerprint || !previous.visible())
        return unavailable();
      return result(previous.receipt);
    }
    const installedApproval =
      input.expectedInstalledApproval === undefined
        ? undefined
        : approval(input.expectedInstalledApproval);
    let ghost: InstalledGhost | undefined;
    if (target) {
      ghost = this.find(target);
      if (installedApproval !== ghostInstallApprovalToken(ghost.approval)) return unavailable();
    } else if (!['install', 'install-file', 'install-share'].includes(kind)) return invalid();
    const pluginId = kind === 'install' ? str(input.pluginId, 1024) : undefined;
    const releaseId = kind === 'install' ? str(input.expectedReleaseId, 1024) : undefined;
    if (kind === 'install-file' && (!this.deps.installFile || typeof input.attachment !== 'string'))
      return invalid();
    if (
      this.operations.size >= 128 ||
      [...this.operations.values()].filter(
        (op) => op.peer === peer && ['running', 'confirmation'].includes(op.receipt.phase),
      ).length >= 8
    )
      return unavailable();
    const current = this.deps.capture(peer);
    if (!current()) return unavailable();
    const op: Operation = {
      peer,
      fingerprint,
      current,
      visible: this.deps.captureReceipt(peer),
      abort: new AbortController(),
      receipt: { operationId: id, phase: 'running' },
      timer: setTimeout(() => {
        op.abort.abort();
        op.answer?.(false);
        this.operations.delete(id);
      }, 15 * 60_000),
    };
    op.timer.unref?.();
    this.operations.set(id, op);
    const assertCurrent = () => {
      this.assertScope(op);
      if (target && ghostInstallApprovalToken(this.find(target).approval) !== installedApproval)
        return unavailable();
    };
    const prompt: GhostInstallConsentPrompt = (facts) => {
      assertCurrent();
      const requestId = randomUUID();
      op.receipt = { operationId: id, phase: 'confirmation', consent: { ...facts, requestId } };
      return new Promise((resolve) => {
        const cancel = () => {
          delete op.answer;
          delete op.receipt.consent;
          resolve(false);
        };
        op.abort.signal.addEventListener('abort', cancel, { once: true });
        op.answer = (accepted) => {
          op.abort.signal.removeEventListener('abort', cancel);
          if (!op.current() || op.abort.signal.aborted) return resolve(false);
          resolve(accepted);
        };
      });
    };
    prompt.uiCapabilityApproval = input.uiConsentVersion === 1;
    void (async () => {
      try {
        assertCurrent();
        switch (kind) {
          case 'install-share':
            await this.deps.installShare!(sharedSnapshot!, prompt, () => this.assertScope(op));
            break;
          case 'approve-ui':
            if (!await this.deps.ui!.approve(target!, prompt, assertCurrent)) {
              // A stale install is not a user cancellation. Retain its failed receipt.
              assertCurrent();
              throw Object.assign(new Error('Page approval cancelled'), { code: 'MUTATION_CANCELLED' });
            }
            break;
          case 'defer-ui':
            this.deps.ui!.defer(target!, assertCurrent);
            break;
          case 'install':
            await this.deps.market.install(
              pluginId!,
              {
                expectedReleaseId: releaseId!,
                allowSourceReplacement: false,
                ...(installedApproval ? { expectedInstalledApproval: installedApproval } : {}),
                ...(input.expectedManifest
                  ? { expectedManifest: input.expectedManifest as PluginMarketDetail['manifest'] }
                  : {}),
              },
              prompt,
              assertCurrent,
              // The installer owns approval checks; this guard survives its directory swap.
              () => this.assertScope(op),
              // 契约 V2.9：提交成功时把这次操作号记作安装证据，只对本控制端（peer）投影。
              { operationId: id, controller: peer },
            );
            break;
          case 'install-file':
            await this.deps.installFile!(
              peer,
              str(input.attachment, 2048),
              target,
              installedApproval,
              prompt,
              // The native update transaction checks the old approval itself. Its
              // commit hook runs after the directory swap, when that receipt no
              // longer describes the staged package; re-reading it would roll
              // back our own update. Keep owner/peer/cancellation fencing active.
              () => this.assertScope(op),
            );
            break;
          case 'enable':
          case 'disable':
            if (projectId) {
              const project = await this.project(projectId, peer);
              const assertProjectCurrent = () => {
                assertCurrent();
                if (this.projectState(projectId, project.workdir).revision !== projectRevision)
                  return unavailable();
                // Project exceptions can never enable a globally disabled plugin.
                if (kind === 'enable' && !this.find(target!).enabled) return unavailable();
              };
              assertProjectCurrent();
              this.deps.projects!.setDisabled(
                project.workdir,
                target!,
                kind === 'disable',
                assertProjectCurrent,
              );
            } else {
              await this.deps.setEnabled(
                target!,
                kind === 'enable',
                installedApproval!,
                assertCurrent,
              );
            }
            break;
          case 'uninstall':
            await this.deps.uninstall(target!, installedApproval!, assertCurrent);
            break;
        }
        // The authoritative result wins after commit, even if the view was cancelled meanwhile.
        op.receipt = { operationId: id, phase: 'succeeded' };
      } catch (error) {
        const code =
          extractIpcError(error)?.code ??
          (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'INTERNAL');
        op.receipt = {
          operationId: id,
          phase:
            op.abort.signal.aborted || code === 'MUTATION_CANCELLED' || code === 'SETUP_CANCELLED'
              ? 'cancelled'
              : 'failed',
          errorCode: code,
        };
      } finally {
        delete op.answer;
      }
    })();
    return result(op.receipt);
  }
}
