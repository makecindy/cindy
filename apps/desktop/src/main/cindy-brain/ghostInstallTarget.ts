import type { InstalledGhost } from '../../shared/ghost.js';
import { hasDeliveryNamespace, installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export interface GhostInstallTargetOption {
  instanceId: string;
  name: string;
  namespace: string | null;
  version: string;
  enabled: boolean;
}
export class GhostInstallTargetRequiredError extends Error {
  constructor(
    readonly targets: GhostInstallTargetOption[],
    readonly copyNamespace: string | null,
  ) {
    super(
      '已安装同名插件。请让用户选择更新哪一份，或明确另装一份。换源更新会隔离旧账号与数据；另装一份需要单独连接账号，不会覆盖或停用已有插件。',
    );
  }
}
export function ghostInstallTargetContext(
  ghosts: InstalledGhost[],
  ghostId: string,
  namespace: string | null,
  installed: InstalledGhost | undefined,
  sourceChanged: boolean,
) {
  const receiver = installed ? installedGhostStoragePart(installed) : undefined;
  return {
    namespace,
    sourceChanged,
    otherCopies: ghosts.filter(
      (g) => g.manifest.id === ghostId && installedGhostStoragePart(g) !== receiver,
    ).length,
  };
}

/** Local authoring can target root or the current organization, never another organization. */
export function resolveForgeInstallTarget(
  ghosts: InstalledGhost[],
  ghostId: string,
  currentNamespace: string | null,
  options: { targetInstanceId?: string; installCopy?: boolean; namespace?: string | null },
): { namespace: string | null; installed?: InstalledGhost } {
  if (
    (options.targetInstanceId !== undefined &&
      (typeof options.targetInstanceId !== 'string' ||
        !options.targetInstanceId ||
        options.targetInstanceId.length > 256)) ||
    (options.installCopy !== undefined && typeof options.installCopy !== 'boolean') ||
    (options.targetInstanceId !== undefined &&
      (options.installCopy === true || options.namespace !== undefined)) ||
    (options.namespace !== undefined &&
      options.namespace !== null &&
      options.namespace !== currentNamespace)
  ) {
    throwIpcError('INVALID_PARAMS', 'Choose either an existing Plugin instance or a separate copy');
  }
  const sameId = ghosts.filter((g) => g.manifest.id === ghostId);
  const permitted = sameId.filter(
    (g) => hasDeliveryNamespace(g) && (g.namespace === null || g.namespace === currentNamespace),
  );
  if (options.targetInstanceId !== undefined) {
    const installed = permitted.find(
      (g) => installedGhostStoragePart(g) === options.targetInstanceId,
    );
    if (!installed)
      throwIpcError('PRECONDITION_FAILED', '目标插件已变化或不属于当前身份，请重新选择');
    return { namespace: installed.namespace!, installed };
  }
  // A login's organization is not the provenance of a local package. New
  // installs default to root; organization installs require an explicit target.
  const namespace = options.namespace ?? null;
  const installed = permitted.find((g) => g.namespace === namespace);
  if (options.installCopy === true) {
    if (installed) throwIpcError('ALREADY_EXISTS', '当前身份已安装此插件，请选择更新已有插件');
    return { namespace };
  }
  if (installed || options.namespace !== undefined || sameId.length === 0)
    return { namespace, ...(installed ? { installed } : {}) };
  // Keep an existing sole organization install in place, with its own state.
  // This is an update, not permission to create another organization instance.
  if (sameId.length === 1 && permitted.length === 1)
    return { namespace: permitted[0].namespace!, installed: permitted[0] };
  throw new GhostInstallTargetRequiredError(
    permitted.map((g) => ({
      instanceId: installedGhostStoragePart(g),
      name: g.manifest.name,
      namespace: g.namespace!,
      version: g.manifest.version,
      enabled: g.enabled,
    })),
    null,
  );
}
