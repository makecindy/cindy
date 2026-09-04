// extract-helpers.mjs — extract.mjs 作者的共享工具函数。
//
// 诞生背景(2026-07-29 login-all-hifi 事故):每个 demo 的 extract.mjs 手写 repoRoot
// 定位(`../../..` 数目录层级),demo 从 _tmp/ 迁到 docs/design-previews/ 后路径全断,
// 一天连修 3 个 bug(repoRoot 深度、provenance 前缀、truth 相对路径)。本库把这些
// 「每个 demo 都要做且都做错过」的事收敛为一次实现:
//   - findRepoRoot():git 定位仓库根,与目录深度彻底解耦——demo 随便搬家;
//   - makeLeaf():provenance 工厂,source 相对路径 / hash / locatorPattern 一次做对;
//   - importTsModule():esbuild 临时编译 TS 纯函数后 import(门 F oracle 用产品公式本身);
//   - extractThemeVars():主题桥——从产品 themes/colors.ts 的 registerColor 全表提取
//     light/dark 双态色值,每个值都是带 provenance 的 truth 叶子(组件模式 adapter 复刻
//     主题变量时用它,而不是手抄一份色表——手抄两边同错就是假绿)。
//
// 使用方式:init.mjs 会把本文件拷贝进 demo 目录(extract-helpers.mjs),extract.mjs
// `import { findRepoRoot, makeLeaf } from './extract-helpers.mjs'`——demo 自包含,
// 随 PR 入产品仓后不依赖 skill 安装位置。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * 定位产品仓库根。优先 `git rev-parse --show-toplevel`(worktree/submodule 都正确),
 * 降级为向上找 .git。**禁止**用 `../../..` 数目录层级——那是 2026-07-29 三连 bug 的根因。
 */
export function findRepoRoot(startDir = process.cwd()) {
  try {
    const out = execFileSync('git', ['-C', startDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {}
  let cur = resolve(startDir);
  while (true) {
    if (existsSync(join(cur, '.git'))) return cur;
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  throw new Error(`findRepoRoot: 从 ${startDir} 向上找不到 git 仓库根——extract 必须在产品仓内运行,或显式传 startDir`);
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * truth 叶子工厂:{ value, provenance: { source, locator, hash[, locatorPattern] } }。
 * source 自动写成「相对 demo 目录」的路径(truth.mjs 以 cwd=demoDir 跑 extract,
 * 校验器 validateProvenance 也按 demoDir 解析)——搬家后重跑 extract 即自动修正,
 * 不再出现「provenance 前缀硬编码旧目录深度」(obs 16371)。
 *
 * @param value 提取到的值(界面文案/几何/色值等)
 * @param sourceFile 源文件绝对路径(或相对 demoDir 的路径)
 * @param opts.locator 必填:一句话说明该值在源文件中的定位方式(人读)
 * @param opts.locatorPattern 可选:恰含一个捕获组的正则(writeback 机械写回的锚,regex 模式)
 * @param opts.keyPath 可选:源文件中该值的完整对象路径(writeback 机械写回的锚,AST 模式;
 *   从顶层变量名/export default/JSON 根起,如 'loginDesignTokens.hero.size';记进
 *   provenance.locatorKeyPath,由 writeback 用产品仓 typescript 在 AST 上定位)
 * @param opts.demoDir 默认 process.cwd()(truth.mjs 保证 = demo 目录)
 */
export function makeLeaf(value, sourceFile, { locator, locatorPattern, keyPath, demoDir = process.cwd() } = {}) {
  if (!locator || typeof locator !== 'string') {
    throw new Error(`makeLeaf(${JSON.stringify(value)}): 必须写 locator——一句话说明该值在源文件里怎么定位`);
  }
  const abs = isAbsolute(sourceFile) ? sourceFile : resolve(demoDir, sourceFile);
  if (!existsSync(abs)) throw new Error(`makeLeaf: 源文件不存在:${abs}`);
  if (locatorPattern !== undefined) {
    let groups;
    try {
      groups = new RegExp(`${locatorPattern}|`).exec('').length - 1;
    } catch (err) {
      throw new Error(`makeLeaf: locatorPattern 不是合法正则:${err.message}`);
    }
    if (groups !== 1) throw new Error(`makeLeaf: locatorPattern 必须恰含一个捕获组(当前 ${groups} 个):${locatorPattern}`);
  }
  if (keyPath !== undefined) {
    if (typeof keyPath !== 'string' || !keyPath.trim() || keyPath.split('.').some((s) => !s || /\s/.test(s))) {
      throw new Error(`makeLeaf: keyPath 必须是「段.段.段」非空路径(段不含空白):${JSON.stringify(keyPath)}`);
    }
  }
  const provenance = { source: relative(demoDir, abs), locator, hash: sha256File(abs) };
  if (locatorPattern !== undefined) provenance.locatorPattern = locatorPattern;
  if (keyPath !== undefined) provenance.locatorKeyPath = keyPath;
  return { value, provenance };
}

/* ────────────────────────────────────────────────────────────────────────────
   fixture locator:受限 JSON 路径 + 双侧值绑定

   审核 P1 #3 的根因:旧实现只 hash 整个 fixture 文件,locator 是自由文本。于是
   `makeFixtureLeaf('HANDWRITTEN', 'fixtures/providers.json', { locator: 'data[0].displayName' })`
   能过全部校验——hash 对得上(文件没改),locator 看起来很像路径(其实没人解析它),
   value 却是手打的。fixture 从"声明性降级"变成了"手抄数据的免检通道"。

   修法两条,工厂函数与 validateProvenance 双侧共用本节代码(单一真相源,免得两边漂):
     ① locator 收紧为可机械解析的 JSON 路径(对象键 / 数组下标 / JSON Pointer),
        自由文本一律拒——不可解析的锚等于没有锚;
     ② 解析 fixture 文件、按 locator 取值,与叶子 value canonical-equal 比对,不符即拒。

   注意:本文件被 init.mjs 整份拷进 demo 目录(demo 自包含),因此只许 import node
   内建模块——canonicalJson 与 fs-utils.canonicalize 语义相同但必须在此独立实现。
   ──────────────────────────────────────────────────────────────────────────── */

const LOCATOR_KEY_CHARS = /[A-Za-z0-9_$-]/;
export const FIXTURE_LOCATOR_SYNTAX =
  '受限 JSON 路径:对象键用 `.` 分隔、数组下标用 `.0` 或 `[0]`(如 data.0.displayName / ' +
  'data[0].displayName),或 RFC6901 JSON Pointer(如 /data/0/displayName)';

/**
 * 解析 fixture locator 为路径段数组。不合法(自由文本、空段、非数字下标等)返回 null。
 * 段一律是 string;取值时按容器类型决定它是对象键还是数组下标。
 */
export function parseFixtureLocator(locator) {
  if (typeof locator !== 'string' || !locator) return null;
  if (locator !== locator.trim()) return null;
  // JSON Pointer(RFC6901):必须以 / 开头,~1 → / 、~0 → ~
  if (locator.startsWith('/')) {
    const raw = locator.slice(1).split('/');
    if (raw.some((s) => s === '')) return null;
    // 未转义的 ~ 后必须跟 0/1,否则是笔误而不是合法 pointer
    if (raw.some((s) => /~(?![01])/.test(s))) return null;
    return raw.map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  const segs = [];
  let i = 0;
  while (i < locator.length) {
    if (locator[i] === '[') {
      const close = locator.indexOf(']', i);
      if (close === -1) return null;
      const idx = locator.slice(i + 1, close);
      if (!/^\d+$/.test(idx)) return null;
      segs.push(idx);
      i = close + 1;
    } else {
      let j = i;
      while (j < locator.length && LOCATOR_KEY_CHARS.test(locator[j])) j += 1;
      if (j === i) return null;
      segs.push(locator.slice(i, j));
      i = j;
    }
    if (i >= locator.length) break;
    if (locator[i] === '.') {
      i += 1;
      if (i >= locator.length) return null;
    } else if (locator[i] !== '[') return null;
  }
  return segs.length ? segs : null;
}

/** 按已解析的路径段在 fixture JSON 上取值。返回 {ok:true,value} 或 {ok:false,reason}。 */
export function resolveFixtureLocator(root, segs) {
  let cur = root;
  const walked = [];
  for (const seg of segs) {
    const at = walked.length ? walked.join('.') : '(root)';
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return { ok: false, reason: `${at} 是数组,段必须是数字下标(当前 "${seg}")` };
      const idx = Number(seg);
      if (idx >= cur.length) return { ok: false, reason: `${at} 数组长 ${cur.length},下标 ${idx} 越界` };
      cur = cur[idx];
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.hasOwn(cur, seg)) return { ok: false, reason: `${at} 下没有键 "${seg}"` };
      cur = cur[seg];
    } else {
      return { ok: false, reason: `${at} 不是对象/数组(${cur === null ? 'null' : typeof cur}),无法继续取 "${seg}"` };
    }
    walked.push(seg);
  }
  return { ok: true, value: cur };
}

/** 键序无关的稳定序列化(值比对用)。与 fs-utils.canonicalize 同语义,见本节顶部注释。 */
export function canonicalJson(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) !== null && Object.getPrototypeOf(v) !== Object.prototype) return v;
    if (v !== null && typeof v === 'object') {
      const out = Object.create(null);   // r12:同 fs-utils.canonicalize,__proto__ 键不许被静默丢弃
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

const CAPTURED_FROM_KEYS = ['environment', 'capturedAt', 'endpoint', 'note'];

/**
 * capturedFrom 必须是结构化声明,不是自由文本。
 *
 * 为什么收紧:自由文本没有任何可机械检查的成分,"沙盒响应" 四个字就能过——
 * 但它既没说是哪个环境、也没说什么时候录的,reviewer 三个月后完全无法判断这份
 * fixture 还代表不代表真实服务端。structured 之后至少 environment / capturedAt
 * 两段是必填且可校验的(capturedAt 必须是真日期)。
 *
 * 返回 problems 数组(以 'capturedFrom' 开头,调用方自行加 path 前缀)。
 */
export function validateCapturedFrom(capturedFrom) {
  if (capturedFrom === undefined || capturedFrom === null) {
    return ['capturedFrom 必填(sourceKind=fixture):结构化对象 { environment, capturedAt[, endpoint, note] }'];
  }
  if (typeof capturedFrom === 'string') {
    return [
      'capturedFrom 不接受自由文本(旧写法已下线):改成结构化对象 ' +
        '{ environment: "公司沙盒", capturedAt: "2026-07-30", endpoint: "GET /api/providers" }',
    ];
  }
  if (typeof capturedFrom !== 'object' || Array.isArray(capturedFrom)) {
    return ['capturedFrom 必须是对象 { environment, capturedAt[, endpoint, note] }'];
  }
  const problems = [];
  for (const key of ['environment', 'capturedAt']) {
    if (typeof capturedFrom[key] !== 'string' || !capturedFrom[key].trim()) problems.push(`capturedFrom.${key} 必填非空 string`);
  }
  const at = typeof capturedFrom.capturedAt === 'string' ? capturedFrom.capturedAt.trim() : '';
  if (at) {
    if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(at)) problems.push(`capturedFrom.capturedAt 必须以 ISO 日期开头(YYYY-MM-DD),当前 "${at}"`);
    else if (Number.isNaN(Date.parse(at.slice(0, 10)))) problems.push(`capturedFrom.capturedAt 不是真实日期:"${at}"`);
  }
  for (const key of ['endpoint', 'note']) {
    if (capturedFrom[key] !== undefined && (typeof capturedFrom[key] !== 'string' || !capturedFrom[key].trim()))
      problems.push(`capturedFrom.${key} 必须是非空 string`);
  }
  for (const key of Object.keys(capturedFrom)) {
    if (!CAPTURED_FROM_KEYS.includes(key)) problems.push(`capturedFrom.${key} 不是支持的字段(${CAPTURED_FROM_KEYS.join('/')})`);
  }
  return problems;
}

/**
 * 校验「叶子 value ≡ fixture 文件里 locator 指向的值」。fixtureAbs 须已确认存在。
 * 返回 problems 数组(空 = 绑定成立)。
 */
export function validateFixtureValueBinding(value, fixtureAbs, locator) {
  const segs = parseFixtureLocator(locator);
  if (!segs) return [`locator 必须是可机械解析的${FIXTURE_LOCATOR_SYNTAX};自由文本不接受(当前 ${JSON.stringify(locator)})`];
  let json;
  try {
    json = JSON.parse(readFileSync(fixtureAbs, 'utf8'));
  } catch (err) {
    return [`fixture 不是合法 JSON,无法核对 locator 指向的值:${err.message}`];
  }
  const hit = resolveFixtureLocator(json, segs);
  if (!hit.ok) return [`locator "${locator}" 在 fixture 里定位失败:${hit.reason}`];
  if (canonicalJson(hit.value) !== canonicalJson(value)) {
    return [
      `value 与 fixture 不符:locator "${locator}" 指向 ${canonicalJson(hit.value)},` +
        `叶子写的是 ${canonicalJson(value)}——fixture 叶子的值必须来自 fixture 本身,不能手打`,
    ];
  }
  return [];
}

/**
 * 服务端驱动数据的叶子工厂:值来自**录制的服务端响应**(providers 配置、account
 * memberships 等源码里没有字面量的数据)。产出 provenance.sourceKind='fixture',
 * 并强制结构化 capturedFrom——诚实声明"这不是源码溯源",而不是假装是。
 *
 * 硬约束(与 validateProvenance 同口径同代码,这里提前抛以便 extract 作者立刻看到):
 *   - locator 必须是受限 JSON 路径,且在 fixture 里能定位到与 value canonical-equal 的值;
 *   - capturedFrom 必须是结构化对象 { environment, capturedAt[, endpoint, note] };
 *   - fixtureFile 必须存在,且落在 demo 内 `fixtures/` 下(随 PR 走、reviewer 能打开)。
 *
 * 边界(诚实声明):本工具能证明"这个值确实来自这份 fixture",**不能**证明"这个值
 * 本来可以从源码提取却偷懒用了 fixture"——后者没有机械判据,属人工审查项。
 *
 * @param value 从 fixture 里读出的值
 * @param fixtureFile fixture 文件路径(绝对或相对 demoDir),须为 demo 内 fixtures/<name>.json
 * @param opts.locator 必填:该值在 fixture 中的 JSON 路径(如 'data.0.displayName')
 * @param opts.capturedFrom 必填:{ environment, capturedAt[, endpoint, note] }
 * @param opts.demoDir 默认 process.cwd()
 */
export function makeFixtureLeaf(value, fixtureFile, { locator, capturedFrom, demoDir = process.cwd() } = {}) {
  if (!locator || typeof locator !== 'string') {
    throw new Error(`makeFixtureLeaf(${JSON.stringify(value)}): 必须写 locator——该值在 fixture 里的 JSON 路径`);
  }
  const cfProblems = validateCapturedFrom(capturedFrom);
  if (cfProblems.length) throw new Error(`makeFixtureLeaf(${JSON.stringify(value)}): ${cfProblems.join(';')}`);
  const abs = isAbsolute(fixtureFile) ? fixtureFile : resolve(demoDir, fixtureFile);
  if (!existsSync(abs)) throw new Error(`makeFixtureLeaf: fixture 文件不存在:${abs}`);
  const rel = relative(demoDir, abs).split('\\').join('/');
  if (!rel || rel === '..' || rel.startsWith('../')) {
    throw new Error(`makeFixtureLeaf: fixture 必须放 demo 目录内(当前 ${abs} 在 demo 外,随 PR 走不了)`);
  }
  if (!rel.startsWith('fixtures/')) {
    throw new Error(`makeFixtureLeaf: fixture 必须放 demo 内 fixtures/ 下(当前 ${rel})`);
  }
  const bindProblems = validateFixtureValueBinding(value, abs, locator);
  if (bindProblems.length) throw new Error(`makeFixtureLeaf: ${bindProblems.join(';')}`);
  const cf = { environment: capturedFrom.environment.trim(), capturedAt: capturedFrom.capturedAt.trim() };
  if (capturedFrom.endpoint !== undefined) cf.endpoint = capturedFrom.endpoint.trim();
  if (capturedFrom.note !== undefined) cf.note = capturedFrom.note.trim();
  return {
    value,
    provenance: { source: rel, sourceKind: 'fixture', locator, capturedFrom: cf, hash: sha256File(abs) },
  };
}

/** 从正则捕获组提取源文件中的值(常见「读常量」场景的一步到位封装)。 */
export function extractByPattern(sourceFile, pattern, { locator, demoDir = process.cwd(), transform } = {}) {
  const abs = isAbsolute(sourceFile) ? sourceFile : resolve(demoDir, sourceFile);
  const content = readFileSync(abs, 'utf8');
  const matches = [...content.matchAll(new RegExp(pattern, 'g'))];
  if (matches.length !== 1) throw new Error(`extractByPattern: ${pattern} 在 ${abs} 命中 ${matches.length} 次(必须恰 1 次)`);
  if (matches[0].length !== 2) throw new Error(`extractByPattern: ${pattern} 必须恰含一个捕获组`);
  const raw = matches[0][1];
  return makeLeaf(transform ? transform(raw) : raw, abs, {
    locator: locator ?? `正则 ${pattern}`,
    locatorPattern: pattern,
    demoDir,
  });
}

export function resolveFrom(name, startDirs) {
  const attempts = [];
  for (const dir of startDirs.filter(Boolean)) {
    try {
      return createRequire(join(resolve(dir), 'package.json')).resolve(name);
    } catch (err) {
      attempts.push(`${dir}: ${err.message}`);
    }
  }
  throw new Error(`无法解析模块 ${name}(在产品仓装了吗?)\n${attempts.join('\n')}`);
}

/**
 * esbuild 临时编译 TS 模块后 import——门 F 的 oracle 必须是产品布局公式本身,
 * 不许在 extract 里手抄公式(抄错两边同错 = 假绿)。esbuild 从产品仓 node_modules 解析。
 */
export async function importTsModule(tsFile, { repoRoot } = {}) {
  const abs = resolve(tsFile);
  if (!existsSync(abs)) throw new Error(`importTsModule: 文件不存在:${abs}`);
  const root = repoRoot ?? findRepoRoot(dirname(abs));
  // 候选链不放 process.cwd():cwd 可能是 demo 目录(不可信侧),
  // 命中 <demo>/node_modules/esbuild 就是任意代码执行(审核 r4 CRITICAL)。
  const esbuildPath = resolveFrom('esbuild', [process.env.QA_HIFI_MODULE_ROOT, root]);
  const esbuildMod = await import(pathToFileURL(esbuildPath).href);
  const esbuild = esbuildMod.default?.build ? esbuildMod.default : esbuildMod;
  const result = await esbuild.build({
    entryPoints: [abs],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        // 只允许打进相对导入的纯函数依赖;裸导入(react 等)一律 external——
        // oracle 应是纯计算模块,拖进 UI 依赖说明选错了提取对象
        name: 'externalize-bare',
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => (isBuiltin(args.path) ? undefined : { path: args.path, external: true }));
        },
      },
    ],
  });
  const outFile = join(mkdtempSync(join(tmpdir(), 'qa-hifi-ts-')), 'mod.mjs');
  writeFileSync(outFile, result.outputFiles[0].text);
  return import(pathToFileURL(outFile).href);
}

/* ────────────────────────────────────────────────────────────────────────────
   主题桥:registerColor 全表 → 带 provenance 的 truth 叶子

   组件模式(直接渲染产品组件)下 demo 需要一份 CSS 自定义属性表来复刻产品主题。
   spike 阶段是在 build 脚本里就地正则一把梭;产品化后必须走 truth 叶子——否则
   色值进了 demo 却不在 truth.json 里,门 A 的防伪链(provenance + extractor-drift)
   管不到它,改了产品色表也没人报警。

   语义与 themes/theme-service.ts 的 resolveThemeValue 对齐:
     · light 有值 → 用 light;
     · dark 有值 → 用 dark;dark 为 null/未写 → 回退 light(历史 :root-only token 的级联)。
   ──────────────────────────────────────────────────────────────────────────── */

const REGISTER_COLOR_HEAD = /registerColor\(\s*(['"])((?:[^'"\\]|\\.)*?)\1\s*,\s*\{/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 `{` 开始找配平的 `}`,跳过字符串/模板/注释。返回 {body, endIdx} 或 null(未配平)。 */
function scanBraceBlock(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      for (let j = i + 1; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === c) { i = j; break; }
        if (j === src.length - 1) return null;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(openIdx + 1, i), endIdx: i };
    }
  }
  return null;
}

const JS_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

function unescapeJs(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc) => {
    if (esc[0] === 'u' || esc[0] === 'x') {
      const hex = esc[1] === '{' ? esc.slice(2, -1) : esc.slice(1);
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    return Object.hasOwn(JS_ESCAPES, esc) ? JS_ESCAPES[esc] : esc;
  });
}

/** 从 openIdx 处的引号跳到闭合引号,返回闭合引号之后的下标(未闭合返回 src.length)。 */
function skipStringLiteral(src, openIdx) {
  const q = src[openIdx];
  for (let j = openIdx + 1; j < src.length; j += 1) {
    if (src[j] === '\\') { j += 1; continue; }
    if (src[j] === q) return j + 1;
  }
  return src.length;
}

/**
 * 词法化扫描对象体,列出**顶层**属性的「值起始下标」。
 *
 * 审核 P1 #4 的根因:旧实现用裸正则 `(?:^|[,{\s])light\s*:` 在 body 上找键,body 里
 * 的注释原样保留,于是 `// light: '#stale'` 这行注释会被当成真属性命中,过时色值
 * 直接进 truth 且 provenance 全绿(hash 对得上,因为文件确实没改)。
 *
 * 本函数按字符走:注释整段跳过、字符串/模板整段跳过、只在 depth===0 记录属性,
 * 因此注释里的伪属性、嵌套对象里的同名属性都不会被误当成 defaults 的顶层属性。
 * 返回 Map<键名, 值起始下标>(同名键取第一个,与 JS 对象字面量后者覆盖前者不同——
 * 源码里真出现重复键属于异常,取第一个后值比对/pattern 自检会把问题暴露出来)。
 */
function scanTopLevelProps(body) {
  const props = new Map();
  let depth = 0;
  let i = 0;
  const remember = (name, colonIdx) => {
    let v = colonIdx + 1;
    while (v < body.length && /\s/.test(body[v])) v += 1;
    if (!props.has(name)) props.set(name, v);
  };
  const colonAfter = (from) => {
    let k = from;
    while (k < body.length && /\s/.test(body[k])) k += 1;
    return body[k] === ':' ? k : -1;
  };
  while (i < body.length) {
    const c = body[i];
    if (c === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i);
      i = nl === -1 ? body.length : nl + 1;
      continue;
    }
    if (c === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      i = end === -1 ? body.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const after = skipStringLiteral(body, i);
      // 带引号的键:`'light': '#fff'` —— 字符串后紧跟 ':' 才算键,否则是个值
      if (depth === 0) {
        const colon = colonAfter(after);
        if (colon !== -1) remember(unescapeJs(body.slice(i + 1, after - 1)), colon);
      }
      i = after;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') { depth += 1; i += 1; continue; }
    if (c === '}' || c === ']' || c === ')') { depth -= 1; i += 1; continue; }
    if (depth === 0 && /[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < body.length && /[A-Za-z0-9_$]/.test(body[j])) j += 1;
      const colon = colonAfter(j);
      if (colon !== -1) remember(body.slice(i, j), colon);
      i = j;
      continue;
    }
    i += 1;
  }
  return props;
}

/**
 * 读 defaults 对象体里某个**顶层**模式键的值。返回:
 *   { kind: 'string', raw, value, quote, valueIdx } | { kind: 'null' } | { kind: 'absent' }
 *   | { kind: 'unresolvable' }(函数调用 / 变量 / 带插值的模板字面量 —— 静态提取不了)
 * valueIdx = 值在 body 内的起始下标(调用方加 body 偏移即得源码绝对位置,供 pattern 自检)。
 */
function readModeValue(body, key, props = scanTopLevelProps(body)) {
  if (!props.has(key)) return { kind: 'absent' };
  let i = props.get(key);
  const valueIdx = i;
  const q = body[i];
  if (q === "'" || q === '"' || q === '`') {
    let raw = '';
    for (let j = i + 1; j < body.length; j++) {
      const c = body[j];
      if (c === '\\') { raw += c + (body[j + 1] ?? ''); j++; continue; }
      if (c === q) return { kind: 'string', raw, value: unescapeJs(raw), quote: q, valueIdx };
      // 模板插值 = 运行期求值,静态提取不了
      if (q === '`' && c === '$' && body[j + 1] === '{') return { kind: 'unresolvable' };
      raw += c;
    }
    return { kind: 'unresolvable' };
  }
  if (/^null\b/.test(body.slice(i))) return { kind: 'null' };
  return { kind: 'unresolvable' };
}

/**
 * 生成「该 token 该模式」的 writeback 定位锚:恰含一个捕获组、在整个 colors.ts 里恰命中
 * 一次的正则。`(?:(?!registerColor\()[\s\S])*?` 保证不越界到下一个 registerColor 调用。
 * 生成后自检(命中次数 + 捕获内容 == 源码原文 + 捕获位置 == 词法扫描定位到的真值位置),
 * 不达标就返回 null —— 宁可退化成「无机械写回通道」(writeback 会明确拒绝并要求 agent
 * 双改),也不给一个会写错位置的锚。
 *
 * 位置自检是 #4 修复的一部分:正则本身不懂注释,`// light:'#x'` 里的伪属性同样会被它
 * 命中。只要注释里的值恰好与真值同字面量,次数/内容自检就都过得去,锚却指向注释——
 * writeback 会把改动写进注释里。要求捕获位置与词法位置一致才能彻底排除这种错位。
 */
function makeModePattern(src, id, key, expectedRaw, absValueIdx) {
  const pattern =
    String.raw`registerColor\(\s*['"]${escapeRe(id)}['"]` +
    String.raw`(?:(?!registerColor\()[\s\S])*?\b${key}\s*:\s*['"]([^'"]*)['"]`;
  let hits;
  try {
    hits = [...src.matchAll(new RegExp(pattern, 'g'))];
  } catch {
    return null;
  }
  if (hits.length !== 1 || hits[0][1] !== expectedRaw) return null;
  // 捕获组紧跟在开引号之后:pattern 尾部固定为 ['"]([^'"]*)['"],故 groupStart = matchEnd - 1 - raw.length
  const groupStart = hits[0].index + hits[0][0].length - 1 - expectedRaw.length;
  if (Number.isInteger(absValueIdx) && groupStart !== absValueIdx + 1) return null;
  return pattern;
}

/**
 * 提取 `themes/colors.ts` 的 registerColor 全表为 truth 子树。
 *
 *   truth.themeVars = extractThemeVars(colorsFile, { demoDir });
 *   // → { 'surface': { light: <leaf>, dark: <leaf> }, 'surface-hsl': {...}, ... }
 *
 * 每个叶子是 makeLeaf() 的产物(value = CSS 值字符串,provenance.source = colors.ts,
 * locator 写明 token 名与模式)。light/dark 各自可机械写回时带 locatorPattern;
 * dark 回退 light 的叶子不带锚(它在源码里没有对应字面量,给锚只会写错位置)。
 *
 * 跳过的 token(light 非字面量、或 dark 是非字面量表达式)不进结果:静态提取拿不到
 * 真值,硬塞一个猜的值等于往 truth 里注假。跳过项通过 onSkip 回调交出;没给回调时
 * 打一条 stderr 汇总——不静默。
 *
 * @param colorsFile 产品 colors.ts 路径(绝对,或相对 demoDir)
 * @param opts.prefix 只要 id 以此开头的 token(如 'login-');缺省全量
 * @param opts.demoDir 默认 process.cwd()(truth.mjs 保证 = demo 目录)
 * @param opts.onSkip (skipped) => void,skipped = [{ id, mode, reason }]
 */
export function extractThemeVars(colorsFile, { prefix, demoDir = process.cwd(), onSkip } = {}) {
  const abs = isAbsolute(colorsFile) ? colorsFile : resolve(demoDir, colorsFile);
  if (!existsSync(abs)) throw new Error(`extractThemeVars: 源文件不存在:${abs}`);
  const src = readFileSync(abs, 'utf8');

  const out = Object.create(null);   // r12:key 是产品源码里的 color id,同一形状
  const skipped = [];
  let scanned = 0;
  REGISTER_COLOR_HEAD.lastIndex = 0;
  for (const head of src.matchAll(REGISTER_COLOR_HEAD)) {
    scanned++;
    const id = unescapeJs(head[2]);
    const openIdx = head.index + head[0].length - 1;
    const block = scanBraceBlock(src, openIdx);
    if (!block) {
      skipped.push({ id, mode: 'both', reason: 'defaults 对象大括号未配平(源码语法异常?)' });
      continue;
    }
    if (prefix && !id.startsWith(prefix)) continue;
    if (Object.hasOwn(out, id)) {
      throw new Error(`extractThemeVars: token '${id}' 在 ${abs} 里注册了两次——产品侧 ColorRegistry 会直接抛错,先修源码`);
    }

    // 词法扫描一次,light/dark 共用——注释里的伪属性在这一步就被排除(审核 P1 #4)
    const props = scanTopLevelProps(block.body);
    const bodyOffset = openIdx + 1; // block.body 在 src 中的起始位置
    const light = readModeValue(block.body, 'light', props);
    const dark = readModeValue(block.body, 'dark', props);
    if (light.kind !== 'string') {
      skipped.push({
        id,
        mode: 'light',
        reason: light.kind === 'null' || light.kind === 'absent'
          ? 'light 为 null/未写(该 token 在 light 下无值)'
          : 'light 是非字面量表达式(函数调用/变量/模板插值),静态提取不到真值',
      });
      continue;
    }
    if (dark.kind === 'unresolvable') {
      skipped.push({ id, mode: 'dark', reason: 'dark 是非字面量表达式,静态提取不到真值(不敢回退 light,那会写进假值)' });
      continue;
    }

    const lightPattern = makeModePattern(src, id, 'light', light.raw, bodyOffset + light.valueIdx);
    const lightLeaf = makeLeaf(light.value, abs, {
      locator: `colors.ts registerColor('${id}') 的 defaults.light`,
      ...(lightPattern ? { locatorPattern: lightPattern } : {}),
      demoDir,
    });

    let darkLeaf;
    if (dark.kind === 'string') {
      const darkPattern = makeModePattern(src, id, 'dark', dark.raw, bodyOffset + dark.valueIdx);
      darkLeaf = makeLeaf(dark.value, abs, {
        locator: `colors.ts registerColor('${id}') 的 defaults.dark`,
        ...(darkPattern ? { locatorPattern: darkPattern } : {}),
        demoDir,
      });
    } else {
      // dark: null / 未写 → theme-service.resolveThemeValue 回退 light(旧 :root-only 级联)
      darkLeaf = makeLeaf(light.value, abs, {
        locator: `colors.ts registerColor('${id}') 的 defaults.dark 为 null/未写,按 theme-service.resolveThemeValue 回退 light`,
        demoDir,
      });
    }

    out[id] = { light: lightLeaf, dark: darkLeaf };
  }

  if (scanned === 0) {
    throw new Error(`extractThemeVars: 在 ${abs} 里一个 registerColor(...) 都没匹配到——源码格式变了,先修本函数的解析再跑`);
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      `extractThemeVars: ${abs} 扫到 ${scanned} 个 registerColor,但${prefix ? ` prefix='${prefix}' 过滤后` : ''}一个可用 token 都没有`,
    );
  }
  if (skipped.length) {
    if (onSkip) onSkip(skipped);
    else console.warn(`[extractThemeVars] 跳过 ${skipped.length} 个 token:${skipped.map((s) => `${s.id}(${s.mode})`).join(', ')}`);
  }
  return out;
}
