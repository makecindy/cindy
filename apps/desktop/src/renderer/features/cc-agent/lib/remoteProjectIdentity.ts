import { deviceDisplayName } from '@/lib/deviceName';
import type { DeviceNameSource } from '@cindy/maker-shared/device-list';

/** 远程项目在 UI 中显示的机器身份,统一供项目树、搜索与筛选使用。 */
export interface RemoteProjectMachineIdentity {
  kind: 'ssh' | 'device-link';
  /** 主要身份:SSH alias、设备名,或本地化的未命名提示。 */
  label: string;
  /** 补充身份:user@hostname[:port] ；设备互联不附加原始 ID。 */
  detail: string | null;
  /** 适合 tooltip / 紧凑元信息行的完整单行文案。 */
  displayLabel: string;
}

interface RemoteProjectIdentitySource {
  scope: 'local' | 'remote';
  remoteHostId: string | null;
  deviceLinkDeviceId: string | null;
  deviceLinkDeviceName: string | null;
  remoteMachineIdentity?: RemoteProjectMachineIdentity | null;
}

function joinIdentity(label: string, detail: string | null): string {
  return detail ? `${label} · ${detail}` : label;
}

export interface ResolveRemoteProjectIdentityOptions {
  devices?: readonly DeviceNameSource[];
}

/** Visible project hosts, deduplicated by identity for compact name disambiguation. */
export function collectProjectDevices(
  projects: readonly Pick<RemoteProjectIdentitySource, 'deviceLinkDeviceId' | 'deviceLinkDeviceName'>[],
): DeviceNameSource[] {
  const devices = new Map<string, DeviceNameSource>();
  for (const project of projects) {
    if (project.deviceLinkDeviceId) devices.set(project.deviceLinkDeviceId, {
      deviceId: project.deviceLinkDeviceId, name: project.deviceLinkDeviceName,
    });
  }
  return [...devices.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

/** 把项目持久化身份与当前 SSH registry 合并成稳定、可读的展示模型。 */
export function resolveRemoteProjectMachineIdentity(
  project: Omit<RemoteProjectIdentitySource, 'remoteMachineIdentity'>,
  sshHosts: readonly RemoteHostSnapshot[],
  options?: ResolveRemoteProjectIdentityOptions,
): RemoteProjectMachineIdentity | null {
  if (project.scope !== 'remote') return null;

  if (project.deviceLinkDeviceId) {
    const name = deviceDisplayName(project.deviceLinkDeviceId, project.deviceLinkDeviceName, options?.devices);
    const detail = null;
    return {
      kind: 'device-link',
      label: name,
      detail,
      displayLabel: joinIdentity(name, detail),
    };
  }

  if (!project.remoteHostId) return null;
  const host = sshHosts.find((candidate) => candidate.config.id === project.remoteHostId);
  if (!host) {
    return {
      kind: 'ssh',
      label: project.remoteHostId,
      detail: null,
      displayLabel: project.remoteHostId,
    };
  }

  const endpoint = `${host.config.user}@${host.config.hostname}${
    host.config.port === 22 ? '' : `:${host.config.port}`
  }`;
  const displayName = host.config.displayName?.trim() || host.config.id;
  const label = displayName === host.config.id
    ? host.config.id
    : `${displayName} (${host.config.id})`;
  return {
    kind: 'ssh',
    label,
    detail: endpoint,
    displayLabel: joinIdentity(label, endpoint),
  };
}

/** 已富化的 ProjectNode 优先;测试/旧调用方未富化时仍按持久化 id 兜底。 */
export function getRemoteProjectMachineIdentity(
  project: RemoteProjectIdentitySource,
): RemoteProjectMachineIdentity | null {
  if (project.remoteMachineIdentity !== undefined) return project.remoteMachineIdentity;
  return resolveRemoteProjectMachineIdentity(project, []);
}

/** 需要把项目名序列化到搜索请求/ARIA 文案时使用,避免同路径远程项目同名。 */
export function projectDisplayLabelWithMachine(
  project: RemoteProjectIdentitySource & { displayName: string },
): string {
  const identity = getRemoteProjectMachineIdentity(project);
  return identity ? `${project.displayName} (${identity.displayLabel})` : project.displayName;
}
