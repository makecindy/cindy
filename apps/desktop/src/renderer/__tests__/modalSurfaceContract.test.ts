/**
 * DESIGN.md §4 Dialog & Modal「Overlay / Container」:所有模态弹窗共用同一个外框。
 * - 遮罩一律用 `.modal-scrim`(--overlay-modal 压暗 + 背后模糊,Windows 不模糊,见 globals.css),
 *   不在调用处另写遮罩色或 backdrop-blur;
 * - 居中面板一律用 `.modal-panel`(12px 圆角、--confirm-bg、1px Board 描边、与下拉菜单同一个 --shadow-menu 阴影),
 *   不在调用处另写圆角、底色、描边色或阴影。宽度、定位、内边距照常由调用处决定。
 * - 出现 / 消失动画也由这两个类统一提供,调用处不再挂 animate-* 类。
 * 侧边抽屉(Radix Dialog 做的右侧面板)只共用遮罩,面板按抽屉自己的样式。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const RENDERER_ROOT = resolve(__dirname, '..');
const RADIX_DIALOGS = new Set(['@radix-ui/react-dialog', '@radix-ui/react-alert-dialog']);

// 用 Radix Dialog 做的侧边抽屉:贴右边的整高面板,不是居中弹窗。
const SIDE_DRAWERS = new Set([
  'features/bots/BotGroupSettingsDrawer.tsx',
  'features/bots/BotSettingsDrawer.tsx',
  'features/bots/ChatThreadPanel.tsx',
]);

// 不经过 Radix、自己写遮罩和面板的弹窗:每个都必须同时挂着 modal-scrim 与 modal-panel,
// 删掉其中一个(改回独立底色 / 圆角)就会报出来。新增手写弹窗时登记到这里。
const HAND_BUILT_DIALOGS = new Set([
  'components/chat/GhostCardHostPrompts.tsx',
  'components/markdown/MermaidSourceEditor.tsx',
  'components/settings/AddProviderWizard.tsx',
  'components/settings/ProviderConnectionDialog.tsx',
  'features/cc-agent/CreateWorkerPopover.tsx',
  'features/right-sidebar/plugins/web-browser/BrowserTabBody.tsx',
]);

// 允许直接引用 --overlay-modal 的地方:变量注册,以及不是弹窗的面板内抽屉遮罩
// (DiffPanelShell 点遮罩即收起,DESIGN §4 已登记)。
const OVERLAY_TOKEN_ALLOWED = new Set(['components/diff-panel/DiffPanelShell.tsx']);

// 面板上不允许出现的外观类:这些都由 .modal-panel 决定。
const PANEL_OVERRIDE = /^(?:rounded(?:-.+)?|shadow(?:-.+)?|drop-shadow(?:-.+)?|bg-.+|border-\[.+\]|border-default)$/;
const SCRIM_OVERRIDE = /^(?:bg-.+|backdrop-.+)$/;
// 去掉 dark: / hover: 之类的变体前缀再判断:dark:border-[…] 同样会盖掉共享外框。
const bare = (token: string) => token.replace(/^(?:[\w-]+(?:\[[^\]]*\])?:)+/, '');

function rendererFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : rendererFiles(path);
      return /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
    })
    .sort();
}

const label = (path: string) => relative(RENDERER_ROOT, path).replaceAll('\\', '/');

/** 本文件里指向 Radix Dialog / AlertDialog 某个部件的 JSX 标签判断。 */
function radixPart(sourceFile: ts.SourceFile, part: 'Overlay' | 'Content'): (tag: string) => boolean {
  const namespaces = new Set<string>();
  const named = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!RADIX_DIALOGS.has((statement.moduleSpecifier as ts.StringLiteral).text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === part || imported.endsWith(`Dialog${part}`)) named.add(element.name.text);
      }
    }
  }
  return (tag) => {
    const [head, member, ...rest] = tag.split('.');
    if (rest.length) return false;
    return member === undefined ? named.has(head) : namespaces.has(head) && member === part;
  };
}

/** className 里所有字符串字面量(含 cn(...) 参数、三元分支与模板字符串)拆出的类名。 */
function classTokens(node: ts.JsxOpeningLikeElement, sourceFile: ts.SourceFile): string[] | null {
  const attribute = node.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'className',
  ) as ts.JsxAttribute | undefined;
  if (!attribute?.initializer) return null;
  const tokens: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) tokens.push(...child.text.split(/\s+/));
    else if (ts.isTemplateExpression(child)) {
      tokens.push(...child.head.text.split(/\s+/));
      for (const span of child.templateSpans) tokens.push(...span.literal.text.split(/\s+/));
    }
    ts.forEachChild(child, visit);
  };
  visit(attribute.initializer);
  return tokens.filter(Boolean);
}

/** 内联 style 里写了颜色、描边或阴影,同样会盖掉 .modal-scrim / .modal-panel。 */
function stylesSurface(node: ts.JsxOpeningLikeElement, sourceFile: ts.SourceFile): boolean {
  const attribute = node.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'style',
  );
  return !!attribute && /\b(?:background|backgroundColor|border|borderColor|borderRadius|boxShadow|backdropFilter)\s*:/.test(attribute.getText(sourceFile));
}

function offenders(path: string): string[] {
  const file = label(path);
  const source = readFileSync(path, 'utf8');
  const radix = [...RADIX_DIALOGS].some((module) => source.includes(module));
  if (!radix && !/modal-(?:scrim|panel)/.test(source)) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const isOverlay = radixPart(sourceFile, 'Overlay');
  const isContent = radixPart(sourceFile, 'Content');
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      const at = `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
      const own = classTokens(node, sourceFile) ?? [];
      // 手写弹窗与任何挂了共享类的元素:同样不得再自带外观或动画。
      if (!isOverlay(tag) && !isContent(tag) && (own.includes('modal-scrim') || own.includes('modal-panel'))) {
        const override = own.includes('modal-scrim') ? SCRIM_OVERRIDE : PANEL_OVERRIDE;
        const extra = own.filter((token) => override.test(bare(token)) || /^animate-/.test(bare(token)));
        if (extra.length) found.push(`${at} 手写弹窗自带 ${extra.join(' ')}`);
        if (stylesSurface(node, sourceFile)) found.push(`${at} 手写弹窗用内联样式改外观`);
      }
      if (isOverlay(tag)) {
        const tokens = classTokens(node, sourceFile) ?? [];
        if (!tokens.includes('modal-scrim')) found.push(`${at} 遮罩缺少 modal-scrim`);
        const extra = tokens.filter((token) => SCRIM_OVERRIDE.test(bare(token)) || /^animate-/.test(bare(token)));
        if (extra.length) found.push(`${at} 遮罩自带 ${extra.join(' ')}`);
        if (stylesSurface(node, sourceFile)) found.push(`${at} 遮罩用内联样式改颜色`);
      } else if (isContent(tag) && !SIDE_DRAWERS.has(file)) {
        const tokens = classTokens(node, sourceFile) ?? [];
        if (!tokens.includes('modal-panel')) found.push(`${at} 面板缺少 modal-panel`);
        const extra = tokens.filter((token) => PANEL_OVERRIDE.test(bare(token)) || /^animate-/.test(bare(token)));
        if (extra.length) found.push(`${at} 面板自带 ${extra.join(' ')}`);
        if (stylesSurface(node, sourceFile)) found.push(`${at} 面板用内联样式改外观`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('modal surface contract', () => {
  const files = rendererFiles(RENDERER_ROOT);

  it('every Radix dialog uses the shared scrim and panel', () => {
    expect(files.flatMap(offenders)).toEqual([]);
  });

  it('registered hand-built dialogs keep both shared classes', () => {
    const missing = [...HAND_BUILT_DIALOGS].filter((file) => {
      const source = readFileSync(resolve(RENDERER_ROOT, file), 'utf8');
      return !source.includes('modal-scrim') || !source.includes('modal-panel');
    });
    expect(missing).toEqual([]);
  });

  it('hand-built scrims use .modal-scrim instead of the raw overlay token', () => {
    const raw = files
      .filter((path) => !label(path).startsWith('themes/') && !OVERLAY_TOKEN_ALLOWED.has(label(path)))
      .filter((path) => /var\(--overlay-modal/.test(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
      .map(label);
    expect(raw).toEqual([]);
  });

  it('the shared scrim blurs except on Windows, and the panel carries the menu shadow', () => {
    const css = readFileSync(resolve(RENDERER_ROOT, 'styles/globals.css'), 'utf8');
    const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.modal-scrim')).toMatch(/background-color:\s*var\(--overlay-modal\)/);
    expect(rule('.modal-scrim')).toMatch(/backdrop-filter:\s*blur\(4px\)/);
    expect(rule("[data-platform='win32'] .modal-scrim")).toMatch(/backdrop-filter:\s*none/);
    expect(rule('.modal-panel')).toMatch(/border-radius:\s*0\.75rem/);
    expect(rule('.modal-panel')).toMatch(/border:\s*1px solid var\(--border-default\)/);
    expect(rule('.modal-panel')).toMatch(/background-color:\s*var\(--confirm-bg\)/);
    expect(rule('.modal-panel')).toMatch(/box-shadow:\s*var\(--shadow-menu\)/);
  });

  it('dialogs share one enter / exit motion on motion tokens', () => {
    const css = readFileSync(resolve(RENDERER_ROOT, 'styles/globals.css'), 'utf8');
    const keyframes = (name: string) => css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    // 布局居中(inset-0 + m-auto)的面板走 modal-panel-in:不得带 translate(-50%,-50%)。
    expect(keyframes('modal-panel-in')).toMatch(/translateY\(8px\) scale\(0\.96\)/);
    expect(keyframes('modal-panel-in')).not.toMatch(/-50%/);
    // transform 居中的面板必须把 translate(-50%,-50%) 烘进首尾帧,否则入场时跳到左上。
    expect(keyframes('modal-panel-in-centered')).toMatch(/from[\s\S]*translate\(-50%, -50%\)[\s\S]*to[\s\S]*translate\(-50%, -50%\)/);
    expect(css).toMatch(/\.modal-panel\.-translate-x-1\\\/2\s*\{\s*animation-name:\s*modal-panel-in-centered/);
    expect(css).toMatch(/\.modal-scrim\s*\{[^}]*animation:\s*modal-scrim-in var\(--motion-enter\) var\(--motion-ease-out\)/);
    expect(css).toMatch(/\.modal-panel\s*\{[^}]*animation:\s*modal-panel-in var\(--motion-enter\) var\(--motion-ease-out\)/);
    // 消失只淡出,不倒放入场。
    expect(css).toMatch(/\.modal-scrim\[data-state='closed'\],\s*\.modal-panel\[data-state='closed'\]\s*\{\s*animation:\s*modal-fade-out var\(--motion-exit\) var\(--motion-ease-in\) forwards/);
  });
});
