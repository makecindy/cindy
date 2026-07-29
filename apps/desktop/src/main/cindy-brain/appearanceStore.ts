/**
 * appearanceStore.ts — 当前账号的外观覆盖持久化与背景媒体引用生命周期。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  GHOST_APPEARANCE_PALETTES,
  GHOST_APPEARANCE_DEFAULT_DIM,
  GHOST_APPEARANCE_DEFAULT_SURFACE_OPACITY,
  type GhostAppearanceSnapshot,
  type GhostAppearancePresetSummary,
} from '../../shared/ghost.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import {
  addRef,
  hasRef,
  pinBlob,
  getBlobInfo,
  removeRefs,
  removeRefsExceptHash,
} from '../cindy-media/ledger.js';

const FILE_NAME = 'appearance-skin.v1.json';
/** 与 appearanceSlot 入口校验同限:isSnapshot 按它拒读,写入侧必须同规。 */
const NAME_MAX_CHARS = 48;
// eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
const NAME_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PRESETS_FILE_NAME = 'appearance-skins.v1.json';
const REF_ID = 'active';
const MAX_PRESETS_PER_GHOST = 50;
const MAX_LIBRARY_PRESETS = 500;
const MAX_PRESET_MEDIA_BYTES_PER_GHOST = 128 * 1024 * 1024;
const IMAGE_URL_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.(?:png|jpe?g|webp)$/;
const IMAGE_HASH_RE = /[0-9a-f]{64}/;

let mutationTail: Promise<void> = Promise.resolve();

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(operation);
  mutationTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

type PersistedAppearance = Omit<GhostAppearanceSnapshot, 'dim' | 'surfaceOpacity'> & {
  dim?: number;
  surfaceOpacity?: number;
};

interface PersistedAppearancePreset {
  id: string;
  snapshot: PersistedAppearance;
  createdAt: number;
  updatedAt: number;
  sourceGhostId?: string;
}

interface PersistedAppearancePresetLibrary {
  version: 1;
  presets: PersistedAppearancePreset[];
}

function isSnapshot(value: unknown): value is PersistedAppearance {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!GHOST_APPEARANCE_PALETTES.includes(v.palette as never)) return false;
  if (v.dim !== undefined && (typeof v.dim !== 'number' || v.dim < 0 || v.dim > 0.85)) return false;
  if (
    v.surfaceOpacity !== undefined &&
    (typeof v.surfaceOpacity !== 'number' || v.surfaceOpacity < 0.55 || v.surfaceOpacity > 1)
  )
    return false;
  if (typeof v.updatedAt !== 'number' || !Number.isFinite(v.updatedAt)) return false;
  if (v.sourceGhostId !== undefined && typeof v.sourceGhostId !== 'string') return false;
  if (
    v.name !== undefined &&
    (typeof v.name !== 'string' ||
      v.name.length === 0 ||
      v.name.length > NAME_MAX_CHARS ||
      NAME_CONTROL_RE.test(v.name))
  )
    return false;
  if (v.background !== undefined) {
    if (!v.background || typeof v.background !== 'object') return false;
    const bg = v.background as Record<string, unknown>;
    if (typeof bg.url !== 'string' || !IMAGE_URL_RE.test(bg.url)) return false;
    if (typeof bg.focusX !== 'number' || bg.focusX < 0 || bg.focusX > 1) return false;
    if (typeof bg.focusY !== 'number' || bg.focusY < 0 || bg.focusY > 1) return false;
  }
  if (v.brand !== undefined) {
    if (!v.brand || typeof v.brand !== 'object') return false;
    const brand = v.brand as Record<string, unknown>;
    for (const key of ['icon', 'logo'] as const) {
      const asset = brand[key];
      if (asset === undefined) continue;
      if (!asset || typeof asset !== 'object') return false;
      if (!IMAGE_URL_RE.test((asset as Record<string, unknown>).url as string)) return false;
    }
    if (brand.icon === undefined && brand.logo === undefined) return false;
  }
  return true;
}

function filePath(): string {
  return ownerScopedUserDataPath(FILE_NAME);
}

function presetsFilePath(): string {
  return ownerScopedUserDataPath(PRESETS_FILE_NAME);
}

function normalizePresetName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

function hashesFromSnapshot(
  snapshot: Pick<GhostAppearanceSnapshot, 'background' | 'brand'>,
): AppearanceMediaHashes {
  const hash = (url: string | undefined): string | undefined => url?.match(IMAGE_HASH_RE)?.[0];
  return {
    background: hash(snapshot.background?.url),
    brandIcon: hash(snapshot.brand?.icon?.url),
    brandLogo: hash(snapshot.brand?.logo?.url),
  };
}

function isPreset(value: unknown): value is PersistedAppearancePreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Record<string, unknown>;
  return (
    typeof preset.id === 'string' &&
    /^[0-9a-f-]{16,64}$/i.test(preset.id) &&
    isSnapshot(preset.snapshot) &&
    typeof (preset.snapshot as PersistedAppearance).name === 'string' &&
    typeof preset.createdAt === 'number' &&
    Number.isFinite(preset.createdAt) &&
    typeof preset.updatedAt === 'number' &&
    Number.isFinite(preset.updatedAt) &&
    (preset.sourceGhostId === undefined || typeof preset.sourceGhostId === 'string')
  );
}

async function readPresetLibrary(): Promise<PersistedAppearancePresetLibrary> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(presetsFilePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, presets: [] };
    const library = parsed as Record<string, unknown>;
    if (library.version !== 1 || !Array.isArray(library.presets)) {
      return { version: 1, presets: [] };
    }
    // 单条损坏只丢该条:整库清空会让仍有效预设的 skin-preset 引用在账本里
    // 永久失联(预设没了,引用行却再没有人删),并连带丢用户数据。
    return {
      version: 1,
      presets: library.presets.filter(isPreset).slice(0, MAX_LIBRARY_PRESETS),
    };
  } catch {
    return { version: 1, presets: [] };
  }
}

export async function readGhostAppearance(): Promise<GhostAppearanceSnapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath(), 'utf8'));
    return isSnapshot(parsed)
      ? {
          ...parsed,
          dim: parsed.dim ?? GHOST_APPEARANCE_DEFAULT_DIM,
          surfaceOpacity: parsed.surfaceOpacity ?? GHOST_APPEARANCE_DEFAULT_SURFACE_OPACITY,
        }
      : null;
  } catch {
    return null;
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

type AppearanceMediaHashes = {
  background?: string;
  brandIcon?: string;
  brandLogo?: string;
};

function presetSummary(preset: PersistedAppearancePreset): GhostAppearancePresetSummary {
  return {
    id: preset.id,
    name: preset.snapshot.name!,
    palette: preset.snapshot.palette,
    ...(preset.sourceGhostId ? { sourceGhostId: preset.sourceGhostId } : {}),
    hasBackground: Boolean(preset.snapshot.background),
    hasBrandIcon: Boolean(preset.snapshot.brand?.icon),
    hasBrandLogo: Boolean(preset.snapshot.brand?.logo),
    updatedAt: preset.updatedAt,
  };
}

function presetRefId(id: string, asset: keyof AppearanceMediaHashes): string {
  return `${id}:${asset}`;
}

async function retainPresetMedia(
  presetId: string,
  mediaHashes: AppearanceMediaHashes,
  ghostId?: string,
): Promise<void> {
  for (const asset of ['background', 'brandIcon', 'brandLogo'] as const) {
    const hash = mediaHashes[asset];
    const refId = presetRefId(presetId, asset);
    if (hash) {
      if (!(await hasRef({ hash, refKind: 'skin-preset', refId }))) {
        await addRef({
          hash,
          refKind: 'skin-preset',
          refId,
          ...(ghostId ? { originKind: 'ghost' as const, originId: ghostId } : {}),
        });
      }
      await pinBlob(hash);
    }
  }
}

async function assertPresetMediaBudget(
  library: PersistedAppearancePresetLibrary,
  replacingId: string | undefined,
  candidate: AppearanceMediaHashes,
  sourceGhostId: string | undefined,
): Promise<void> {
  const hashes = new Set<string>();
  for (const preset of library.presets) {
    if (preset.id === replacingId || preset.sourceGhostId !== sourceGhostId) continue;
    const existing = hashesFromSnapshot(preset.snapshot);
    for (const hash of Object.values(existing)) if (hash) hashes.add(hash);
  }
  for (const hash of Object.values(candidate)) if (hash) hashes.add(hash);
  let total = 0;
  for (const hash of hashes) {
    const info = await getBlobInfo(hash);
    if (info) total += info.bytes;
    if (total > MAX_PRESET_MEDIA_BYTES_PER_GHOST) {
      throw new Error('每个插件的皮肤预设媒体总量不能超过 128 MB');
    }
  }
}

async function releaseReplacedPresetMedia(
  presetId: string,
  mediaHashes: AppearanceMediaHashes,
): Promise<void> {
  for (const asset of ['background', 'brandIcon', 'brandLogo'] as const) {
    const hash = mediaHashes[asset];
    const refId = presetRefId(presetId, asset);
    if (hash) {
      await removeRefsExceptHash({ refKind: 'skin-preset', refId, keepHash: hash });
    } else {
      await removeRefs({ refKind: 'skin-preset', refId });
    }
  }
}

async function saveGhostAppearanceUnsafe(
  snapshot: GhostAppearanceSnapshot,
  mediaHashes: AppearanceMediaHashes = {},
  ghostId?: string,
  customized: { dim: boolean; surfaceOpacity: boolean } = {
    dim: true,
    surfaceOpacity: true,
  },
): Promise<void> {
  if (ghostId && snapshot.sourceGhostId && snapshot.sourceGhostId !== ghostId) {
    throw new Error('皮肤来源与当前插件不一致');
  }
  const previousAppearance = await readGhostAppearance();
  const previousHashes = previousAppearance
    ? hashesFromSnapshot(previousAppearance)
    : {};
  const refs = [
    ['skin-background', mediaHashes.background],
    ['skin-brand-icon', mediaHashes.brandIcon],
    ['skin-brand-logo', mediaHashes.brandLogo],
  ] as const;
  try {
    for (const [refKind, hash] of refs) {
      if (!hash) continue;
      if (!(await hasRef({ hash, refKind, refId: REF_ID }))) {
        await addRef({
          hash,
          refKind,
          refId: REF_ID,
          ...(ghostId ? { originKind: 'ghost' as const, originId: ghostId } : {}),
        });
      }
      await pinBlob(hash);
    }
    const persisted: PersistedAppearance = {
      ...snapshot,
      ...(ghostId ? { sourceGhostId: ghostId } : {}),
    };
    if (!customized.dim) delete persisted.dim;
    if (!customized.surfaceOpacity) delete persisted.surfaceOpacity;
    await atomicWriteJson(filePath(), persisted);
  } catch (error) {
    // 引用必须先于文件提交建立，防止回收器窗口；反向失败路径则把引用精确恢复到
    // 旧快照，避免磁盘满/权限错误重复累积不可达 blob。
    await reconcileActiveMedia(previousHashes, previousAppearance?.sourceGhostId).catch(() => {});
    throw error;
  }
  await reconcileActiveMedia(mediaHashes, ghostId);
}

async function reconcileActiveMedia(
  mediaHashes: AppearanceMediaHashes,
  ghostId?: string,
): Promise<void> {
  const refs = [
    ['skin-background', mediaHashes.background],
    ['skin-brand-icon', mediaHashes.brandIcon],
    ['skin-brand-logo', mediaHashes.brandLogo],
  ] as const;
  for (const [refKind, hash] of refs) {
    if (hash) {
      if (!(await hasRef({ hash, refKind, refId: REF_ID }))) {
        await addRef({
          hash,
          refKind,
          refId: REF_ID,
          ...(ghostId ? { originKind: 'ghost' as const, originId: ghostId } : {}),
        });
      }
      await pinBlob(hash);
      await removeRefsExceptHash({ refKind, refId: REF_ID, keepHash: hash });
    } else {
      await removeRefs({ refKind, refId: REF_ID });
    }
  }
}

export function saveGhostAppearance(
  snapshot: GhostAppearanceSnapshot,
  mediaHashes: AppearanceMediaHashes = {},
  ghostId?: string,
  customized: { dim: boolean; surfaceOpacity: boolean } = { dim: true, surfaceOpacity: true },
): Promise<void> {
  return serializeMutation(() =>
    saveGhostAppearanceUnsafe(snapshot, mediaHashes, ghostId, customized),
  );
}

export async function listGhostAppearancePresets(
  sourceGhostId?: string,
): Promise<GhostAppearancePresetSummary[]> {
  const library = await readPresetLibrary();
  return library.presets
    .filter((preset) => !sourceGhostId || preset.sourceGhostId === sourceGhostId)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(presetSummary);
}

async function saveGhostAppearancePresetUnsafe(
  snapshot: GhostAppearanceSnapshot,
  mediaHashes: AppearanceMediaHashes = hashesFromSnapshot(snapshot),
  ghostId?: string,
): Promise<GhostAppearancePresetSummary> {
  if (ghostId && snapshot.sourceGhostId && snapshot.sourceGhostId !== ghostId) {
    throw new Error('皮肤来源与当前插件不一致');
  }
  const name = snapshot.name?.trim();
  if (!name) throw new Error('保存皮肤预设需要名称');
  if (name.length > NAME_MAX_CHARS || NAME_CONTROL_RE.test(name)) {
    throw new Error('皮肤名称须为 1–48 个可见字符');
  }
  const library = await readPresetLibrary();
  const normalizedName = normalizePresetName(name);
  const existingIndex = library.presets.findIndex(
    (preset) =>
      preset.sourceGhostId === ghostId &&
      normalizePresetName(preset.snapshot.name!) === normalizedName,
  );
  const existing = existingIndex >= 0 ? library.presets[existingIndex] : undefined;
  const ownerPresetCount = library.presets.filter(
    (candidate) => candidate.sourceGhostId === ghostId,
  ).length;
  if (!existing && ownerPresetCount >= MAX_PRESETS_PER_GHOST) {
    throw new Error(`每个插件最多保存 ${MAX_PRESETS_PER_GHOST} 套皮肤`);
  }
  if (!existing && library.presets.length >= MAX_LIBRARY_PRESETS) {
    throw new Error('皮肤库已达到宿主安全上限');
  }
  const now = Date.now();
  const preset: PersistedAppearancePreset = {
    id: existing?.id ?? randomUUID(),
    snapshot: {
      ...snapshot,
      name,
      ...(ghostId ? { sourceGhostId: ghostId } : {}),
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: snapshot.updatedAt,
    ...(ghostId || existing?.sourceGhostId
      ? { sourceGhostId: ghostId ?? existing?.sourceGhostId }
      : {}),
  };
  await assertPresetMediaBudget(library, existing?.id, mediaHashes, ghostId);
  try {
    await retainPresetMedia(preset.id, mediaHashes, ghostId);
    if (existingIndex >= 0) {
      library.presets[existingIndex] = preset;
    } else {
      library.presets.push(preset);
    }
    await atomicWriteJson(presetsFilePath(), library);
  } catch (error) {
    const previousHashes = existing ? hashesFromSnapshot(existing.snapshot) : {};
    await releaseReplacedPresetMedia(preset.id, previousHashes).catch(() => {});
    await retainPresetMedia(
      preset.id,
      previousHashes,
      existing?.sourceGhostId,
    ).catch(() => {});
    throw error;
  }
  await releaseReplacedPresetMedia(preset.id, mediaHashes);
  return presetSummary(preset);
}

async function restorePresetState(before: PersistedAppearancePresetLibrary): Promise<void> {
  const after = await readPresetLibrary();
  const beforeById = new Map(before.presets.map((preset) => [preset.id, preset]));
  for (const preset of after.presets) {
    const previous = beforeById.get(preset.id);
    if (!previous) {
      await Promise.all(
        (['background', 'brandIcon', 'brandLogo'] as const).map((asset) =>
          removeRefs({ refKind: 'skin-preset', refId: presetRefId(preset.id, asset) }),
        ),
      );
      continue;
    }
    const previousHashes = hashesFromSnapshot(previous.snapshot);
    await releaseReplacedPresetMedia(preset.id, previousHashes);
    await retainPresetMedia(preset.id, previousHashes, previous.sourceGhostId);
  }
  for (const previous of before.presets) {
    if (after.presets.some((preset) => preset.id === previous.id)) continue;
    await retainPresetMedia(
      previous.id,
      hashesFromSnapshot(previous.snapshot),
      previous.sourceGhostId,
    );
  }
  await atomicWriteJson(presetsFilePath(), before);
}

export function saveGhostAppearancePreset(
  snapshot: GhostAppearanceSnapshot,
  mediaHashes: AppearanceMediaHashes = hashesFromSnapshot(snapshot),
  ghostId?: string,
): Promise<GhostAppearancePresetSummary> {
  return serializeMutation(() => saveGhostAppearancePresetUnsafe(snapshot, mediaHashes, ghostId));
}

export function saveGhostAppearanceWithPreset(
  snapshot: GhostAppearanceSnapshot,
  mediaHashes: AppearanceMediaHashes,
  ghostId: string,
  customized: { dim: boolean; surfaceOpacity: boolean },
): Promise<GhostAppearancePresetSummary> {
  return serializeMutation(async () => {
    const previousAppearance = await readGhostAppearance();
    const previousPresets = await readPresetLibrary();
    try {
      const preset = await saveGhostAppearancePresetUnsafe(snapshot, mediaHashes, ghostId);
      await saveGhostAppearanceUnsafe(snapshot, mediaHashes, ghostId, customized);
      return preset;
    } catch (error) {
      try {
        if (previousAppearance) {
          await saveGhostAppearanceUnsafe(
            previousAppearance,
            hashesFromSnapshot(previousAppearance),
            undefined,
            { dim: true, surfaceOpacity: true },
          );
        } else {
          await fs.rm(filePath(), { force: true });
          await Promise.all(
            (['skin-background', 'skin-brand-icon', 'skin-brand-logo'] as const).map((refKind) =>
              removeRefs({ refKind, refId: REF_ID }),
            ),
          );
        }
        await restorePresetState(previousPresets);
      } catch {
        // Preserve the original failure; the recycler grace period protects any
        // references that need a later reconciliation pass.
      }
      throw error;
    }
  });
}

function findPreset(
  presets: PersistedAppearancePreset[],
  idOrName: string,
  sourceGhostId?: string,
): PersistedAppearancePreset | undefined {
  const needle = idOrName.trim();
  const normalizedName = normalizePresetName(needle);
  return presets.find(
    (preset) =>
      (!sourceGhostId || preset.sourceGhostId === sourceGhostId) &&
      (preset.id === needle || normalizePresetName(preset.snapshot.name!) === normalizedName),
  );
}

export async function activateGhostAppearancePreset(
  idOrName: string,
  sourceGhostId?: string,
): Promise<GhostAppearanceSnapshot | null> {
  return serializeMutation(async () => {
    const library = await readPresetLibrary();
    const preset = findPreset(library.presets, idOrName, sourceGhostId);
    if (!preset) return null;
    const appearance: GhostAppearanceSnapshot = {
      ...preset.snapshot,
      ...(preset.sourceGhostId ? { sourceGhostId: preset.sourceGhostId } : {}),
      dim: preset.snapshot.dim ?? GHOST_APPEARANCE_DEFAULT_DIM,
      surfaceOpacity: preset.snapshot.surfaceOpacity ?? GHOST_APPEARANCE_DEFAULT_SURFACE_OPACITY,
      updatedAt: Date.now(),
    };
    await saveGhostAppearanceUnsafe(
      appearance,
      hashesFromSnapshot(appearance),
      preset.sourceGhostId,
      {
        dim: preset.snapshot.dim !== undefined,
        surfaceOpacity: preset.snapshot.surfaceOpacity !== undefined,
      },
    );
    return appearance;
  });
}

export function deleteGhostAppearancePreset(
  idOrName: string,
  sourceGhostId?: string,
): Promise<boolean> {
  return serializeMutation(async () => {
    const library = await readPresetLibrary();
    const preset = findPreset(library.presets, idOrName, sourceGhostId);
    if (!preset) return false;
    library.presets = library.presets.filter((candidate) => candidate.id !== preset.id);
    await atomicWriteJson(presetsFilePath(), library);
    await Promise.all(
      (['background', 'brandIcon', 'brandLogo'] as const).map((asset) =>
        removeRefs({ refKind: 'skin-preset', refId: presetRefId(preset.id, asset) }),
      ),
    );
    return true;
  });
}

export function resetGhostAppearance(): Promise<void> {
  return serializeMutation(async () => {
    await fs.rm(filePath(), { force: true });
    await Promise.all(
      (['skin-background', 'skin-brand-icon', 'skin-brand-logo'] as const).map((refKind) =>
        removeRefs({ refKind, refId: REF_ID }),
      ),
    );
  });
}
