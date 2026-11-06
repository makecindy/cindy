/**
 * list_machines 的数据来源（docs/product-rules/cindy-machines.md）：账号下的电脑加这台电脑配置的 SSH 主机，都带实时资源。
 * 只暴露情况，不替 Agent 判断、排序或过滤；看不到的如实写明原因，不从结果里消失。
 */
import type { ProviderLocalLoadDeps } from '../provider-group/localLoad.js';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import { MACHINE_STATUS_CHANNEL, parseMachineStatus, type MachineStatus } from '@cindy/device-link';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { parseSshStatus } from './sshStatus.js';

export type MachineAvailability =
  | 'available'
  /** 账号下这台没在线。 */
  | 'offline'
  /** 那台没开「允许同账号设备控制本机」。 */
  | 'remote_control_off'
  /** 这台电脑关掉了对那台的控制。 */
  | 'control_off'
  /** 那台的 Cindy 版本太旧，不会报资源。 */
  | 'update_required'
  /** 在线，但这次没问到。 */
  | 'unreachable';

export interface ComputerMachine {
  kind: 'computer';
  deviceId: string;
  name: string;
  isSelf: boolean;
  platform: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  cpuLabel: string | null;
  modelLabel: string | null;
  osVersion: string | null;
  availability: MachineAvailability;
  status: MachineStatus | null;
}

export interface SshMachine {
  kind: 'ssh';
  id: string;
  hostname: string;
  port: number;
  user: string;
  connection: string;
  /**
   * reachable：读到了。unreachable：连不上或超时。unreadable：连上了，但跑不了这段命令（例如 Windows）。
   * host_key_changed：主机密钥和记录不一致，已拒绝连接，要向可信来源核对指纹。
   * unverified：还没信任过这台的密钥，这里不连接：自动读取不能替用户做首次信任。
   */
  availability: 'reachable' | 'unreachable' | 'unreadable' | 'host_key_changed' | 'unverified';
  /** 配置里地址相同的其他条目，可能是同一台机器的另一个入口，一个连不上不代表这台机器有问题。 */
  sameAddressAs?: string[];
  os: string | null;
  arch: string | null;
  status: MachineStatus | null;
  /** 连不上时的错误码，便于判断是认证还是网络。 */
  errorCode?: string;
}

export interface MachineDirectory {
  computers: ComputerMachine[];
  ssh: SshMachine[];
  /** SSH 主机读失败时的原因；不把「读失败」当成「没有主机」。 */
  sshError?: string;
  /** 账号设备列表读失败时的原因（未登录、连不上服务）；此时只有这台电脑，不代表账号下只有它。 */
  computersError?: string;
}

export interface MachineDirectoryDeps {
  listDevices(): Promise<readonly DeviceLinkDeviceView[]>;
  invokeStatus(deviceId: string): Promise<unknown>;
  readLocal(): Promise<MachineStatus>;
  /** 读不到设备列表时，这台电脑叫什么。 */
  selfName(): string;
  listSsh(): Promise<Array<Pick<SshMachine, 'kind' | 'id' | 'hostname' | 'port' | 'user' | 'connection'>>>;
  /** The SSH config could not be read: listSsh then holds the last good hosts, or none. */
  sshConfigProblem?(): string | null;
  /** 在那台主机上跑只读状态命令，返回输出；连不上时抛错。 */
  readSsh(id: string): Promise<string>;
  /** 这台的密钥是否已被信任过；不连接。 */
  isSshKeyKnown(hostname: string, port: number): Promise<boolean>;
  /** 传输层等多久算这次没问到：一台卡住不能拖住其他机器。 */
  probeTimeoutMs?: number;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** SSH 可能要新建连接，比问一台已连着的电脑慢。 */
const SSH_PROBE_TIMEOUT_MS = 8_000;

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('[INVOKE_TIMEOUT]')), ms);
    })]);
  } finally { clearTimeout(timer); }
};

async function probeSsh(host: Awaited<ReturnType<MachineDirectoryDeps['listSsh']>>[number], deps: MachineDirectoryDeps): Promise<SshMachine> {
  const empty = { os: null, arch: null, status: null };
  try {
    if (!await deps.isSshKeyKnown(host.hostname, host.port)) return { ...host, availability: 'unverified', ...empty };
    const parsed = parseSshStatus(await withTimeout(deps.readSsh(host.id), deps.probeTimeoutMs ?? SSH_PROBE_TIMEOUT_MS));
    return parsed
      ? { ...host, availability: 'reachable', os: parsed.os, arch: parsed.arch, status: parsed.status }
      : { ...host, availability: 'unreadable', ...empty };
  } catch (error) {
    const code = /^\[([A-Z_]+)\]/.exec(message(error))?.[1];
    return { ...host, availability: code === 'SSH_HOST_KEY_MISMATCH' ? 'host_key_changed' : 'unreachable', ...empty, ...(code ? { errorCode: code } : {}) };
  }
}

async function probe(device: DeviceLinkDeviceView, deps: MachineDirectoryDeps): Promise<Pick<ComputerMachine, 'availability' | 'status'>> {
  if (device.isSelf) return { availability: 'available', status: await deps.readLocal() };
  if (!device.online) return { availability: 'offline', status: null };
  if (!device.remoteControlEnabled) return { availability: 'remote_control_off', status: null };
  if (!device.controlEnabled) return { availability: 'control_off', status: null };
  try {
    const value = await withTimeout(deps.invokeStatus(device.deviceId), deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    const status = parseMachineStatus(value);
    return status ? { availability: 'available', status } : { availability: 'update_required', status: null };
  } catch (error) {
    return { availability: /CHANNEL_NOT_ALLOWED|UNSUPPORTED_CAPABILITY/.test(message(error)) ? 'update_required' : 'unreachable', status: null };
  }
}

/**
 * Turns running on this computer: Agents here plus those run for other computers. The same places
 * as the provider count, but a task whose provider cannot be told is still a running task.
 */
export async function countMachineRunningTasks(deps: Pick<ProviderLocalLoadDeps,
  'listTurnRunningSessions' | 'readSessionRoutes' | 'hostRunningProviders' | 'applicationRunningProviders'>): Promise<number> {
  const running = deps.listTurnRunningSessions();
  const routes = running.length ? await deps.readSessionRoutes(running) : [];
  return deps.hostRunningProviders().length + (deps.applicationRunningProviders?.().length ?? 0)
    + routes.filter(route => !route.agentDeviceId && !route.remoteHostId).length;
}

export async function listMachines(deps: MachineDirectoryDeps): Promise<MachineDirectory> {
  const listed = await withTimeout(deps.listDevices(), deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    .then(devices => ({ devices }), (error: unknown) => ({ error: message(error) }));
  const known = 'devices' in listed ? listed.devices.filter(device => !isMobilePlatform(device.platform)) : [];
  // 本机不依赖账号服务：没登录或连不上时仍然报这台电脑和 SSH 主机。
  const devices = known.some(device => device.isSelf) ? known : [...known, {
    deviceId: 'local', name: deps.selfName(), platform: process.platform, appVersion: null, lastSeenAt: null,
    online: true, busy: false, remoteControlEnabled: false, controlEnabled: false, isSelf: true,
  } satisfies DeviceLinkDeviceView];
  const [computers, ssh] = await Promise.all([
    Promise.all(devices.map(async (device): Promise<ComputerMachine> => ({
      kind: 'computer',
      deviceId: device.deviceId,
      name: device.name,
      isSelf: device.isSelf,
      platform: device.platform,
      appVersion: device.appVersion,
      lastSeenAt: device.lastSeenAt,
      cpuLabel: device.deviceInfo?.cpuLabel ?? null,
      modelLabel: device.deviceInfo?.modelLabel ?? null,
      osVersion: device.deviceInfo?.osVersion ?? null,
      ...await probe(device, deps),
    }))),
    deps.listSsh().then(async hosts => ({ hosts: (await Promise.all(hosts.map(host => probeSsh(host, deps)))).map(host => {
      const others = hosts.filter(other => other.id !== host.id && other.hostname === host.hostname).map(other => other.id);
      return others.length ? { ...host, sameAddressAs: others } : host;
    }) }), (error: unknown) => ({ error: message(error) })),
  ]);
  // Read after listSsh, which loads the config: an empty list must not read as "no SSH hosts".
  const sshProblem = deps.sshConfigProblem?.() ?? null;
  return {
    computers,
    ssh: 'hosts' in ssh ? ssh.hosts : [],
    ...('error' in ssh ? { sshError: ssh.error } : sshProblem ? { sshError: sshProblem } : {}),
    ...('error' in listed ? { computersError: listed.error } : {}),
  };
}
