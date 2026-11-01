/**
 * list_machines 的数据来源（docs/product-rules/cindy-machines.md）：账号下的电脑加这台电脑配置的 SSH 主机。
 * 只暴露情况，不替 Agent 判断、排序或过滤；看不到的如实写明原因，不从结果里消失。
 */
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import { MACHINE_STATUS_CHANNEL, parseMachineStatus, type MachineStatus } from '@cindy/device-link';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';

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
  listSsh(): Promise<SshMachine[]>;
  /** 传输层等多久算这次没问到：一台卡住不能拖住其他机器。 */
  probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

async function probe(device: DeviceLinkDeviceView, deps: MachineDirectoryDeps): Promise<Pick<ComputerMachine, 'availability' | 'status'>> {
  if (device.isSelf) return { availability: 'available', status: await deps.readLocal() };
  if (!device.online) return { availability: 'offline', status: null };
  if (!device.remoteControlEnabled) return { availability: 'remote_control_off', status: null };
  if (!device.controlEnabled) return { availability: 'control_off', status: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      deps.invokeStatus(device.deviceId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('[INVOKE_TIMEOUT]')), deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
      }),
    ]);
    const status = parseMachineStatus(value);
    return status ? { availability: 'available', status } : { availability: 'update_required', status: null };
  } catch (error) {
    return { availability: message(error).includes('CHANNEL_NOT_ALLOWED') ? 'update_required' : 'unreachable', status: null };
  } finally { clearTimeout(timer); }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function listMachines(deps: MachineDirectoryDeps): Promise<MachineDirectory> {
  const listed = await deps.listDevices().then(devices => ({ devices }), (error: unknown) => ({ error: message(error) }));
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
      name: device.selfName || device.name,
      isSelf: device.isSelf,
      platform: device.platform,
      appVersion: device.appVersion,
      lastSeenAt: device.lastSeenAt,
      cpuLabel: device.deviceInfo?.cpuLabel ?? null,
      modelLabel: device.deviceInfo?.modelLabel ?? null,
      osVersion: device.deviceInfo?.osVersion ?? null,
      ...await probe(device, deps),
    }))),
    deps.listSsh().then(hosts => ({ hosts }), (error: unknown) => ({ error: message(error) })),
  ]);
  return {
    computers,
    ssh: 'hosts' in ssh ? ssh.hosts : [],
    ...('error' in ssh ? { sshError: ssh.error } : {}),
    ...('error' in listed ? { computersError: listed.error } : {}),
  };
}
