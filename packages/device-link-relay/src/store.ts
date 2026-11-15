/**
 * 中转的持久状态:中转身份、主人账号与主人公钥、设备档案(只存凭证哈希,另存主人签发的设备证书)、
 * 媒体签名密钥。
 *
 * 单个 JSON 文件,原子写入(临时文件 + rename,权限 0600)。结构变化(加入、移除、改名、
 * 自报信息变化)立即排队保存;lastSeenAt 只在断开时更新,避免每次心跳写盘。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceInfo } from '@cindy/device-link-protocol';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';
import { isRelayPublicKey, verifyRelayDeviceCert, type RelayDeviceCert } from '@cindy/device-link/relay-auth';
import { createSecret, hashSecret, isSha256Hex } from './credentials';
import { RelayError } from './errors';

export const STATE_FILE = 'relay-state.json';
/** 2:加入设备签名(主人公钥 + 每台设备的证书)。schema 1 的数据不再接受,需重新开启中转。 */
const STATE_SCHEMA = 2;

export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_NAME_LENGTH = 64;
const MAX_USER_ID_LENGTH = 128;

export type DeviceRole = 'owner' | 'member';

export interface StoredDevice {
  deviceId: string;
  role: DeviceRole;
  credentialHash: string;
  /** 主人签发的设备证书:其他设备据此核对这台设备发出的消息。 */
  cert: RelayDeviceCert;
  /** 设备在 hello 里自报的名字。 */
  reportedName: string;
  /** 用户改过的名字;null = 用自报名。 */
  customName: string | null;
  platform: string | null;
  appVersion: string | null;
  deviceInfo: DeviceInfo | null;
  pairedAt: number;
  lastSeenAt: number | null;
}

interface RelayStateFile {
  schema: typeof STATE_SCHEMA;
  relayId: string;
  name: string;
  ownerUserId: string;
  ownerPublicKey: string;
  mediaSigningKey: string;
  devices: StoredDevice[];
}

export interface InitializeRelayInput {
  dataDir: string;
  /** 中转的展示名,加入页与设置页显示。 */
  name: string;
  /** 主人电脑登录的 Cindy 账号 ID;hello-ack.userId 原样返回,加入时用于防误操作。 */
  ownerUserId: string;
  /** 主人电脑与官方登录相同的设备 ID。 */
  ownerDeviceId: string;
  ownerDeviceName: string;
  /** 主人电脑凭证的 SHA-256;明文只留在主人电脑。 */
  ownerCredentialHash: string;
  /** 中转 ID 由主人电脑生成(UUID):主人证书要签进这个 ID。 */
  relayId: string;
  /** 主人公钥;私钥只留在主人电脑。 */
  ownerPublicKey: string;
  /** 主人给自己签发的设备证书。 */
  ownerCert: unknown;
  now?: number;
}

export function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
}

function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_USER_ID_LENGTH;
}

/** 首次创建中转状态。已存在时拒绝,避免覆盖已有设备档案。 */
export async function initializeRelay(input: InitializeRelayInput): Promise<{ relayId: string }> {
  const name = normalizeName(input.name);
  const ownerDeviceName = normalizeName(input.ownerDeviceName);
  if (!name || !ownerDeviceName) throw new RelayError('BAD_REQUEST', 'invalid relay or device name');
  if (!isValidUserId(input.ownerUserId)) throw new RelayError('BAD_REQUEST', 'invalid owner account');
  if (!DEVICE_ID_PATTERN.test(input.ownerDeviceId)) throw new RelayError('BAD_REQUEST', 'invalid owner device id');
  if (!isSha256Hex(input.ownerCredentialHash)) throw new RelayError('BAD_REQUEST', 'invalid owner credential hash');
  if (!RELAY_ID_PATTERN.test(input.relayId)) throw new RelayError('BAD_REQUEST', 'invalid relay id');
  if (!isRelayPublicKey(input.ownerPublicKey)) throw new RelayError('BAD_REQUEST', 'invalid owner public key');
  const ownerCert = verifyRelayDeviceCert(nodeRelayAuthCrypto, input.ownerPublicKey, input.relayId, input.ownerCert);
  if (!ownerCert || ownerCert.role !== 'owner' || ownerCert.deviceId !== input.ownerDeviceId) {
    throw new RelayError('BAD_REQUEST', 'invalid owner certificate');
  }

  await mkdir(input.dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(input.dataDir, STATE_FILE);
  const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) throw new RelayError('ALREADY_INITIALIZED', 'relay data directory is already initialized');

  const state: RelayStateFile = {
    schema: STATE_SCHEMA,
    relayId: input.relayId,
    name,
    ownerUserId: input.ownerUserId,
    ownerPublicKey: input.ownerPublicKey,
    mediaSigningKey: createSecret(),
    devices: [
      {
        deviceId: input.ownerDeviceId,
        role: 'owner',
        credentialHash: input.ownerCredentialHash,
        cert: ownerCert,
        reportedName: ownerDeviceName,
        customName: null,
        platform: null,
        appVersion: null,
        deviceInfo: null,
        pairedAt: input.now ?? Date.now(),
        lastSeenAt: null,
      },
    ],
  };
  await writeStateAtomically(input.dataDir, state);
  return { relayId: state.relayId };
}

async function writeStateAtomically(dataDir: string, state: RelayStateFile): Promise<void> {
  const file = path.join(dataDir, STATE_FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseStoredDevice(raw: unknown, relayId: string, ownerPublicKey: string): StoredDevice | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(d.deviceId)) return null;
  if (d.role !== 'owner' && d.role !== 'member') return null;
  if (!isSha256Hex(d.credentialHash)) return null;
  const cert = verifyRelayDeviceCert(nodeRelayAuthCrypto, ownerPublicKey, relayId, d.cert);
  if (!cert || cert.deviceId !== d.deviceId || cert.role !== d.role) return null;
  if (typeof d.reportedName !== 'string') return null;
  if (typeof d.pairedAt !== 'number') return null;
  return {
    deviceId: d.deviceId,
    role: d.role,
    credentialHash: d.credentialHash,
    cert,
    reportedName: d.reportedName,
    customName: typeof d.customName === 'string' ? d.customName : null,
    platform: typeof d.platform === 'string' ? d.platform : null,
    appVersion: typeof d.appVersion === 'string' ? d.appVersion : null,
    deviceInfo: d.deviceInfo && typeof d.deviceInfo === 'object' ? (d.deviceInfo as DeviceInfo) : null,
    pairedAt: d.pairedAt,
    lastSeenAt: typeof d.lastSeenAt === 'number' ? d.lastSeenAt : null,
  };
}

export class RelayStore {
  readonly relayId: string;
  readonly ownerUserId: string;
  readonly ownerPublicKey: string;
  readonly mediaSigningKey: string;
  private name: string;
  private readonly devices = new Map<string, StoredDevice>();
  private readonly deviceIdByHash = new Map<string, string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(
    private readonly dataDir: string,
    state: RelayStateFile,
    private readonly onSaveError: (error: unknown) => void,
  ) {
    this.relayId = state.relayId;
    this.ownerUserId = state.ownerUserId;
    this.ownerPublicKey = state.ownerPublicKey;
    this.mediaSigningKey = state.mediaSigningKey;
    this.name = state.name;
    for (const device of state.devices) this.index(device);
  }

  /** 读取已初始化的状态;缺失或损坏时明确失败,不自动重建(重建会让所有已加入设备失效)。 */
  static async open(dataDir: string, onSaveError: (error: unknown) => void): Promise<RelayStore> {
    const file = path.join(dataDir, STATE_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RelayError('NOT_INITIALIZED', 'relay data directory is not initialized');
      }
      throw error;
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new RelayError('STATE_INVALID', 'relay state file is not valid JSON');
    }
    if (raw.schema !== STATE_SCHEMA) {
      throw new RelayError('STATE_INVALID', `relay state schema ${String(raw.schema)} is not supported`);
    }
    const relayId = typeof raw.relayId === 'string' ? raw.relayId : '';
    const ownerPublicKey = isRelayPublicKey(raw.ownerPublicKey) ? raw.ownerPublicKey : '';
    const devices = Array.isArray(raw.devices) && relayId && ownerPublicKey
      ? raw.devices.map((device) => parseStoredDevice(device, relayId, ownerPublicKey))
      : null;
    if (
      typeof raw.relayId !== 'string' ||
      typeof raw.name !== 'string' ||
      !isValidUserId(raw.ownerUserId) ||
      typeof raw.mediaSigningKey !== 'string' ||
      raw.mediaSigningKey.length < 32 ||
      !devices ||
      devices.some((device) => device === null) ||
      devices.filter((device) => device!.role === 'owner').length !== 1
    ) {
      throw new RelayError('STATE_INVALID', 'relay state file has an unexpected shape');
    }
    return new RelayStore(
      dataDir,
      {
        schema: STATE_SCHEMA,
        relayId: raw.relayId,
        name: raw.name,
        ownerUserId: raw.ownerUserId,
        ownerPublicKey,
        mediaSigningKey: raw.mediaSigningKey,
        devices: devices as StoredDevice[],
      },
      onSaveError,
    );
  }

  get relayName(): string {
    return this.name;
  }

  private index(device: StoredDevice): void {
    this.devices.set(device.deviceId, device);
    this.deviceIdByHash.set(device.credentialHash, device.deviceId);
  }

  findByCredential(credential: string): StoredDevice | undefined {
    const deviceId = this.deviceIdByHash.get(hashSecret(credential));
    return deviceId ? this.devices.get(deviceId) : undefined;
  }

  get(deviceId: string): StoredDevice | undefined {
    return this.devices.get(deviceId);
  }

  list(): StoredDevice[] {
    return [...this.devices.values()];
  }

  /** 全部设备证书(由主人私钥签名,中转无法伪造)。 */
  certificates(): RelayDeviceCert[] {
    return this.list().map((device) => device.cert);
  }

  /** 加入审批通过:新设备入档,或同一设备重新加入时替换凭证(旧凭证立即失效)。 */
  admitMember(input: {
    deviceId: string;
    credentialHash: string;
    cert: RelayDeviceCert;
    reportedName: string;
    platform: string | null;
    appVersion: string | null;
    now: number;
  }): StoredDevice {
    const existing = this.devices.get(input.deviceId);
    if (existing?.role === 'owner') throw new RelayError('FORBIDDEN', 'owner device cannot re-pair');
    if (existing) this.deviceIdByHash.delete(existing.credentialHash);
    const device: StoredDevice = {
      deviceId: input.deviceId,
      role: 'member',
      credentialHash: input.credentialHash,
      cert: input.cert,
      reportedName: input.reportedName,
      customName: existing?.customName ?? null,
      platform: input.platform,
      appVersion: input.appVersion,
      deviceInfo: existing?.deviceInfo ?? null,
      pairedAt: input.now,
      lastSeenAt: existing?.lastSeenAt ?? null,
    };
    this.index(device);
    this.markDirty();
    return device;
  }

  remove(deviceId: string): StoredDevice | undefined {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    this.devices.delete(deviceId);
    this.deviceIdByHash.delete(device.credentialHash);
    this.markDirty();
    return device;
  }

  update(
    deviceId: string,
    patch: Partial<Pick<StoredDevice, 'reportedName' | 'customName' | 'platform' | 'appVersion' | 'deviceInfo' | 'lastSeenAt'>>,
  ): StoredDevice | undefined {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    Object.assign(device, patch);
    this.markDirty();
    return device;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 200);
    this.saveTimer.unref?.();
  }

  /** 把挂起的修改写盘;串行执行,保证后写覆盖先写。 */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return this.saving;
    this.dirty = false;
    const snapshot: RelayStateFile = {
      schema: STATE_SCHEMA,
      relayId: this.relayId,
      name: this.name,
      ownerUserId: this.ownerUserId,
      ownerPublicKey: this.ownerPublicKey,
      mediaSigningKey: this.mediaSigningKey,
      devices: this.list().map((device) => ({ ...device })),
    };
    this.saving = this.saving
      .then(() => writeStateAtomically(this.dataDir, snapshot))
      .catch((error) => {
        this.dirty = true;
        this.onSaveError(error);
      });
    return this.saving;
  }
}
