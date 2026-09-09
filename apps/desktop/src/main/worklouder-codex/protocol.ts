import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';
import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CREATOR_LIT_TASK_KEY_COUNT,
  buildCreatorMicro2AgentKeymap,
  type WorkLouderCodexConnectionReason,
  type WorkLouderCodexDeviceState,
} from '../../shared/workLouderCodex.js';

export { WORKLOUDER_CODEX_AGENT_SLOT_COUNT } from '../../shared/workLouderCodex.js';

export const enum WorkLouderLightingEffect {
  Off = 0,
  Solid = 1,
  Snake = 2,
  Rainbow = 3,
  Breath = 4,
  Gradient = 5,
  ShallowBreath = 6,
}

/** Hardware lighting consumes only the stable activity facets it renders. */
export type WorkLouderCodexSessionActivity = Pick<
  AgentIslandSessionActivity,
  'sessionId' | 'phase' | 'attention' | 'compactDetail'
>;

export interface WorkLouderLightingSide {
  effect: WorkLouderLightingEffect;
  brightness: number;
  speed: number;
  magic: number;
  color: number;
}

export interface WorkLouderThreadLighting {
  id: number;
  color: number;
  brightness: number;
  effect: WorkLouderLightingEffect;
  speed: number;
  syncKeysLighting: boolean;
  syncAmbientLighting: boolean;
}

export interface WorkLouderCodexLightingFrame {
  ambient: WorkLouderLightingSide;
  keys: WorkLouderLightingSide;
  threads: WorkLouderThreadLighting[];
}

export type WorkLouderCodexHostRequest =
  | { kind: 'init'; sdkEntry: string; keymapBackupDir?: string; creatorKeymap?: string[][] }
  | { kind: 'listen' }
  | { kind: 'apply'; frame: WorkLouderCodexLightingFrame }
  // Ask the host to verify the device is still there. The SDK has no
  // disconnect event, so unplugging goes unnoticed until something tries to
  // talk to the device — this is that something, driven by whoever is
  // currently showing connection state.
  | { kind: 'probe' }
  | { kind: 'discover' }
  | { kind: 'rebind-creator-keymap'; keymap: string[][] }
  | { kind: 'stop' };

export type WorkLouderCodexHostMessage =
  | {
      kind: 'state';
      status: 'connected' | 'not-detected' | 'error';
      reason?: Exclude<WorkLouderCodexConnectionReason, 'sdk-unavailable'>;
    }
  /** Legacy utility-host message retained for older host fakes and upgrades. */
  | { kind: 'agent-key'; slot: number }
  | { kind: 'device'; device: WorkLouderCodexDeviceState }
  | {
      kind: 'presence';
      present: boolean;
      deviceType?: 'codex-micro' | 'creator-micro-2';
      isUsbConnection?: boolean;
    }
  | { kind: 'hid'; event: WorkLouderCodexHidEvent }
  | { kind: 'joystick'; event: WorkLouderCodexJoystickEvent }
  | { kind: 'activity' }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { kind: 'stopped' };

export interface WorkLouderCodexHidEvent {
  key: string;
  act: 0 | 1 | 2;
}

export interface WorkLouderCodexJoystickEvent {
  angle: number;
  distance: number;
}

/**
 * Creator Micro 2's HID read loop goes idle between reports and the SDK logs
 * `hid_read_timeout`. That is silence, not an unplugged cable. Codex treats the
 * same timeout as "the cable came out".
 *
 * Both boards speak `v.oai.rgbcfg` / `v.oai.thstatus` / `v.oai.hid`. A lighting
 * RPC timeout must not tear down HID — ChatGPT keeps the notify subscription.
 */
export function workLouderFirmwareIdlesHidRead(
  deviceType: 'codex-micro' | 'creator-micro-2' | null | undefined,
): boolean {
  return deviceType === 'creator-micro-2';
}

/**
 * Another process is using the vendor HID, or our own handle was closed under
 * an in-flight RPC. That is contention, not an unplugged cable — recycling the
 * host here just storms `0xE00002E2` / `device has been closed`.
 */
export function isWorkLouderHidContention(detail: string): boolean {
  return /0xE00002C1|0xE00002E2|device has been closed|\(iokit\/common\) not permitted/i.test(
    detail,
  );
}

/** Creator idle HID silence. Not an unplug, not a reason to probe liveness. */
export function isWorkLouderIdleFirmwareError(
  detail: string,
  deviceType: 'codex-micro' | 'creator-micro-2' | null | undefined,
): boolean {
  if (!workLouderFirmwareIdlesHidRead(deviceType)) return false;
  return /hid_read_timeout|device disconnected|could not read/i.test(detail);
}

export function shouldRequestWorkLouderLivenessProbe(
  detail: string,
  deviceType: 'codex-micro' | 'creator-micro-2' | null | undefined,
): boolean {
  if (isWorkLouderHidContention(detail)) return false;
  if (isWorkLouderIdleFirmwareError(detail, deviceType)) return false;
  return true;
}

/**
 * The native SDK often logs a dead USB/BT handle instead of throwing.
 *
 * Lighting control-plane noise (`Error calling RPC`, `Request timed out`,
 * `No resolver found`, `RPC operation failed`) is not a dead cable. Treating
 * those as transport death unsubscribes `v.oai.hid` and makes Creator Micro 2
 * keys look dead while Codex still works.
 *
 * Creator's idle HID read also poisons the in-flight `device.status` RPC with
 * `Device disconnected`. That is the same silence as `hid_read_timeout`, not an
 * unplug. Codex still treats both the timeout and a disconnected handle as a
 * dead cable.
 *
 * HID contention (`0xE00002E2`, `device has been closed`) is also not a dead
 * cable — see `isWorkLouderHidContention`.
 */

export function isWorkLouderSdkTransportDeath(
  detail: string,
  deviceType: 'codex-micro' | 'creator-micro-2' | null | undefined,
): boolean {
  if (isWorkLouderHidContention(detail)) return false;
  if (isWorkLouderIdleFirmwareError(detail, deviceType)) return false;
  if (/hid_read_timeout/i.test(detail)) {
    return Boolean(deviceType) && !workLouderFirmwareIdlesHidRead(deviceType);
  }
  return /cannot send, no device connected|device disconnected|hid_unavailable|0xE00002C5|error sending message|could not write|hid device disconnected/i.test(
    detail,
  );
}

const COLORS = {
  running: 0x4c6fff,
  'needs-interaction': 0xffa000,
  completed: 0x35c759,
  error: 0xff453a,
  /**
   * Window-reopen red tuned for these LEDs.
   * UI brand red `#DF0C27` / `#A61629` wash pink on the board.
   */
  brand: 0xd0060c,
} as const;

const OFF_SIDE: WorkLouderLightingSide = {
  effect: WorkLouderLightingEffect.Off,
  brightness: 0,
  speed: 0,
  magic: 0,
  color: 0,
};

const PHASE_PRIORITY: Readonly<Record<WorkLouderCodexSessionActivity['phase'], number>> = {
  'needs-interaction': 4,
  error: 3,
  running: 2,
  completed: 1,
};

/**
 * Projects Cindy's process-wide task activity into the two Codex Micro lighting
 * zones plus its six per-thread indicators.
 */
export function createWorkLouderCodexLightingFrame(
  activity: readonly WorkLouderCodexSessionActivity[],
  slotSessionIds?: readonly string[],
  threadCount: number = WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
): WorkLouderCodexLightingFrame {
  const slots = projectWorkLouderCodexSlotActivity(activity, slotSessionIds, threadCount);
  const aggregate = slots.reduce<WorkLouderCodexSessionActivity['phase'] | null>((current, item) => {
    if (!item) return current;
    return current === null || PHASE_PRIORITY[item.phase] > PHASE_PRIORITY[current]
      ? item.phase
      : current;
  }, null);

  return {
    ambient: aggregate ? ambientForPhase(aggregate) : { ...OFF_SIDE },
    keys: aggregate ? keysForPhase(aggregate) : { ...OFF_SIDE },
    threads: Array.from({ length: threadCount }, (_, id) => threadForActivity(id, slots[id])),
  };
}

/** Extra Creator keys have no AG thread and would otherwise inherit this zone. */
export function muteWorkLouderCodexKeyZone(
  frame: WorkLouderCodexLightingFrame,
): WorkLouderCodexLightingFrame {
  return { ...frame, keys: { ...OFF_SIDE } };
}

/** The ordered task assignment shared by the six LEDs and their physical keys. */
export function selectWorkLouderCodexSlotActivity(
  activity: readonly WorkLouderCodexSessionActivity[],
): WorkLouderCodexSessionActivity[] {
  return activity.filter(isLightingVisibleActivity).slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT);
}

/**
 * Copy worker lighting onto the lead task key.
 *
 * Agent keys and LEDs are assigned to the lead session. Orca workers are
 * separate sessions, so a team that is still working would otherwise look idle
 * as soon as the lead turn finished.
 */
export function foldOrcaWorkerActivityOntoLeads(
  activity: readonly WorkLouderCodexSessionActivity[],
  workersByLead: Readonly<Record<string, readonly string[]>>,
): WorkLouderCodexSessionActivity[] {
  const byId = new Map(activity.map((item) => [item.sessionId, item]));
  let changed = false;
  const next = [...activity];
  for (const [leadId, workerIds] of Object.entries(workersByLead)) {
    if (workerIds.length === 0) continue;
    let best = lightingActivityOrNull(byId.get(leadId));
    for (const workerId of workerIds) {
      const worker = lightingActivityOrNull(byId.get(workerId));
      if (!worker) continue;
      if (!best || lightingActivityRank(worker) > lightingActivityRank(best)) {
        best = { ...worker, sessionId: leadId };
      }
    }
    if (!best) continue;
    const existingIndex = next.findIndex((item) => item.sessionId === leadId);
    if (existingIndex === -1) {
      next.push(best);
      changed = true;
    } else if (lightingActivityRank(best) > lightingActivityRank(next[existingIndex]!)) {
      next[existingIndex] = best;
      changed = true;
    }
  }
  return changed ? next : activity as WorkLouderCodexSessionActivity[];
}

function lightingActivityOrNull(
  item: WorkLouderCodexSessionActivity | undefined,
): WorkLouderCodexSessionActivity | null {
  return item && isLightingVisibleActivity(item) ? item : null;
}

function lightingActivityRank(item: WorkLouderCodexSessionActivity): number {
  return (PHASE_PRIORITY[item.phase] ?? 0) + (item.attention ? 0.1 : 0);
}

/** Aligns activity LEDs with an explicit six-task key assignment when one is available. */
export function projectWorkLouderCodexSlotActivity(
  activity: readonly WorkLouderCodexSessionActivity[],
  slotSessionIds?: readonly string[],
  threadCount: number = WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
): Array<WorkLouderCodexSessionActivity | undefined> {
  if (slotSessionIds === undefined) {
    return selectWorkLouderCodexSlotActivity(activity).slice(0, threadCount);
  }
  const visibleBySessionId = new Map(
    activity.filter(isLightingVisibleActivity).map((item) => [item.sessionId, item] as const),
  );
  return Array.from({ length: threadCount }, (_, slot) => {
    const sessionId = slotSessionIds[slot];
    return sessionId ? visibleBySessionId.get(sessionId) : undefined;
  });
}

/** Accept press events for Agent keys AG00 through AG12. */
export function parseWorkLouderCodexAgentKeyPress(value: unknown): number | null {
  const event = parseWorkLouderCodexHidEvent(value);
  if (!event || event.act !== 1) return null;
  const match = /^AG(0[0-9]|1[0-2])$/.exec(event.key);
  return match ? Number(match[1]) : null;
}

export function parseWorkLouderCodexHidEvent(value: unknown): WorkLouderCodexHidEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as { key?: unknown; k?: unknown; act?: unknown };
  const key = typeof event.key === 'string' ? event.key : event.k;
  if (typeof key !== 'string' || key.length === 0 || key.length > 32) {
    return null;
  }
  if (
    !/^AG(0[0-9]|1[0-2])$/.test(key) &&
    !/^ACT(?:0[6-9]|1[0-2])$/.test(key) &&
    !/^ENC[A-Z0-9_]*$/.test(key)
  ) {
    return null;
  }
  const act = parseWorkLouderCodexHidAct(event.act);
  return act === null ? null : { key, act };
}

/**
 * Creator Micro 2 often emits HID / stick reports as a bare JSON object
 * (`{k,act}` / `{a,d}`) instead of a JSON-RPC notify with `method: v.oai.hid`.
 * The official SDK then logs "Received RPC call without id and method" and
 * drops the report, so Cindy never sees the key. Rewrite those lines into the
 * notify the SDK already knows how to dispatch.
 */
export function rewriteBareWorkLouderNotifyJson(data: string): string | null {
  const jsonStart = data.indexOf('{');
  if (jsonStart < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.slice(jsonStart));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.id != null || record.i != null || record.method != null || record.m != null) {
    return null;
  }
  const hidKey = record.k ?? record.key;
  if (typeof hidKey === 'string' && hidKey.length > 0 && hidKey.length <= 32) {
    return JSON.stringify({
      method: 'v.oai.hid',
      params: { k: hidKey, act: record.act, ag: record.ag ?? record.agent },
    });
  }
  const angle = record.a ?? record.angle;
  const distance = record.d ?? record.distance;
  if (
    typeof angle === 'number' &&
    Number.isFinite(angle) &&
    typeof distance === 'number' &&
    Number.isFinite(distance)
  ) {
    return JSON.stringify({
      method: 'v.oai.rad',
      params: { a: angle, d: distance },
    });
  }
  return null;
}

/** Explicit `{ ok: false }` envelopes are failed hardware round trips, not empty telemetry. */
export function isFailedWorkLouderRpcEnvelope(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      (result as { ok?: unknown }).ok === false,
  );
}

export function workLouderRpcFailureMessage(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return 'Work Louder RPC failed';
  }
  const error = (result as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return 'Work Louder RPC failed';
}

/** Liveness/bind reads must throw on a failed envelope. Telemetry may still unwrap to `{}`. */
export function readWorkLouderDeviceStatusOrThrow(result: unknown): {
  firmwareVersion?: string;
  batteryPercentage?: number;
  isCharging?: boolean;
  layerIndex?: number;
  profileIndex?: number;
} {
  if (isFailedWorkLouderRpcEnvelope(result)) {
    throw new Error(workLouderRpcFailureMessage(result));
  }
  return unwrapWorkLouderDeviceStatus(result);
}

/** `getDeviceStatus` returns either a snapshot or the SDK `{ok, value}` envelope. */
export function unwrapWorkLouderDeviceStatus(result: unknown): {
  firmwareVersion?: string;
  batteryPercentage?: number;
  isCharging?: boolean;
  layerIndex?: number;
  profileIndex?: number;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const record = result as Record<string, unknown>;
  if (record.ok === false) return {};
  const source =
    record.ok === true && record.value && typeof record.value === 'object' && !Array.isArray(record.value)
      ? (record.value as Record<string, unknown>)
      : record;
  const firmwareVersion =
    typeof source.firmwareVersion === 'string'
      ? source.firmwareVersion
      : typeof source.version === 'string'
        ? source.version
        : undefined;
  const batteryPercentage =
    typeof source.batteryPercentage === 'number'
      ? source.batteryPercentage
      : typeof source.battery === 'number'
        ? source.battery
        : undefined;
  const isCharging =
    typeof source.isCharging === 'boolean'
      ? source.isCharging
      : typeof source.is_charging === 'boolean'
        ? source.is_charging
        : undefined;
  const layerIndex = readFiniteNumber(
    source.layer_index ?? source.layerIndex ?? source.selectedLayerIndex,
  );
  const profileIndex = readFiniteNumber(
    source.profile_index ?? source.profileIndex ?? source.selectedProfileIndex,
  );
  return {
    ...(firmwareVersion !== undefined ? { firmwareVersion } : {}),
    ...(batteryPercentage !== undefined ? { batteryPercentage } : {}),
    ...(isCharging !== undefined ? { isCharging } : {}),
    ...(layerIndex !== undefined ? { layerIndex } : {}),
    ...(profileIndex !== undefined ? { profileIndex } : {}),
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Creator Micro 2 ships as an open macropad: factory layers emit boot-protocol
 * keystrokes on the standard keyboard collection. Codex Micro ships with the
 * same keys bound to `KV_OAI_*`, which stops typing and emits `v.oai.hid`
 * instead. Cindy claims exclusivity the same way ChatGPT does — by writing
 * those keycodes into the active keymap layer.
 */
export const WORKLOUDER_DEVICE_KEYMAP_FILE = 'keymap.json';
export const WORKLOUDER_AGENT_KEY_MARKER = 'KV_OAI_AG00';
export const CREATOR_MICRO_2_KEYMAP_RELOAD_MS = 2_500;
/** Legacy owner-scoped fallback kept so an existing factory backup stays valid. */
export const CREATOR_MICRO_2_KEYMAP_BACKUP_FILE = 'keymap-backup.json';

export const CREATOR_MICRO_2_AGENT_KEYMAP: readonly (readonly string[])[] =
  buildCreatorMicro2AgentKeymap();

export const CREATOR_MICRO_2_AGENT_ENCODERS: readonly (readonly string[])[] = [
  ['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KV_OAI_ENC_CLK'],
];

export interface WorkLouderKeymapLayer {
  id?: number;
  name?: string;
  layout?: {
    encoders?: unknown;
    buttons?: unknown;
    keymap?: unknown;
    joystick?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface WorkLouderKeymapDocument {
  profiles: Array<{ layers: WorkLouderKeymapLayer[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

function unwrapWorkLouderRpcValue(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (record.ok === false) return null;
  if (record.ok === true && 'value' in record) return record.value;
  return result;
}

/** `fs.read` may return a string, `{data}`, a parsed object, or an SDK envelope. */
export function unwrapWorkLouderKeymapText(result: unknown): string | null {
  const payload = unwrapWorkLouderRpcValue(result);
  if (typeof payload === 'string') {
    return payload.trim().length > 0 ? payload : null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.data === 'string' && record.data.trim().length > 0) return record.data;
  if (Array.isArray(record.profiles)) return JSON.stringify(payload);
  return null;
}

export function parseWorkLouderKeymapDocument(text: string): WorkLouderKeymapDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const profiles = (parsed as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  const layers = (profiles[0] as { layers?: unknown } | undefined)?.layers;
  if (!Array.isArray(layers) || layers.length === 0) return null;
  return parsed as WorkLouderKeymapDocument;
}

export function workLouderLayerHasAgentKeys(layer: WorkLouderKeymapLayer | undefined): boolean {
  return Boolean(layer && JSON.stringify(layer).includes(WORKLOUDER_AGENT_KEY_MARKER));
}

/**
 * Cindy occupies a board by replacing one active layer with a full `KV_OAI_*`
 * grid. Snapshot/restore identity is that layer — a stale Cindy map on some
 * other profile or layer must not skip capturing the layer about to be rewritten.
 */
export function isCindyExclusiveAgentLayer(layer: WorkLouderKeymapLayer | undefined): boolean {
  const keymap = layer?.layout?.keymap;
  if (!Array.isArray(keymap)) return false;
  const codes = keymap.flat().filter((code): code is string => typeof code === 'string');
  return (
    codes.length >= 8 &&
    codes.every((code) => code.startsWith('KV_OAI_')) &&
    codes.some((code) => code.includes('AG00'))
  );
}

export function isCindyExclusiveAgentKeymap(
  text: string,
  profileIndex = 0,
  layerIndex = 0,
): boolean {
  const document = parseWorkLouderKeymapDocument(text);
  if (!document) return false;
  return isCindyExclusiveAgentLayer(document.profiles[profileIndex]?.layers?.[layerIndex]);
}

/**
 * `device.status.layer_index` is 1-based (ChatGPT uses layer 1). Returns a
 * 0-based index into `profiles[0].layers`, clamped to the keymap.
 */
export function resolveWorkLouderActiveLayerIndex(
  layerIndex: number | undefined,
  layerCount: number,
): number {
  if (layerCount <= 0) return 0;
  const oneBased =
    typeof layerIndex === 'number' && Number.isInteger(layerIndex) && layerIndex >= 1
      ? layerIndex
      : 1;
  return Math.min(layerCount - 1, oneBased - 1);
}

/** Firmware profile index is 0-based in `device.status`. */
export function resolveWorkLouderActiveProfileIndex(
  profileIndex: number | undefined,
  profileCount: number,
): number {
  if (profileCount <= 0) return 0;
  const zeroBased =
    typeof profileIndex === 'number' && Number.isInteger(profileIndex) && profileIndex >= 0
      ? profileIndex
      : 0;
  return Math.min(profileCount - 1, zeroBased);
}

export function applyCreatorMicro2AgentLayer(
  document: WorkLouderKeymapDocument,
  layerIndex: number,
  keymap: readonly (readonly string[])[] = CREATOR_MICRO_2_AGENT_KEYMAP,
  profileIndex = 0,
): { document: WorkLouderKeymapDocument; changed: boolean; alreadyBound: boolean } {
  const layers = document.profiles[profileIndex]?.layers;
  if (!layers || layerIndex < 0 || layerIndex >= layers.length) {
    return { document, changed: false, alreadyBound: false };
  }
  const original = layers[layerIndex] ?? {};
  const desiredKeymap = keymap.map((row) => [...row]);
  const desiredEncoders = CREATOR_MICRO_2_AGENT_ENCODERS.map((row) => [...row]);
  if (
    JSON.stringify(original.layout?.keymap) === JSON.stringify(desiredKeymap) &&
    JSON.stringify(original.layout?.encoders) === JSON.stringify(desiredEncoders)
  ) {
    return { document, changed: false, alreadyBound: true };
  }
  const nextLayer: WorkLouderKeymapLayer = {
    ...original,
    id: typeof original.id === 'number' ? original.id : layerIndex,
    layout: {
      ...(original.layout ?? {}),
      encoders: desiredEncoders,
      buttons: [],
      keymap: desiredKeymap,
      joystick: { type: 'VENDOR', sectors: [] },
    },
  };
  const nextLayers = layers.slice();
  nextLayers[layerIndex] = nextLayer;
  const nextProfiles = document.profiles.slice();
  nextProfiles[profileIndex] = { ...document.profiles[profileIndex], layers: nextLayers };
  return {
    document: { ...document, profiles: nextProfiles },
    changed: true,
    alreadyBound: false,
  };
}

const CREATOR_KEYMAP_BACKUP_ID_MAX = 64;

/**
 * Stable-enough filename for one Creator Micro 2 factory keymap.
 *
 * The SDK HID object has no serial. Prefer HID `serialNumber` when the host
 * still has it; otherwise fall back to a sanitized `portPath` / `devicePid`.
 * Empty identity keeps the legacy `keymap-backup.json` so an existing owner
 * backup is not abandoned.
 */
export function creatorMicro2KeymapBackupFileName(deviceId?: string | null): string {
  const sanitized = sanitizeCreatorKeymapBackupId(deviceId);
  return sanitized
    ? `keymap-backup-${sanitized}.json`
    : CREATOR_MICRO_2_KEYMAP_BACKUP_FILE;
}

/** Per-occupancy snapshot restored when Cindy releases the board. */
export function creatorMicro2KeymapSessionFileName(deviceId?: string | null): string {
  const sanitized = sanitizeCreatorKeymapBackupId(deviceId);
  return sanitized ? `keymap-session-${sanitized}.json` : 'keymap-session.json';
}

function sanitizeCreatorKeymapBackupId(deviceId: string | null | undefined): string {
  if (typeof deviceId !== 'string') return '';
  const trimmed = deviceId.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return trimmed.slice(0, CREATOR_KEYMAP_BACKUP_ID_MAX);
}

/** Firmware may omit `act` (SDK marks it optional); treat that as a press. */
function parseWorkLouderCodexHidAct(value: unknown): 0 | 1 | 2 | null {
  if (value === undefined || value === null) return 1;
  if (value === 0 || value === 1 || value === 2) return value;
  if (value === '0' || value === '1' || value === '2') return Number(value) as 0 | 1 | 2;
  return null;
}

export function parseWorkLouderCodexJoystickEvent(
  value: unknown,
): WorkLouderCodexJoystickEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as { angle?: unknown; distance?: unknown };
  if (
    typeof event.angle !== 'number' ||
    !Number.isFinite(event.angle) ||
    event.angle < 0 ||
    event.angle > 1 ||
    typeof event.distance !== 'number' ||
    !Number.isFinite(event.distance) ||
    event.distance < 0 ||
    event.distance > 1
  ) {
    return null;
  }
  return { angle: event.angle, distance: event.distance };
}

export function isWorkLouderCodexLightingFrameOff(frame: WorkLouderCodexLightingFrame): boolean {
  return (
    frame.ambient.brightness === 0 &&
    frame.keys.brightness === 0 &&
    frame.threads.every((thread) => thread.brightness === 0)
  );
}

/** Applies the user-facing overall brightness without mutating the semantic frame. */
export function applyWorkLouderCodexLightingBrightness(
  frame: WorkLouderCodexLightingFrame,
  brightnessPercent: number,
): WorkLouderCodexLightingFrame {
  const factor = Math.max(0, Math.min(100, brightnessPercent)) / 100;
  return {
    ambient: { ...frame.ambient, brightness: frame.ambient.brightness * factor },
    keys: { ...frame.keys, brightness: frame.keys.brightness * factor },
    threads: frame.threads.map((thread) => ({
      ...thread,
      brightness: thread.brightness * factor,
    })),
  };
}

export function createWorkLouderCodexOffFrame(
  threadCount: number = WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
): WorkLouderCodexLightingFrame {
  return {
    ambient: { ...OFF_SIDE },
    keys: { ...OFF_SIDE },
    threads: Array.from({ length: threadCount }, (_, id) => ({
      id,
      color: 0,
      brightness: 0,
      effect: WorkLouderLightingEffect.Off,
      speed: 0,
      syncKeysLighting: false,
      syncAmbientLighting: false,
    })),
  };
}

/**
 * A short hello on the whole board — used when Cindy's window comes back
 * after being hidden or minimized. Snake and breath are the two animated
 * effects already proven on this hardware (running / waiting). Rainbow is
 * not: on an idle board it can look like the lights never came on.
 */
export function createWorkLouderCodexWindowRevealFrame(
  threadCount: number = WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
): WorkLouderCodexLightingFrame {
  return {
    ambient: side(WorkLouderLightingEffect.Snake, 0.78, 0.55, COLORS.brand),
    keys: side(WorkLouderLightingEffect.Breath, 0.34, 0.55, COLORS.brand),
    threads: Array.from({ length: threadCount }, (_, id) => ({
      id,
      color: COLORS.brand,
      brightness: 0.72,
      effect: WorkLouderLightingEffect.Breath,
      speed: 0.55,
      syncKeysLighting: false,
      syncAmbientLighting: false,
    })),
  };
}

export function isWorkLouderCodexHostMessage(value: unknown): value is WorkLouderCodexHostMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as { kind?: unknown; status?: unknown; level?: unknown; message?: unknown };
  if (message.kind === 'stopped') return true;
  if (message.kind === 'activity') return true;
  if (message.kind === 'agent-key') {
    const slot = (message as { slot?: unknown }).slot;
    return (
      typeof slot === 'number' &&
      Number.isInteger(slot) &&
      slot >= 0 &&
      slot < WORKLOUDER_CREATOR_LIT_TASK_KEY_COUNT
    );
  }
  if (message.kind === 'hid')
    return parseWorkLouderCodexHidEvent((message as { event?: unknown }).event) !== null;
  if (message.kind === 'joystick') {
    return parseWorkLouderCodexJoystickEvent((message as { event?: unknown }).event) !== null;
  }
  if (message.kind === 'device')
    return isWorkLouderCodexDeviceState((message as { device?: unknown }).device);
  if (message.kind === 'presence') {
    const present = (message as { present?: unknown }).present;
    const deviceType = (message as { deviceType?: unknown }).deviceType;
    const isUsbConnection = (message as { isUsbConnection?: unknown }).isUsbConnection;
    return (
      typeof present === 'boolean' &&
      (deviceType === undefined ||
        deviceType === 'codex-micro' ||
        deviceType === 'creator-micro-2') &&
      (isUsbConnection === undefined || typeof isUsbConnection === 'boolean')
    );
  }
  if (message.kind === 'state') {
    const validStatus =
      message.status === 'connected' ||
      message.status === 'not-detected' ||
      message.status === 'error';
    const reason = (message as { reason?: unknown }).reason;
    return (
      validStatus &&
      (reason === undefined ||
        reason === null ||
        reason === 'connection-timeout' ||
        reason === 'connection-failed' ||
        reason === 'permission-required' ||
        reason === 'device-in-use')
    );
  }
  if (message.kind === 'log') {
    return (
      (message.level === 'debug' ||
        message.level === 'info' ||
        message.level === 'warn' ||
        message.level === 'error') &&
      typeof message.message === 'string'
    );
  }
  return false;
}

function isWorkLouderCodexDeviceState(value: unknown): value is WorkLouderCodexDeviceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const device = value as WorkLouderCodexDeviceState;
  return (
    (device.deviceType === null ||
      device.deviceType === 'codex-micro' ||
      device.deviceType === 'creator-micro-2') &&
    (device.isUsbConnection === null || typeof device.isUsbConnection === 'boolean') &&
    (device.firmwareVersion === null || typeof device.firmwareVersion === 'string') &&
    (device.batteryPercentage === null ||
      (typeof device.batteryPercentage === 'number' &&
        Number.isFinite(device.batteryPercentage) &&
        device.batteryPercentage >= 0 &&
        device.batteryPercentage <= 100)) &&
    (device.isCharging === null || typeof device.isCharging === 'boolean') &&
    (device.inputMonitoringPermission === 'granted' ||
      device.inputMonitoringPermission === 'denied' ||
      device.inputMonitoringPermission === 'unknown' ||
      device.inputMonitoringPermission === 'not-required')
  );
}

function isLightingVisibleActivity(activity: WorkLouderCodexSessionActivity): boolean {
  return (
    activity.phase === 'running' ||
    activity.phase === 'needs-interaction' ||
    activity.attention === true
  );
}

function ambientForPhase(phase: WorkLouderCodexSessionActivity['phase']): WorkLouderLightingSide {
  switch (phase) {
    case 'running':
      return side(WorkLouderLightingEffect.Snake, 0.7, 0.4, COLORS.running);
    case 'needs-interaction':
      return side(WorkLouderLightingEffect.Breath, 0.95, 0.35, COLORS['needs-interaction']);
    case 'completed':
      return side(WorkLouderLightingEffect.Solid, 0.7, 0, COLORS.completed);
    case 'error':
      return side(WorkLouderLightingEffect.Breath, 1, 0.45, COLORS.error);
  }
}

function keysForPhase(phase: WorkLouderCodexSessionActivity['phase']): WorkLouderLightingSide {
  const effect =
    phase === 'error' ? WorkLouderLightingEffect.Breath : WorkLouderLightingEffect.Solid;
  const brightness = phase === 'needs-interaction' || phase === 'error' ? 0.28 : 0.16;
  return side(effect, brightness, phase === 'error' ? 0.45 : 0, COLORS[phase]);
}

function threadForActivity(
  id: number,
  activity: WorkLouderCodexSessionActivity | undefined,
): WorkLouderThreadLighting {
  if (!activity) {
    return {
      id,
      color: 0,
      brightness: 0,
      effect: WorkLouderLightingEffect.Off,
      speed: 0,
      syncKeysLighting: false,
      syncAmbientLighting: false,
    };
  }
  const animated =
    activity.phase === 'running' ||
    activity.phase === 'needs-interaction' ||
    activity.phase === 'error';
  return {
    id,
    color: COLORS[activity.phase],
    brightness: 0.8,
    effect: animated ? WorkLouderLightingEffect.Breath : WorkLouderLightingEffect.Solid,
    speed: animated ? 0.35 : 0,
    syncKeysLighting: false,
    syncAmbientLighting: false,
  };
}

function side(
  effect: WorkLouderLightingEffect,
  brightness: number,
  speed: number,
  color: number,
): WorkLouderLightingSide {
  return { effect, brightness, speed, magic: 0, color };
}
