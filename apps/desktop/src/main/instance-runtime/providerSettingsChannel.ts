import type { AgentKind } from '@cindy/model-providers';
import {
  CLOUD_MODEL_CALLS,
  CLOUD_PROVIDER_SETTINGS_CHANNEL,
  CLOUD_PROVIDER_SETTINGS_MAX_BYTES,
  CLOUD_PROVIDER_SETTINGS_OPS,
  CLOUD_PROVIDER_SHARE_ACTIONS,
  cloudProviderSettingsRequestSchema,
  type CloudProviderSettingsList,
  type CloudProviderSettingsRequest,
  type CloudProviderSettingsWriteReceipt,
  type CloudProviderVisibilityState,
} from '../../shared/cloudProviderSettings.js';
import type { SettingsOwnerStamp } from '../../shared/hostSettings.js';
import type { CustomModelEdit } from '../../shared/customModelEdit.js';
import type { ManagementExecution } from '../host-settings/management.js';
import { hasRuntimeHeaders, type ProviderSetup } from './providerSetup.js';
import { runReportedRemoteChange } from './maintenance.js';

/** Cindy AI and organization connection controls of the instance's own Settings page. */
export interface CloudModelAccessControl {
  status(): unknown;
  retry(): Promise<unknown>;
  rotate(): Promise<unknown>;
  byokStatus(): unknown;
  byokRetry(): Promise<unknown>;
}

export interface ProviderSettingsChannelDeps {
  /** The managed instance exists and its signed-in member is the instance owner. */
  isInstanceOwner(): boolean;
  owner(): SettingsOwnerStamp | null;
  /** Native provider handlers through the closed cloud management call set. */
  call(
    channel: string,
    args: unknown[],
    execution: ManagementExecution,
    options?: { sender?: boolean },
  ): Promise<unknown>;
  /** CAS token over the window's visibility choices (Main's mirror); null until it is ready. */
  visibilityRevision(): Promise<string | null>;
  /** One provider's models through the model-visibility operation; null follows the default. */
  setVisibility(
    providerId: string,
    targets: Array<{ agent: AgentKind; modelId: string }>,
    enabled: boolean | null,
    assertCaller: () => void,
  ): Promise<void>;
  /** Display-only routing (the DeviceLink projection) for built-in and organization rows. */
  projectRouting(routing: unknown): unknown;
  resolveLogoKind(providerId: string, routing: unknown): string | null;
  /** Remembered reasoning effort by memory slot and model, as the app window keeps it. */
  readEfforts(): Promise<Record<string, Record<string, string>>>;
  applyEffort(pref: {
    agent: AgentKind;
    providerId: string;
    modelId: string;
    effort: string | null;
  }): Promise<void>;
  /** Guest share actions on this instance (received list, credential trust, leave, insights). */
  shareCommand(
    command: Extract<CloudProviderSettingsRequest, { op: 'share' }>['command'],
  ): Promise<unknown>;
  /** Read-modify-write of the saved custom provider config on this instance. */
  editModel(
    request: { providerId: string; agent: AgentKind; modelId: string; edit: CustomModelEdit },
    execution: ManagementExecution,
  ): Promise<void>;
  /** Staged wizard and connection-form steps; secrets and logins apply on the CIS ticket. */
  setup?: ProviderSetup;
  modelAccess?(): CloudModelAccessControl | null;
  /** Storage name of the Cindy AI key (the only key the page may remove). */
  xdKey?: string;
  timeoutMs?: number;
}

const fail = (code: string, message: string): never => {
  throw new Error(`[${code}] ${message}`);
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail('INTERNAL', 'invalid provider list');


/**
 * Same display fields as the DeviceLink list, without dropping hidden models. The
 * owner's own connections keep their routing (the endpoints they typed; credentials and
 * authentication headers stay in the instance's Main process), so subtitles, account usage
 * and the connection form read the same facts as locally. Built-in and organization
 * connections keep display-only routing.
 */
function projectProvider(raw: unknown, deps: ProviderSettingsChannelDeps): unknown {
  const provider = record(raw);
  const out: Record<string, unknown> = { ...provider };
  delete out.logoKind;
  delete out.remoteModelIds;
  delete out.remoteInvocationEnabled;
  if (typeof provider.remoteInvocationEnabled === 'boolean')
    out.remoteInvocationEnabled = provider.remoteInvocationEnabled;
  if (provider.source !== 'user') {
    delete out.routing;
    const routing = deps.projectRouting(provider.routing);
    if (routing !== undefined) out.routing = routing;
  }
  const logoKind =
    typeof provider.id === 'string' ? deps.resolveLogoKind(provider.id, provider.routing) : null;
  if (logoKind) out.logoKind = logoKind;
  return out;
}

export function createProviderSettingsChannel(deps: ProviderSettingsChannelDeps) {
  const ownerAtIngress = (): SettingsOwnerStamp => {
    if (!deps.isInstanceOwner()) fail('PERMISSION_DENIED', 'not the instance owner');
    return deps.owner() ?? fail('OWNER_CHANGED', 'the instance account is changing');
  };
  const execution = (owner: SettingsOwnerStamp): ManagementExecution => {
    const signal = AbortSignal.timeout(deps.timeoutMs ?? 30_000);
    return {
      signal,
      assertCurrent() {
        if (signal.aborted) fail('TIMEOUT', 'request timed out');
        const now = deps.isInstanceOwner() ? deps.owner() : null;
        if (
          !now ||
          now.dataOwnerId !== owner.dataOwnerId ||
          now.ownerGeneration !== owner.ownerGeneration
        )
          fail('OWNER_CHANGED', 'the instance account changed');
      },
      prompt() {
        fail('UNSUPPORTED', 'interactive provider flows use the cloud authorization page');
      },
      onCancel(cancel) {
        signal.addEventListener('abort', cancel, { once: true });
      },
    };
  };

  async function list(owner: SettingsOwnerStamp): Promise<CloudProviderSettingsList> {
    const run = execution(owner);
    const raw = record(await deps.call('maker:provider:list', [], run));
    run.assertCurrent();
    const providers = Array.isArray(raw.providers)
      ? raw.providers
      : fail('INTERNAL', 'invalid list');
    // The same visibility the ordinary list gives other devices; editable once the window's choices are ready.
    const revision = await deps.visibilityRevision();
    run.assertCurrent();
    const visibility: CloudProviderVisibilityState = {
      status: revision === null ? 'unavailable' : 'ready',
      revision,
      overrides:
        raw.modelVisibilityOverrides && typeof raw.modelVisibilityOverrides === 'object'
          ? Object.fromEntries(
              Object.entries(raw.modelVisibilityOverrides as Record<string, unknown>).filter(
                (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
              ),
            )
          : {},
    };
    const result: CloudProviderSettingsList = {
      version: 1,
      ownerGeneration: owner.ownerGeneration,
      providers: providers.map((provider) => projectProvider(provider, deps)),
      providerOrder: Array.isArray(raw.providerOrder)
        ? raw.providerOrder.filter((id): id is string => typeof id === 'string')
        : [],
      visibility,
      efforts: await deps.readEfforts(),
      supportedOps: [...CLOUD_PROVIDER_SETTINGS_OPS],
      shareActions: [...CLOUD_PROVIDER_SHARE_ACTIONS],
    };
    if (Buffer.byteLength(JSON.stringify(result)) > CLOUD_PROVIDER_SETTINGS_MAX_BYTES)
      fail('TOO_LARGE', 'provider catalog exceeds the transfer limit');
    return result;
  }

  async function write(
    request: Exclude<CloudProviderSettingsRequest, { op: 'list' }>,
    owner: SettingsOwnerStamp,
  ): Promise<CloudProviderSettingsWriteReceipt> {
    if (request.ownerGeneration !== owner.ownerGeneration)
      fail('OWNER_CHANGED', 'refresh the provider list');
    const run = execution(owner);
    const native = async (channel: string, ...args: unknown[]) => {
      await deps.call(channel, args, run);
      run.assertCurrent();
      return { ok: true as const, ownerGeneration: owner.ownerGeneration, catalogChanged: true };
    };
    switch (request.op) {
      case 'visibility-set':
      case 'visibility-reset': {
        const revision = await deps.visibilityRevision();
        if (revision === null) fail('UNAVAILABLE', 'model preferences are not ready');
        if (revision !== request.revision)
          fail('REVISION_CONFLICT', 'model visibility changed; refresh');
        await deps.setVisibility(
          request.providerId,
          request.targets as Array<{ agent: AgentKind; modelId: string }>,
          request.op === 'visibility-set' ? request.enabled : null,
          run.assertCurrent,
        );
        run.assertCurrent();
        return {
          ok: true,
          ownerGeneration: owner.ownerGeneration,
          visibility: (await list(owner)).visibility,
          catalogChanged: false,
        };
      }
      case 'model-disable':
        return native('maker:model-disable:set', {
          providerId: request.providerId,
          kind: request.kind,
          ...(request.disabled === undefined ? {} : { disabled: request.disabled }),
          ...(request.modelIds ? { modelIds: request.modelIds } : {}),
        });
      case 'order':
        return native('maker:provider:order:set', {
          dataOwnerId: owner.dataOwnerId,
          ownerGeneration: owner.ownerGeneration,
          providerIds: request.providerIds,
        });
      case 'presentation':
        // Deleting OpenAI also revokes its image API key, as on the local page.
        if (
          request.action === 'remove' &&
          request.providerId === 'openai' &&
          (await deps.call('builtin-api-key-has', ['openai-images'], run)) === true
        )
          await deps.call('builtin-api-key-remove', ['openai-images'], run);
        return native('maker:provider:presentation:set', {
          dataOwnerId: owner.dataOwnerId,
          ownerGeneration: owner.ownerGeneration,
          providerId: request.providerId,
          action: request.action,
          ...(request.name === undefined ? {} : { name: request.name }),
        });
      case 'remote-access':
        return native('maker:provider:remote-access:set', {
          providerId: request.providerId,
          enabled: request.enabled,
        });
      case 'refresh':
        return native('maker:provider:models-refresh', request.providerId);
      case 'rediscover':
        return native('maker:provider:models-rediscover', request.providerId);
      case 'model-call': {
        // The instance stamps its own owner; a controller stamp never reaches the handler.
        const stamp = { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.ownerGeneration };
        const quote = typeof request.value === 'object' && request.value !== null;
        const args =
          request.call === 'image-input-set'
            ? typeof request.value === 'boolean' || request.value == null
              ? [request.target, request.value ?? null, stamp]
              : fail('INVALID_PARAMS', 'expected a boolean or null')
            : request.call === 'context-set' || request.call === 'compaction-set'
            ? quote || typeof request.value === 'boolean'
              ? fail('INVALID_PARAMS', 'expected a number or null')
              : [request.target, request.value ?? null, stamp]
            : request.call === 'context-reset'
              ? [request.target, stamp]
              : request.call === 'price-set'
                ? quote
                  ? [request.target, request.value]
                  : fail('INVALID_PARAMS', 'expected a price quote')
                : [request.target];
        const value = await deps.call(CLOUD_MODEL_CALLS[request.call], args, run);
        run.assertCurrent();
        return {
          ok: true,
          ownerGeneration: owner.ownerGeneration,
          // Overrides change the catalog's limits and prices; reads change nothing.
          catalogChanged: !request.call.endsWith('-get'),
          value,
        };
      }
      case 'effort':
        await deps.applyEffort({
          agent: request.agent,
          providerId: request.providerId,
          modelId: request.modelId,
          effort: request.effort,
        });
        run.assertCurrent();
        return {
          ok: true,
          ownerGeneration: owner.ownerGeneration,
          catalogChanged: false,
          value: await deps.readEfforts(),
        };
      case 'model-edit':
        await deps.editModel(
          {
            providerId: request.providerId,
            agent: request.agent,
            modelId: request.modelId,
            edit: request.edit,
          },
          run,
        );
        run.assertCurrent();
        return { ok: true, ownerGeneration: owner.ownerGeneration, catalogChanged: true };
      case 'share': {
        const value = await deps.shareCommand(request.command);
        run.assertCurrent();
        return { ok: true, ownerGeneration: owner.ownerGeneration, catalogChanged: false, value };
      }
      case 'cli-scan': {
        const value = await deps.call('maker:provider:local-cli-scan', [], run);
        run.assertCurrent();
        return { ok: true, ownerGeneration: owner.ownerGeneration, catalogChanged: false, value };
      }
      default:
        return setupWrite(request, owner, run);
    }
  }

  const ownerKey = (owner: SettingsOwnerStamp) => `${owner.dataOwnerId}:${owner.ownerGeneration}`;
  async function setupWrite(
    request: Exclude<CloudProviderSettingsRequest, { op: 'list' }>,
    owner: SettingsOwnerStamp,
    run: ManagementExecution,
  ): Promise<CloudProviderSettingsWriteReceipt> {
    const done = (value: unknown, catalogChanged = false) => {
      run.assertCurrent();
      return { ok: true as const, ownerGeneration: owner.ownerGeneration, catalogChanged, value };
    };
    const setup = deps.setup ?? fail('UNSUPPORTED', 'provider setup is unavailable');
    switch (request.op) {
      case 'presets':
        return done(await deps.call('maker:provider:presets', [], run));
      case 'provider-view': {
        const raw = record(await deps.call('maker:provider:list', [], run));
        const view = (Array.isArray(raw.providers) ? raw.providers : []).find(
          (provider) => record(provider).id === request.providerId,
        );
        return done(view ? projectProvider(view, deps) : fail('NOT_FOUND', 'provider not found'));
      }
      case 'custom-create':
      case 'custom-update':
        if (hasRuntimeHeaders(request.config))
          fail('INVALID_PARAMS', 'request headers travel with the secrets');
        return done(
          await deps.call(
            request.op === 'custom-create'
              ? 'maker:provider:custom:create'
              : 'maker:provider:custom:update',
            [request.config, {}, request.options ?? { source: 'manual-settings' }],
            run,
          ),
          true,
        );
      case 'custom-delete':
        return done(
          await deps.call(
            'maker:provider:custom:delete',
            [
              request.providerId,
              { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.ownerGeneration },
              { source: 'manual-settings' },
            ],
            run,
          ),
          true,
        );
      case 'models-fetch':
      case 'test-connection':
      case 'detect': {
        const probe =
          request.op === 'test-connection' && request.request.kind === 'adhoc'
            ? (request.request.spec as Record<string, unknown> | undefined)
            : request.request;
        if (!probe || !setup.secretFree(probe))
          fail('INVALID_PARAMS', 'credentials travel with the secrets');
        const channel =
          request.op === 'models-fetch'
            ? 'maker:provider:models-fetch'
            : request.op === 'detect'
              ? 'maker:provider:detect'
              : 'maker:provider:test-connection';
        return done(
          await deps.call(channel, [request.request], run, {
            sender: request.op !== 'models-fetch',
          }),
        );
      }
      case 'setup-stage':
        return done({ stageId: setup.stage(ownerKey(owner), request.kind, request.request) });
      case 'setup-result':
        return done(setup.result(ownerKey(owner), request.stageId));
      case 'xd':
      case 'byok': {
        const control = deps.modelAccess?.() ?? fail('UNAVAILABLE', 'model access is not ready');
        if (request.op === 'byok')
          return done(
            request.action === 'retry' ? await control.byokRetry() : control.byokStatus(),
          );
        if (request.action === 'disconnect') {
          const removed = record(
            await deps.call(
              'safe-storage-remove',
              [deps.xdKey ?? fail('UNAVAILABLE', 'no key')],
              run,
            ),
          );
          if (removed.success !== true) fail('INTERNAL', 'the Cindy AI key was not removed');
          return done(control.status(), true);
        }
        return done(
          request.action === 'retry'
            ? await control.retry()
            : request.action === 'rotate'
              ? await control.rotate()
              : control.status(),
          request.action !== 'status',
        );
      }
      case 'codex-limits':
        return done(
          await deps.call(
            'maker:usage:codex-rate-limits',
            request.providerId ? [request.providerId] : [],
            run,
          ),
        );
      case 'codex-reset':
        return done(
          await deps.call(
            'maker:usage:codex-rate-limit-reset',
            [request.idempotencyKey, ...(request.providerId ? [request.providerId] : [])],
            run,
          ),
        );
      case 'account-usage':
        return done(
          await deps.call(
            'maker:provider:account-usage',
            [
              {
                providerId: request.providerId,
                ...(request.forceRefresh ? { forceRefresh: true } : {}),
              },
            ],
            run,
          ),
        );
      default:
        return fail('INVALID_PARAMS', 'unknown provider settings request');
    }
  }

  return {
    channel: CLOUD_PROVIDER_SETTINGS_CHANNEL,
    async handle(_controller: string, raw: unknown): Promise<unknown> {
      const owner = ownerAtIngress();
      const parsed = cloudProviderSettingsRequestSchema.safeParse(raw);
      if (!parsed.success) fail('INVALID_PARAMS', 'invalid provider settings request');
      const request = parsed.data!;
      // A change counts as maintenance work until it settles, over DeviceLink and the web alike.
      return request.op === 'list' ? list(owner) : runReportedRemoteChange(() => write(request, owner));
    },
  };
}
