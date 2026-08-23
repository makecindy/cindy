/** 远程项目在 UI 中显示的机器身份,统一供项目树、搜索与筛选使用。 */
export interface RemoteProjectMachineIdentity {
  kind: 'ssh' | 'device-link';
  /** 主要身份:SSH alias、设备名,或无法解析时的持久化 id。 */
  label: string;
  /** 补充身份:user@hostname[:port] 或设备 id。 */
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

/** 设备名归一(比对同名用):去空白 + 小写。 */
function deviceNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export interface ResolveRemoteProjectIdentityOptions {
  /**
   * 「同名但不同设备」的设备名集合(deviceNameKey 归一后)。
   * device-link 的设备 ID 是机器指纹哈希,对用户没有可读意义,默认**不显示**
   * (2026-08-12 用户裁决);只有两台设备撞名、光看名字分不出来时才附在名字后面消歧。
   */
  ambiguousDeviceNames?: ReadonlySet<string>;
}

/**
 * 从一批远程项目里找出需要显示设备 ID 消歧的设备名——同一个名字对应了两个以上
 * 不同 deviceId 时才算撞名。只统计真的有项目会渲染的设备:没有项目的同名设备不会
 * 在列表里出现,不构成用户看得见的歧义。
 */
export function collectAmbiguousDeviceNames(
  projects: readonly Pick<
    RemoteProjectIdentitySource,
    'deviceLinkDeviceId' | 'deviceLinkDeviceName'
  >[],
): ReadonlySet<string> {
  const idsByName = new Map<string, Set<string>>();
  for (const project of projects) {
    const deviceId = project.deviceLinkDeviceId;
    const name = project.deviceLinkDeviceName?.trim();
    if (!deviceId || !name) continue;
    const key = deviceNameKey(name);
    const ids = idsByName.get(key);
    if (ids) ids.add(deviceId);
    else idsByName.set(key, new Set([deviceId]));
  }
  const ambiguous = new Set<string>();
  for (const [key, ids] of idsByName) {
    if (ids.size > 1) ambiguous.add(key);
  }
  return ambiguous;
}

/** 把项目持久化身份与当前 SSH registry 合并成稳定、可读的展示模型。 */
export function resolveRemoteProjectMachineIdentity(
  project: Omit<RemoteProjectIdentitySource, 'remoteMachineIdentity'>,
  sshHosts: readonly RemoteHostSnapshot[],
  options?: ResolveRemoteProjectIdentityOptions,
): RemoteProjectMachineIdentity | null {
  if (project.scope !== 'remote') return null;

  if (project.deviceLinkDeviceId) {
    const resolvedName = project.deviceLinkDeviceName?.trim();
    const name = resolvedName || project.deviceLinkDeviceId;
    // 设备 ID 只在撞名时才露出来消歧(见 ResolveRemoteProjectIdentityOptions);
    // 名字都拿不到时 label 已经退化成 ID 本身,不再重复附一遍。
    const detail =
      resolvedName && options?.ambiguousDeviceNames?.has(deviceNameKey(resolvedName))
        ? project.deviceLinkDeviceId
        : null;
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
  return {
    kind: 'ssh',
    label: host.config.id,
    detail: endpoint,
    displayLabel: joinIdentity(host.config.id, endpoint),
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
