import { randomUUID, createHash } from 'node:crypto';
import type { RemoteActionInvokeRequest } from '@cindy/device-link';
import type { RemoteResourceProvider } from '../device-link/remoteResourceRegistry';
import { RemoteResourceRegistryError } from '../device-link/remoteResourceRegistry';
import type {
  RemoteSkillItem,
  RemoteSkillMarketItem,
  RemoteSkillMutation,
  RemoteSkillReceipt,
  RemoteSkillProject,
} from '../../shared/remoteSkills';

export interface RemoteSkillRecord<T> {
  view: RemoteSkillItem;
  target: T;
  linkOnly?: boolean;
}
export interface RemoteSkillsDeps<T> {
  capture(peer: string): { current(): boolean; visible(): boolean };
  scan(): Promise<RemoteSkillRecord<T>[]>;
  market(
    query: string,
    cursor?: string,
  ): Promise<{ items: RemoteSkillMarketItem[]; nextCursor: string | null }>;
  latest(name: string, catalogScope: 'market' | 'team'): Promise<RemoteSkillMarketItem | null>;
  detail(record: RemoteSkillRecord<T>): Promise<string>;
  catalog?(input: Record<string, unknown>): Promise<unknown>;
  projects?(): Promise<RemoteSkillProject[]>;
  readFile?(
    record: RemoteSkillRecord<T>,
    relativePath: string,
    children: boolean,
  ): Promise<unknown>;
  mutate(
    kind: RemoteSkillMutation,
    record: RemoteSkillRecord<T> | undefined,
    market: RemoteSkillMarketItem | undefined,
    current: () => boolean,
    project?: RemoteSkillProject,
  ): Promise<void>;
}
type Operation = {
  peer: string;
  fingerprint: string;
  receipt: RemoteSkillReceipt;
  current(): boolean;
  visible(): boolean;
  run(): Promise<void>;
  timer: ReturnType<typeof setTimeout>;
};
function fail(
  code: 'INVALID_PARAMS' | 'NOT_FOUND' | 'UNSUPPORTED_CAPABILITY' = 'INVALID_PARAMS',
): never {
  throw new RemoteResourceRegistryError(code, 'Skill management request is unavailable');
}
const str = (v: unknown, max = 256): string =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail();

/** Host-owned identities and per-controller receipts; no local renderer path authority. */
export class RemoteSkillsManagement<T> {
  private operations = new Map<string, Operation>();
  constructor(private readonly deps: RemoteSkillsDeps<T>) {}
  private access(peer: string) {
    const access = this.deps.capture(peer);
    if (!access.current()) fail('NOT_FOUND');
    return access;
  }
  private operation(peer: string, id: unknown) {
    const operation = this.operations.get(str(id));
    if (!operation || operation.peer !== peer || !operation.visible()) fail('NOT_FOUND');
    return operation;
  }
  private async invoke(peer: string, request: RemoteActionInvokeRequest): Promise<unknown> {
    const input = request.input ?? {};
    if (request.actionId === 'management:operation')
      return this.operation(peer, input.operationId).receipt;
    if (request.actionId === 'management:cancel' || request.actionId === 'management:answer') {
      const operation = this.operation(peer, input.operationId);
      if (request.actionId === 'management:cancel') {
        if (operation.receipt.phase === 'confirmation')
          operation.receipt = { operationId: operation.receipt.operationId, phase: 'cancelled' };
      } else if (operation.receipt.phase === 'confirmation') {
        if (
          !operation.current() ||
          input.requestId !== operation.receipt.confirmation?.requestId ||
          typeof input.accepted !== 'boolean'
        )
          fail('NOT_FOUND');
        if (input.accepted) {
          operation.receipt = { operationId: operation.receipt.operationId, phase: 'running' };
          void operation.run();
        } else
          operation.receipt = { operationId: operation.receipt.operationId, phase: 'cancelled' };
      }
      return operation.receipt;
    }
    const access = this.access(peer);
    if (request.actionId === 'management:catalog') {
      if (!this.deps.catalog) fail('UNSUPPORTED_CAPABILITY');
      const result = await this.deps.catalog(input);
      if (!access.current()) fail('NOT_FOUND');
      return result;
    }
    if (request.actionId === 'management:snapshot') {
      const records = await this.deps.scan();
      const projects = await this.deps.projects?.();
      let market: { items: RemoteSkillMarketItem[]; nextCursor: string | null } = {
          items: [],
          nextCursor: null,
        },
        marketUnavailable = false;
      try {
        // New controllers use the paginated catalog API independently of scans.
        if (input.installedOnly !== true) {
          market = await this.deps.market(
            typeof input.query === 'string' ? input.query.slice(0, 256) : '',
            typeof input.cursor === 'string' ? input.cursor.slice(0, 32) : undefined,
          );
        }
      } catch {
        marketUnavailable = true;
      }
      if (!access.current()) fail('NOT_FOUND');
      return {
        version: 1,
        items: records.map((r) => r.view),
        market: market.items,
        nextCursor: market.nextCursor,
        marketUnavailable,
        ...(projects ? { projects } : {}),
      };
    }
    if (
      ![
        'management:detail',
        'management:begin',
        'management:children',
        'management:read-file',
      ].includes(request.actionId)
    )
      fail('UNSUPPORTED_CAPABILITY');
    const operationId = request.actionId === 'management:begin' ? str(input.operationId, 64) : '';
    const fingerprint = JSON.stringify([
      request.resourceRef?.id,
      input.expectedRevision,
      input.kind,
      input.name,
      input.catalogScope,
      input.version,
      input.projectId,
      input.projectRevision,
    ]);
    if (operationId && this.operations.has(operationId)) {
      const operation = this.operation(peer, operationId);
      if (operation.fingerprint !== fingerprint) fail();
      return operation.receipt;
    }
    let record: RemoteSkillRecord<T> | undefined;
    if (request.resourceRef) {
      record = (await this.deps.scan()).find((r) => r.view.id === request.resourceRef?.id);
      if (!record || record.view.revision !== input.expectedRevision) fail('NOT_FOUND');
    }
    if (!access.current()) fail('NOT_FOUND');
    if (request.actionId === 'management:children' || request.actionId === 'management:read-file') {
      if (!record || !this.deps.readFile) fail('UNSUPPORTED_CAPABILITY');
      const relativePath = input.path === '' ? '' : str(input.path, 1024);
      if (
        relativePath.startsWith('/') ||
        relativePath.includes('\\') ||
        relativePath.split('/').some((part) => part === '..' || part === '.')
      )
        fail();
      const result = await this.deps.readFile(
        record,
        relativePath,
        request.actionId === 'management:children',
      );
      if (!access.current()) fail('NOT_FOUND');
      return result;
    }
    if (request.actionId === 'management:detail') {
      if (!record) fail();
      const markdown = await this.deps.detail(record);
      let latest: RemoteSkillMarketItem | null = null;
      if (record.view.market && !record.view.builtIn && !record.view.managedByPlugin) {
        try {
          latest = await this.deps.latest(
            record.view.market.name,
            record.view.market.catalogScope ?? 'market',
          );
        } catch {
          /* Keep installed content readable when the market is unavailable. */
        }
      }
      if (!access.current()) fail('NOT_FOUND');
      return { id: record.view.id, revision: record.view.revision, markdown, latest };
    }
    const kind = str(input.kind) as RemoteSkillMutation;
    if (!['enable', 'disable', 'install', 'update', 'uninstall'].includes(kind)) fail();
    if (kind !== 'install' && !record) fail();
    let project: RemoteSkillProject | undefined;
    if (input.projectId !== undefined) {
      if (kind !== 'install' || !this.deps.projects) fail();
      project = (await this.deps.projects()).find(
        (entry) => entry.id === input.projectId && entry.revision === input.projectRevision,
      );
      if (!project || !access.current()) fail('NOT_FOUND');
    }
    if (
      record?.view.managedByPlugin ||
      (kind === 'uninstall' && !record?.view.canUninstall) ||
      (kind === 'update' && (record?.view.builtIn || !record?.view.market))
    )
      fail();
    let market: RemoteSkillMarketItem | undefined;
    if (kind === 'install' || kind === 'update') {
      if (kind === 'install' && record) fail();
      const name = kind === 'update' ? record!.view.market!.name : str(input.name, 128);
      const scope =
        kind === 'update' ? (record!.view.market!.catalogScope ?? 'market') : input.catalogScope;
      if (scope !== 'market' && scope !== 'team') fail();
      market = (await this.deps.latest(name, scope)) ?? undefined;
      if (!market || market.version !== input.version || !access.current()) fail('NOT_FOUND');
    }
    // Two identical begin calls may finish their async reads together. Recheck
    // the receipt at the final allocation point before starting any mutation.
    if (this.operations.has(operationId)) {
      const existing = this.operation(peer, operationId);
      if (existing.fingerprint !== fingerprint) fail();
      return existing.receipt;
    }
    for (const [id, op] of this.operations)
      if (!op.visible()) {
        clearTimeout(op.timer);
        this.operations.delete(id);
      }
    if (
      this.operations.size >= 128 ||
      [...this.operations.values()].filter(
        (op) => op.peer === peer && ['running', 'confirmation'].includes(op.receipt.phase),
      ).length >= 8
    )
      fail();
    const confirmation = ['install', 'update', 'uninstall'].includes(kind);
    const receipt: RemoteSkillReceipt = {
      operationId,
      phase: confirmation ? 'confirmation' : 'running',
      ...(confirmation
        ? {
            confirmation: {
              requestId: randomUUID(),
              kind,
              name: record?.view.name ?? market!.displayName,
              version: market?.version,
              linkOnly: record?.linkOnly,
            },
          }
        : {}),
    };
    const operation: Operation = {
      peer,
      fingerprint,
      receipt,
      ...access,
      timer: setTimeout(() => {
        this.operations.delete(operationId);
      }, 15 * 60_000),
      run: async () => {
        try {
          if (!access.current()) fail('NOT_FOUND');
          if (
            record &&
            !(await this.deps.scan()).some(
              (next) =>
                next.view.id === record!.view.id && next.view.revision === record!.view.revision,
            )
          )
            fail('NOT_FOUND');
          if (!access.current()) fail('NOT_FOUND');
          if (
            project &&
            !(await this.deps.projects!()).some(
              (next) => next.id === project.id && next.revision === project.revision,
            )
          )
            fail('NOT_FOUND');
          await this.deps.mutate(kind, record, market, access.current, project);
          operation.receipt = { operationId, phase: 'succeeded' };
        } catch {
          operation.receipt = { operationId, phase: 'failed' };
        }
      },
    };
    operation.timer.unref?.();
    this.operations.set(operationId, operation);
    if (!confirmation) void operation.run();
    return receipt;
  }
  provider(): RemoteResourceProvider {
    return {
      collection: {
        id: 'skills',
        resourceKind: 'skill',
        title: { fallback: 'Skills' },
        actions: [
          { id: 'management:snapshot', label: 'Manage skills' },
          ...(this.deps.catalog
            ? [{ id: 'management:catalog', label: 'Browse skill catalog' }]
            : []),
        ],
      },
      list: async ({ controllerDeviceId }) => {
        const access = this.access(controllerDeviceId);
        const records = await this.deps.scan();
        if (!access.current()) fail('NOT_FOUND');
        return {
          collectionId: 'skills',
          revision: createHash('sha256')
            .update(records.map((record) => record.view.revision).join(':'))
            .digest('hex'),
          items: records.map(({ view }) => ({
            ref: { collectionId: 'skills', kind: 'skill', id: view.id },
            revision: view.revision,
            display: { title: view.name, subtitle: view.description },
            links: [],
          })),
        };
      },
      get: async ({ controllerDeviceId }, request) => {
        const access = this.access(controllerDeviceId);
        const record = (await this.deps.scan()).find((record) => record.view.id === request.ref.id);
        if (!record) fail('NOT_FOUND');
        const markdown = await this.deps.detail(record);
        if (!access.current()) fail('NOT_FOUND');
        return {
          ref: request.ref,
          revision: record.view.revision,
          display: { title: record.view.name, subtitle: record.view.description },
          links: [],
          blocks: [{ id: 'content', primitive: 'markdown', fallbackMarkdown: markdown }],
        };
      },
      invoke: async ({ controllerDeviceId }, request) => ({
        effects: [],
        result: await this.invoke(controllerDeviceId, request),
      }),
    };
  }
}
