import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { resolvedSemanticValues, type BuiltLayers } from './build-layers.ts';
import {
  CLASSIFICATION_CATEGORIES,
  type ClassificationCategory,
  type ClassificationDocument,
  PROTECTED_IDS,
} from './classify.ts';
import {
  collectLeaves,
  isDtcgLeaf,
  parseAliasPath,
  resolveAlias,
  TOKEN_NAME_RE,
  type DtcgFile,
} from './dtcg.ts';
import {
  CLASSIFICATION_RELATIVE_PATH,
  REFERENCE_RELATIVE_PATH,
  SEMANTIC_RELATIVE_PATH,
  SNAPSHOT_RELATIVE_PATH,
} from './paths.ts';
import { SEMANTIC_ROLE_IDS } from './semantic-roles.ts';
import type { ColorDefaultsSnapshot } from './snapshot.ts';

export function snapshotMismatch(what: string): string {
  return [
    `${what} 与 DS-2b 冻结快照不一致。`,
    '红灯不是禁令。有意改值的合法路径 = 同一 PR 更新本快照 + 同步影子层（packages/design-tokens 的 generate 脚本）+ 按治理合同 §6 交证据 + 设计师批准。',
    `更新方式：把实时提取结果写回 ${SNAPSHOT_RELATIVE_PATH}，并重新生成 ${CLASSIFICATION_RELATIVE_PATH} / ${REFERENCE_RELATIVE_PATH} / ${SEMANTIC_RELATIVE_PATH}。`,
    '保护值（CINDY 皮肤族 DESIGN.md §15、U2 二级信息色、annotation-accent）另有比「改快照 + 设计师批准」更严的门槛，不能只更新本文件。',
    '禁止为绿灯加豁免或绕加载路径。',
  ].join('\n');
}

export function assertClassificationCoversSnapshot(
  classification: ClassificationDocument,
  snapshot: ColorDefaultsSnapshot,
): void {
  if (classification.entries.length !== snapshot.count) {
    throw new Error(
      snapshotMismatch(
        `classification.entries.length=${classification.entries.length} vs snapshot.count=${snapshot.count}`,
      ),
    );
  }
  if (classification.entries.length !== snapshot.colors.length) {
    throw new Error(snapshotMismatch('classification 条目数与快照 colors.length'));
  }

  const snapshotIds = snapshot.colors.map((entry) => entry.id);
  const classIds = classification.entries.map((entry) => entry.id);
  if (JSON.stringify(classIds) !== JSON.stringify(snapshotIds)) {
    throw new Error(snapshotMismatch('classification 的 id 顺序/集合'));
  }

  const seen = new Set<string>();
  const tallies: Record<ClassificationCategory, number> = {
    literal: 0,
    alias: 0,
    'hsl-triplet': 0,
    'runtime-derived-or-protected': 0,
  };
  for (const entry of classification.entries) {
    if (seen.has(entry.id)) {
      throw new Error(`分类登记重复 id: ${entry.id}`);
    }
    seen.add(entry.id);
    if (!CLASSIFICATION_CATEGORIES.includes(entry.category)) {
      throw new Error(`未知分类 ${entry.category}（id=${entry.id}）`);
    }
    tallies[entry.category] += 1;
  }
  for (const category of CLASSIFICATION_CATEGORIES) {
    if (tallies[category] !== classification.categories[category]) {
      throw new Error(
        `分类计数不一致：${category} tally=${tallies[category]} header=${classification.categories[category]}`,
      );
    }
  }
  const sum = CLASSIFICATION_CATEGORIES.reduce(
    (total, category) => total + classification.categories[category],
    0,
  );
  if (sum !== snapshot.count) {
    throw new Error(
      `四类计数之和 ${sum} ≠ snapshot.count ${snapshot.count}（分类必须互斥完备）`,
    );
  }
}

export function assertProtectedNotSemantic(
  classification: ClassificationDocument,
): void {
  for (const [id, rule] of Object.entries(PROTECTED_IDS)) {
    const entry = classification.entries.find((item) => item.id === id);
    if (!entry) {
      throw new Error(`保护值 ${id} 未出现在分类登记`);
    }
    if (entry.category !== 'runtime-derived-or-protected') {
      throw new Error(`保护值 ${id} 分类应为 runtime-derived-or-protected，实际 ${entry.category}`);
    }
    if (entry.modeledAsSemantic) {
      throw new Error(`保护值 ${id} 不得进入 semantic 映射`);
    }
    if (entry.protected?.family !== rule.family) {
      throw new Error(`保护值 ${id} 的 family 标记错误`);
    }
    if (SEMANTIC_ROLE_IDS.has(id)) {
      throw new Error(`保护值 ${id} 出现在 SEMANTIC_ROLES`);
    }
  }
}

export function assertSemanticMatchesSnapshot(
  layers: BuiltLayers,
  snapshot: ColorDefaultsSnapshot,
): void {
  const byId = new Map(snapshot.colors.map((entry) => [entry.id, entry]));
  const resolved = resolvedSemanticValues(layers);
  if (resolved.size !== SEMANTIC_ROLE_IDS.size) {
    throw new Error(
      `semantic 角色数 ${resolved.size} ≠ SEMANTIC_ROLES ${SEMANTIC_ROLE_IDS.size}`,
    );
  }
  for (const [id, value] of resolved) {
    const frozen = byId.get(id);
    if (!frozen) {
      throw new Error(snapshotMismatch(`semantic 角色 ${id} 不在冻结快照中`));
    }
    if (value.light !== frozen.light || value.dark !== frozen.dark) {
      throw new Error(
        snapshotMismatch(
          `semantic.${id} light/dark（影子层 ${value.light}/${value.dark} vs 快照 ${frozen.light}/${frozen.dark}）`,
        ),
      );
    }
  }
}

export interface StructureIssue {
  code:
    | 'invalid-syntax'
    | 'missing-mode'
    | 'alias-cycle'
    | 'alias-unresolved'
    | 'alias-direction';
  message: string;
}

function fileLeaves(file: DtcgFile) {
  return collectLeaves(file);
}

export function validateDtcgSyntax(file: DtcgFile, fileName: string): StructureIssue[] {
  const issues: StructureIssue[] = [];
  try {
    const leaves = fileLeaves(file);
    if (leaves.length === 0) {
      issues.push({
        code: 'invalid-syntax',
        message: `${fileName} 没有任何 $value 叶子`,
      });
    }
    for (const { path, leaf } of leaves) {
      if (path.some((segment) => !TOKEN_NAME_RE.test(segment))) {
        issues.push({
          code: 'invalid-syntax',
          message: `${fileName} 路径 ${path.join('.')} 含非法 token 名`,
        });
      }
      if (leaf.$type !== 'color' && leaf.$type !== 'other') {
        issues.push({
          code: 'invalid-syntax',
          message: `${fileName} ${path.join('.')} 的 $type 非法: ${leaf.$type}`,
        });
      }
      if (typeof leaf.$value !== 'string' || leaf.$value.length === 0) {
        issues.push({
          code: 'invalid-syntax',
          message: `${fileName} ${path.join('.')} 缺少 $value`,
        });
      }
    }
  } catch (error) {
    issues.push({
      code: 'invalid-syntax',
      message: `${fileName} DTCG 语法无法遍历: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return issues;
}

export function validateDualModes(semantic: DtcgFile): StructureIssue[] {
  const issues: StructureIssue[] = [];
  for (const [groupName, group] of Object.entries(semantic)) {
    if (groupName.startsWith('$') || !group || typeof group === 'string' || isDtcgLeaf(group)) {
      continue;
    }
    for (const [roleId, modes] of Object.entries(group as DtcgFile)) {
      if (roleId.startsWith('$') || !modes || typeof modes === 'string') continue;
      if (isDtcgLeaf(modes)) {
        issues.push({
          code: 'missing-mode',
          message: `semantic.${groupName}.${roleId} 不是 light/dark 分组`,
        });
        continue;
      }
      const record = modes as DtcgFile;
      for (const mode of ['light', 'dark'] as const) {
        if (!isDtcgLeaf(record[mode])) {
          issues.push({
            code: 'missing-mode',
            message: `semantic.${groupName}.${roleId} 缺少 ${mode}`,
          });
        }
      }
    }
  }
  return issues;
}

export function validateAliasDirection(layers: BuiltLayers): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const files = {
    reference: layers.reference,
    semantic: layers.semantic,
  };

  for (const { path, leaf } of fileLeaves(layers.reference)) {
    if (parseAliasPath(leaf.$value)) {
      issues.push({
        code: 'alias-direction',
        message: `reference.${path.join('.')} 不得使用 alias（reference 只能持有字面量）`,
      });
    }
  }

  for (const { path, leaf } of fileLeaves(layers.semantic)) {
    const alias = parseAliasPath(leaf.$value);
    if (!alias) {
      issues.push({
        code: 'alias-direction',
        message: `semantic.${path.join('.')} 必须 alias 到 reference，不能写字面量`,
      });
      continue;
    }
    const resolved = resolveAlias(files, 'semantic', leaf.$value);
    if (!resolved) {
      issues.push({
        code: 'alias-unresolved',
        message: `semantic.${path.join('.')} 无法解析 ${leaf.$value}`,
      });
      continue;
    }
    if (resolved.file === 'semantic') {
      issues.push({
        code: 'alias-direction',
        message: `semantic.${path.join('.')} 解析回 semantic，违反单向依赖`,
      });
    }
    if (parseAliasPath(resolved.leaf.$value)) {
      issues.push({
        code: 'alias-cycle',
        message: `semantic.${path.join('.')} 指向的 reference 仍是 alias`,
      });
    }
  }
  return issues;
}

export function validateStructure(layers: BuiltLayers): StructureIssue[] {
  return [
    ...validateDtcgSyntax(layers.reference, 'reference'),
    ...validateDtcgSyntax(layers.semantic, 'semantic'),
    ...validateDualModes(layers.semantic),
    ...validateAliasDirection(layers),
  ];
}

const RUNTIME_PACKAGE_DIRS = ['apps/desktop', 'apps/mobile', 'packages'];

export const DESIGN_TOKENS_MODULE_ID = '@cindy/design-tokens';

function dependencyHits(pkgJson: Record<string, unknown>, rel: string): string[] {
  const hits: string[] = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkgJson[field];
    if (deps && typeof deps === 'object' && DESIGN_TOKENS_MODULE_ID in deps) {
      hits.push(`${rel}#${field}`);
    }
  }
  return hits;
}

/**
 * 零运行时接线守卫必须拒绝所有合法的包导入与依赖入口，而不是只识别少数
 * 静态文本形态。逐一列出每种形态（模块 id 后允许子路径，如
 * '@cindy/design-tokens/package.json' 这类 subpath 消费同样算接线）：
 *  - from 子句：静态具名 / 默认 / 命名空间 / type-only import 与 re-export
 *    （`\s` 覆盖跨行变体，不要求以 import 开头，避免漏掉 export…from）；
 *  - import '<id>' 副作用导入；
 *  - import('<id>') 动态导入（可跨行）；
 *  - require('<id>') 与 TS import-equals（import x = require('<id>')）；
 *  - import.meta.resolve('<id>') 运行期解析入口；
 *  - 绕过包 id、以相对路径直读包内源码 / 产物。
 * `(?<![\w$.])` 排除 foo.import( / myImport( 这类成员调用与标识符误报。
 */
const IMPORT_ENTRY_PATTERNS: readonly RegExp[] = [
  /from\s*['"]@cindy\/design-tokens(?:\/[^'"\s]*)?['"]/,
  /(?<![\w$.])import\s*['"]@cindy\/design-tokens(?:\/[^'"\s]*)?['"]/,
  /(?<![\w$.])import\s*\(\s*['"]@cindy\/design-tokens(?:\/[^'"\s]*)?['"]/,
  /(?<![\w$.])import\.meta\.resolve\s*\(\s*['"]@cindy\/design-tokens(?:\/[^'"\s]*)?['"]/,
  /(?<![\w$.])require\s*\(\s*['"]@cindy\/design-tokens(?:\/[^'"\s]*)?['"]/,
  /packages\/design-tokens\/(?:src|dist|build)\//,
];

/** 一段源码文本是否含任何合法形态的包导入 / 依赖入口（供扫描与自证伪测试共用）。 */
export function containsRuntimeImportOfDesignTokens(text: string): boolean {
  return IMPORT_ENTRY_PATTERNS.some((pattern) => pattern.test(text));
}

export function findRuntimeImportsOfDesignTokens(repoRoot: string): string[] {
  const hits: string[] = [];
  const skip = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

  const visit = (abs: string, rel: string) => {
    const entries = readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const childAbs = join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (childRel === 'packages/design-tokens') continue;
        visit(childAbs, childRel);
        continue;
      }
      if (entry.name === 'package.json') {
        const pkg = JSON.parse(readFileSync(childAbs, 'utf8')) as Record<string, unknown>;
        hits.push(...dependencyHits(pkg, childRel));
        continue;
      }
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
      const text = readFileSync(childAbs, 'utf8');
      if (containsRuntimeImportOfDesignTokens(text)) hits.push(childRel);
    }
  };

  for (const dir of RUNTIME_PACKAGE_DIRS) {
    visit(join(repoRoot, dir), dir);
  }
  return hits;
}
