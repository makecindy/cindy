import { describe, expect, it, vi } from 'vitest';

import {
  buildGhostPluginSettingsThemeCss,
  buildGhostSettingsThemeCss,
  buildGhostThemeCss,
  buildGhostThemeVarsBlock,
  createGhostThemeInjector,
  isSafeGhostThemeValue,
  type ThemeInjectableWebview,
} from '../ghostPanelTheme';

/** insertCSS / removeInsertedCSS 的记录型 mock(key 自增)。 */
function mockWebview(): ThemeInjectableWebview & {
  insertCSS: ReturnType<typeof vi.fn>;
  removeInsertedCSS: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  return {
    insertCSS: vi.fn(async () => `key-${++n}`),
    removeInsertedCSS: vi.fn(async () => {}),
  };
}

/** 让 insertCSS 的 then 回调落地。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createGhostThemeInjector · webview 主题注入状态机', () => {
  it('token 文本没变就不重复灌(换肤监听误触发去重)', async () => {
    const webview = mockWebview();
    const injector = createGhostThemeInjector(webview, () => 'body { background: red; }');
    injector.inject();
    injector.inject();
    injector.inject();
    await flush();
    expect(webview.insertCSS).toHaveBeenCalledTimes(1);
  });

  it('token 变了 → 重灌并移除旧 key', async () => {
    const webview = mockWebview();
    let css = 'a';
    const injector = createGhostThemeInjector(webview, () => css);
    injector.inject();
    await flush();
    css = 'b';
    injector.inject();
    await flush();
    expect(webview.insertCSS).toHaveBeenCalledTimes(2);
    expect(webview.removeInsertedCSS).toHaveBeenCalledWith('key-1');
  });

  it('回归:dom-ready(拖动换位触发整页重载)后即使 css 未变也必须重灌', async () => {
    const webview = mockWebview();
    const injector = createGhostThemeInjector(webview, () => 'same-css');
    injector.onDomReady(); // 首载
    await flush();
    // 拖动面板 → DOM reparent → Electron 整页重载 → dom-ready 再触发;
    // 旧 insertCSS 已随旧页面蒸发,若被去重挡住,面板背景色全丢(2026-07-11 实撞)。
    injector.onDomReady();
    await flush();
    expect(webview.insertCSS).toHaveBeenCalledTimes(2);
    // 旧 key 属于已销毁的旧页面,不该对新页面调 removeInsertedCSS(白做且可能误删)。
    expect(webview.removeInsertedCSS).not.toHaveBeenCalled();
  });

  it('dispose 后一切静默', async () => {
    const webview = mockWebview();
    const injector = createGhostThemeInjector(webview, () => 'css');
    injector.dispose();
    injector.inject();
    injector.onDomReady();
    await flush();
    expect(webview.insertCSS).not.toHaveBeenCalled();
  });
});

describe('isSafeGhostThemeValue · 注入值合法性守卫(纵深防御)', () => {
  it('放行正常主题色 / 长度值', () => {
    for (const v of ['#1a1a1a', '#fff', 'rgba(0,0,0,0.5)', 'hsl(60 12% 97%)', 'white', '12px']) {
      expect(isSafeGhostThemeValue(v)).toBe(true);
    }
  });

  it('否决能破 <style> / 声明上下文的字符', () => {
    for (const v of [
      'red</style><script>',
      'a{}',
      'x;color:red',
      '@import url(x)',
      'a\\3c b',
      'foo<bar',
      'y}z',
    ]) {
      expect(isSafeGhostThemeValue(v)).toBe(false);
    }
  });
});

/**
 * 本测试文件跑 node 环境:变量块读 :root 的 getComputedStyle 打桩即可,断言
 * 对象只是基线字符串(fallback 链写法),与 DOM 无关。
 *
 * classList 必须一并打桩:readHostColorScheme 在 computed color-scheme 缺失或
 * 为多值形态时回落到 root 的 dark class(applyTheme 与它同步 toggle,同源信号)。
 */
function withDomStubs(
  run: () => void,
  opts: { colorScheme?: string; dark?: boolean; tokenValue?: (token: string) => string } = {},
): void {
  vi.stubGlobal('document', {
    documentElement: {
      classList: { contains: (cls: string) => cls === 'dark' && opts.dark === true },
    },
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (token: string) => opts.tokenValue?.(token) ?? '',
    colorScheme: opts.colorScheme,
  }));
  try {
    run();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('注入基线 CSS(幽灵 token 防线 + 设置区卡片色对齐)', () => {
  it('面板基线:背景 fallback 链 --panel-bg → --surface(--panel-bg 已注册 alias 到 surface,fallback 作纵深兜底)', () => {
    withDomStubs(() => {
      expect(buildGhostThemeCss()).toContain('background: var(--panel-bg, var(--surface))');
    });
  });

  it('panel-bg 已进 Ghost 注入白名单:读到现值时注入块含 --panel-bg(历史幽灵补注册后,沙箱面板与宿主同源)', () => {
    withDomStubs(
      () => {
        // panel-bg 在白名单 → 注入块显式下发(此前被刻意排除,沙箱只能靠 body fallback)
        expect(buildGhostThemeCss()).toContain('--panel-bg: var(--surface)');
      },
      { tokenValue: (token) => (token === '--panel-bg' ? 'var(--surface)' : '') },
    );
  });

  it('面板下发功能性 motion token,插件无需硬编码交互与 spinner 时长', () => {
    withDomStubs(
      () => {
        const css = buildGhostThemeCss();
        expect(css).toContain('--motion-fast: 150ms');
        expect(css).toContain('--motion-spinner-cycle: 1000ms');
      },
      {
        tokenValue: (token) =>
          token === '--motion-fast' ? '150ms' : token === '--motion-spinner-cycle' ? '1000ms' : '',
      },
    );
  });

  it('设置区基线:背景 = 宿主设置卡片色(与相邻卡片无缝),fallback --surface', () => {
    withDomStubs(() => {
      expect(buildGhostSettingsThemeCss()).toContain(
        'background: var(--settings-theme-card-bg, var(--surface))',
      );
    });
  });

  it('设置区基线:宿主设置页与 Plugin 详情页都把 placeholder 明确画成空值提示', () => {
    withDomStubs(() => {
      for (const css of [buildGhostSettingsThemeCss(), buildGhostPluginSettingsThemeCss()]) {
        expect(css).toContain('input::placeholder, textarea::placeholder');
        expect(css).toContain('color: var(--text-placeholder)');
        expect(css).toContain('opacity: 0.45');
        expect(css).toContain('font-weight: 400');
      }
    });
  });
});

/**
 * 回归:意识沙箱页的明暗档必须显式下发(color-scheme 不跨文档继承)。
 *
 * 不下发的后果是 Chromium 按 light 处理 guest 文档:卡片 iframe 拿到一张**不透明
 * 白 canvas**,于是"不铺底色 = 透明画布"的全出血卡在暗色主题下整张变白、且切主题
 * 不变(白来自 UA,不是任何 token);面板 / 设置区 webview 虽有基线底色不露白,但
 * 原生控件(滚动条、input / select、日期选择器)会停在浅色档。xd-mivo 实撞。
 */
describe('沙箱页明暗档下发(color-scheme,双模式门槛)', () => {
  it('宿主 root 是 dark → 变量块下发 color-scheme: dark', () => {
    withDomStubs(
      () => {
        expect(buildGhostThemeVarsBlock()).toContain('color-scheme: dark;');
      },
      { colorScheme: 'dark' },
    );
  });

  it('宿主 root 是 light → 变量块下发 color-scheme: light', () => {
    withDomStubs(
      () => {
        expect(buildGhostThemeVarsBlock()).toContain('color-scheme: light;');
      },
      { colorScheme: 'light' },
    );
  });

  it('computed 值不可直接下发时(normal / 多值 / 缺失)回落 root 的 dark class', () => {
    // 'normal' = 尚未 applyTheme;'light dark' = 未来的多值形态;undefined = 属性缺失。
    for (const colorScheme of ['normal', 'light dark', undefined]) {
      withDomStubs(
        () => {
          expect(buildGhostThemeVarsBlock()).toContain('color-scheme: dark;');
        },
        { colorScheme, dark: true },
      );
      withDomStubs(
        () => {
          expect(buildGhostThemeVarsBlock()).toContain('color-scheme: light;');
        },
        { colorScheme, dark: false },
      );
    }
  });

  it('computed 原文不透传:未知值收敛成两个字面量之一,不落进注入 CSS', () => {
    withDomStubs(
      () => {
        const block = buildGhostThemeVarsBlock();
        expect(block).not.toContain('dark light');
        expect(block).toContain('color-scheme: light;');
      },
      { colorScheme: 'dark light', dark: false },
    );
  });

  it('四条注入路径(面板 / 设置区 / Plugin 详情 / 卡片变量块)都带明暗档', () => {
    withDomStubs(
      () => {
        for (const css of [
          buildGhostThemeCss(),
          buildGhostSettingsThemeCss(),
          buildGhostPluginSettingsThemeCss(),
          buildGhostThemeVarsBlock(),
        ]) {
          expect(css).toContain('color-scheme: dark;');
        }
      },
      { colorScheme: 'dark' },
    );
  });

  it('token 全空也不产出空变量块:卡片 srcDoc 按非空决定是否注 <style>,空了明暗档就丢', () => {
    withDomStubs(
      () => {
        // buildCardSrcDoc 的 `themeVars ? <style> : ''` —— 变量块为空即整段不注入,
        // 明暗档随之丢失、白 canvas 回归。color-scheme 恒在保证它永不为空。
        expect(buildGhostThemeVarsBlock().trim()).not.toBe(':root {  }');
        expect(buildGhostThemeVarsBlock()).toContain('color-scheme: light;');
      },
      { colorScheme: 'light' },
    );
  });

  it('只有明暗档变化(颜色 token 未变)也必须重灌:CSS 文本随之变,去重挡不住', async () => {
    const webview = mockWebview();
    let scheme = 'light';
    const injector = createGhostThemeInjector(webview, () =>
      withCapturedCss(() => buildGhostThemeVarsBlock(), scheme),
    );
    injector.inject();
    await flush();
    scheme = 'dark';
    injector.inject();
    await flush();
    expect(webview.insertCSS).toHaveBeenCalledTimes(2);
    expect(webview.insertCSS).toHaveBeenLastCalledWith(
      expect.stringContaining('color-scheme: dark;'),
    );
  });
});

/** 在给定明暗档下取一次注入 CSS(stub 只在同步调用期内生效)。 */
function withCapturedCss(build: () => string, colorScheme: string): string {
  let css = '';
  withDomStubs(
    () => {
      css = build();
    },
    { colorScheme },
  );
  return css;
}
