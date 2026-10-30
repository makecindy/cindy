import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** DS-2b 冻结快照。DS-3 只读这份 fixture，不解析 colors.ts。 */
export const SNAPSHOT_RELATIVE_PATH =
  'apps/desktop/src/renderer/themes/__tests__/fixtures/desktop-color-defaults.json';

export const CLASSIFICATION_RELATIVE_PATH =
  'packages/design-tokens/src/classification.json';

export const REFERENCE_RELATIVE_PATH =
  'packages/design-tokens/src/reference/color.json';

export const SEMANTIC_RELATIVE_PATH =
  'packages/design-tokens/src/semantic/color.json';

export const COMPONENT_RELATIVE_PATH =
  'packages/design-tokens/src/component/color.json';

export function findRepoRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('找不到仓库根（缺少 pnpm-workspace.yaml）');
    }
    dir = parent;
  }
}

export function snapshotPath(repoRoot = findRepoRoot()): string {
  return join(repoRoot, SNAPSHOT_RELATIVE_PATH);
}

export function classificationPath(repoRoot = findRepoRoot()): string {
  return join(repoRoot, CLASSIFICATION_RELATIVE_PATH);
}

export function referencePath(repoRoot = findRepoRoot()): string {
  return join(repoRoot, REFERENCE_RELATIVE_PATH);
}

export function semanticPath(repoRoot = findRepoRoot()): string {
  return join(repoRoot, SEMANTIC_RELATIVE_PATH);
}

export function componentPath(repoRoot = findRepoRoot()): string {
  return join(repoRoot, COMPONENT_RELATIVE_PATH);
}
