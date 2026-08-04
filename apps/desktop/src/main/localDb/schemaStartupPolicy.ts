/**
 * localDb schema 启动阶段的确定性编排。
 *
 * shared passive 与 packaged readOnly 只允许先做兼容性/只读不变量核对，绝不执行
 * migration、drift repair 或其它 schema DDL；primary / packaged writer 则按既有顺序
 * 完成维护并发布 runtime manifest。
 */

export interface SchemaCompatibilityResult {
  compatible: boolean;
}

export interface SchemaReadOnlyInvariantCheck {
  compatible: boolean;
}

interface RunSchemaStartupPolicyOptions<T extends SchemaCompatibilityResult> {
  sharedPassive: boolean;
  readOnly?: boolean;
  checkCompatibility: () => T;
  checkReadOnlyInvariants?: () => SchemaReadOnlyInvariantCheck;
  prepareRuntimeManifest: () => void;
  runMigrations: () => Promise<void>;
  handleSchemaDrift: () => Promise<void>;
  cleanupSchemaDdl: () => void;
}

export type SchemaStartupPolicyResult<T extends SchemaCompatibilityResult> =
  { ready: true; compatibility: T | null } | { ready: false; compatibility: T };

export async function runSchemaStartupPolicy<T extends SchemaCompatibilityResult>(
  options: RunSchemaStartupPolicyOptions<T>,
): Promise<SchemaStartupPolicyResult<T>> {
  if (options.sharedPassive || options.readOnly) {
    const compatibility = options.checkCompatibility();
    if (options.readOnly) {
      if (!compatibility.compatible || !options.checkReadOnlyInvariants) {
        return { ready: false, compatibility: { ...compatibility, compatible: false } };
      }
      const invariant = options.checkReadOnlyInvariants();
      if (!invariant.compatible) {
        return { ready: false, compatibility: { ...compatibility, compatible: false } };
      }
    }
    return compatibility.compatible
      ? { ready: true, compatibility }
      : { ready: false, compatibility };
  }

  options.prepareRuntimeManifest();
  await options.runMigrations();
  await options.handleSchemaDrift();
  options.cleanupSchemaDdl();
  return { ready: true, compatibility: null };
}
