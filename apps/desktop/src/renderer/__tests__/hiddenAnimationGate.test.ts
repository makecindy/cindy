/**
 * hiddenAnimationGate.test.ts
 * ---------------------------------------------------------------------------
 * 隐藏期装饰动画闸门的行为测试:通过注入面用假 visibilityState 驱动,并对
 * globals.css 的冻结规则做一次静态回归 —— 一次性动画不得被纳入冻结清单。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  alignFrameWithGate,
  HIDDEN_ANIMATION_ATTR,
  installHiddenAnimationGate,
  isLoopingAnimation,
  syncFrameAnimations,
  type GateAnimation,
  type HiddenAnimationGateTarget,
} from '../lib/hiddenAnimationGate';

function createHarness(
  initialVisibility: DocumentVisibilityState = 'visible',
  opts: { withElectronAPI?: boolean } = { withElectronAPI: true },
) {
  let visibility: DocumentVisibilityState = initialVisibility;
  const listeners = new Set<() => void>();
  const attrs = new Map<string, string>();
  const windowHiddenListeners = new Set<(hidden: boolean) => void>();

  const target: HiddenAnimationGateTarget = {
    document: {
      get visibilityState() {
        return visibility;
      },
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attrs.set(name, value);
        },
        removeAttribute: (name: string) => {
          attrs.delete(name);
        },
      },
      addEventListener: ((type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') listeners.add(cb as () => void);
      }) as Document['addEventListener'],
      removeEventListener: ((type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') listeners.delete(cb as () => void);
      }) as Document['removeEventListener'],
    },
    window: opts.withElectronAPI
      ? {
          electronAPI: {
            onWindowHiddenChange: (cb: (hidden: boolean) => void) => {
              windowHiddenListeners.add(cb);
              return () => windowHiddenListeners.delete(cb);
            },
          },
        }
      : {},
  };

  return {
    target,
    listenerCount: () => listeners.size,
    windowHiddenListenerCount: () => windowHiddenListeners.size,
    isFrozen: () => attrs.get('data-app-hidden') === 'true',
    setVisibility(next: DocumentVisibilityState) {
      visibility = next;
      for (const cb of [...listeners]) cb();
    },
    /** 模拟 main 侧 BrowserWindow hide/minimize 广播。 */
    emitWindowHidden(hidden: boolean) {
      for (const cb of [...windowHiddenListeners]) cb(hidden);
    },
  };
}

describe('installHiddenAnimationGate', () => {
  it('页面隐藏时打上冻结标记，恢复可见时摘掉', () => {
    const h = createHarness('visible');
    installHiddenAnimationGate(h.target);
    expect(h.isFrozen()).toBe(false);

    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);

    h.setVisibility('visible');
    expect(h.isFrozen()).toBe(false);
  });

  it('安装时已处于隐藏态则立即冻结（启动后马上切走的场景）', () => {
    const h = createHarness('hidden');
    installHiddenAnimationGate(h.target);
    expect(h.isFrozen()).toBe(true);
  });

  it('dispose 后摘掉监听并恢复动画，不把页面留在冻结态', () => {
    const h = createHarness('visible');
    const dispose = installHiddenAnimationGate(h.target);
    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);

    dispose();
    expect(h.isFrozen()).toBe(false);
    expect(h.listenerCount()).toBe(0);
    expect(h.windowHiddenListenerCount()).toBe(0);
  });

  // 这是本模块存在的主要理由:backgroundThrottling 关闭时(有 running turn),
  // visibilityState 会一直停在 'visible',只能靠 main 广播兜底。
  it('visibilityState 始终 visible 时，main 广播的窗口隐藏仍能触发冻结', () => {
    const h = createHarness('visible');
    installHiddenAnimationGate(h.target);
    expect(h.isFrozen()).toBe(false);

    h.emitWindowHidden(true);
    expect(h.isFrozen()).toBe(true);

    h.emitWindowHidden(false);
    expect(h.isFrozen()).toBe(false);
  });

  it('两路信号取或：任一为隐藏就冻结，两路都恢复才解冻', () => {
    const h = createHarness('visible');
    installHiddenAnimationGate(h.target);

    h.emitWindowHidden(true);
    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);

    // 只有 main 说恢复，但 visibilityState 仍是 hidden（如 macOS 遮挡）→ 保持冻结
    h.emitWindowHidden(false);
    expect(h.isFrozen()).toBe(true);

    h.setVisibility('visible');
    expect(h.isFrozen()).toBe(false);
  });

  it('缺少 electronAPI 时（非 Electron 宿主）不报错，退化为只认 visibilityState', () => {
    const h = createHarness('visible', { withElectronAPI: false });
    expect(() => installHiddenAnimationGate(h.target)).not.toThrow();
    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);
  });

  it('重复安装只保留一份监听（HMR 重入不叠加）', () => {
    const h = createHarness('visible');
    installHiddenAnimationGate(h.target);
    installHiddenAnimationGate(h.target);
    expect(h.listenerCount()).toBe(1);

    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);
  });
});

describe('同源子文档（Ghost 卡片 iframe）动画同步', () => {
  function makeAnim(iterations: number, playState = 'running') {
    return {
      playState,
      effect: { getTiming: () => ({ iterations }) },
      paused: false,
      pause() {
        this.paused = true;
        this.playState = 'paused';
      },
      play() {
        this.paused = false;
        this.playState = 'running';
      },
    };
  }

  const docWith = (anims: unknown[]): HiddenAnimationGateTarget['document'] =>
    ({
      querySelectorAll: () => [{ contentDocument: { getAnimations: () => anims } }],
    }) as unknown as HiddenAnimationGateTarget['document'];

  it('只暂停无限循环动画，有限动画照播（避免冻在中途帧、恢复时突兀）', () => {
    const loop = makeAnim(Infinity);
    const oneShot = makeAnim(1);
    const paused = new Set<GateAnimation>();

    syncFrameAnimations(docWith([loop, oneShot]), true, paused);
    expect(loop.paused).toBe(true);
    expect(oneShot.paused).toBe(false);
  });

  it('恢复时只 play 本闸门暂停过的，不动意识自己 pause 的动画', () => {
    const loop = makeAnim(Infinity);
    const selfPaused = makeAnim(Infinity, 'paused');
    const paused = new Set<GateAnimation>();

    syncFrameAnimations(docWith([loop, selfPaused]), true, paused);
    expect(loop.paused).toBe(true);
    // 本来就是 paused 的不会被接管
    expect(paused.has(selfPaused as unknown as GateAnimation)).toBe(false);

    syncFrameAnimations(docWith([loop, selfPaused]), false, paused);
    expect(loop.playState).toBe('running');
    expect(selfPaused.playState).toBe('paused');
    expect(paused.size).toBe(0);
  });

  it('跨源 iframe 读 contentDocument 抛错时跳过，不影响其它 frame', () => {
    const loop = makeAnim(Infinity);
    const crossOrigin = {
      get contentDocument(): never {
        throw new DOMException('cross-origin', 'SecurityError');
      },
    };
    const doc = {
      querySelectorAll: () => [crossOrigin, { contentDocument: { getAnimations: () => [loop] } }],
    } as unknown as HiddenAnimationGateTarget['document'];

    const paused = new Set<GateAnimation>();
    expect(() => syncFrameAnimations(doc, true, paused)).not.toThrow();
    expect(loop.paused).toBe(true);
  });

  it('宿主 document 没有 querySelectorAll 时安全跳过', () => {
    const doc = {} as unknown as HiddenAnimationGateTarget['document'];
    expect(() => syncFrameAnimations(doc, true, new Set())).not.toThrow();
  });

  it('isLoopingAnimation 只认 iterations === Infinity', () => {
    expect(isLoopingAnimation({ effect: { getTiming: () => ({ iterations: Infinity }) } })).toBe(true);
    expect(isLoopingAnimation({ effect: { getTiming: () => ({ iterations: 1 }) } })).toBe(false);
    expect(isLoopingAnimation({})).toBe(false);
  });

  it('卡片 srcDoc 不再注通配暂停 CSS，改由 onLoad 精确暂停循环动画', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../components/chat/GhostToolCard.tsx', import.meta.url)),
      'utf8',
    );
    // 通配 CSS 会把有限动画一并冻住，必须已经移除。
    expect(src).not.toContain('animation-play-state:paused!important');
    // 必须走闸门入口而不是自己 pause —— 自行 pause 不登记会让卡片动画永久停住。
    expect(src).toContain('alignFrameWithGate(doc);');
  });
});

describe('alignFrameWithGate（隐藏期间新挂载的卡片）', () => {
  function makeAnim(iterations: number, playState = 'running') {
    return {
      playState,
      effect: { getTiming: () => ({ iterations }) },
      pause() {
        this.playState = 'paused';
      },
      play() {
        this.playState = 'running';
      },
    };
  }
  const hostDoc = (hidden: boolean) =>
    ({
      documentElement: { hasAttribute: (n: string) => hidden && n === HIDDEN_ANIMATION_ATTR },
    }) as unknown as Pick<Document, 'documentElement'>;

  it('窗口可见时不动任何动画', () => {
    const loop = makeAnim(Infinity);
    const win = {};
    alignFrameWithGate({ getAnimations: () => [loop] }, hostDoc(false), win);
    expect(loop.playState).toBe('running');
  });

  it('窗口已隐藏时暂停循环动画，且登记进闸门的共享恢复集合', () => {
    const loop = makeAnim(Infinity);
    const oneShot = makeAnim(1);
    const win: { __xdtHiddenAnimationGatePausedAnims?: Set<GateAnimation> } = {};

    alignFrameWithGate({ getAnimations: () => [loop, oneShot] }, hostDoc(true), win);

    expect(loop.playState).toBe('paused');
    expect(oneShot.playState).toBe('running');
    // 关键：必须登记，否则统一恢复路径不会 play 它，卡片动画永久停住。
    expect(win.__xdtHiddenAnimationGatePausedAnims?.has(loop as unknown as GateAnimation)).toBe(true);
  });

  it('登记后能被统一恢复路径播回来（端到端串起 onLoad → 恢复）', () => {
    const loop = makeAnim(Infinity);
    const win: { __xdtHiddenAnimationGatePausedAnims?: Set<GateAnimation> } = {};

    alignFrameWithGate({ getAnimations: () => [loop] }, hostDoc(true), win);
    expect(loop.playState).toBe('paused');

    const doc = {
      querySelectorAll: () => [{ contentDocument: { getAnimations: () => [loop] } }],
    } as unknown as HiddenAnimationGateTarget['document'];
    syncFrameAnimations(doc, false, win.__xdtHiddenAnimationGatePausedAnims!);

    expect(loop.playState).toBe('running');
  });
});

const CSS_PATH = fileURLToPath(new URL('../styles/globals.css', import.meta.url));
const css = readFileSync(CSS_PATH, 'utf8');
const frozenBlock =
  /\[data-app-hidden='true'\][\s\S]*?animation-play-state:\s*paused\s*!important;/.exec(css)?.[0] ?? '';

/**
 * 取选择器里「真正挂动画的那个元素」——最后一段后代选择器。
 * 冻结清单按这一段收敛：祖先条件不同、落点相同的规则（如 8 条
 * `.agent-island-mascot-stage[data-motion=...] .agent-island-mascot-character`）只需一条。
 * 按顶层空格切分，属性值内部的空格不算分隔符。
 */
function animatedElementToken(selector: string): string {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of selector) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  const last = parts[parts.length - 1] ?? selector;
  // 去掉紧跟在落点元素后的状态限定（如 :hover），保留伪元素（::before 是独立的动画宿主）
  return last.replace(/(?<!:):(?!:)[a-z-]+(\(.*\))?/g, '');
}

/**
 * 扫描 globals.css 里所有 `animation: ... infinite` 规则，回溯其选择器。
 * 先把注释替换成等长空白（保留换行以维持行号），否则注释里提到的
 * `animation: ... infinite` 字样会被误判成真规则。
 */
function collectInfiniteRules(): { line: number; selector: string }[] {
  const lines = css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n');
  const found: { line: number; selector: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/animation:.*\binfinite\b/.test(lines[i])) continue;
    let j = i;
    while (j >= 0 && !lines[j].includes('{')) j--;
    const sel: string[] = [lines[j].split('{')[0].trim()];
    let k = j - 1;
    while (k >= 0 && /,\s*$/.test(lines[k])) {
      sel.unshift(lines[k].trim());
      k--;
    }
    found.push({ line: i + 1, selector: sel.join(' ').trim() });
  }
  return found;
}

describe('globals.css 冻结规则', () => {
  it('冻结的是 play-state 而不是 animation: none', () => {
    expect(frozenBlock).not.toBe('');
    expect(frozenBlock).toContain('animation-play-state: paused');
    expect(frozenBlock).not.toMatch(/animation:\s*none/);
  });

  it('每个 infinite 动画的宿主元素都在冻结清单里', () => {
    const rules = collectInfiniteRules();
    // 兜底：确认扫描逻辑确实抓到了规则，避免正则失效导致本用例空跑。
    expect(rules.length).toBeGreaterThan(10);

    const missing = rules
      .filter((r) => !frozenBlock.includes(animatedElementToken(r.selector)))
      .map((r) => `globals.css:${r.line}  ${r.selector}  (落点 ${animatedElementToken(r.selector)})`);

    expect(
      missing,
      `以下 infinite 动画没有被 [data-app-hidden='true'] 冻结清单覆盖，隐藏窗口里它们会继续跑：\n${missing.join('\n')}\n\n` +
        '请把落点元素补进 globals.css 的冻结清单，不要修改本测试。',
    ).toEqual([]);
  });

  it('一次性动画不得纳入冻结清单（否则会冻在中途帧，恢复时突兀）', () => {
    for (const oneShot of [
      '.status-bar-done',
      '.session-card--settle',
      '.card-col-fade',
      '.ghost-panel-enter',
      '.ghost-panel-exit',
    ]) {
      expect(frozenBlock).not.toContain(oneShot);
    }
  });

  it('Tailwind 动画用 [class*=] 匹配，以覆盖 motion-safe: 等变体的转义类名', () => {
    expect(frozenBlock).toContain("[class*='animate-spin']");
    expect(frozenBlock).toContain("[class*='animate-pulse']");
  });

  // 任意值工具类（animate-[spin_2.4s_linear_infinite]）不含 animate-spin 子串，
  // 也不在 globals.css 里，前面那条 CSS 扫描看不见它们 —— 单独扫源码兜住。
  // 用 Node 自己遍历而不是外部 grep：Windows 上没有 POSIX grep，execFileSync 会
  // 直接 ENOENT，测试在到达断言前就挂了。
  it('源码里的任意值循环动画工具类都能被冻结清单匹配', () => {
    const rendererDir = fileURLToPath(new URL('..', import.meta.url));

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full, out);
        } else if (/\.tsx?$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    };

    const infiniteUtilities: string[] = [];
    for (const file of walk(rendererDir)) {
      const content = readFileSync(file, 'utf8');
      for (const m of content.matchAll(/animate-\[[^\]]*\]/g)) {
        if (m[0].includes('infinite')) {
          infiniteUtilities.push(`${relative(rendererDir, file)}  ${m[0]}`);
        }
      }
    }

    // 有任意值循环动画存在时，冻结清单必须有能匹配它们的选择器。
    if (infiniteUtilities.length > 0) {
      expect(
        frozenBlock.includes("[class*='infinite']"),
        `源码里存在任意值循环动画工具类，但冻结清单没有 [class*='infinite'] 兜底：\n${infiniteUtilities.join('\n')}`,
      ).toBe(true);
    }
  });

  // 属性名分散在 CSS / gate / GhostToolCard / 测试里，CSS 侧没法 import 常量，
  // 这里替它把两边钉在一起。
  // drawio viewer 把循环动画以 inline style 写到 SVG 上，类名不含任何可匹配的串，
  // 且是压缩过的第三方脚本，前面的 CSS / tsx 扫描都够不着 —— 只能按容器子树冻结。
  it('drawio viewer 子树在冻结清单里', () => {
    expect(frozenBlock).toContain('[data-mxgraph]');
    expect(frozenBlock).toContain('[data-mxgraph] *');
  });

  it('CSS 冻结清单用的属性名与模块导出的常量一致', () => {
    expect(HIDDEN_ANIMATION_ATTR).toBe('data-app-hidden');
    expect(frozenBlock).toContain(`[${HIDDEN_ANIMATION_ATTR}='true']`);
  });
});
