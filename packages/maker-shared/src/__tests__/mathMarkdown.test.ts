import { describe, expect, it } from 'vitest';
import { latexToUnicodeApproximation, normalizeMathDelimiters, tokenizeInlineMath } from '../mathMarkdown.js';

describe('normalizeMathDelimiters', () => {
  it('无定界符时返回原引用(快速通路,保住下游缓存)', () => {
    const src = '普通文本,含 $5 货币和 `code`。';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('inline \\(...\\) → $...$', () => {
    expect(normalizeMathDelimiters('质能方程 \\(E=mc^2\\) 很有名')).toBe(
      '质能方程 $E=mc^2$ 很有名',
    );
  });

  it('inline 定界符内侧空白被 trim', () => {
    expect(normalizeMathDelimiters('\\( a+b \\)')).toBe('$a+b$');
  });

  it('单行 display \\[...\\] → 独立 $$ 块', () => {
    expect(normalizeMathDelimiters('结论:\\[E=mc^2\\]完毕')).toBe(
      '结论:\n\n$$\nE=mc^2\n$$\n\n完毕',
    );
  });

  it('多行 display(定界符各占一行)', () => {
    const src = '\\[\n\\int_0^1 x\\,dx = \\frac{1}{2}\n\\]';
    expect(normalizeMathDelimiters(src)).toBe(
      '\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n\n',
    );
  });

  it('display 内容里嵌套 \\(...\\) 不被二次转换', () => {
    const src = '\\[f\\(x\\) = 1\\]';
    expect(normalizeMathDelimiters(src)).toBe('\n\n$$\nf\\(x\\) = 1\n$$\n\n');
  });

  it('fenced code block 内的定界符原样保留', () => {
    const src = '前文 \\(a\\)\n```tex\n\\(raw\\) \\[raw\\]\n```\n后文 \\(b\\)';
    expect(normalizeMathDelimiters(src)).toBe(
      '前文 $a$\n```tex\n\\(raw\\) \\[raw\\]\n```\n后文 $b$',
    );
  });

  it('~~~ fence 同样跳过,且闭 fence 长度可更长', () => {
    const src = '~~~\n\\(raw\\)\n~~~~\n\\(x\\)';
    expect(normalizeMathDelimiters(src)).toBe('~~~\n\\(raw\\)\n~~~~\n$x$');
  });

  it('未闭合 fence(streaming 中途)内不转换', () => {
    const src = '```\n\\(raw\\)';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('inline code span 内的定界符原样保留', () => {
    const src = '用 `\\(x\\)` 语法写 \\(y\\)';
    expect(normalizeMathDelimiters(src)).toBe('用 `\\(x\\)` 语法写 $y$');
  });

  it('未闭合定界符(streaming 中途)不动', () => {
    const src = '推导:\\(E=mc^2';
    expect(normalizeMathDelimiters(src)).toBe(src);
    const src2 = '\\[\n\\int x dx';
    expect(normalizeMathDelimiters(src2)).toBe(src2);
  });

  it('空内容定界符不转换', () => {
    expect(normalizeMathDelimiters('\\(\\) 和 \\[\\]')).toBe('\\(\\) 和 \\[\\]');
  });

  it('同段多个公式全部转换', () => {
    expect(normalizeMathDelimiters('\\(a\\) 与 \\(b\\)')).toBe('$a$ 与 $b$');
  });

  it('keeps escaped literal delimiters and skips escaped closers', () => {
    expect(normalizeMathDelimiters(String.raw`\\(literal\\) and \(x\)`)).toBe(String.raw`\\(literal\\) and $x$`);
    expect(normalizeMathDelimiters(String.raw`\(a\\)b\)`)).toBe(String.raw`$a\\)b$`);
    expect(normalizeMathDelimiters(String.raw`\\[literal\\]`)).toBe(String.raw`\\[literal\\]`);
  });
});

describe('normalizeMathDelimiters — link destination 保护', () => {
  it('URL 里的转义括号不被当成定界符:[log](./run\\(1\\).md)', () => {
    const src = '看 [log](./run\\(1\\).md) 文件';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('URL 里的转义方括号同样保护', () => {
    const src = '![img](./a\\[1\\].png)';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('link 前后的公式照常转换', () => {
    expect(normalizeMathDelimiters('\\(a\\) [x](./p\\(1\\).md) \\(b\\)')).toBe(
      '$a$ [x](./p\\(1\\).md) $b$',
    );
  });

  it('reference 式定义行整行保护:[r]: ./run\\(1\\).md', () => {
    const src = '[r]: ./run\\(1\\).md\n正文 \\(a\\) 公式';
    expect(normalizeMathDelimiters(src)).toBe('[r]: ./run\\(1\\).md\n正文 $a$ 公式');
  });

  it('reference 定义在文末无换行同样保护', () => {
    const src = '公式 \\(x\\)\n[img]: ./a\\[1\\].png';
    expect(normalizeMathDelimiters(src)).toBe('公式 $x$\n[img]: ./a\\[1\\].png');
  });

  it('未闭合 destination 不吞掉后续公式', () => {
    expect(normalizeMathDelimiters('[x](broken\ndest \\(a\\)')).toBe('[x](broken\ndest $a$');
  });
});

describe('normalizeMathDelimiters — preserveLineCount(行锚点模式)', () => {
  it('单行 inline 照常转换,行数不变', () => {
    const src = '第一行 \\(E=mc^2\\) 结尾\n第二行';
    const out = normalizeMathDelimiters(src, { preserveLineCount: true });
    expect(out).toBe('第一行 $E=mc^2$ 结尾\n第二行');
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('display 与跨行 inline 原样保留(转换会改行数)', () => {
    const src = '前\n\\[\nx=1\n\\]\n后 \\(a\n+b\\) 尾';
    const out = normalizeMathDelimiters(src, { preserveLineCount: true });
    expect(out).toBe(src);
  });

  it('混合场景:display 保留、同段单行 inline 转换', () => {
    const out = normalizeMathDelimiters('圆 \\(\\pi r^2\\)\n\\[x\\]', { preserveLineCount: true });
    expect(out).toBe('圆 $\\pi r^2$\n\\[x\\]');
  });
});

describe('normalizeMathDelimiters — 对抗性输入(ReDoS 回归,CodeQL js/polynomial-redos)', () => {
  it('大量未闭合开定界符线性完成', () => {
    const adversarial = '\\[a'.repeat(50000);
    const started = Date.now();
    const out = normalizeMathDelimiters(adversarial);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toBe(adversarial); // 全部未闭合,原样返回
  });

  it('大量反引号运行线性完成', () => {
    const adversarial = '\\(x\\) ' + '`'.repeat(2) .repeat(1) + '``a'.repeat(50000);
    const started = Date.now();
    normalizeMathDelimiters(adversarial);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('普通反斜杠命令穿插时不丢字符', () => {
    expect(normalizeMathDelimiters('a \\alpha b \\(x\\) c \\beta d')).toBe(
      'a \\alpha b $x$ c \\beta d',
    );
    expect(normalizeMathDelimiters('尾部未闭合 \\alpha \\(x')).toBe('尾部未闭合 \\alpha \\(x');
  });
});

describe('latexToUnicodeApproximation', () => {
  it('上标数字 → Unicode superscript', () => {
    expect(latexToUnicodeApproximation('E=mc^2')).toBe('E=mc²');
    expect(latexToUnicodeApproximation('x^{10}')).toBe('x¹⁰');
  });

  it('下标 → Unicode subscript', () => {
    expect(latexToUnicodeApproximation('x_1 + x_2')).toBe('x₁ + x₂');
    expect(latexToUnicodeApproximation('a_{ij}')).toBe('aᵢⱼ');
  });

  it('无法整体映射的上下标退化为 ^(...) / _(...)', () => {
    expect(latexToUnicodeApproximation('x^{a+b+c}')).toBe('x^(a+b+c)');
    expect(latexToUnicodeApproximation('e^w')).toBe('e^w');
  });

  it('希腊字母与运算符映射', () => {
    expect(latexToUnicodeApproximation('\\alpha + \\beta \\times \\gamma')).toBe('α + β × γ');
    expect(latexToUnicodeApproximation('a \\leq b \\neq c')).toBe('a ≤ b ≠ c');
  });

  it('\\frac → 线性 a/b,复合分子分母加括号', () => {
    expect(latexToUnicodeApproximation('\\frac{1}{2}')).toBe('1/2');
    expect(latexToUnicodeApproximation('\\frac{a+b}{c}')).toBe('(a+b)/c');
  });

  it('\\sqrt → √', () => {
    expect(latexToUnicodeApproximation('\\sqrt{2}')).toBe('√2');
    expect(latexToUnicodeApproximation('\\sqrt{a+b}')).toBe('√(a+b)');
  });

  // Production fallback used by mobile RN Text (MessageRenderer.renderInline).
  // Screenshot regression: nested radicals bypassed FRAC_RE; accents leaked
  // command names. Existing coverage only exercised flat braced arguments.
  it.each([
    ['\\frac{2\\sqrt{3}}{3}\\pi = 3.63', '((2√3)/3)π = 3.63'],
    ['\\frac{1}{\\frac{a}{b}}', '1/(a/b)'],
    ['\\frac{a}{bc}', 'a/(bc)'],
    ['\\sqrt{\\frac{a+b}{c}}', '√((a+b)/c)'],
    ['\\dot c', 'c\u0307'],
    ['\\dot{c}(t)', 'c\u0307(t)'],
    ['\\ddot{x}_1', 'x\u0308₁'],
    ['\\dot{\\theta}', 'θ\u0307'],
    ['t_s \\approx \\frac{3}{\\xi\\omega_n}', 'tₛ ≈ 3/(ξωₙ)'],
    ['\\frac{a}{b}^2', '(a/b)²'],
    ['\\frac{a}{b}c', '(a/b)c'],
    ['\\frac{x^{a+b}}{y}', '(x^(a+b))/y'],
    ['\\frac\\sqrt{3}2', '(√3)/2'],
    ['\\sqrt[3]{x}', '∛x'],
    ['\\sqrt[4]{x}', '∜x'],
    ['\\sqrt[n]{a+b}', '√[n](a+b)'],
    ['\\sqrt{1-x^{2}}', '√(1-x²)'],
    ['\\sqrt{\\alpha}x', '√αx'],
    ['\\sqrt[n]{\\alpha}x', '√[n]αx'],
    ['\\hat{x} + \\bar{y} + \\vec{v}', 'x\u0302 + y\u0305 + v\u20d7'],
    ['\\{x\\} + x\\_1', '{x} + x_1'],
    ['x\\,y\\quad z', 'x y z'],
  ])('preserves inline math structure: %s', (source, expected) => {
    expect(latexToUnicodeApproximation(source)).toBe(expected);
  });

  it('handles incomplete streaming fragments and bounded nesting without throwing', () => {
    for (const source of [String.raw`\frac{\sqrt[3]{x}}{y}`, String.raw`e\in\mathcal{\mathbf E}_\mathrm i`]) {
      for (let end = 0; end <= source.length; end += 1) {
        expect(() => latexToUnicodeApproximation(source.slice(0, end))).not.toThrow();
      }
    }
    for (const command of ['\\sqrt{', '\\mathbf{']) {
      expect(() => latexToUnicodeApproximation(command.repeat(2000) + 'x' + '}'.repeat(2000))).not.toThrow();
    }
  });

  // PR #7560 / Greptile 4391615793: the numerator must not be rendered
  // speculatively when a denominator is absent. This exact input previously
  // exceeded a 3s isolated reproduction budget (exponential repeated work).
  it('returns readable text for nested fractions with missing denominators', () => {
    const source = '\\frac{'.repeat(30) + 'x' + '}'.repeat(30);
    expect(latexToUnicodeApproximation(source)).toBe('frac'.repeat(30) + 'x');
  });

  it('样式包装剥壳保内容,函数名保字面', () => {
    expect(latexToUnicodeApproximation('\\text{速度} v')).toBe('速度 v');
    expect(latexToUnicodeApproximation('\\mathbf{A} \\sin x')).toBe('A sin x');
  });

  // #9422: the mobile Text/share fallback must preserve symbols and argument
  // scope. Existing style coverage only tested an isolated, braced wrapper;
  // stripping it before command mapping merged \in + E into unknown \inE.
  // Unit: exercise the production converter's visible text, including single
  // tokens, nested wrappers and wrappers used as structural/script arguments.
  it.each([
    [String.raw`e\in\mathcal E`, 'e∈E'],
    [String.raw`e\in\mathcal{E}`, 'e∈E'],
    [String.raw`\mathrm{\alpha}x`, 'αx'],
    [String.raw`\mathbf{\mathcal{E}}`, 'E'],
    [String.raw`\mathbf\alpha+x`, 'α+x'],
    [String.raw`\frac\mathrm{12}2`, '(12)/2'],
    [String.raw`\sqrt\mathrm{2}`, '√2'],
    [String.raw`x^{\mathrm{12}}+y_\mathrm i`, 'x¹²+yᵢ'],
    [String.raw`e\in\mathrm{\{E\}}`, 'e∈{E}'],
    [String.raw`\mathcal{}x`, 'x'],
  ])('preserves styled inline math argument boundaries: %s', (source, expected) => {
    expect(latexToUnicodeApproximation(source)).toBe(expected);
  });

  it('\\left \\right 修饰被丢弃', () => {
    expect(latexToUnicodeApproximation('\\left( x \\right)')).toBe('( x )');
  });

  it('积分/求和等大型运算符', () => {
    expect(latexToUnicodeApproximation('\\int_0^1 x dx')).toBe('∫₀¹ x dx');
    expect(latexToUnicodeApproximation('\\sum_{i=1}^n i')).toBe('∑ᵢ₌₁ⁿ i');
  });

  it('未知命令去反斜杠保留名字,永不抛错', () => {
    expect(latexToUnicodeApproximation('\\unknowncmd x')).toBe('unknowncmd x');
  });
});

describe('tokenizeInlineMath', () => {
  it('renders all subscript letters cleanly without falling back to raw underscores', () => {
    expect(tokenizeInlineMath("f'_x(0,0)=f'_y(0,0)=0")).toEqual([
      { kind: 'var', text: 'f' },
      { kind: 'text', text: "'" },
      { kind: 'sub', text: 'x', italic: true },
      { kind: 'text', text: '(0,0)=' },
      { kind: 'var', text: 'f' },
      { kind: 'text', text: "'" },
      { kind: 'sub', text: 'y', italic: true },
      { kind: 'text', text: '(0,0)=0' },
    ]);
  });

  it('keeps functions, numbers, operators and sqrt delimiters upright and avoids double parens', () => {
    expect(tokenizeInlineMath('(\\sqrt{|x|}+\\sqrt{|y|})^2 = \\rho(\\sqrt{|\\cos\\theta|}+\\sqrt{|\\sin\\theta|})^2')).toEqual([
      { kind: 'text', text: '(√|' },
      { kind: 'var', text: 'x' },
      { kind: 'text', text: '|+√|' },
      { kind: 'var', text: 'y' },
      { kind: 'text', text: '|)' },
      { kind: 'sup', text: '²', italic: false },
      { kind: 'text', text: ' = ' },
      { kind: 'var', text: 'ρ' },
      { kind: 'text', text: '(√|cos ' },
      { kind: 'var', text: 'θ' },
      { kind: 'text', text: '|+√|sin ' },
      { kind: 'var', text: 'θ' },
      { kind: 'text', text: '|)' },
      { kind: 'sup', text: '²', italic: false },
    ]);
  });

  it('separates variables from upright digits/operators and supports extended letter superscripts', () => {
    expect(tokenizeInlineMath('x^4+y^4 \\le (x^2+y^2)^2 = \\rho^4')).toEqual([
      { kind: 'var', text: 'x' },
      { kind: 'sup', text: '⁴', italic: false },
      { kind: 'text', text: '+' },
      { kind: 'var', text: 'y' },
      { kind: 'sup', text: '⁴', italic: false },
      { kind: 'text', text: ' ≤ (' },
      { kind: 'var', text: 'x' },
      { kind: 'sup', text: '²', italic: false },
      { kind: 'text', text: '+' },
      { kind: 'var', text: 'y' },
      { kind: 'sup', text: '²', italic: false },
      { kind: 'text', text: ')' },
      { kind: 'sup', text: '²', italic: false },
      { kind: 'text', text: ' = ' },
      { kind: 'var', text: 'ρ' },
      { kind: 'sup', text: '⁴', italic: false },
    ]);
    expect(tokenizeInlineMath('e^z + \\|x\\|_{a,1}')).toEqual([
      { kind: 'var', text: 'e' },
      { kind: 'sup', text: 'ᶻ', italic: false },
      { kind: 'text', text: ' + ‖' },
      { kind: 'var', text: 'x' },
      { kind: 'text', text: '‖' },
      { kind: 'sub', text: 'a', italic: true },
      { kind: 'sub', text: ',1', italic: false },
    ]);
  });

  it('handles \\text / \\mathrm upright, \\frac, and deeply nested streaming inputs safely', () => {
    expect(tokenizeInlineMath('\\text{速度} v + \\mathrm{d}x')).toEqual([
      { kind: 'text', text: '速度 ' },
      { kind: 'var', text: 'v' },
      { kind: 'text', text: ' + d' },
      { kind: 'var', text: 'x' },
    ]);
    expect(() => tokenizeInlineMath('\\sqrt{'.repeat(2000) + 'x')).not.toThrow();
  });

  it('ignores Object.prototype keys like \\toString and \\constructor instead of throwing', () => {
    expect(tokenizeInlineMath('\\toString + \\constructor + \\valueOf')).toEqual([
      { kind: 'text', text: 'toString + constructor + valueOf' },
    ]);
    expect(latexToUnicodeApproximation('\\toString + \\constructor')).toBe('toString + constructor');
  });

  it('keeps outer parentheses unless a single delimiter pair wraps the whole operand', () => {
    const plain = (latex: string) => tokenizeInlineMath(latex).map((s) => s.text).join('');
    expect(plain('\\frac{(a)+(b)}{c}')).toBe('((a)+(b))/c');
    expect(plain('\\frac{a}{(b)+(c)}')).toBe('a/((b)+(c))');
    expect(plain('\\sqrt{(a)+(b)}')).toBe('√((a)+(b))');
    expect(plain('\\sqrt{|x|+|y|}')).toBe('√(|x|+|y|)');
    expect(plain('\\sqrt{(a+b)}')).toBe('√(a+b)');
    expect(plain('\\sqrt{|x|}')).toBe('√|x|');
  });

  it('preserves nested subscript boundaries inside superscripts', () => {
    const plain = (latex: string) => tokenizeInlineMath(latex).map((s) => s.text).join('');
    expect(plain('x^{a_b}')).toBe('x^(a_b)');
    expect(plain('2^{n_1+n_2}')).toBe('2^(n₁+n₂)');
  });
});
