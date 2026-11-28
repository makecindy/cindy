import { z } from 'zod';

/**
 * Provider management of a managed cloud instance, for the same account's cloud settings
 * page. It is a private DeviceLink channel registered only by the cloud runtime; ordinary
 * desktops answer CHANNEL_NOT_ALLOWED, so an older runtime is detected as unsupported.
 *
 * Reads return the full catalog the local providers page uses (hidden and payment-locked
 * models included); execution routing and credentials never cross. Writes reuse the Host's
 * native provider handlers. Credentials and logins stay on the CIS
 * management tickets (see CLOUD_PROVIDER_SETUP_ITEM).
 */
export const CLOUD_PROVIDER_SETTINGS_CHANNEL = 'cloud:provider-settings:v1';
export const CLOUD_PROVIDER_SETTINGS_MAX_BYTES = 2 * 1024 * 1024;

export const CLOUD_PROVIDER_SETTINGS_OPS = [
  'list',
  'visibility-set',
  'visibility-reset',
  'model-disable',
  'order',
  'presentation',
  'remote-access',
  'refresh',
  'rediscover',
  'model-call',
  // Image-input capability override of the model panel.
  'image-input',
  'effort',
  'model-edit',
  'cli-scan',
  'share',
  'presets',
  'provider-view',
  'custom-create',
  'custom-update',
  'custom-delete',
  'models-fetch',
  'test-connection',
  'detect',
  'setup-stage',
  'setup-result',
  'xd',
  'byok',
  'codex-limits',
  'codex-reset',
  'account-usage',
] as const;
export type CloudProviderSettingsOp = (typeof CLOUD_PROVIDER_SETTINGS_OPS)[number];

/** Model panel calls served by the instance's native handlers, with its own owner stamp. */
export const CLOUD_MODEL_CALLS = {
  'context-get': 'maker:model-context-limit:get',
  'context-set': 'maker:model-context-limit:set',
  'context-reset': 'maker:model-context-limit:reset',
  'compaction-set': 'maker:model-compaction:set',
  'price-get': 'maker:model-price-override:get',
  'price-set': 'maker:model-price-override:set',
  'price-reset': 'maker:model-price-override:reset',
  'image-input-get': 'maker:model-image-input:get',
  'image-input-set': 'maker:model-image-input:set',
} as const;
export type CloudModelCall = keyof typeof CLOUD_MODEL_CALLS;

/**
 * Setup steps that carry secrets (API keys, request headers) or need an interactive login run
 * through this CIS management item: the controller stages the non-secret request on the
 * private channel, then applies it with the secrets in the ticket and reads the result back.
 */
export const CLOUD_PROVIDER_SETUP_ITEM = 'setup:apply';
export const CLOUD_PROVIDER_SETUP_KINDS = [
  'models-fetch',
  'test-connection',
  'detect',
  'custom-create',
  'custom-update',
  'builtin-key',
  'oauth-login',
  'native-login',
] as const;
export type CloudProviderSetupKind = (typeof CLOUD_PROVIDER_SETUP_KINDS)[number];
/** Ticket field with the secrets: `{ apiKey?, headers?, keys?, runtimeHeaders? }` as JSON. */
export interface CloudProviderSetupSecrets {
  apiKey?: string;
  headers?: Record<string, string>;
  keys?: Partial<Record<'claude-code' | 'codex' | 'pi', string>>;
  runtimeHeaders?: Partial<Record<'claude-code' | 'codex' | 'pi', Record<string, string>>>;
}

const id = z.string().min(1).max(256);
const agent = z.enum(['claude-code', 'codex', 'pi']);
const modelTarget = z.strictObject({ providerId: id, agent, modelId: id });
const ownerGeneration = z.number().int().nonnegative();
const json = z.record(z.string(), z.unknown());
const updateOptions = z
  .strictObject({
    source: z.literal('manual-settings').optional(),
    codexImageGenerationRestartPolicy: z.literal('interrupt').optional(),
  });
const targets = z
  .array(z.strictObject({ agent: z.string().min(1).max(64), modelId: id }))
  .min(1)
  .max(512);

export const cloudProviderSettingsRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('list') }),
  z
    .strictObject({
      op: z.literal('visibility-set'),
      ownerGeneration,
      revision: z.string().min(1).max(256),
      providerId: id,
      targets,
      enabled: z.boolean(),
    }),
  z
    .strictObject({
      op: z.literal('visibility-reset'),
      ownerGeneration,
      revision: z.string().min(1).max(256),
      providerId: id,
      targets,
    }),
  z
    .strictObject({
      op: z.literal('model-disable'),
      ownerGeneration,
      providerId: id,
      kind: z.enum(['model', 'provider', 'reset']),
      disabled: z.boolean().optional(),
      modelIds: z.array(id).min(1).max(512).optional(),
    }),
  z
    .strictObject({ op: z.literal('order'), ownerGeneration, providerIds: z.array(id).min(1).max(256) }),
  z
    .strictObject({
      op: z.literal('presentation'),
      ownerGeneration,
      providerId: id,
      action: z.enum(['rename', 'remove', 'restore']),
      name: z.string().min(1).max(128).optional(),
    }),
  z
    .strictObject({
      op: z.literal('remote-access'),
      ownerGeneration,
      providerId: id,
      enabled: z.boolean(),
    }),
  z.strictObject({ op: z.literal('refresh'), ownerGeneration, providerId: id }),
  z.strictObject({ op: z.literal('rediscover'), ownerGeneration, providerId: id }),
  z
    .strictObject({
      op: z.literal('model-call'),
      ownerGeneration,
      call: z.enum(Object.keys(CLOUD_MODEL_CALLS) as [CloudModelCall, ...CloudModelCall[]]),
      target: modelTarget
        .extend({ relatedTargets: z.array(modelTarget).max(2).optional() })
        .strict(),
      /** Limit, compaction percentage or image input (null resets), or the desired price quote. */
      value: z
        .union([
          z.number().finite().nullable(),
          z.boolean(),
          z
            .strictObject({
              currency: z.enum(['CNY', 'USD']),
              inputPerMtok: z.number().finite(),
              outputPerMtok: z.number().finite(),
              cacheReadPerMtok: z.number().finite().nullable().optional(),
              cacheCreatePerMtok: z.number().finite().nullable().optional(),
            }),
        ])
        .optional(),
    }),
  z
    .strictObject({
      op: z.literal('effort'),
      ownerGeneration,
      agent,
      providerId: id,
      modelId: id,
      effort: z.string().min(1).max(32).nullable(),
    }),
  z
    .strictObject({
      op: z.literal('model-edit'),
      ownerGeneration,
      providerId: id,
      agent,
      modelId: id,
      edit: z.discriminatedUnion('kind', [
        z
          .strictObject({
            kind: z.literal('interface'),
            api: z.string().min(1).max(128),
            profile: z.boolean(),
          }),
        z
          .strictObject({
            kind: z.literal('capability'),
            media: z.enum(['image', 'video']),
            value: z.enum(['default', 'generate', 'edit']),
          }),
      ]),
    }),
  z.strictObject({ op: z.literal('cli-scan'), ownerGeneration }),
  z.strictObject({ op: z.literal('presets'), ownerGeneration }),
  /** One provider as the instance's own Settings page sees it; never credentials. */
  z.strictObject({ op: z.literal('provider-view'), ownerGeneration, providerId: id }),
  /** Secret-free configuration writes (OAuth drafts, model choices); keys use the ticket. */
  z
    .strictObject({
      op: z.enum(['custom-create', 'custom-update']),
      ownerGeneration,
      config: json,
      options: updateOptions.optional(),
    }),
  z.strictObject({ op: z.literal('custom-delete'), ownerGeneration, providerId: id }),
  /** Secret-free probes (saved credentials stay on the instance, or no authentication). */
  z
    .strictObject({
      op: z.enum(['models-fetch', 'test-connection', 'detect']),
      ownerGeneration,
      request: json,
    }),
  z
    .strictObject({
      op: z.literal('setup-stage'),
      ownerGeneration,
      kind: z.enum(CLOUD_PROVIDER_SETUP_KINDS),
      request: json,
    }),
  z.strictObject({ op: z.literal('setup-result'), ownerGeneration, stageId: z.string().uuid() }),
  z
    .strictObject({
      op: z.literal('xd'),
      ownerGeneration,
      action: z.enum(['status', 'retry', 'rotate', 'disconnect']),
    }),
  z.strictObject({ op: z.literal('byok'), ownerGeneration, action: z.enum(['status', 'retry']) }),
  z.strictObject({ op: z.literal('codex-limits'), ownerGeneration, providerId: id.optional() }),
  z
    .strictObject({
      op: z.literal('codex-reset'),
      ownerGeneration,
      idempotencyKey: z.string().uuid(),
      providerId: id.optional(),
    }),
  z
    .strictObject({
      op: z.literal('account-usage'),
      ownerGeneration,
      providerId: id,
      forceRefresh: z.boolean().optional(),
    }),
  z
    .strictObject({
      op: z.literal('share'),
      ownerGeneration,
      /** Guest actions on this instance: its received shares, its credential trust, leaving. */
      command: z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('received') }),
        z.strictObject({ action: z.literal('get-credential-consent'), shareId: id }),
        z
          .strictObject({ action: z.literal('set-credential-consent'), shareId: id, skip: z.boolean() }),
        z.strictObject({ action: z.literal('leave'), memberId: id }),
        z.strictObject({ action: z.literal('insights'), shareId: id, includeUsage: z.boolean() }),
      ]),
    }),
]);
export type CloudProviderSettingsRequest = z.infer<typeof cloudProviderSettingsRequestSchema>;

export interface CloudProviderVisibilityState {
  /** `ready` only; anything else keeps visibility read-only, as on the local page. */
  status: 'ready' | 'pending-migration' | 'unavailable' | 'unreadable';
  revision: string | null;
  overrides: Record<string, boolean>;
}

export interface CloudProviderSettingsList {
  version: 1;
  ownerGeneration: number;
  /** Same shape as the local `maker:provider:list` providers, with routing projected for display. */
  providers: unknown[];
  providerOrder: string[];
  visibility: CloudProviderVisibilityState;
  /** Remembered reasoning effort by memory slot (`agent:providerId`, `agent:*`) and model. */
  efforts?: Record<string, Record<string, string>>;
  supportedOps: CloudProviderSettingsOp[];
  /** Guest share actions this instance runs; absent on older instances, which do not run `insights`. */
  shareActions?: CloudProviderShareAction[];
}

export type CloudProviderShareAction = Extract<
  CloudProviderSettingsRequest,
  { op: 'share' }
>['command']['action'];
export const CLOUD_PROVIDER_SHARE_ACTIONS: readonly CloudProviderShareAction[] = [
  'received',
  'get-credential-consent',
  'set-credential-consent',
  'leave',
  'insights',
];

export interface CloudProviderSettingsWriteReceipt {
  ok: true;
  ownerGeneration: number;
  /** Visibility writes return the new state so a toggle need not re-download the catalog. */
  visibility?: CloudProviderVisibilityState;
  /** The write changed the catalog itself; refetch `list`. */
  catalogChanged: boolean;
  /** Result of a model panel call (context limit or price override view, CLI detections). */
  value?: unknown;
}
