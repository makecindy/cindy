/**
 * What each controller declares on the wire. Values are the production constants;
 * the lists mirror the controller code cited next to each field.
 */
import {
  CONTROLLER_CAPABILITY_HISTORY_RELINK_FOLDED_V1,
  CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
  CONTROLLER_CAPABILITY_SESSION_LIST_MESSAGES_V1,
  CONTROLLER_CAPABILITY_SESSION_TEXT_SNAPSHOT_V1,
  CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1,
  CONTROLLER_CAPABILITY_TOOL_RESULT_EVENT_TEXT_OPTIONAL_V1,
  CONTROLLER_CAPABILITY_TOOL_RESULT_LIVE_LIMIT_V1,
  CONTROLLER_CAPABILITY_TOOL_USE_EVENT_INPUT_OPTIONAL_V1,
  DEVICE_LINK_CAPABILITY_COMPACT_MESSAGE_HISTORY_V1,
  PROVIDER_SHARE_RELAY_CAPABILITY,
  SHARED_TASK_CAPABILITY,
  type DeviceLinkClientOptions,
  type DeviceLinkTiming,
} from '@cindy/device-link';

export type ProfileId = 'phone' | 'desktop';

export interface ControllerProfile {
  id: ProfileId;
  deviceId: string;
  deviceName: string;
  platform: 'ios' | 'darwin';
  helloCapabilities: string[];
  /** link-open and device-link:subscribe capability list (the client appends transport ones). */
  controllerCapabilities: string[];
  remoteControlEnabled: boolean;
  peerFailurePolicy: DeviceLinkClientOptions['peerFailurePolicy'];
  peerResetReadRetry: boolean;
  timing: Partial<DeviceLinkTiming>;
  /** `capabilities` is the profile's list after capability switches (switches.ts). */
  subscribeArgs(topics: string[], capabilities: readonly string[]): unknown;
  /** Open-view `local-db:messages:view` options (before is dropped by JSON when undefined). */
  historyViewOptions(before?: string): Record<string, unknown>;
  /** Sidebar read-ahead `local-db:messages:view` options. */
  prefetchViewOptions(): Record<string, unknown>;
}

/** apps/mobile/src/device-link/DeviceLinkContext.tsx:301-317 (CONTROLLER_CAPABILITIES). */
const MOBILE_CONTROLLER_CAPABILITIES = [
  CONTROLLER_CAPABILITY_SESSION_LIST_MESSAGES_V1,
  SHARED_TASK_CAPABILITY,
  CONTROLLER_CAPABILITY_SESSION_TEXT_SNAPSHOT_V1,
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
  CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
  DEVICE_LINK_CAPABILITY_COMPACT_MESSAGE_HISTORY_V1,
  CONTROLLER_CAPABILITY_TOOL_RESULT_EVENT_TEXT_OPTIONAL_V1,
  CONTROLLER_CAPABILITY_TOOL_USE_EVENT_INPUT_OPTIONAL_V1,
  CONTROLLER_CAPABILITY_HISTORY_RELINK_FOLDED_V1,
];

/** apps/desktop/src/main/device-link/index.ts:623-645 (CONTROLLER_CAPABILITIES). */
const DESKTOP_CONTROLLER_CAPABILITIES = [
  CONTROLLER_CAPABILITY_SESSION_LIST_MESSAGES_V1,
  SHARED_TASK_CAPABILITY,
  CONTROLLER_CAPABILITY_SESSION_TEXT_SNAPSHOT_V1,
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
  CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1,
  CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
  CONTROLLER_CAPABILITY_TOOL_RESULT_EVENT_TEXT_OPTIONAL_V1,
  CONTROLLER_CAPABILITY_HISTORY_RELINK_FOLDED_V1,
  CONTROLLER_CAPABILITY_TOOL_RESULT_LIVE_LIMIT_V1,
  PROVIDER_SHARE_RELAY_CAPABILITY,
];

export const PHONE: ControllerProfile = {
  id: 'phone',
  deviceId: 'baseline-phone',
  deviceName: 'Baseline phone',
  platform: 'ios',
  // DeviceLinkContext.tsx:1172-1179
  helloCapabilities: [SHARED_TASK_CAPABILITY],
  controllerCapabilities: MOBILE_CONTROLLER_CAPABILITIES,
  remoteControlEnabled: false,
  // DeviceLinkContext.tsx connectionOptions
  peerFailurePolicy: 'isolate-peer',
  peerResetReadRetry: false,
  timing: { pingIntervalMs: 10_000, pongMissLimit: 1, getTokenTimeoutMs: 10_000, handshakeTimeoutMs: 12_000, requestTimeoutMs: 15_000 },
  // DeviceLinkContext.tsx:2714-2721
  subscribeArgs: (topics, capabilities) => ({ topics, controllerName: 'Baseline phone', capabilities: [...capabilities] }),
  // mobileMakerTransport.ts:1268-1270
  historyViewOptions: (before) => ({ before, lazyDetails: true, workLines: true }),
  // remoteHistoryPrefetch.ts reads through readHistoryView (same options)
  prefetchViewOptions: () => ({ lazyDetails: true, workLines: true }),
};

export const DESKTOP: ControllerProfile = {
  id: 'desktop',
  deviceId: 'baseline-desktop',
  deviceName: 'Baseline desktop',
  platform: 'darwin',
  // index.ts:916-917 (provider-share-availability-v1 from providerShareAvailability.ts:24)
  helloCapabilities: [SHARED_TASK_CAPABILITY, PROVIDER_SHARE_RELAY_CAPABILITY, 'provider-share-availability-v1'],
  controllerCapabilities: DESKTOP_CONTROLLER_CAPABILITIES,
  remoteControlEnabled: false,
  peerFailurePolicy: 'legacy',
  // index.ts connectionOptions
  peerResetReadRetry: true,
  timing: { pingIntervalMs: 15_000 },
  // index.ts:2553-2561
  subscribeArgs: (topics, capabilities) => ({ topics, controllerName: 'Baseline desktop', capabilities: [...capabilities] }),
  // makerChatStore.ts:12294
  historyViewOptions: (before) => ({ before, lazyDetails: true, workLines: true }),
  // makerChatStore.ts:12468-12469
  prefetchViewOptions: () => ({ lazyDetails: true }),
};

export const PROFILES: readonly ControllerProfile[] = [PHONE, DESKTOP];
