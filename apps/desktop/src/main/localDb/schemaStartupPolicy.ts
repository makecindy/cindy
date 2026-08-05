/**
 * localDb schema 启动阶段的确定性编排。
 *
 * shared passive 只允许先做兼容性核对，绝不执行 migration、drift repair 或其它
 * schema DDL；primary / packaged 则按既有顺序完成维护并发布 runtime manifest。
 */

export interface SchemaCompatibilityResult {
  compatible: boolean;
}

interface RunSchemaStartupPolicyOptions<T extends SchemaCompatibilityResult> {
  sharedPassive: boolean;
  checkCompatibility: () => T;
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
  if (options.sharedPassive) {
    const compatibility = options.checkCompatibility();
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
