/**
 * 意识面板主题下发:把主机当前主题的一组
 * 白名单 token 值编成一段 CSS,经 webview.insertCSS 灌进意识沙箱页——
 * 意识内容用与主机同名的 var(--xxx) 就能拿到主题色,主题切换时重灌。
 *
 * 白名单口径:只下发"画面板需要的语义色",不整表倾倒(意识不需要知道
 * 主机的全部 token;新增槽位时在这里显式加)。值在注入时从 :root 现值
 * 读取,天然跟随任意主题(不只 light/dark,规则 16 的扩展主题同样成立)。
 */

const GHOST_THEME_TOKENS = [
  // --panel-bg 已补注册(colors.ts,alias 到 --surface):此前是宿主里的历史
  // 幽灵 token(被 9 处组件裸引用但 colors.ts 从未注册,:root 读不到值),
  // 故曾刻意排除在白名单外、只让 body 走 fallback 链兜底。注册后白名单
  // 注入真实 panel-bg 值,沙箱面板背景与宿主面板同源;body 的 fallback 链
  // 保留作纵深兜底(见下方 buildGhostThemeCss)。
  '--panel-bg',
  '--surface',
  '--surface-elevated',
  '--surface-chip',
  '--border-default',
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--text-placeholder',
  '--accent-soft',
  // 反相 CTA 一对(意识设置页的主按钮要与宿主 CTA 同观感;2026-07-13
  // filo-google「连接账号」实撞:不放行时 fallback 黑底,暗色主题下反了)。
  '--accent-cta-bg',
  '--accent-pure-cta-fg',
  '--error-bg',
  '--error-border',
  '--error-fg',
  '--focus-ring',
  // 滚动条(globals.css 统一规范同源色):意识面板照主机同款画 thumb。
  '--msg-scrollbar',
  '--msg-scrollbar-hover',
  // 工具卡四件套(data-ghost-audio 卡内播放器 1:1 对标基座 ChatAudioCard 的
  // 配色来源;注册值是 var(--surface-elevated) 这类别名引用,目标 token 也在
  // 本白名单 → iframe 内 var 链完整解析)。--text-secondary-mid 是
  // msg-tool-card-chevron 的引用目标,必须一并放行,否则链条断在中间。
  '--msg-tool-card-bg',
  '--msg-tool-card-border',
  '--msg-tool-card-text',
  '--msg-tool-card-chevron',
  '--text-secondary-mid',
  // 设置页「自定义设置区」webview 的底色对齐:guest 背景必须与宿主设置
  // 卡片同色,否则暗色主题下嵌块突兀(2026-07-13 mivo 实撞)。
  '--settings-theme-card-bg',
] as const;

/** docs/design-rules/cindy-design-system.md §3 的字体栈(意识面板与主机同字)。 */
const GHOST_FONT_STACK = `Inter, system-ui, -apple-system, "Segoe UI", sans-serif`;

/**
 * 设置页输入框的占位文字基线。
 *
 * Cindy 主题为保证 token 本身可读，给 `--text-placeholder` 保留了较高对比度，
 * 具体的“这是空值而不是已输入内容”层级由组件透明度表达。意识设置页运行在独立
 * webview，不能继承宿主 Tailwind 样式，因此由主题注入统一补齐普通字重与淡化；
 * 意识仍可用更高 specificity 覆盖这组基线。
 */
const GHOST_SETTINGS_PLACEHOLDER_CSS =
  'input::placeholder, textarea::placeholder { color: var(--text-placeholder); opacity: 0.45; font-weight: 400; }';

/**
 * 值合法性守卫:白名单 token 的值只该是主机主题色(hex / rgb(a) / hsl(a) /
 * 具名色 / 长度)。这段变量块会原样注进卡片 srcDoc 的 `<style>`(iframe)或
 * 经 insertCSS 灌进面板(webview),值不转义;出现能破 `<style>` / 声明上下文
 * 的字符(`< > { } @ ; \`)即丢弃该条(fail-closed,纵深防御)。值恒来自本应用
 * colors.ts、天然不含这些字符,此守卫防未来某 token 的值意外不是纯色。
 */
export function isSafeGhostThemeValue(value: string): boolean {
  return !/[<>{}@;\\]/.test(value);
}

/**
 * 沙箱页的明暗档(`color-scheme`)——必须与白名单色值一起显式下发。
 *
 * `color-scheme` **不跨文档继承**:theme-service.applyTheme 写在宿主 root 上的
 * `color-scheme: <theme.type>` 到不了意识沙箱页(卡片 iframe / 面板 webview 都是
 * 独立文档),而不声明的文档按 light 处理。后果分两档:
 * - **卡片 iframe(srcDoc)**:iframe canvas 透明与否,取决于 guest 的 used
 *   color-scheme 与 embedder(宿主 renderer 文档)**是否一致** —— 一致才透明、
 *   露出聊天背景;不一致就用 guest 那一档的 UA 底色填成不透明(light=白)。
 *   于是宿主暗色 + guest 未声明(按 light)= **一张不透明白 canvas**,而卡片的
 *   作者契约是"不铺底色 = 透明画布"(见 GhostToolCard.buildCardSrcDoc),不铺
 *   底色的全出血卡整张变白、切主题也不变(白来自 UA,不是任何 token)——
 *   xd-mivo 实撞。浅色主题下两者恰好一致,所以这个坑长期没被看见。实测:光写
 *   `background: transparent` 不管用,只有档位一致才让 canvas 真透明;
 * - **面板 / 设置区 webview**:body 底色由下面的基线 CSS 铺住,不会露白 canvas,
 *   但原生控件(滚动条、input / select / checkbox、日期选择器)会停在浅色档。
 *
 * 只下发 'light' | 'dark' 两个字面量,不扩大暴露面(白名单里的颜色值早已把明暗
 * 告诉了 guest,这里不含新信息),也无需过 isSafeGhostThemeValue —— 取值由本函数
 * 收敛成两个字面量,不透传 computed 原文。
 */
function readHostColorScheme(): 'light' | 'dark' {
  // computed 值可能是 'normal'(尚未 applyTheme)或未来的多值形态(如
  // 'light dark'),两者都不能直接下发;jsdom 下该属性可能整个缺失。一律
  // 回落到 root 的 dark class —— applyTheme 与它同步 toggle,是同源信号。
  const scheme = getComputedStyle(document.documentElement).colorScheme?.trim();
  if (scheme === 'light' || scheme === 'dark') return scheme;
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * 读取 :root 现值,产出 `:root { color-scheme: …; --token: value; … }` 变量块。
 * 面板与聊天卡片(卡槽③,iframe srcDoc 注入)共用同一套白名单 token —— 意识用
 * 同名 var(--xxx) 就能跟主机主题(不只 light/dark,扩展主题同样成立);明暗档由
 * color-scheme 一并下发(见 readHostColorScheme:UA 层的默认底色/原生控件只认
 * 它,不认 token)。
 *
 * color-scheme 声明在最前:一是恒有值 → 变量块永不为空(卡片 srcDoc 按非空
 * 决定是否注 `<style>`,见 buildCardSrcDoc),二是意识自己的 color-scheme 声明
 * 后置或更高 specificity 时仍能覆盖(与下面几组基线外观同一口径)。
 */
export function buildGhostThemeVarsBlock(): string {
  const style = getComputedStyle(document.documentElement);
  const vars = GHOST_THEME_TOKENS.map((token) => {
    const value = style.getPropertyValue(token).trim();
    return value && isSafeGhostThemeValue(value) ? `${token}: ${value};` : '';
  })
    .filter(Boolean)
    .join(' ');
  return `:root { color-scheme: ${readHostColorScheme()}; ${vars} }`;
}

/** 读取 :root 现值,产出注入面板 webview 的 CSS 文本(变量块 + 面板基线外观)。 */
export function buildGhostThemeCss(): string {
  return [
    buildGhostThemeVarsBlock(),
    // 沙箱页的基线外观:主机面板底色 + 主字色 + 同款字体;意识不写一行
    // 样式也能"看起来属于这个应用"。
    // --panel-bg 已注册(alias 到 --surface),白名单注入其现值;fallback 链
    // `var(--panel-bg, var(--surface))` 作纵深兜底——panel-bg 值缺失或被未来
    // 某主题置空时仍落到 --surface,不掉回 webview 默认白底(历史 2026-07-13
    // mivo 设置区实撞的根因,注册后双重保险)。
    `body { margin: 0; background: var(--panel-bg, var(--surface)); color: var(--text-primary); font-family: ${GHOST_FONT_STACK}; font-size: 13px; }`,
  ].join('\n');
}

/**
 * 设置区 webview 的注入 CSS(GhostSettingsWebview 用):变量块同面板,
 * 基线背景改用设置卡片色——guest 与它所嵌的宿主卡片无缝同色,而不是
 * 面板底色(两者在暗色主题下不同,色差会让设置区突兀成"一块")。
 */
export function buildGhostSettingsThemeCss(): string {
  return [
    buildGhostThemeVarsBlock(),
    `body { margin: 0; background: var(--settings-theme-card-bg, var(--surface)); color: var(--text-primary); font-family: ${GHOST_FONT_STACK}; font-size: 13px; }`,
    GHOST_SETTINGS_PLACEHOLDER_CSS,
  ].join('\n');
}

/** Plugin detail embeds settings.html on the shared Plugin card surface. */
export function buildGhostPluginSettingsThemeCss(): string {
  return [
    buildGhostThemeVarsBlock(),
    `body { margin: 0; background: color-mix(in srgb, var(--surface-elevated) 82%, var(--surface)); color: var(--text-primary); font-family: ${GHOST_FONT_STACK}; font-size: 13px; }`,
    GHOST_SETTINGS_PLACEHOLDER_CSS,
  ].join('\n');
}

/**
 * 订阅主机主题变化(root 上 class / style / data-theme 任一变动)。
 * 返回取消订阅函数。
 */
export function observeHostTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  });
  return () => observer.disconnect();
}

/** createGhostThemeInjector 需要的 webview 能力子集(便于单测注入 mock)。 */
export interface ThemeInjectableWebview {
  insertCSS(css: string): Promise<string>;
  removeInsertedCSS(key: string): Promise<void>;
}

/**
 * 主题注入状态机(ghostPanels 的 webview 主题下发真身,抽出来可独立单测):
 * - `inject`:token 文本没变就不灌(去重只为拦"换肤监听误触发"——root 上
 *   class/style 无关翻动会连环触发,token 未变时跨进程 insertCSS 纯属白做);
 * - `onDomReady`:每次 dom-ready 都是一份全新 document(首载,或 webview
 *   被拖动换位 / DOM reparent 触发 Electron 整页重载)——上次 insertCSS 已
 *   随旧页面蒸发,必须清掉去重状态无条件重灌,否则面板拖一下就掉主题
 *   (背景色全丢,2026-07-11 实撞);
 * - `dispose` 后一切静默。
 */
export function createGhostThemeInjector(
  webview: ThemeInjectableWebview,
  buildCss: () => string = buildGhostThemeCss,
): { inject(): void; onDomReady(): void; dispose(): void } {
  let disposed = false;
  let cssKey: string | null = null;
  let lastCss = '';
  const inject = () => {
    if (disposed) return;
    const css = buildCss();
    if (css === lastCss) return;
    lastCss = css;
    void webview
      .insertCSS(css)
      .then((key) => {
        if (disposed) return;
        const prev = cssKey;
        cssKey = key;
        if (prev) void webview.removeInsertedCSS(prev).catch(() => {});
      })
      .catch(() => {});
  };
  return {
    inject,
    onDomReady: () => {
      lastCss = '';
      cssKey = null;
      inject();
    },
    dispose: () => {
      disposed = true;
    },
  };
}
