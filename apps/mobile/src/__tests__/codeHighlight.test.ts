import { describe, expect, it } from 'vitest';

import {
  CODE_HIGHLIGHT_LIMITS,
  tokenizeCode,
  type CodeToken,
  type CodeTokenKind,
} from '@/session/codeHighlight';

/** 取某 kind 的全部片段文本,便于断言"哪些东西被认成了什么"。 */
function kindTexts(tokens: readonly CodeToken[], kind: CodeTokenKind): string[] {
  return tokens.filter((t) => t.kind === kind).map((t) => t.text);
}

/** 词法不能吞字:拼回原文必须逐字节等于输入。 */
function assertLossless(source: string, language?: string): CodeToken[] {
  const tokens = tokenizeCode(source, language);
  expect(tokens.map((t) => t.text).join('')).toBe(source);
  return tokens;
}

describe('tokenizeCode · 无损与基本分类', () => {
  it('任何语言下拼回 token 都等于原文(不吞字、不重复)', () => {
    const samples: [string, string | undefined][] = [
      ['const a = 1; // hi', 'ts'],
      ['def f(x):\n    return x # c', 'python'],
      ['SELECT * FROM t WHERE a = 1 -- c', 'sql'],
      ['.a { color: red; /* c */ }', 'css'],
      ['<div class="x"><!-- c --></div>', 'html'],
      ['{"a": 1, "b": null}', 'json'],
      ['echo "hi" # c', 'bash'],
      ['无语言标注的文本 `x` 123', undefined],
      ['', 'ts'],
      ['\n\n', 'ts'],
    ];
    for (const [src, lang] of samples) assertLossless(src, lang);
  });

  it('js/ts:关键字、字符串、数字、注释、函数名各归其类', () => {
    const tokens = assertLossless(
      'const n = 42;\n// 说明\nfunction run(a) { return "s"; }',
      'ts',
    );
    expect(kindTexts(tokens, 'keyword')).toEqual(expect.arrayContaining(['const', 'function', 'return']));
    expect(kindTexts(tokens, 'number')).toContain('42');
    expect(kindTexts(tokens, 'comment')).toContain('// 说明');
    expect(kindTexts(tokens, 'string')).toContain('"s"');
    expect(kindTexts(tokens, 'function')).toContain('run');
  });

  it('块注释与未闭合块注释都吃到正确边界', () => {
    const closed = assertLossless('a /* c1 */ b', 'ts');
    expect(kindTexts(closed, 'comment')).toEqual(['/* c1 */']);
    const open = assertLossless('a /* 未闭合', 'ts');
    expect(kindTexts(open, 'comment')).toEqual(['/* 未闭合']);
  });

  it('未闭合的单/双引号只吃到行尾,不把后续整块染成字符串', () => {
    const tokens = assertLossless('a = "未闭合\nconst b = 1', 'ts');
    const strings = kindTexts(tokens, 'string');
    expect(strings).toEqual(['"未闭合']);
    // 下一行仍能正常识别关键字
    expect(kindTexts(tokens, 'keyword')).toContain('const');
  });

  it('模板字符串可以跨行', () => {
    const tokens = assertLossless('const t = `a\nb`;', 'ts');
    expect(kindTexts(tokens, 'string')).toEqual(['`a\nb`']);
  });

  it('转义引号不提前结束字符串', () => {
    const tokens = assertLossless('const s = "a\\"b";', 'ts');
    expect(kindTexts(tokens, 'string')).toEqual(['"a\\"b"']);
  });

  it('python / bash 用 # 行注释,而不是 //', () => {
    const py = assertLossless('x = 1 # 注释', 'python');
    expect(kindTexts(py, 'comment')).toEqual(['# 注释']);
    const sh = assertLossless('ls -al # 注释', 'bash');
    expect(kindTexts(sh, 'comment')).toEqual(['# 注释']);
  });

  it('sql 关键字大小写不敏感,用 -- 行注释', () => {
    const tokens = assertLossless('select A from T -- c', 'sql');
    expect(kindTexts(tokens, 'keyword')).toEqual(expect.arrayContaining(['select', 'from']));
    expect(kindTexts(tokens, 'comment')).toEqual(['-- c']);
  });

  it('json 不把 // 当注释(JSON 无注释语法),url 里的 // 也不吞', () => {
    const tokens = assertLossless('{"u": "http://a.com"}', 'json');
    expect(kindTexts(tokens, 'comment')).toEqual([]);
    // "u" 后紧跟 `:` → 属性名;值仍是 string(见「属性名」一组断言)。
    expect(kindTexts(tokens, 'property')).toEqual(['"u"']);
    expect(kindTexts(tokens, 'string')).toEqual(['"http://a.com"']);
  });

  it('未知语言退化为通用词法:仍认字符串 / 数字 / 注释', () => {
    const tokens = assertLossless('foo "bar" 12 # c', 'no-such-lang');
    expect(kindTexts(tokens, 'string')).toEqual(['"bar"']);
    expect(kindTexts(tokens, 'number')).toEqual(['12']);
    expect(kindTexts(tokens, 'comment')).toEqual(['# c']);
  });

  it('相邻同类片段被合并,不产生碎片节点', () => {
    const tokens = tokenizeCode('a b c d', 'ts');
    // 全是 plain,应合并成 1 个 token
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ text: 'a b c d', kind: 'plain' });
  });

  it('中文与 emoji 不被拆坏', () => {
    const src = 'const 名字 = "值 🎉"; // 说明';
    const tokens = assertLossless(src, 'ts');
    expect(kindTexts(tokens, 'string')).toEqual(['"值 🎉"']);
  });
});

describe('tokenizeCode · 属性名(hljs attr 对应类)', () => {
  it('对象字面量的裸 key 归为 property', () => {
    const tokens = assertLossless(
      'markdownInlineCode: {\n  fontFamily: monoFont,\n  fontSize: typeScale.code,\n}',
      'ts',
    );
    expect(kindTexts(tokens, 'property')).toEqual(
      expect.arrayContaining(['markdownInlineCode', 'fontFamily', 'fontSize']),
    );
    // 值侧的标识符不该被误染
    expect(kindTexts(tokens, 'property')).not.toContain('monoFont');
  });

  it('JSON 的带引号 key 归为 property,值仍是 string', () => {
    const tokens = assertLossless('{"name": "cindy", "n": 1}', 'json');
    expect(kindTexts(tokens, 'property')).toEqual(['"name"', '"n"']);
    expect(kindTexts(tokens, 'string')).toEqual(['"cindy"']);
    expect(kindTexts(tokens, 'number')).toEqual(['1']);
  });

  it('css 属性名与 yaml 键都归为 property', () => {
    const css = assertLossless('.a { color: red; }', 'css');
    expect(kindTexts(css, 'property')).toContain('color');
    const yaml = assertLossless('name: cindy\nport: 8081', 'yaml');
    expect(kindTexts(yaml, 'property')).toEqual(expect.arrayContaining(['name', 'port']));
  });

  it('`::` 作用域符不算属性名(Rust / C++)', () => {
    const tokens = assertLossless('std::vec::Vec', 'rust');
    expect(kindTexts(tokens, 'property')).toEqual([]);
  });

  it('关键字优先于属性名(switch 的 default:)', () => {
    const tokens = assertLossless('switch (x) { default: break; }', 'ts');
    expect(kindTexts(tokens, 'keyword')).toEqual(expect.arrayContaining(['switch', 'default', 'break']));
    expect(kindTexts(tokens, 'property')).toEqual([]);
  });
});

/**
 * 着色预算守护。
 *
 * 每个非 plain token 在聊天流都会变成一个嵌套原生 Text(iOS selectable 路径上是
 * UITextView 家族子节点),外层横向 ScrollView 不虚拟化,所以 token 数 = 挂载成本;
 * 流式期间整块还会随每个 chunk 重新分词并重新挂载。所以 token 数必须有上界,
 * 而不是"通常也不会那么长"。超预算时退回纯文本 —— 那正是本 PR 之前的形态。
 */
describe('tokenizeCode · 大代码块的着色预算', () => {
  it('超长源码整块退回单个 plain token(连分词都不做)', () => {
    const long = 'const a = 1; // c\n'.repeat(
      Math.ceil((CODE_HIGHLIGHT_LIMITS.maxSource + 1000) / 18),
    );
    expect(long.length).toBeGreaterThan(CODE_HIGHLIGHT_LIMITS.maxSource);

    const tokens = assertLossless(long, 'ts');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('plain');
  });

  it('刚好在长度预算内的源码仍然着色(阈值不过度保守)', () => {
    const unit = 'const a = 1;\n';
    const within = unit.repeat(Math.floor(CODE_HIGHLIGHT_LIMITS.maxSource / unit.length / 2));
    expect(within.length).toBeLessThanOrEqual(CODE_HIGHLIGHT_LIMITS.maxSource);

    const tokens = assertLossless(within, 'ts');
    expect(kindTexts(tokens, 'keyword').length).toBeGreaterThan(0);
  });

  it('token 极密的短源码按 token 数收口,剩余部分并成 plain', () => {
    // 每组 `a1:1,` 都产出 property + number 等多个 token,长度远小于 maxSource,
    // 靠 maxTokens 兜住。
    let dense = '';
    for (let n = 0; dense.length < CODE_HIGHLIGHT_LIMITS.maxSource - 20; n += 1) {
      dense += `a${n}:${n},`;
    }
    expect(dense.length).toBeLessThanOrEqual(CODE_HIGHLIGHT_LIMITS.maxSource);

    const tokens = assertLossless(dense, 'ts');
    // 收口后允许再多一个 plain 收尾 token。
    expect(tokens.length).toBeLessThanOrEqual(CODE_HIGHLIGHT_LIMITS.maxTokens + 1);
    expect(tokens[tokens.length - 1].kind).toBe('plain');
  });
});

/**
 * 源码级守护(不是纯函数测试):代码块的语法着色 span 必须经 `spanFor()` 取组件。
 *
 * 为什么值得单独守:块可选中且在 iOS 时,代码块外层是原生 UITextView,它只接受
 * UITextView 家族的子节点 —— 传普通 RN `Text` 会让所有着色 span **静默消失**
 * (代码里的属性名、关键字直接从画面上不见,不报错、不警告)。这类问题 typecheck
 * 与全部单测都抓不到,只有实机能发现(2026-07 实际踩过一次)。mobile 当前没有 RN
 * 组件渲染测试设施(引入需要新 devDependency,可能动 runtime fingerprint),因此
 * 退一步用源码断言兜住最关键的一条:调用点不许绕开 spanFor。
 */
describe('代码块着色 span 的取用方式(源码守护)', () => {
  it('HighlightedCodeText 的调用点必须用 spanFor(...) 提供 SpanComponent', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../session/MessageRenderer.tsx', import.meta.url));
    const src = await readFile(path, 'utf8');

    const callSites = src.match(/<HighlightedCodeText[\s\S]*?\/>/g) ?? [];
    expect(callSites.length, '找不到 HighlightedCodeText 的调用点(重构后请同步本测试)')
      .toBeGreaterThan(0);
    for (const site of callSites) {
      expect(site, 'SpanComponent 必须来自 spanFor(...),不能直接传 RN Text')
        .toMatch(/SpanComponent=\{spanFor\(/);
    }
  });
});
