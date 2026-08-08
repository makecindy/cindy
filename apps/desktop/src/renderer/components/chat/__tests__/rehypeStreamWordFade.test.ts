/**
 * rehypeStreamWordFade.test.ts
 * ---------------------------------------------------------------------------
 * 流式逐词淡入插件的行为测试:切词、delay 分配(不重播)、背压压缩、
 * code/KaTeX 跳过,以及 CSS 侧动画本体的静态回归。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Element, Root, Text } from 'hast';

import {
  createWordFadeState,
  rehypeStreamWordFade,
  splitWords,
  type WordFadeState,
} from '../rehypeStreamWordFade';

function textNode(value: string): Text {
  return { type: 'text', value };
}

function el(tagName: string, children: Element['children'], properties: Element['properties'] = {}): Element {
  return { type: 'element', tagName, properties, children };
}

function root(...children: Root['children']): Root {
  return { type: 'root', children };
}

function run(tree: Root, state: WordFadeState): Root {
  const transformer = (rehypeStreamWordFade as (s: WordFadeState) => (t: Root) => void)(state);
  transformer(tree);
  return tree;
}

/** 收集树里所有 stream-word span 的 (text, delay)。 */
function collectWords(node: Root | Element): { text: string; delay: number }[] {
  const out: { text: string; delay: number }[] = [];
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    const cls = child.properties?.className;
    if (Array.isArray(cls) && cls.includes('stream-word')) {
      const t = child.children[0];
      const style = String(child.properties?.style ?? '');
      const m = /--wf-delay:(\d+)ms/.exec(style);
      out.push({
        text: t?.type === 'text' ? t.value : '',
        delay: m ? Number(m[1]) : NaN,
      });
      continue;
    }
    out.push(...collectWords(child));
  }
  return out;
}

describe('splitWords', () => {
  it('英文按空格切词,空白并入前一词', () => {
    expect(splitWords('hello world foo')).toEqual(['hello ', 'world ', 'foo']);
  });

  it('CJK 无空格也按词切(Intl.Segmenter),不整句一团', () => {
    const words = splitWords('今天天气很好');
    expect(words.length).toBeGreaterThan(1);
    expect(words.join('')).toBe('今天天气很好');
  });

  it('切词无损:任意混排拼回原文', () => {
    const src = 'mixed 中文 and English,标点。 done';
    expect(splitWords(src).join('')).toBe(src);
  });
});

describe('rehypeStreamWordFade', () => {
  it('文本节点被切成带 --wf-delay 的 stream-word span,16ms/词递进', () => {
    const state = createWordFadeState();
    const tree = root(el('p', [textNode('one two three')]));
    run(tree, state);
    const words = collectWords(tree);
    expect(words.map((w) => w.text)).toEqual(['one ', 'two ', 'three']);
    expect(words.map((w) => w.delay)).toEqual([16, 32, 48]);
  });

  it('同一 state 重跑(流式 re-parse)已见词拿回同一 delay —— 不重播', () => {
    const state = createWordFadeState();
    run(root(el('p', [textNode('one two')])), state);

    // 下一个 tick:全文重建 + 新词到达。
    const tree2 = root(el('p', [textNode('one two three four')]));
    run(tree2, state);
    const words = collectWords(tree2);
    // 旧词 delay 不变(1、2 号),新词从本 tick 的 0 起重新 stagger。
    expect(words[0].delay).toBe(16);
    expect(words[1].delay).toBe(32);
    expect(words[2].delay).toBe(16);
    expect(words[3].delay).toBe(32);
  });

  it('背压:单 tick 积压超过 96ms 后压缩到 4ms/词', () => {
    const state = createWordFadeState();
    const many = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
    const tree = root(el('p', [textNode(many)]));
    run(tree, state);
    const delays = collectWords(tree).map((w) => w.delay);
    // 前 6 词 16ms 步进到 96ms,之后 4ms 步进。
    expect(delays.slice(0, 6)).toEqual([16, 32, 48, 64, 80, 96]);
    expect(delays[6]).toBe(100);
    expect(delays[11]).toBe(120);
  });

  it('code / pre 子树跳过(路径 chip 与代码块保持整体形态)', () => {
    const state = createWordFadeState();
    const code = el('code', [textNode('src/foo bar.ts')]);
    const pre = el('pre', [el('code', [textNode('const a = 1')])]);
    const tree = root(el('p', [code]), pre);
    run(tree, state);
    expect(collectWords(tree)).toEqual([]);
    expect((code.children[0] as Text).value).toBe('src/foo bar.ts');
  });

  it('KaTeX 子树跳过(公式内部 span 不拆)', () => {
    const state = createWordFadeState();
    const katex = el('span', [el('span', [textNode('x + y')])], { className: ['katex'] });
    const tree = root(el('p', [katex]));
    run(tree, state);
    expect(collectWords(tree)).toEqual([]);
  });

  it('块间纯空白文本节点原样保留,不生成 span、不占词序号', () => {
    const state = createWordFadeState();
    const tree = root(el('p', [textNode('a')]), textNode('\n'), el('p', [textNode('b')]));
    run(tree, state);
    expect(tree.children[1]).toEqual(textNode('\n'));
    const words = collectWords(tree);
    expect(words.map((w) => w.text)).toEqual(['a', 'b']);
  });
});

describe('globals.css 的 stream-word 动画本体', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../../styles/globals.css', import.meta.url)),
    'utf8',
  );

  it('引用 --motion-fast token + both 填充(delay 未到时保持透明)', () => {
    const rule = /\.stream-word\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
    expect(rule).toContain('var(--motion-fast)');
    expect(rule).toContain('var(--wf-delay');
    expect(rule).toContain('both');
  });

  it('关键帧只动 opacity(compositor-only,一次性非 infinite)', () => {
    const kf = /@keyframes stream-word-in\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(kf).toContain('opacity');
    expect(kf).not.toMatch(/transform|width|height|margin|top|left/);
    expect(/\.stream-word\s*\{[\s\S]*?\}/.exec(css)?.[0]).not.toContain('infinite');
  });
});
