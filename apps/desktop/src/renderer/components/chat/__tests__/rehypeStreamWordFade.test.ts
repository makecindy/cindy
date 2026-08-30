/**
 * rehypeStreamWordFade.test.ts
 * ---------------------------------------------------------------------------
 * 流式分段淡入插件的行为测试：切词、连续时间线、稳定 key（不重播）、结构
 * 变化下的 key 稳定性、render candidate 提交、inline-code 原子淡入、
 * pre/KaTeX 跳过,以及 CSS 侧动画本体的静态回归。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Element, Root, Text } from 'hast';

import {
  _resetWordFadeStateCacheForTests,
  commitWordFadeCandidate,
  createWordFadeCandidate,
  createWordFadeState,
  getOrCreateWordFadeState,
  releaseWordFadeState,
  rehypeStreamWordFade,
  scheduleWordFadeSegment,
  splitWords,
  type WordFadeState,
} from '../rehypeStreamWordFade';

afterEach(() => {
  _resetWordFadeStateCacheForTests();
});

function textNode(value: string): Text {
  return { type: 'text', value };
}

function el(
  tagName: string,
  children: Element['children'],
  properties: Element['properties'] = {},
): Element {
  return { type: 'element', tagName, properties, children };
}

function root(...children: Root['children']): Root {
  return { type: 'root', children };
}

function run(tree: Root, state: WordFadeState, nowMs = 0): Root {
  state.timeline.nowFn = () => nowMs;
  const transformer = (rehypeStreamWordFade as (s: WordFadeState) => (t: Root) => void)(state);
  transformer(tree);
  return tree;
}

function nodeText(node: Root | Element): string {
  let out = '';
  for (const child of node.children) {
    if (child.type === 'text') out += child.value;
    else if (child.type === 'element') out += nodeText(child);
  }
  return out;
}

/** 收集树里所有 stream-word span 的 (text, delay, key)。inline code 取整体文本。 */
function collectWords(node: Root | Element): { text: string; delay: number; key: string }[] {
  const out: { text: string; delay: number; key: string }[] = [];
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    const cls = child.properties?.className;
    if (Array.isArray(cls) && cls.includes('stream-word')) {
      const style = String(child.properties?.style ?? '');
      const m = /--wf-delay:(-?\d+)ms/.exec(style);
      out.push({
        text: nodeText(child),
        delay: m ? Number(m[1]) : NaN,
        key: String(child.properties?.dataWfKey ?? ''),
      });
      continue;
    }
    out.push(...collectWords(child));
  }
  return out;
}

function schedule(state: WordFadeState, key: string): number {
  let writtenDelay = '';
  const element = {
    style: {
      setProperty(name: string, value: string) {
        if (name === '--wf-delay') writtenDelay = value;
      },
    },
  } as unknown as HTMLElement;
  const delay = scheduleWordFadeSegment(state, key, element);
  expect(writtenDelay).toBe(`${delay}ms`);
  return delay;
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
  it('同一条流式消息 remount 超过动画时长后把旧词兜底落袋', () => {
    const cacheKey = 'session-1\u0000message-1';
    const firstMount = getOrCreateWordFadeState(cacheKey);
    const tree1 = root(el('p', [textNode('one two')]));
    run(tree1, firstMount, 0);
    const firstKeys = collectWords(tree1).map((word) => word.key);
    for (const key of firstKeys) schedule(firstMount, key);

    const remount = getOrCreateWordFadeState(cacheKey);
    const tree2 = root(el('p', [textNode('one two three')]));
    run(tree2, remount, 1000);
    const words = collectWords(tree2);

    expect(remount).toBe(firstMount);
    expect(firstKeys.every((key) => remount.timeline.settled.has(key))).toBe(true);
    expect(words.map((word) => word.text)).toEqual(['three']);
    expect(schedule(remount, words[0].key)).toBe(0);
  });

  it('消息进入终态后释放 remount 状态', () => {
    const cacheKey = 'session-1\u0000message-1';
    const active = getOrCreateWordFadeState(cacheKey);
    releaseWordFadeState(cacheKey);
    expect(getOrCreateWordFadeState(cacheKey)).not.toBe(active);
  });

  it('首帧估值按 16ms 连续错峰，DOM commit 时间线与之对齐', () => {
    const state = createWordFadeState();
    const tree = root(el('p', [textNode('one two three')]));
    run(tree, state);
    const words = collectWords(tree);
    expect(words.map((w) => w.text)).toEqual(['one ', 'two ', 'three']);
    expect(words.map((w) => w.delay)).toEqual([0, 16, 32]);
    expect(words.map((word) => schedule(state, word.key))).toEqual([0, 16, 32]);
  });

  it('积压到 96ms 后把新增段步长压缩为 4ms', () => {
    const state = createWordFadeState();
    state.timeline.nowFn = () => 0;
    const delays = Array.from({ length: 10 }, (_, index) => schedule(state, `wf-${index}`));
    expect(delays).toEqual([0, 16, 32, 48, 64, 80, 96, 100, 104, 108]);
  });

  it('同一 state 重跑时已见词恢复原进度，新词续接消息时间线', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('one two')]));
    run(tree1, state);
    const keys1 = collectWords(tree1).map((w) => w.key);
    expect(keys1.map((key) => schedule(state, key))).toEqual([0, 16]);

    // 下一个 tick(100ms 后):全文重建 + 新词到达。
    const tree2 = root(el('p', [textNode('one two three four')]));
    run(tree2, state, 100);
    const words = collectWords(tree2);
    // 旧词 key 不变、开播时刻不重排:本 tick 视角发负 delay(CSS 从中途续播,
    // react-markdown 位置 key remount 后跳回正确进度 —— remount 免疫)。
    expect(words[0].key).toBe(keys1[0]);
    expect(words[1].key).toBe(keys1[1]);
    expect(words[0].delay).toBe(-100);
    expect(words[1].delay).toBe(-84);
    // 真实 ref 在 paint 前把新词接到当前时刻，不继承已经消化完的历史积压。
    expect(words.slice(2).map((word) => schedule(state, word.key))).toEqual([0, 16]);
  });

  it('空闲后突发的新段从当前时刻重新起排', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('a b')]));
    run(tree1, state);
    for (const word of collectWords(tree1)) schedule(state, word.key);
    const tree2 = root(el('p', [textNode('a b x y z')]));
    run(tree2, state, 5000);
    const newWords = collectWords(tree2);
    expect(newWords.map((w) => w.text)).toEqual(['x ', 'y ', 'z']);
    expect(newWords.map((word) => schedule(state, word.key))).toEqual([0, 16, 32]);
  });

  it('chunk 边界半个词长成整词:前缀延续复用同一 key', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('hello wor')]));
    run(tree1, state);
    const keys1 = collectWords(tree1).map((w) => w.key);

    const tree2 = root(el('p', [textNode('hello world done')]));
    run(tree2, state);
    const words = collectWords(tree2);
    expect(words[1].text).toBe('world ');
    expect(words[1].key).toBe(keys1[1]);
  });

  it('结构变化吃掉前置词(列表标记)后,后续词按内容找回旧 key —— 不重淡', () => {
    const state = createWordFadeState();
    // tick 1:"2. " 还是普通文本,占了词位。
    const tree1 = root(el('p', [textNode('2. alpha beta gamma')]));
    run(tree1, state);
    const words1 = collectWords(tree1);
    const keyOf = new Map(words1.map((w) => [w.text, w.key]));

    // tick 2:markdown 闭合成列表,"2. " 变成列表标记,不再是词 —— 全体词序号前移。
    const tree2 = root(el('ol', [el('li', [textNode('alpha beta gamma delta')])]));
    run(tree2, state);
    const words2 = collectWords(tree2);
    // 平移后的词按内容拿回旧 key(delay 同步找回,不会当新词重淡)。
    // (tick 1 的末词 "gamma" 在 tick 2 长成 "gamma ",错位 + 内容变化,允许拿
    // 新 key —— 它是最新的词,本就可能还在播。稳定的中部词绝不能重淡。)
    expect(words2[0].key).toBe(keyOf.get('alpha '));
    expect(words2[1].key).toBe(keyOf.get('beta '));
    // 真正的新词才拿新 key。
    expect(words1.map((w) => w.key)).not.toContain(words2[3].key);
  });

  it('文本节点被行内结构劈开(加粗闭合)后,两侧词仍复用旧 key', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('aa **bb** cc')]));
    run(tree1, state);
    const keys1 = collectWords(tree1).map((w) => w.key);

    // 加粗闭合:同一段文字劈成 text + strong + text 三个节点。
    const tree2 = root(el('p', [textNode('aa '), el('strong', [textNode('bb')]), textNode(' cc')]));
    run(tree2, state);
    const words2 = collectWords(tree2);
    // " cc" 的段首空白独立保留为文本节点,词本体是 "cc"。
    expect(words2.map((w) => w.text)).toEqual(['aa ', 'bb', 'cc']);
    // "aa " 同位同内容直接复用;"bb"/"cc" 内容变了(标记剥离)拿新 key 属预期,
    // 但绝不能反过来把 "aa " 当新词。
    expect(words2[0].key).toBe(keys1[0]);
  });

  it('超大 tick 在阈值后压缩步长，并把透明等待收敛到 160ms', () => {
    const state = createWordFadeState();
    const many = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    const tree = root(el('p', [textNode(many)]));
    run(tree, state);
    const delays = collectWords(tree).map((w) => w.delay);
    expect(delays).toHaveLength(500);
    expect(delays.slice(0, 10)).toEqual([0, 16, 32, 48, 64, 80, 96, 100, 104, 108]);
    expect(Math.max(...delays)).toBe(160);
    expect(delays.at(-1)).toBe(160);
  });

  it('被放弃的 render candidate 不污染 committed key 状态', () => {
    const committed = createWordFadeState();
    const abandoned = createWordFadeCandidate(committed);
    run(root(el('p', [textNode('abandoned render')])), abandoned, 10);

    expect(committed.nextId).toBe(0);
    expect(committed.previous).toEqual([]);
    expect(committed.timeline.startAtByKey.size).toBe(0);

    const mounted = createWordFadeCandidate(committed);
    const tree = root(el('p', [textNode('mounted render')]));
    run(tree, mounted, 20);
    expect(collectWords(tree)[0].key).toBe('wf-0');
  });

  it('layout commit 发布 candidate，并保留提交间隙到达的 settled 事件', () => {
    const committed = createWordFadeState();
    const candidate = createWordFadeCandidate(committed);
    const tree = root(el('p', [textNode('one two')]));
    run(tree, candidate, 0);
    const keys = collectWords(tree).map((word) => word.key);

    committed.timeline.settled.add('older-frame');
    commitWordFadeCandidate(committed, candidate);

    expect(committed.previous.map((segment) => segment.key)).toEqual(keys);
    expect(committed.timeline.startAtByKey.size).toBe(0);
    expect(committed.timeline.settled.has('older-frame')).toBe(true);
  });

  it('inline code 与前文进入同一条连续时间线，不会抢先显示', () => {
    const state = createWordFadeState();
    const code = el('code', [textNode('meta.Disabled')]);
    const pre = el('pre', [el('code', [textNode('const a = 1')])]);
    const paragraph = el('p', [textNode('看 line 241 上下文和 line 145 '), code]);
    const tree = root(paragraph, pre);
    run(tree, state);
    const segments = collectWords(tree);
    const codeSegment = paragraph.children.at(-1) as Element;

    expect(segments.at(-1)?.text).toBe('meta.Disabled');
    expect(segments.map((segment) => schedule(state, segment.key))).toEqual(
      segments.map((_, index) => (index <= 6 ? index * 16 : 96 + (index - 6) * 4)),
    );
    expect(codeSegment.tagName).toBe('span');
    expect(codeSegment.properties?.className).toContain('stream-word');
    expect(codeSegment.children).toEqual([code]);
    // fenced code block 仍保持整体，不进入流式淡入。
    expect((pre.children[0] as Element).tagName).toBe('code');
    expect((pre.children[0] as Element).properties?.className).toBeUndefined();
  });

  it('inline code 作为带类型的原子段复用稳定 key，不与同文本正文串 key', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('same '), el('code', [textNode('same')])]));
    run(tree1, state, 0);
    const first = collectWords(tree1);
    for (const segment of first) schedule(state, segment.key);

    const tree2 = root(
      el('p', [textNode('same '), el('code', [textNode('same')]), textNode(' tail')]),
    );
    run(tree2, state, 100);
    const second = collectWords(tree2);

    expect(first[0].key).not.toBe(first[1].key);
    expect(second[0].key).toBe(first[0].key);
    expect(second[1].key).toBe(first[1].key);
    expect(second[1].delay).toBe(-84);
  });

  it('表格格内文字照常分段淡入,结构(table/tr/td)不打任何动画标', () => {
    const state = createWordFadeState();
    const td = el('td', [textNode('早晚 跑步 最佳')]);
    const tr = el('tr', [td]);
    const tree = root(el('table', [el('tbody', [tr])]));
    run(tree, state);
    // Codex 模型:结构即时出现,文字与正文共用同一淡入时机。
    expect(collectWords(tree).map((w) => w.text)).toEqual(['早晚 ', '跑步 ', '最佳']);
    expect(tr.properties?.dataStreamBlock).toBeUndefined();
    expect(tr.properties?.dataStreamMarker).toBeUndefined();
  });

  it('li 圆点借用第一个词的 key/delay 同帧浮现;hr/blockquote 不打标', () => {
    const state = createWordFadeState();
    const li = el('li', [textNode('alpha beta')]);
    const hr = el('hr', []);
    const quote = el('blockquote', [el('p', [textNode('quoted')])]);
    const tree = root(el('ul', [li]), hr, quote);
    run(tree, state);
    const words = collectWords(tree);
    expect(words.map((w) => w.text)).toEqual(['alpha ', 'beta', 'quoted']);
    // 圆点与 li 内第一个段共 key 共 delay(同帧出现,不额外占段位)。
    expect(li.properties?.dataStreamMarker).toBe(true);
    expect(li.properties?.dataWfKey).toBe(words[0].key);
    expect(String(li.properties?.style)).toContain(`--wf-delay:${words[0].delay}ms`);
    // 块结构不淡入；动效对象只有文本词、inline-code 原子和圆点。
    expect(hr.properties?.dataStreamMarker).toBeUndefined();
    expect(quote.properties?.dataStreamMarker).toBeUndefined();
    // 打标不覆盖已有属性。
    const li2 = el('li', [textNode('x')], { className: ['task-list-item'] });
    run(root(el('ul', [li2])), createWordFadeState());
    expect(li2.properties?.className).toEqual(['task-list-item']);
    expect(li2.properties?.dataStreamMarker).toBe(true);
  });

  it('空 li 立即淡入，文字到达后切到首段 key 不重播', () => {
    const state = createWordFadeState();
    const li = el('li', []);
    run(root(el('p', [textNode('one two three')]), el('ul', [li])), state, 0);
    expect(li.properties?.dataStreamMarker).toBe(true);
    expect(li.properties?.dataWfKey).toBeUndefined();
    expect(String(li.properties?.style)).toContain('--wf-delay:0ms');
    // tick 2:文字到达,圆点挂到第一个词的 key/delay 上。
    const li2 = el('li', [textNode('four')]);
    run(root(el('p', [textNode('one two three')]), el('ul', [li2])), state, 0);
    const words = collectWords(root(li2));
    expect(words.map((w) => w.text)).toEqual(['four']);
    expect(li2.properties?.dataWfKey).toBe(words[0].key);
    expect(String(li2.properties?.style)).toContain(`--wf-delay:${words[0].delay}ms`);
    // tick 3:第一个词 settled 后圆点不再打标(remount 无从重播)。
    state.timeline.settled.add(words[0].key);
    const li3 = el('li', [textNode('four')]);
    run(root(el('p', [textNode('one two three')]), el('ul', [li3])), state, 0);
    expect(li3.properties?.dataStreamMarker).toBeUndefined();
  });

  it('KaTeX 子树跳过(公式内部 span 不拆)', () => {
    const state = createWordFadeState();
    const katex = el('span', [el('span', [textNode('x + y')])], { className: ['katex'] });
    const tree = root(el('p', [katex]));
    run(tree, state);
    expect(collectWords(tree)).toEqual([]);
  });

  it('块间纯空白文本节点原样保留,不生成 span、不占词位', () => {
    const state = createWordFadeState();
    const tree = root(el('p', [textNode('a')]), textNode('\n'), el('p', [textNode('b')]));
    run(tree, state);
    expect(tree.children[1]).toEqual(textNode('\n'));
    const words = collectWords(tree);
    expect(words.map((w) => w.text)).toEqual(['a', 'b']);
  });

  it('全 settled 的文本槽位保留 span 身份，只摘动画 class', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('one two three')]), el('p', [textNode('tail')]));
    run(tree1, state);
    const words1 = collectWords(tree1);
    // 第一段全部播完落袋;第二段仍在播。
    state.timeline.settled.add(words1[0].key);
    state.timeline.settled.add(words1[1].key);
    state.timeline.settled.add(words1[2].key);

    const tree2 = root(el('p', [textNode('one two three')]), el('p', [textNode('tail more')]));
    run(tree2, state, 100);
    // settled 节点仍在原位，避免后续兄弟因包装拆除而换身份。
    const p1 = tree2.children[0] as Element;
    expect(p1.children).toHaveLength(3);
    expect(
      p1.children.map((child) =>
        child.type === 'element' ? child.properties?.className : undefined,
      ),
    ).toEqual([undefined, undefined, undefined]);
    expect(nodeText(p1)).toBe('one two three');
    // 在播槽位照常:tail 保住原 key(续播),more 拿新 key。
    const words2 = collectWords(tree2);
    expect(words2.map((w) => w.text)).toEqual(['tail ', 'more']);
    expect(words2[0].key).toBe(words1[3].key);
  });

  it('部分 settled 的槽位保留全部 span，只有活动段携带动画 class', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('one two three')]));
    run(tree1, state);
    const words1 = collectWords(tree1);
    // 只有 0 号播完。
    state.timeline.settled.add(words1[0].key);

    const tree2 = root(el('p', [textNode('one two three four')]));
    run(tree2, state, 100);
    const words2 = collectWords(tree2);
    expect(words2.map((w) => w.text)).toEqual(['two ', 'three ', 'four']);
    const p = tree2.children[0] as Element;
    expect(p.children).toHaveLength(4);
    const settledSpan = p.children[0] as Element;
    expect(settledSpan.properties?.dataWfKey).toBe(words1[0].key);
    expect(settledSpan.properties?.className).toBeUndefined();
  });

  it('长 settled 前缀保留稳定 span，增长尾部继续取得新 key', () => {
    const state = createWordFadeState();
    const prefix = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const tree1 = root(el('p', [textNode(`${prefix} tail`)]));
    run(tree1, state);
    const words1 = collectWords(tree1);
    for (const word of words1.slice(0, 200)) state.timeline.settled.add(word.key);

    const tree2 = root(el('p', [textNode(`${prefix} tail next`)]));
    run(tree2, state, 100);
    const p = tree2.children[0] as Element;
    expect(p.children).toHaveLength(202);
    expect((p.children[0] as Element).properties?.className).toBeUndefined();
    expect((p.children[199] as Element).properties?.className).toBeUndefined();
    expect(collectWords(tree2).map((w) => w.text)).toEqual(['tail ', 'next']);
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
    expect(rule).toContain('var(--motion-ease-out)');
    expect(rule).toContain('var(--wf-delay');
    expect(rule).toContain('both');
    expect(css).not.toContain('--motion-ease-stream-word');
  });

  it('关键帧只动 opacity(compositor-only,一次性非 infinite)', () => {
    const kf = /@keyframes stream-word-in\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(kf).toContain('opacity');
    expect(kf).not.toMatch(/transform|width|height|margin|top|left/);
    expect(/\.stream-word\s*\{[\s\S]*?\}/.exec(css)?.[0]).not.toContain('infinite');
  });

  it('列表圆点 ::marker 淡入规则存在且纳入 reduced-motion 关停清单', () => {
    const rule = /\[data-stream-marker\]::marker\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
    expect(rule).toContain('stream-marker-in');
    expect(rule).toContain('var(--motion-fast)');
    expect(rule).toContain('var(--motion-ease-out)');
    expect(rule).toContain('var(--wf-delay');
    expect(rule).toContain('both');
    // ::marker 只支持 color/font 系属性,关键帧必须动 color 而不是 opacity。
    const kf = /@keyframes stream-marker-in\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(kf).toContain('color: transparent');
    expect(kf).not.toMatch(/opacity|transform/);
    // 块级整体淡入已废弃(Codex 模型:结构即时出现,只有词与圆点淡入)。
    expect(css).not.toContain('data-stream-block');
    // 与 .stream-word 同在 reduced-motion 的 animation:none 关停清单里
    // (文件里有多个 reduce 块,按同规则相邻断言而不是抓第一个块)。
    expect(css).toMatch(
      /\.stream-word,\s*\[data-stream-marker\]::marker,[\s\S]{0,300}?animation: none !important/,
    );
  });
});
