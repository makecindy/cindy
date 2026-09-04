import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';

const { dirname: posixDirname, join: posixJoin, normalize: posixNormalize } = posix;

import { resolvedSemanticValues, type BuiltLayers } from './build-layers.ts';
import {
  CLASSIFICATION_CATEGORIES,
  type ClassificationCategory,
  type ClassificationDocument,
  PROTECTED_IDS,
  SEMANTIC_EXEMPTION_IDS,
} from './classify.ts';
import {
  collectLeaves,
  isDtcgLeaf,
  parseAliasPath,
  resolveAlias,
  toDtcgColorObject,
  TOKEN_NAME_RE,
  type DtcgColorObject,
  type DtcgFile,
} from './dtcg.ts';
import {
  CLASSIFICATION_RELATIVE_PATH,
  COMPONENT_RELATIVE_PATH,
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
    `更新方式：把实时提取结果写回 ${SNAPSHOT_RELATIVE_PATH}，并重新生成 ${CLASSIFICATION_RELATIVE_PATH} / ${REFERENCE_RELATIVE_PATH} / ${SEMANTIC_RELATIVE_PATH} / ${COMPONENT_RELATIVE_PATH}。`,
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
    if (entry.protected?.family !== rule.family) {
      throw new Error(`保护值 ${id} 的 family 标记错误`);
    }
    if (rule.mode === 'register-only') {
      // Tier-3 singleton：只登记、不建模（治理合同 §3.2「保留原位」）。
      if (entry.category !== 'runtime-derived-or-protected') {
        throw new Error(
          `保护值 ${id} 分类应为 runtime-derived-or-protected，实际 ${entry.category}`,
        );
      }
      if (entry.modeledAsSemantic) {
        throw new Error(`保护值 ${id}（register-only）不得进入 semantic 映射`);
      }
      if (SEMANTIC_ROLE_IDS.has(id)) {
        throw new Error(`保护值 ${id}（register-only）出现在 SEMANTIC_ROLES`);
      }
    } else {
      // Tier-1 slot（semantic-modeled）：照常建模 + 保留 protected 元数据
      // （治理合同 §3.2「名称与用途延续」；保护限制改值，不禁止迁移）。
      if (!entry.modeledAsSemantic) {
        throw new Error(
          `保护值 ${id}（semantic-modeled）必须进入 semantic 映射——DS-8 依赖新真相源生成它`,
        );
      }
      if (!SEMANTIC_ROLE_IDS.has(id)) {
        throw new Error(
          `保护值 ${id}（semantic-modeled）未出现在 SEMANTIC_ROLES`,
        );
      }
    }
  }
}

/**
 * 语义豁免色登记守卫（DESIGN.md §10 theme-invariant 族，治理合同 §3.2）：
 * 已进 semantic 建模的豁免色必须携带 exemption 元数据——DS-8 生成主题入口
 * 时据此区分「可覆写 semantic」与「必须保留原值的豁免族」。豁免色与
 * PROTECTED_IDS 不同：照常建模，只是带标记。
 */
export function assertSemanticExemptionsRegistered(
  classification: ClassificationDocument,
): void {
  for (const [id, rule] of Object.entries(SEMANTIC_EXEMPTION_IDS)) {
    const entry = classification.entries.find((item) => item.id === id);
    if (!entry) {
      throw new Error(`豁免色 ${id} 未出现在分类登记`);
    }
    if (!SEMANTIC_ROLE_IDS.has(id)) {
      throw new Error(
        `豁免色 ${id} 未进 semantic 建模——豁免登记的前提是已建模（否则等建模后再登记）`,
      );
    }
    if (entry.modeledAsSemantic !== true) {
      throw new Error(`豁免色 ${id} modeledAsSemantic 应为 true，实际 false`);
    }
    if (!entry.exemption) {
      throw new Error(
        `豁免色 ${id} 已建模但分类登记缺少 exemption 元数据（外部主题不覆盖的语义豁免族）`,
      );
    }
    if (entry.exemption.family !== rule.family) {
      throw new Error(`豁免色 ${id} 的 family 标记错误`);
    }
    if (entry.protected) {
      throw new Error(
        `豁免色 ${id} 同时带 protected 与 exemption——豁免色照常建模，不属加严保护值（只登记不建模）`,
      );
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
  // 逐值一致在标准 DTCG 颜色对象层比较（语义等价），不在原始字符串层比较：
  // 影子层 $value 是对象（如 {colorSpace:"hsl",components:[60,12.5,97]}），
  // 快照是字符串（"60 12.5% 97%"）；两侧都过 toDtcgColorObject 后必须深度相等。
  // hex 大小写（#417CDD vs #417cdd）不构成色值差异。
  for (const [id, value] of resolved) {
    const frozen = byId.get(id);
    if (!frozen) {
      throw new Error(snapshotMismatch(`semantic 角色 ${id} 不在冻结快照中`));
    }
    for (const mode of ['light', 'dark'] as const) {
      const shadowValue = value[mode];
      const frozenValue = frozen[mode];
      if (shadowValue == null || frozenValue == null) {
        throw new Error(
          snapshotMismatch(`semantic.${id} ${mode} 缺值（影子层/快照）`),
        );
      }
      let shadowObj: DtcgColorObject;
      let frozenObj: DtcgColorObject;
      try {
        shadowObj =
          typeof shadowValue === 'string'
            ? toDtcgColorObject(shadowValue)
            : shadowValue;
      } catch {
        throw new Error(
          snapshotMismatch(`semantic.${id} ${mode} 影子层值无法解析: ${String(shadowValue)}`),
        );
      }
      try {
        frozenObj = toDtcgColorObject(frozenValue);
      } catch {
        throw new Error(
          snapshotMismatch(`semantic.${id} ${mode} 快照值无法解析: ${frozenValue}`),
        );
      }
      if (
        shadowObj.colorSpace !== frozenObj.colorSpace ||
        JSON.stringify(shadowObj.components) !== JSON.stringify(frozenObj.components) ||
        shadowObj.alpha !== frozenObj.alpha
      ) {
        throw new Error(
          snapshotMismatch(
            `semantic.${id} ${mode}（影子层 ${JSON.stringify(shadowObj)} vs 快照 ${frozenValue}）`,
          ),
        );
      }
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

const COLOR_SPACES = ['srgb', 'hsl'] as const;

/**
 * 各色彩空间分量的 DTCG 合法范围（W3C DTCG Color 模块的 Color Space 表）：
 * srgb 三通道 [0,1]；hsl 的 hue [0,360)（闭开区间——360 非法）、
 * saturation / lightness [0,100]。注意 hsl 不是 0–1（与 srgb 不同），
 * alpha 恒为 [0,1]。
 */
const COLOR_SPACE_RANGES: Record<
  (typeof COLOR_SPACES)[number],
  Array<{ min: number; max: number; maxInclusive: boolean }>
> = {
  srgb: [
    { min: 0, max: 1, maxInclusive: true },
    { min: 0, max: 1, maxInclusive: true },
    { min: 0, max: 1, maxInclusive: true },
  ],
  hsl: [
    { min: 0, max: 360, maxInclusive: false },
    { min: 0, max: 100, maxInclusive: true },
    { min: 0, max: 100, maxInclusive: true },
  ],
};

function isValidDtcgColorObject(value: unknown): value is DtcgColorObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!COLOR_SPACES.includes(record.colorSpace as (typeof COLOR_SPACES)[number])) {
    return false;
  }
  if (!Array.isArray(record.components) || record.components.length !== 3) {
    return false;
  }
  const space = record.colorSpace as (typeof COLOR_SPACES)[number];
  const inRange = record.components.every((c, i) => {
    if (typeof c !== 'number' || !Number.isFinite(c)) return false;
    const { min, max, maxInclusive } = COLOR_SPACE_RANGES[space][i];
    return c >= min && (maxInclusive ? c <= max : c < max);
  });
  if (!inRange) return false;
  if (
    record.alpha != null &&
    (typeof record.alpha !== 'number' || record.alpha < 0 || record.alpha > 1)
  ) {
    return false;
  }
  return true;
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
      // $type 只允许标准 DTCG 颜色类型。此前这里放行自定义的 "other"，
      // 导致 12 个 HSL triplet 节点以非法类型落盘（Terrazzo 会静默丢弃，
      // 见 build-layers.ts / dtcg.ts 的标准颜色对象迁移）。
      if (leaf.$type !== 'color') {
        issues.push({
          code: 'invalid-syntax',
          message: `${fileName} ${path.join('.')} 的 $type 非法: ${leaf.$type}`,
        });
      }
      if (typeof leaf.$value === 'string') {
        if (leaf.$value.length === 0) {
          issues.push({
            code: 'invalid-syntax',
            message: `${fileName} ${path.join('.')} 缺少 $value`,
          });
        }
        if (!parseAliasPath(leaf.$value)) {
          issues.push({
            code: 'invalid-syntax',
            message: `${fileName} ${path.join('.')} 的 $value 必须是 alias 或标准颜色对象，不能是裸字符串色值`,
          });
        }
      } else if (!isValidDtcgColorObject(leaf.$value)) {
        issues.push({
          code: 'invalid-syntax',
          message: `${fileName} ${path.join('.')} 的 $value 不是合法标准 DTCG 颜色对象`,
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
    component: layers.component,
  };

  for (const { path, leaf } of fileLeaves(layers.reference)) {
    // reference 只能持有标准颜色对象字面量；alias 形态（`{…}` 字符串）违规。
    if (typeof leaf.$value === 'string' && parseAliasPath(leaf.$value)) {
      issues.push({
        code: 'alias-direction',
        message: `reference.${path.join('.')} 不得使用 alias（reference 只能持有字面量）`,
      });
    }
  }

  for (const { path, leaf } of fileLeaves(layers.semantic)) {
    if (typeof leaf.$value !== 'string') {
      issues.push({
        code: 'alias-direction',
        message: `semantic.${path.join('.')} 必须 alias 到 reference，不能写字面量`,
      });
      continue;
    }
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
    if (resolved.file !== 'reference') {
      issues.push({
        code: 'alias-direction',
        message: `semantic.${path.join('.')} 必须落在 reference，实际 ${resolved.file}`,
      });
    }
    if (
      typeof resolved.leaf.$value === 'string' &&
      parseAliasPath(resolved.leaf.$value)
    ) {
      issues.push({
        code: 'alias-cycle',
        message: `semantic.${path.join('.')} 指向的 reference 仍是 alias`,
      });
    }
  }

  for (const { path, leaf } of fileLeaves(layers.component)) {
    if (typeof leaf.$value !== 'string') {
      issues.push({
        code: 'alias-direction',
        message: `component.${path.join('.')} 必须 alias 到 semantic 或 reference，不能写字面量`,
      });
      continue;
    }
    if (!parseAliasPath(leaf.$value)) {
      issues.push({
        code: 'alias-direction',
        message: `component.${path.join('.')} 必须 alias 到 semantic 或 reference，不能写字面量`,
      });
      continue;
    }
    const resolved = resolveAlias(files, 'component', leaf.$value);
    if (!resolved) {
      issues.push({
        code: 'alias-unresolved',
        message: `component.${path.join('.')} 无法解析 ${leaf.$value}`,
      });
      continue;
    }
    if (resolved.file === 'component') {
      issues.push({
        code: 'alias-direction',
        message: `component.${path.join('.')} 解析回 component，违反单向依赖`,
      });
    }
  }
  return issues;
}

export function validateStructure(layers: BuiltLayers): StructureIssue[] {
  return [
    ...validateDtcgSyntax(layers.reference, 'reference'),
    ...validateDtcgSyntax(layers.semantic, 'semantic'),
    ...validateDtcgSyntax(layers.component, 'component'),
    ...validateDualModes(layers.semantic),
    ...validateDualModes(layers.component),
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
 *  - require('<id>') 与 TS import-equals（import x = require('<id>')）——
 *    含 `module.require('<id>')` 成员链形态（Node 真实加载 API）；
 *  - require.resolve('<id>') 运行期路径解析（readFileSync(require.resolve(…))
 *    是消费影子层的真实路径）；
 *  - import.meta.resolve('<id>') 运行期解析入口；
 *  - 绕过包 id、以相对路径直读包内源码 / 产物。
 * `(?<![\w$])` 只排除 myImport( 这类标识符连写；**不排除 `.` 前缀**——
 * `module.require('…')` 是真实加载 API 必须命中，foo.import( 这类自定义
 * 成员调用宁可误报（守卫拦截的是真接线，member-require 是合法接线形态）。
 */
const IMPORT_ENTRY_PATTERNS: readonly RegExp[] = [
  /from\s*['"`]@cindy\/design-tokens(?:\/[^'"`\s]*)?['"`]/,
  /(?<![\w$])import\s*['"`]@cindy\/design-tokens(?:\/[^'"`\s]*)?['"`]/,
  /(?<![\w$])import\s*\(\s*['"`]@cindy\/design-tokens(?:\/[^'"`\s]*)?['"`]/,
  /(?<![\w$])import\.meta\.resolve\s*\(\s*['"`]@cindy\/design-tokens(?:\/[^'"`\s]*)?['"`]/,
  /(?<![\w$])require\s*\(\s*['"`]@cindy\/design-tokens(?:\/[^'"`\s]*)?['"`]/,
  /(?<![\w$])require\s*\.\s*resolve\s*\(\s*['"`]@cindy\/design-tokens(?:\/[^'"`\s]*)?['"`]/,
  /packages\/design-tokens\/(?:src|dist|build)\//,
];

/**
 * 从源码文本中提取全部模块说明符（'…' / "…" / 无插值 `…` 模板字面量形式
 * 的 import / require / URL 目标），供按被扫描文件位置解析相对路径。覆盖
 * 七种语境：import-from / import() / require()（含 `module.require()` 等
 * 成员链上的真实 Node 加载 API）/ require.resolve()（运行期解析模块路径，
 * `readFileSync(require.resolve(…))` 是消费影子层的真实路径，review P2
 * 实锤）/ import.meta.resolve() / 裸 `import '…'` 副作用导入（后者无 from
 * 子句无括号，分支自身用 `(?=['"\`])` 前瞻定位引号、不吞引号，引号由共享
 * 后继 `['"\`]…['"\`]` 统一消费，`\s*` 覆盖换行形态）/ `new URL('…',
 * import.meta.url)`（直接文件读取——`readFileSync(new URL('…',
 * import.meta.url))` 同样消费影子层，review P1 实锤；按调用文件位置 resolve
 * 相对说明符，仓内 110 处既有用法都不指向 design-tokens、零误报）。
 * 模板字面量：无插值形态与普通引号同权重（`import(\`../../x\`)` 是有效
 * 运行时加载，review P1 实锤）；**带 `${…}` 插值的模板同样命中**——插值
 * 说明路径在运行期拼装，恰是零接线阶段不该出现的动态消费形态，按宁误报
 * 不漏放处理。
 * `(?<![\w$])` 只排除 myImport / myRequire 这类标识符连写；**不再排除
 * `.` 前缀**——`module.require('…')` 是 Node 真实加载 API（review P1
 * 实锤），foo.import( 这类自定义成员调用宁可误报也不漏放：守卫拦截的是
 * 「有人真接线」，member-require 恰是真实接线的合法形态。
 */
const SPECIFIER_CONTEXT_RE =
  /(?:\bfrom\s*|(?<![\w$])import\s*\(\s*|(?<![\w$])require\s*\(\s*|(?<![\w$])require\s*\.\s*resolve\s*\(\s*|\bimport\.meta\.resolve\s*\(\s*|\bimport\.meta\.glob\s*\(\s*|\bnew\s+URL\s*\(\s*|(?<![\w$])import\s*(?=['"`]))['"`]([^'"`]+)['"`]/g;

/**
 * fs API 路径参数语境（第八类）：`readFileSync('…'` / `readFile('…'` 等
 * 直接文件读取的**第一参数**。相对路径说明符按调用文件位置 resolve 后
 * 落进 packages/design-tokens/ 即命中（review P2 实锤：裸相对路径是最
 * 直接的绕过方式）。含 `node:fs/promises` 的异步 `open('…')`（返回
 * FileHandle 再 readFile——review P2 实锤）；`window.open('https://…')`
 * 这类 URL 参数不以 `.` 开头，天然过滤，仓内实测零误报。
 */
const FS_API_PATH_CONTEXT_RE =
  /(?<![\w$])(?:readFileSync|readFile|writeFileSync|writeFile|appendFileSync|existsSync|statSync|openSync|open|copyFileSync|renameSync|rmSync|unlinkSync|createReadStream)\s*\(\s*['"`]([^'"`]+)['"`]/g;

/**
 * 路径构造器语境（第九类）：`resolve(__dirname, '…')` / `join(here, '…')`
 * 等包装形态——仓内既有 fs 读取的主流写法（54 处实测）。
 * 重建**全部静态参数**（review P2 实锤：`join(__dirname, '..', '..',
 * 'design-tokens/…')` 分段拼接时只看第一个 `'..'` 会漏）——把调用内
 * 按序出现的字符串字面量拼成一个候选路径再按文件位置 resolve；非字符串
 * 参数（`__dirname` / 变量）在拼接中天然缺席（等价于从文件目录起算的
 * 相对段）。非相对拼接结果（如 `'、'` 这类 join 分隔符）不以 `.` 开头，
 * 天然过滤。
 */
const PATH_CONSTRUCTOR_CALL_RE =
  /\b(?:resolve|join)\s*\(([^()]*)\)/g;
const STATIC_STRING_ARG_RE = /['"`]([^'"`]+)['"`]/g;

/**
 * 判断「无空白压缩后的最近输出」是否以 import / fs API / 路径构造器语境
 * 结尾。**所有分支共享末尾 `$` 锚定**（review P2 实锤：`\bfrom` / `\bimport`
 * 分支曾无锚定，源码先出现正常导入再写 `const hint = 'packages/design-tokens/…'`
 * 时，残留语境里的 import 字样让数据字符串被错误保留，裸路径模式随后误报
 * 接线、阻断 required unit workspace）。`$` 保证匹配的是紧邻当前开引号的
 * 调用语境。
 */
const SPECIFIER_PREFIX_RE =
  /(?:\bfrom|\bimport\s*\(|\brequire\s*\(|\brequire\s*\.\s*resolve\s*\(|\bimport\.meta\.resolve\s*\(|\bimport\.meta\.glob\s*\(|\bnew\s+URL\s*\(|\bimport|(?:readFileSync|readFile|writeFileSync|writeFile|appendFileSync|existsSync|statSync|openSync|open|copyFileSync|renameSync|rmSync|unlinkSync|createReadStream)\s*\(|\b(?:resolve|join)\s*\([^()]*$)$/;

/**
 * 剥除源码里的注释与「数据语境」字符串字面量，保留 import 说明符。
 *
 * 为什么需要：零接线守卫的两个检测通道都吃原始文本，注释或错误消息里
 * 出现完整 import 语句（如 `// import '@cindy/design-tokens';`）会被当成
 * 真实接线（review P1 实锤），无运行时接线的改动被 CI 阻断。
 *
 * 规则（轻量状态机，非完整 AST）：
 *  - `//…` 行注释与块注释（slash-star 形态）整体替换为空白（保留换行，
 *    行列结构不变）；
 *  - `'…'` / `"…"` / `` `…` `` 字符串：若开引号前的代码语境以 import
 *    结尾（from / import( / require( / import.meta.resolve( / import），
 *    说明这是模块说明符——**保留原文**；否则视为数据字符串，内容替换为
 *    空白（引号保留，长度不变）。
 *  - **语境判定不看长度窗口**：状态机维护「无空白压缩的最近输出」
 *    （lastCodeContext）——注释与空白产生的输出不推进它，代码字符才
 *    追加。任意长度的注释（如 >64 字符的 webpack 注释）都不会把 import(
 *    挤出语境（review P1 实锤：固定 64 字符窗口会让长注释后的说明符被
 *    误当数据清空）。
 *  - 模板字符串内的 `${…}` 不再细分——数据语境整体剥除，说明符语境
 *    （不会出现插值）整体保留，两个方向都不产生误报。
 *  - 正则字面量（`/…/`）不识别：其内容若含引号会被当字符串处理。这只在
 *    「漏放」方向出偏差（正则内容被清空 → 不命中），真实 import 语句不会
 *    写在正则字面量里，可接受。
 */
export function stripCommentsAndDataStrings(source: string): string {
  const chunks: string[] = [];
  let i = 0;
  const n = source.length;
  let plainStart = 0;
  let lastCodeContext = '';
  const flushPlain = (end: number) => {
    if (end > plainStart) {
      const text = source.slice(plainStart, end);
      chunks.push(text);
      // 压缩空白后并入语境：任意长空白折叠为一个空格，语境不设上限。
      lastCodeContext = (lastCodeContext + text.replace(/\s+/g, ' ')).slice(-256);
    }
  };
  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      flushPlain(i);
      const start = i;
      while (i < n && source[i] !== '\n') i++;
      chunks.push(' '.repeat(i - start));
      plainStart = i;
      continue;
    }
    if (c === '/' && c2 === '*') {
      flushPlain(i);
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      chunks.push(' '.repeat(i - start));
      plainStart = i;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      flushPlain(i);
      const quote = c;
      const open = i;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      i = Math.min(i + 1, n);
      const str = source.slice(open, i);
      if (SPECIFIER_PREFIX_RE.test(lastCodeContext.trimEnd())) {
        chunks.push(str);
      } else {
        chunks.push(quote + ' '.repeat(Math.max(0, str.length - 2)) + quote);
      }
      plainStart = i;
      continue;
    }
    i++;
  }
  flushPlain(n);
  return chunks.join('');
}

/**
 * 相对路径直读检测：按被扫描文件的 repo 相对位置解析每个相对说明符，
 * 归一化后落在 packages/design-tokens/ 之内即命中。
 *
 * 为什么不能只靠 IMPORT_ENTRY_PATTERNS 的 `packages/design-tokens/…` 字面量：
 * 兄弟 workspace（如 packages/foo/src/a.ts 写 `../../design-tokens/src/…`）
 * 的相对说明符不含 `packages/` 段，正则漏检（review P1 实锤）；按文件位置
 * resolve 后无论 `../` 深度、兄弟包还是 apps 侧路径都能正确判定。
 */
export function relativeSpecifierHitsDesignTokens(
  text: string,
  fileRel: string,
): boolean {
  const dir = posixDirname(fileRel);
  // 剥除必须在提取之前：`import(/* c */ '…')` 这类合法注释隔断会让
  // 关键字→引号的正则衔接在原始文本上断开（review P2 实锤），预扫直接
  // 零命中、剥除层反而执行不到。剥除层按注释→空白替换，衔接恢复。
  // 关键字 includes 预检覆盖全部语境字样（import/require/from、fs API
  // 与路径构造器；open 单独列出——裸 `open('…')` 不含 File/Sync 字样），
  // 任一命中才值得付剥除成本。
  if (
    !text.includes('import') &&
    !text.includes('require') &&
    !text.includes('from') &&
    !text.includes('File') &&
    !text.includes('Sync') &&
    !text.includes('open') &&
    !text.includes('resolve') &&
    !text.includes('join')
  ) {
    return false;
  }
  const codeOnly = stripCommentsAndDataStrings(text);
  const specs: string[] = [];
  for (const match of codeOnly.matchAll(SPECIFIER_CONTEXT_RE)) {
    specs.push(match[1]);
  }
  for (const match of codeOnly.matchAll(FS_API_PATH_CONTEXT_RE)) {
    specs.push(match[1]);
  }
  // 路径构造器：重建调用内全部静态字符串参数（按序拼接为候选路径）。
  for (const call of codeOnly.matchAll(PATH_CONSTRUCTOR_CALL_RE)) {
    const args = call[1];
    const statics: string[] = [];
    for (const arg of args.matchAll(STATIC_STRING_ARG_RE)) {
      statics.push(arg[1]);
    }
    if (statics.length > 0) {
      specs.push(statics.join('/'));
    }
  }
  for (const spec of specs) {
    // 说明符分隔符归一（review P2 实锤）：源码字符串里的 `\\` 是转义的
    // 单反斜杠——Windows CJS 允许反斜杠路径（require('..\\..\\x')），
    // posix join 不认。反斜杠统一替换为 / 再 resolve（仓内没有含反斜杠
    // 字符的 POSIX 文件名，替换是安全近似）。
    const normalized = spec.replace(/\\+/g, '/');
    if (!normalized.startsWith('.')) continue;
    const resolved = posixNormalize(posixJoin(dir, normalized));
    if (resolved === 'packages/design-tokens' || resolved.startsWith('packages/design-tokens/')) {
      return true;
    }
  }
  return false;
}

/** 一段源码文本是否含任何合法形态的包导入 / 依赖入口（供扫描与自证伪测试共用）。 */
export function containsRuntimeImportOfDesignTokens(text: string): boolean {
  // 剥除必须在检测之前（同 relativeSpecifierHitsDesignTokens 的理由）：
  // 注释既会制造伪命中（注释掉的 import 语句），也会遮蔽真命中
  // （import(/* c */ '…') 的注释隔断）——两个方向都由剥除层统一解决。
  // 关键字 includes 预检让不含 import 语法痕迹的文件（多数资源型源码）
  // 完全跳过剥除成本；剥除层只在确有 import/require/from 字样时启动。
  if (
    !text.includes('import') &&
    !text.includes('require') &&
    !text.includes('from')
  ) {
    return false;
  }
  const codeOnly = stripCommentsAndDataStrings(text);
  return IMPORT_ENTRY_PATTERNS.some((pattern) => pattern.test(codeOnly));
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
      // .mts/.cts 是有效的 Node/TypeScript 模块扩展（仓内 scripts/ 与
      // tools/ 已使用），不扫它们会让相对路径消费在读取内容前就被跳过
      // （review P2 实锤）。
      if (!/\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(entry.name)) continue;
      const text = readFileSync(childAbs, 'utf8');
      // 双通道检测：包 id / 带前缀路径的静态形态 + 按本文件位置解析的相对
      // 说明符（兄弟 workspace 的 `../../design-tokens/src/…` 只有后者能抓到）。
      if (
        containsRuntimeImportOfDesignTokens(text) ||
        relativeSpecifierHitsDesignTokens(text, childRel)
      ) {
        hits.push(childRel);
      }
    }
  };

  for (const dir of RUNTIME_PACKAGE_DIRS) {
    visit(join(repoRoot, dir), dir);
  }
  return hits;
}
