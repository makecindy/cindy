/** Host 内部采样结果，不是可上传的 wire DTO；必须经过字段目录的显式公开投影。 */
export type ReadonlySettingSource = 'default' | 'override' | 'unknown';
export type ReadonlySettingUnavailableStatus =
  | 'unavailable'
  | 'unreadable'
  | 'unsupported'
  | 'migrationPending'
  | 'private';

export type ReadonlySettingInspection =
  | { status: 'value'; value: unknown; source: ReadonlySettingSource }
  | { status: ReadonlySettingUnavailableStatus };

/** key 仅用于本机排序和关联；公开投影不得把原始路径、账号或任意配置键当成公开 ID。 */
export interface ReadonlyCollectionEntry {
  key: string;
  fields: Record<string, ReadonlySettingInspection>;
}

/** 总量未知时保留 null；只报告已知持久范围，不为了补数量扫描其他工作区。 */
export type ReadonlyCollectionInspection =
  | {
    status: 'value';
    entries: ReadonlyCollectionEntry[];
    total: number | null;
    complete: boolean;
  }
  | { status: ReadonlySettingUnavailableStatus };

/** 各领域独立采样后由执行 Host 聚合，owner/generation 一致性在聚合边界再次检查。 */
export interface ReadonlySettingsInspection {
  fields: Record<string, ReadonlySettingInspection>;
  collections?: Record<string, ReadonlyCollectionInspection>;
}

export function inspectedValue(value: unknown, source: ReadonlySettingSource): ReadonlySettingInspection {
  return { status: 'value', value, source };
}
