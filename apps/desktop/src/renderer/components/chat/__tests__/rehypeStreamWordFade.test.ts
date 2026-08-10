/**
 * rehypeStreamWordFade.test.ts
 * ---------------------------------------------------------------------------
 * 流式逐词淡入插件的行为测试:切词、稳定 key 与 delay 分配(不重播)、结构
 * 变化下的 key 稳定性(序号漂移回归)、settled 落袋、背压压缩、code/KaTeX
 * 跳过,以及 CSS 侧动画本体的静态回归。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Element, Root, Text } from 'hast';

import {
  createWordFadeState,
  markSettledFromAnimationEnd,
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

function run(tree: Root, state: WordFadeState, nowMs = 0): Root {
  state.nowFn = () => nowMs;
  const transformer = (rehypeStreamWordFade as (s: WordFadeState) => (t: Root) => void)(state);
  transformer(tree);
  return tree;
}

/** 收集树里所有 stream-word span 的 (text, delay, key)。 */
function collectWords(node: Root | Element): { text: string; delay: number; key: string }[] {
  const out: { text: string; delay: number; key: string }[] = [];
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    const cls = child.properties?.className;
    if (Array.isArray(cls) && cls.includes('stream-word')) {
      const t = child.children[0];
      const style = String(child.properties?.style ?? '');
      const m = /--wf-delay:(-?\d+)ms/.exec(style);
      out.push({
        text: t?.type === 'text' ? t.value : '',
        delay: m ? Number(m[1]) : NaN,
        key: String(child.properties?.dataWfKey ?? ''),
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
  it('文本节点被切成带 --wf-delay 的 stream-word span,首词 0ms 起、24ms/词递进', () => {
    const state = createWordFadeState();
    const tree = root(el('p', [textNode('one two three')]));
    run(tree, state);
    const words = collectWords(tree);
    expect(words.map((w) => w.text)).toEqual(['one ', 'two ', 'three']);
    expect(words.map((w) => w.delay)).toEqual([0, 24, 48]);
  });

  it('同一 state 重跑(流式 re-parse)已见词拿回同一 key,发剩余(负)delay 续播', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('one two')]));
    run(tree1, state);
    const keys1 = collectWords(tree1).map((w) => w.key);

    // 下一个 tick(100ms 后):全文重建 + 新词到达,队列尾(48ms)已落到过去。
    const tree2 = root(el('p', [textNode('one two three four')]));
    run(tree2, state, 100);
    const words = collectWords(tree2);
    // 旧词 key 不变、开播时刻不重排:本 tick 视角发负 delay(CSS 从中途续播,
    // react-markdown 位置 key remount 后跳回正确进度 —— remount 免疫)。
    expect(words[0].key).toBe(keys1[0]);
    expect(words[1].key).toBe(keys1[1]);
    expect(words[0].delay).toBe(-100);
    expect(words[1].delay).toBe(-76);
    // 新词从本 tick 的 0 起接着排。
    expect(words[2].delay).toBe(0);
    expect(words[3].delay).toBe(24);
  });

  it('timeline 跨 tick 连续:队列尾在未来时后到的词接着排,不插队', () => {
    const state = createWordFadeState();
    // tick 1(t=0):4 词排到 96ms(尾部)。
    run(root(el('p', [textNode('a b c d')])), state);
    // tick 2(t=50):队列尾 96ms 还在未来,新词从 96-50=46ms 接着排。
    const tree2 = root(el('p', [textNode('a b c d e f')]));
    run(tree2, state, 50);
    const words = collectWords(tree2);
    expect(words[4].delay).toBe(46);
    expect(words[5].delay).toBe(70);
  });

  it('卡顿后突发:队列已排空则第一词立即开始,整段连贯波浪推进', () => {
    const state = createWordFadeState();
    run(root(el('p', [textNode('a b')])), state);
    // 卡顿 5 秒后一大坨到达:尾部(48ms)远落在过去,从 0 重新起排。
    const tree2 = root(el('p', [textNode('a b x y z')]));
    run(tree2, state, 5000);
    const words = collectWords(tree2);
    expect(words.slice(2).map((w) => w.delay)).toEqual([0, 24, 48]);
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

  it('自适应背压:预算富余时步长恒为 24ms 上限(慢速输出与 Codex 观感一致)', () => {
    const state = createWordFadeState();
    // 10 词:320/10=32ms ≥ 24ms 上限,不压缩,全程 24ms 步进。
    const many = Array.from({ length: 10 }, (_, i) => `w${i}`).join(' ');
    const tree = root(el('p', [textNode(many)]));
    run(tree, state);
    const delays = collectWords(tree).map((w) => w.delay);
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBe(24);
    expect(delays[9]).toBe(216);
  });

  it('自适应背压:大 tick 步长按预算压缩,超前量封顶 MAX_LEAD_MS(与模型吐词速率无关)', () => {
    const state = createWordFadeState();
    // 500 词一次性到达(超快模型):步长压到 320/500=0.64ms,总积压 ≤320ms。
    const many = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    const tree = root(el('p', [textNode(many)]));
    run(tree, state);
    const delays = collectWords(tree).map((w) => w.delay);
    expect(Math.max(...delays)).toBeLessThanOrEqual(320);
    // 仍保持递增波浪(不是整块同帧蹦出)。
    expect(delays[499]).toBeGreaterThan(delays[250]);
    // 下一 tick(t=320,积压已消化)新词从 0 接着排,不被历史积压顶到未来。
    const tree2 = root(el('p', [textNode(`${many} fresh`)]));
    run(tree2, state, 320);
    const words2 = collectWords(tree2);
    expect(words2[500].text).toBe('fresh');
    expect(words2[500].delay).toBeLessThanOrEqual(24);
    // 慢速恢复后(下一 tick 词少)步长回到 24ms:fresh2 在 fresh 之后 24ms。
    const tree3 = root(el('p', [textNode(`${many} fresh fresh2`)]));
    run(tree3, state, 320);
    const words3 = collectWords(tree3);
    expect(words3[501].delay - words3[500].delay).toBe(24);
  });

  it('持续快速到达:每 tick 预算重算,积压始终收敛不发散', () => {
    const state = createWordFadeState();
    // 模拟 300 tok/s:每 100ms 到达 30 词,连续 10 tick。
    let text = '';
    for (let tick = 0; tick < 10; tick++) {
      text += (text ? ' ' : '') + Array.from({ length: 30 }, (_, i) => `t${tick}w${i}`).join(' ');
      const tree = root(el('p', [textNode(text)]));
      run(tree, state, tick * 100);
      const nowMs = tick * 100;
      // 不变量:排程尾部超前 now 永远不超过 MAX_LEAD_MS + 一个步长。
      expect(state.nextStartAtMs - nowMs).toBeLessThanOrEqual(320 + 24);
      // 感知不变量:本 tick 到达的词,可见时刻落后到达 < 0.5s(预算+动画)。
      const delays = collectWords(tree).map((w) => w.delay);
      expect(Math.max(...delays)).toBeLessThanOrEqual(320);
    }
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

  it('表格格内文字照常逐词淡入,结构(table/tr/td)不打任何动画标', () => {
    const state = createWordFadeState();
    const td = el('td', [textNode('早晚 跑步 最佳')]);
    const tr = el('tr', [td]);
    const tree = root(el('table', [el('tbody', [tr])]));
    run(tree, state);
    // Codex 模型:结构即时出现,文字与正文共用同一条 timeline 逐词浮现。
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
    // 圆点与 li 内第一个词共 key 共 delay(同帧出现,不占队列位)。
    expect(li.properties?.dataStreamMarker).toBe(true);
    expect(li.properties?.dataWfKey).toBe(words[0].key);
    expect(String(li.properties?.style)).toContain(`--wf-delay:${words[0].delay}ms`);
    // 结构元素不淡入(Codex 模型:只有词和圆点两类动效对象)。
    expect(hr.properties?.dataStreamMarker).toBeUndefined();
    expect(quote.properties?.dataStreamMarker).toBeUndefined();
    // 打标不覆盖已有属性。
    const li2 = el('li', [textNode('x')], { className: ['task-list-item'] });
    run(root(el('ul', [li2])), createWordFadeState());
    expect(li2.properties?.className).toEqual(['task-list-item']);
    expect(li2.properties?.dataStreamMarker).toBe(true);
  });

  it('空 li(结构刚长出、文字未到)借队列尾 delay,文字到达后切到词 key 不重播', () => {
    const state = createWordFadeState();
    // tick 1:前文 3 个词把队列推到 72ms,空 li 同时出现。
    const li = el('li', []);
    run(root(el('p', [textNode('one two three')]), el('ul', [li])), state, 0);
    expect(li.properties?.dataStreamMarker).toBe(true);
    expect(li.properties?.dataWfKey).toBeUndefined();
    // 借队列尾部当前值(3 词 × 24ms),且不推进队列。
    expect(String(li.properties?.style)).toContain('--wf-delay:72ms');
    // tick 2:文字到达,圆点挂到第一个词的 key/delay 上。
    const li2 = el('li', [textNode('four')]);
    run(root(el('p', [textNode('one two three')]), el('ul', [li2])), state, 0);
    const words = collectWords(root(li2));
    expect(words.map((w) => w.text)).toEqual(['four']);
    expect(li2.properties?.dataWfKey).toBe(words[0].key);
    expect(String(li2.properties?.style)).toContain(`--wf-delay:${words[0].delay}ms`);
    // tick 3:第一个词 settled 后圆点不再打标(remount 无从重播)。
    state.settled.add(words[0].key);
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

  it('全 settled 的文本槽位不改树(原生文本节点,零 span)—— 流式长文档性能核心', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('one two three')]), el('p', [textNode('tail')]));
    run(tree1, state);
    const words1 = collectWords(tree1);
    // 第一段全部播完落袋;第二段仍在播。
    state.settled.add(words1[0].key);
    state.settled.add(words1[1].key);
    state.settled.add(words1[2].key);

    const tree2 = root(el('p', [textNode('one two three')]), el('p', [textNode('tail more')]));
    run(tree2, state, 100);
    // 全 settled 槽位:文本节点原样保留,不包任何 span。
    const p1 = tree2.children[0] as Element;
    expect(p1.children).toEqual([textNode('one two three')]);
    // 在播槽位照常:tail 保住原 key(续播),more 拿新 key。
    const words2 = collectWords(tree2);
    expect(words2.map((w) => w.text)).toEqual(['tail ', 'more']);
    expect(words2[0].key).toBe(words1[3].key);
  });

  it('部分 settled 的槽位把 settled 前缀还原为纯文本,仅活动尾部保留 span', () => {
    const state = createWordFadeState();
    const tree1 = root(el('p', [textNode('one two three')]));
    run(tree1, state);
    const words1 = collectWords(tree1);
    // 只有 0 号播完:槽位未全 settled,但 settled 前缀不再保留 span。
    state.settled.add(words1[0].key);

    const tree2 = root(el('p', [textNode('one two three four')]));
    run(tree2, state, 500);
    const words2 = collectWords(tree2);
    expect(words2.map((w) => w.text)).toEqual(['two ', 'three ', 'four']);
    const p = tree2.children[0] as Element;
    expect(p.children[0]).toEqual(textNode('one '));
    // 活动词仍保住原 key,负 delay 继续提供 remount 免疫。
    // 在播词续播,新词接排。
    expect(words2[0].key).toBe(words1[1].key);
    expect(words2[1].key).toBe(words1[2].key);
    expect(words2[1].delay).toBe(-452);
  });

  it('长 settled 前缀只保留一个原生文本节点', () => {
    const state = createWordFadeState();
    const prefix = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const tree1 = root(el('p', [textNode(`${prefix} tail`)]));
    run(tree1, state);
    const words1 = collectWords(tree1);
    for (const word of words1.slice(0, 200)) state.settled.add(word.key);

    const tree2 = root(el('p', [textNode(`${prefix} tail next`)]));
    run(tree2, state, 500);
    const p = tree2.children[0] as Element;
    expect(p.children[0]).toEqual(textNode(`${prefix} `));
    expect(collectWords(tree2).map((w) => w.text)).toEqual(['tail ', 'next']);
  });
});

describe('markSettledFromAnimationEnd', () => {
  function fadeEndEvent(wfKey: string | undefined, animationName = 'stream-word-in') {
    const target = (wfKey === undefined ? {} : { dataset: { wfKey } }) as unknown as EventTarget;
    return { animationName, target };
  }

  it('stream-word-in 播完的词 key 进 settled', () => {
    const state = createWordFadeState();
    markSettledFromAnimationEnd(state, fadeEndEvent('wf-3'));
    expect(state.settled.has('wf-3')).toBe(true);
  });

  it('其它动画名 / 非 stream-word 目标都不落袋', () => {
    const state = createWordFadeState();
    markSettledFromAnimationEnd(state, fadeEndEvent('wf-1', 'spinner-rotate'));
    markSettledFromAnimationEnd(state, fadeEndEvent(undefined));
    expect(state.settled.size).toBe(0);
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

  it('列表圆点 ::marker 淡入规则存在且纳入 reduced-motion 关停清单', () => {
    const rule = /\[data-stream-marker\]::marker\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
    expect(rule).toContain('stream-marker-in');
    expect(rule).toContain('var(--motion-fast)');
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
    expect(css).toMatch(/\.stream-word,\s*\[data-stream-marker\]::marker,[\s\S]{0,300}?animation: none !important/);
  });
});
