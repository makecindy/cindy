/**
 * 代码块语法着色的轻量词法分析器。
 *
 * **为什么不用 highlight.js**:`apps/mobile/package.json` 的依赖是 runtime
 * fingerprint 输入,加一个高亮库会触发冷更 —— 存量装机拿不到本次及后续热更,
 * 代价与技术框架变动同级(见 docs/dev-rules/mobile-development.md)。为了纯观感
 * 需求付这个代价不值,所以词法在仓内自己做:本文件是 `src/` 源码,不进依赖表,
 * 指纹不变。
 *
 * 因此它**刻意不追求 hljs 的精确度**,只覆盖"扫一眼能看出结构"所需的 6 类:
 * 注释 / 字符串 / 数字 / 关键字 / 函数名 / 属性名。语言未知或不在表内时退化为
 * 通用词法(仍能高亮字符串、数字与 `//`、`#` 注释),不会整块变纯文本。
 *
 * 属性名(`key:` 形态)这一类是必须有的:配置、样式对象、YAML、JSON 这类内容里
 * 属性名占绝大多数,少了它们整块几乎全是 plain —— 桌面 hljs 把它们归入 `attr`
 * 并着蓝色,是那类代码块最主要的视觉信号。
 *
 * 输出与颜色解耦:只给 kind,配色由 theme 的 syntax* token 决定(对齐桌面所用的
 * GitHub highlight.js 主题)。
 */

export type CodeTokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  /** `key:` 形态的属性名 / 字段名(对齐 hljs 的 attr,GitHub 主题着蓝)。 */
  | 'property';

export interface CodeToken {
  readonly text: string;
  readonly kind: CodeTokenKind;
}

/** 注释与字符串的语法家族 —— 决定用哪套定界符扫描。 */
type SyntaxFamily = 'c' | 'hash' | 'sql' | 'css' | 'markup' | 'json' | 'generic';

const C_KEYWORDS = [
  'abstract', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'char', 'class',
  'const', 'constructor', 'continue', 'debugger', 'declare', 'default', 'delete', 'do',
  'double', 'else', 'enum', 'export', 'extends', 'false', 'final', 'finally', 'float', 'for',
  'from', 'function', 'get', 'goto', 'if', 'implements', 'import', 'in', 'instanceof', 'int',
  'interface', 'is', 'let', 'long', 'namespace', 'new', 'null', 'of', 'override', 'package',
  'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static',
  'struct', 'super', 'switch', 'this', 'throw', 'throws', 'true', 'try', 'type', 'typeof',
  'undefined', 'union', 'unsigned', 'var', 'void', 'while', 'with', 'yield',
];

const GO_KEYWORDS = [
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
  'false', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'nil', 'package',
  'range', 'return', 'select', 'struct', 'switch', 'true', 'type', 'var',
];

const RUST_KEYWORDS = [
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
  'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move',
  'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type',
  'unsafe', 'use', 'where', 'while',
];

const PYTHON_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try',
  'while', 'with', 'yield',
];

const SHELL_KEYWORDS = [
  'case', 'cd', 'do', 'done', 'echo', 'elif', 'else', 'esac', 'exit', 'export', 'fi', 'for',
  'function', 'if', 'in', 'local', 'return', 'set', 'source', 'then', 'unset', 'until',
  'while',
];

const SQL_KEYWORDS = [
  'and', 'alter', 'as', 'asc', 'by', 'case', 'create', 'delete', 'desc', 'distinct', 'drop',
  'else', 'end', 'exists', 'from', 'group', 'having', 'in', 'index', 'inner', 'insert',
  'into', 'is', 'join', 'left', 'like', 'limit', 'not', 'null', 'offset', 'on', 'or', 'order',
  'outer', 'primary', 'select', 'set', 'table', 'then', 'union', 'update', 'values', 'when',
  'where', 'with',
];

const RUBY_KEYWORDS = [
  'begin', 'break', 'case', 'class', 'def', 'do', 'else', 'elsif', 'end', 'ensure', 'false',
  'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'require', 'rescue', 'return',
  'self', 'then', 'true', 'unless', 'until', 'when', 'while', 'yield',
];

const YAML_KEYWORDS = ['false', 'no', 'null', 'true', 'yes'];

interface LanguageSpec {
  readonly family: SyntaxFamily;
  readonly keywords: readonly string[];
  /** 关键字是否区分大小写(SQL 惯例大写,故不区分)。 */
  readonly caseSensitive?: boolean;
}

const C_LIKE: LanguageSpec = { family: 'c', keywords: C_KEYWORDS, caseSensitive: true };

/** 语言别名 → 规格。键一律小写。 */
const LANGUAGES: Readonly<Record<string, LanguageSpec>> = {
  bash: { family: 'hash', keywords: SHELL_KEYWORDS, caseSensitive: true },
  c: C_LIKE,
  'c++': C_LIKE,
  cjs: C_LIKE,
  cpp: C_LIKE,
  cs: C_LIKE,
  csharp: C_LIKE,
  css: { family: 'css', keywords: [], caseSensitive: false },
  dart: C_LIKE,
  go: { family: 'c', keywords: GO_KEYWORDS, caseSensitive: true },
  golang: { family: 'c', keywords: GO_KEYWORDS, caseSensitive: true },
  html: { family: 'markup', keywords: [], caseSensitive: false },
  java: C_LIKE,
  javascript: C_LIKE,
  js: C_LIKE,
  json: { family: 'json', keywords: ['false', 'null', 'true'], caseSensitive: true },
  json5: { family: 'c', keywords: ['false', 'null', 'true'], caseSensitive: true },
  jsonc: { family: 'c', keywords: ['false', 'null', 'true'], caseSensitive: true },
  jsx: C_LIKE,
  kotlin: C_LIKE,
  kt: C_LIKE,
  mjs: C_LIKE,
  mysql: { family: 'sql', keywords: SQL_KEYWORDS, caseSensitive: false },
  php: { family: 'c', keywords: C_KEYWORDS, caseSensitive: true },
  postgres: { family: 'sql', keywords: SQL_KEYWORDS, caseSensitive: false },
  psql: { family: 'sql', keywords: SQL_KEYWORDS, caseSensitive: false },
  py: { family: 'hash', keywords: PYTHON_KEYWORDS, caseSensitive: true },
  python: { family: 'hash', keywords: PYTHON_KEYWORDS, caseSensitive: true },
  rb: { family: 'hash', keywords: RUBY_KEYWORDS, caseSensitive: true },
  ruby: { family: 'hash', keywords: RUBY_KEYWORDS, caseSensitive: true },
  rs: { family: 'c', keywords: RUST_KEYWORDS, caseSensitive: true },
  rust: { family: 'c', keywords: RUST_KEYWORDS, caseSensitive: true },
  scala: C_LIKE,
  scss: { family: 'css', keywords: [], caseSensitive: false },
  sh: { family: 'hash', keywords: SHELL_KEYWORDS, caseSensitive: true },
  shell: { family: 'hash', keywords: SHELL_KEYWORDS, caseSensitive: true },
  sql: { family: 'sql', keywords: SQL_KEYWORDS, caseSensitive: false },
  sqlite: { family: 'sql', keywords: SQL_KEYWORDS, caseSensitive: false },
  svelte: { family: 'markup', keywords: [], caseSensitive: false },
  swift: C_LIKE,
  toml: { family: 'hash', keywords: YAML_KEYWORDS, caseSensitive: true },
  ts: C_LIKE,
  tsx: C_LIKE,
  typescript: C_LIKE,
  vue: { family: 'markup', keywords: [], caseSensitive: false },
  xml: { family: 'markup', keywords: [], caseSensitive: false },
  yaml: { family: 'hash', keywords: YAML_KEYWORDS, caseSensitive: true },
  yml: { family: 'hash', keywords: YAML_KEYWORDS, caseSensitive: true },
  zsh: { family: 'hash', keywords: SHELL_KEYWORDS, caseSensitive: true },
};

const GENERIC_SPEC: LanguageSpec = { family: 'generic', keywords: [], caseSensitive: true };

/** 未知语言退化为通用词法(仍高亮字符串 / 数字 / `//` 与 `#` 注释)。 */
function resolveSpec(language: string | undefined): LanguageSpec {
  if (!language) return GENERIC_SPEC;
  const key = language.trim().toLowerCase();
  return LANGUAGES[key] ?? GENERIC_SPEC;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_BODY = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * 着色预算 —— 超出就退回纯文本(整块或剩余部分并成一个 plain token)。
 *
 * 这不是性能洁癖,是渲染层的硬约束:每个非 plain token 在聊天流都会变成一个嵌套
 * 原生 Text(iOS 的 selectable 路径上是 UITextView 家族子节点),外层横向 ScrollView
 * **不做虚拟化**,所以挂载成本直接等于 token 数;而流式输出期间整块会随每个 chunk
 * 重新分词并重新挂载。一个几千行的日志或生成文件因此能同步挂出上万个原生节点,
 * 卡住 JS / UI 线程。
 *
 * 超预算时退回的正是**本 PR 之前的形态** —— 纯文本代码块,底色与描边都还在,不是
 * 不显示。而且屏幕上本来也只看得见几十行,超过这个量级的着色没有可感知收益。
 *
 * 两个维度都要卡:`maxSource` 挡住长块(连分词都不做),`maxTokens` 挡住"短但 token
 * 极密"的病态输入(比如一行几千个 `a:1,b:2,…`)。
 */
export const CODE_HIGHLIGHT_LIMITS = {
  maxSource: 20_000,
  maxTokens: 2_000,
} as const;

/** 整块退回纯文本。空串保持返回空数组(与主路径一致)。 */
function plainOnly(source: string): CodeToken[] {
  return source ? [{ text: source, kind: 'plain' }] : [];
}

/**
 * 把源码切成带 kind 的 token 序列。
 *
 * 单趟扫描,优先级:注释 > 字符串 > 数字 > 标识符。相邻同 kind 的片段会合并,
 * 减少渲染层要创建的 Text 节点数。超出 CODE_HIGHLIGHT_LIMITS 时退回纯文本。
 *
 * 无论走哪条分支,输出重新拼接后必须与输入逐字节相等(由测试的 assertLossless 守卫)。
 */
export function tokenizeCode(source: string, language?: string): CodeToken[] {
  // 长块直接退回:流式期间每个 chunk 都会重跑本函数,所以这里连分词都不做。
  if (source.length > CODE_HIGHLIGHT_LIMITS.maxSource) return plainOnly(source);

  const spec = resolveSpec(language);
  const keywords = new Set(
    spec.caseSensitive === false ? spec.keywords.map((w) => w.toLowerCase()) : spec.keywords,
  );
  const out: CodeToken[] = [];
  let plain = '';

  const flush = () => {
    if (plain) {
      out.push({ text: plain, kind: 'plain' });
      plain = '';
    }
  };
  const push = (text: string, kind: CodeTokenKind) => {
    if (!text) return;
    flush();
    const last = out[out.length - 1];
    if (last && last.kind === kind) out[out.length - 1] = { text: last.text + text, kind };
    else out.push({ text, kind });
  };

  const { family } = spec;
  const lineComment = family === 'c' ? '//' : family === 'hash' ? '#' : family === 'sql' ? '--' : family === 'generic' ? null : null;
  // json5 / jsonc 的 family 已经是 'c',由第一个分支覆盖,不单列。
  const blockComment = family === 'c' || family === 'css' || family === 'sql'
    ? (['/*', '*/'] as const)
    : family === 'markup'
      ? (['<!--', '-->'] as const)
      : null;

  // 行注释起始符:generic 家族同时认 `//` 与 `#`,尽量别把注释染成正文。
  // 与 lineComment / blockComment 一样是循环不变量,必须在循环外算 —— 放进循环
  // 等于每个字符都新建一个数组。
  const lineStarts = lineComment
    ? [lineComment]
    : family === 'generic'
      ? ['//', '#']
      : [];

  let i = 0;
  while (i < source.length) {
    // token 预算用尽:剩余源码整段并入 plain 收尾(仍然无损)。
    // 计数要带上还没 flush 的 plain,否则一轮里 flush() + push() 会连推两个 token,
    // 上界变成 maxTokens + 2。带上之后每轮"有效 token 数"最多 +1,收口后 out 至多
    // 为 maxTokens + 1(那个 +1 是收尾的 plain)。
    if (out.length + (plain ? 1 : 0) >= CODE_HIGHLIGHT_LIMITS.maxTokens) {
      plain += source.slice(i);
      break;
    }

    // 前缀判定一律用 source.startsWith(mark, i),不要先 source.slice(i) 再判。
    // 澄清一个容易想当然的点:slice 在 V8 里返回 SlicedString(O(1) 引用,不拷贝
    // 字符),所以它**不是** O(n²) —— 实测 20k 字符 0.6ms vs 0.3ms、1MB 3.4ms vs
    // 1.3ms,只是 2~3x 常数因子加一堆短命对象。之所以还是照改:同等正确、更快、
    // 更少垃圾,而这段是同步跑在渲染路径上。真正的规模保护是上面的 token 预算。
    // 块注释
    if (blockComment && source.startsWith(blockComment[0], i)) {
      const end = source.indexOf(blockComment[1], i + blockComment[0].length);
      const stop = end === -1 ? source.length : end + blockComment[1].length;
      push(source.slice(i, stop), 'comment');
      i = stop;
      continue;
    }
    // 行注释
    const hitLine = lineStarts.some((mark) => source.startsWith(mark, i));
    if (hitLine) {
      const nl = source.indexOf('\n', i);
      const stop = nl === -1 ? source.length : nl;
      push(source.slice(i, stop), 'comment');
      i = stop;
      continue;
    }
    // 字符串(未闭合时吃到行尾,避免整块串味)
    const ch = source[i];
    if (ch === '"' || ch === '\'' || ch === '`') {
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        const cj = source[j];
        if (cj === '\\') { j += 2; continue; }
        if (cj === ch) { closed = true; j += 1; break; }
        if (cj === '\n' && ch !== '`') break;
        j += 1;
      }
      const stop = closed ? j : Math.min(j, source.length);
      // 带引号的 key(JSON / JS 对象字面量)算属性名,不算普通字符串 —— 与 hljs
      // 把 JSON key 归到 attr 一致,否则 JSON 里键值同色、读不出结构。
      push(source.slice(i, stop), closed && isPropertyKey(source, stop) ? 'property' : 'string');
      i = stop;
      continue;
    }
    // 数字
    if (DIGIT.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9a-fA-FxXoObB_.]/.test(source[j])) j += 1;
      push(source.slice(i, j), 'number');
      i = j;
      continue;
    }
    // 标识符 → 关键字 / 函数名 / 普通
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < source.length && IDENT_BODY.test(source[j])) j += 1;
      const word = source.slice(i, j);
      const probe = spec.caseSensitive === false ? word.toLowerCase() : word;
      if (keywords.has(probe)) {
        push(word, 'keyword');
      } else if (isCallSite(source, j)) {
        push(word, 'function');
      } else if (isPropertyKey(source, j)) {
        push(word, 'property');
      } else {
        plain += word;
      }
      i = j;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

/** 标识符后跳过空格是否紧跟 `(` —— 粗略的函数名判定。 */
function isCallSite(source: string, from: number): boolean {
  let k = from;
  while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k += 1;
  return source[k] === '(';
}

/**
 * 标识符 / 字符串后跳过空格是否紧跟单个 `:` —— 粗略的属性名判定。
 *
 * 排除 `::`(C++ / Rust 作用域符)。三元表达式的 `a ? b : c` 会把 b 误判成属性名,
 * 这是刻意接受的误差:代价只是多一处蓝色,而正确覆盖对象/YAML/JSON 属性名的收益
 * 远大于此(要真正区分得做表达式级解析,那是 hljs 的量级)。
 */
function isPropertyKey(source: string, from: number): boolean {
  let k = from;
  while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k += 1;
  return source[k] === ':' && source[k + 1] !== ':';
}
