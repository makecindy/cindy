import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 文字色纪律(2026-10-30)—— 静态契约,全仓读取 src/ + app/ 的生产源码,属 guard tier。
 *
 * 规则来源:mobile-design-guide.md §3 / §8、DESIGN.md §4 Inputs。
 * - 主界面文字色只用五档中性色:textPrimary / textSecondary / textTertiary / textPlaceholder / ctaText;
 *   有色文字只用 DESIGN.md §2 / §15.13 已登记的语义 token。
 * - 输入框占位字只用 textPlaceholder。
 * 存量名单按次数登记、只许减少;新增有色文字用途先登记规范,再把 token 加进 SEMANTIC_TEXT_COLORS。
 */

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'app'];
const EXEMPT = [
  /__tests__/,
  /\.test\./,
  /src\/theme\/tokens\.ts$/,
  /^app\/listperf\.tsx$/,
  /^src\/debug\//,
  /^src\/auth\/loginSkinLayout\.ts$/,
  /richContentAssets\.generated\.ts$/,
];
// 登录品牌画布(已登记例外,与 typographyTokenDiscipline 一致)才可用 colors.login.*。
const LOGIN_CANVAS_FILES = [/^app\/\(auth\)\/login\.tsx$/, /^src\/components\/LoginSkinControls\.tsx$/];

function collectFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) {
        const rel = relative(ROOT, p).split(sep).join('/');
        if (!EXEMPT.some((re) => re.test(rel))) files.push(rel);
      }
    }
  };
  SCAN_DIRS.forEach((d) => walk(join(ROOT, d)));
  return files;
}
const files = collectFiles();

const NEUTRAL_TEXT_COLORS = ['textPrimary', 'textSecondary', 'textTertiary', 'textPlaceholder', 'ctaText'];
const SEMANTIC_TEXT_COLORS = [
  'errorText', 'destructive', 'statusError', 'statusDone', 'statusAccent', 'swipeActionText',
  'chatInlineCodeText', 'botUnread', 'betaChannelBadgeForeground', 'sharedTaskConfirmForeground',
  'taskTagWhite', 'taskTagWhiteCheck', // 任务标签底色上的勾与字
];
const isAllowedTextColor = (rel: string, token: string) =>
  NEUTRAL_TEXT_COLORS.includes(token) || SEMANTIC_TEXT_COLORS.includes(token)
  || (token.startsWith('login.') && LOGIN_CANVAS_FILES.some((re) => re.test(rel)))
  || /^syntax[A-Z]/.test(token);

// 已知存量(2026-10-30 盘点):键为「文件 样式名或调用 token」,值为允许出现的次数。
// 次数增加会报错;修掉后实际次数低于登记值时测试会提醒收紧。
const KNOWN_TEXT_COLOR_DEBT = new Map<string, number>([
  ['src/components/MobilePrimitives.tsx mainOptionBadgeTextSelected cta', 1], // 与 textPrimary 两模式同值
  ['src/plugins/PluginDetailView.tsx toolsToggleText inputCaret', 1], // 展开/收起用光标蓝,待设计裁决
  ['src/plugins/PluginDetailView.ios.tsx foregroundStyle inputCaret', 2], // 同上(iOS 原生)
  ['src/remote-desktop/RemoteDesktopSecuritySettings.tsx inline inputCaret', 1], // 空闲超时可用态用光标蓝文字,待设计裁决
  ['src/session/SharedTaskScreen.tsx dangerText sharedTaskConfirmBackground', 1],
  // 2026-10-31 盘点:main 上刚合入的有色文字,规范未登记这些文字用途,待设计裁决或有意可见 PR。
  ['src/session/SessionUsageSummary.tsx quotaWarn quotaBarWarn', 1], // 额度条专用色,规范写明不用于百分比文字
  ['src/session/SessionUsageSummary.tsx quotaCrit quotaBarCrit', 1], // 同上
  ['src/session/BotGroupChatScreen.tsx newReplyDivider threadUnreadDivider', 1], // 规范写明「新回复」分隔线文字保持 text-primary
  ['src/session/ContextSheetGoalView.tsx textColor prop statusRecording', 1], // 目标视图操作按钮文字用录制状态色,该 token 定义只供状态指示
  ['src/session/InteractionPanel.tsx inline statusReady', 1], // 就绪阶段文字用品牌 teal,规范只登记了状态点
  ['src/session/SessionImportSheet.tsx warn warningFg', 1], // 警告文字用金色前景,规范只登记了图标与皇冠 // 借用确认钮底色,待设计裁决
]);
const KNOWN_PLACEHOLDER_DEBT = new Map<string, number>([
  ['src/session/ContextSheet.tsx textTertiary', 1], // 占位字用了三级色,待有意可见 PR 改为 textPlaceholder
]);

const THEME_TOKEN = /\b(?:colors|c)\.([A-Za-z_][\w.]*)/g;
const tokensIn = (expr: string) => [...expr.matchAll(THEME_TOKEN)].map((m) => m[1].replace(/\.$/, ''));
/** `{` 之后配对 `}` 之前的文本(样式表达式里不含带括号的字符串,足够)。 */
const balancedFrom = (src: string, start: number) => {
  let depth = 1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i);
  }
  return src.slice(start);
};
/** 位置 index 之前最近的 JSX 开标签名,如 Text / Animated.Text / View。 */
const enclosingTag = (src: string, index: number) =>
  [...src.slice(Math.max(0, index - 1500), index).matchAll(/<([A-Z][\w.]*)\b/g)].pop()?.[1];
const isTextTag = (tag?: string) => !!tag && /(?:^|\.)(?:Text|AppText|TextInput|AppTextInput)$/.test(tag);
// SwiftUI 里明确不是文字的所有者(形状、图标、分隔、占位):它们的 foregroundStyle 不算文字色。
// 其余所有者——包括没有 JSX 标签的可复用修饰器(如 nativeGlassButtonStyle.ios.ts)——都按文字色检查。
const SWIFTUI_NON_TEXT = new Set(['Circle', 'Rectangle', 'RoundedRectangle', 'Capsule', 'Ellipse', 'UnevenRoundedRectangle', 'Image', 'Divider', 'Spacer', 'ProgressView', 'Gauge']);
const TEXT_STYLE_PROPS = /fontSize|fontWeight|lineHeight|textStyles\./;

/** 被 `<Text style={styles.x}>` / `style={[styles.a, styles.b]}` 这类写法实际用在文字组件上的样式名。 */
function namedStylesUsedOnText(source: string): Set<string> {
  const used = new Set<string>();
  // textStyle={…} 是 NativeText 等文字组件的样式属性,与 style 同等对待,不要求标签名。
  for (const attr of source.matchAll(/\b(style|textStyle)=\{/g)) {
    if (attr[1] === 'style' && !isTextTag(enclosingTag(source, attr.index!))) continue;
    for (const ref of balancedFrom(source, attr.index! + attr[0].length).matchAll(/\b(?:styles|s)\.(\w+)/g)) used.add(ref[1]);
  }
  return used;
}

/** 文字样式里出现的所有颜色 token:命名样式块、内联 style(对象、数组、条件分支)与 SwiftUI foregroundStyle。 */
/** 每个 `{ … }` 块的起止位置(按开括号顺序),用来判断一个别名声明在哪个词法作用域里可见。 */
function braceBlocks(source: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  const stack: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') stack.push(i);
    else if (source[i] === '}' && stack.length) blocks.push([stack.pop()!, i]);
  }
  return blocks;
}

/**
 * 简单局部别名:`const color = cond ? colors.a : colors.b`、`const phaseColor = colors.x`、别名套别名。
 * 按词法作用域和使用位置解析:同名别名出现在不同组件里互不覆盖;嵌套作用域取最内层、且声明在使用之前的那个。
 * 返回 (表达式文本, 表达式在源码中的位置) → 追到的 theme token。
 */
function makeColorResolver(source: string): (expr: string, at: number) => string[] {
  const blocks = braceBlocks(source);
  const innermost = (index: number): [number, number] =>
    blocks.filter(([from, to]) => from < index && index < to).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]))[0] ?? [0, source.length];
  const decls: Array<{ name: string; index: number; scope: [number, number]; tokens: string[] }> = [];
  const resolve = (expr: string, at: number): string[] => {
    const via = [...expr.matchAll(/(?<![.\w])([A-Za-z_]\w*)\b(?!\s*\.)/g)].flatMap((id) => {
      const visible = decls
        .filter((d) => d.name === id[1] && d.index < at && d.scope[0] <= at && at <= d.scope[1])
        .sort((x, y) => (x.scope[1] - x.scope[0]) - (y.scope[1] - y.scope[0]) || y.index - x.index);
      return visible[0]?.tokens ?? [];
    });
    return [...new Set([...tokensIn(expr), ...via])];
  };
  for (const m of source.matchAll(/\b(?:const|let)\s+(\w+)\s*(?::[^=\n]+)?=\s*([^;]{1,400})/g)) {
    // `const login = colors.login` 是命名空间对象,不是颜色。
    const tokens = resolve(m[2], m.index!).filter((t) => t !== 'login');
    if (tokens.length) decls.push({ name: m[1], index: m.index!, scope: innermost(m.index!), tokens });
  }
  return resolve;
}
/** `color: expr` 与对象简写 `{ color }` 的颜色表达式文本。 */
const colorExprs = (body: string): string[] => [
  ...[...body.matchAll(/\bcolor:\s*([^,}]+)/g)].map((m) => m[1]),
  ...[...body.matchAll(/(?:^|[{,])\s*color\s*(?=[,}]|$)/g)].map(() => 'color'),
];

function scanTextColors(source: string): Array<{ where: string; token: string }> {
  const found: Array<{ where: string; token: string }> = [];
  const resolve = makeColorResolver(source);
  const onText = namedStylesUsedOnText(source);
  for (const block of source.matchAll(/(?:const\s+)?(\w+)(?::|\s*=)\s*\{([^{}]*)\}/g)) {
    const [, key, body] = block;
    // 带排版属性、样式名像文字、或实际被 <Text> 引用的样式块,都算文字样式。
    if (!TEXT_STYLE_PROPS.test(body) && !/Text$|Label$|Title$|^text|^label|^title/i.test(key) && !onText.has(key)) continue;
    for (const expr of colorExprs(body)) for (const token of resolve(expr, block.index!)) found.push({ where: key, token });
  }
  for (const attr of source.matchAll(/\b(?:style|textStyle)=\{/g)) {
    const span = balancedFrom(source, attr.index! + attr[0].length);
    for (const expr of colorExprs(span)) for (const token of resolve(expr, attr.index!)) found.push({ where: 'inline', token });
  }
  // 自定义组件把文字颜色当 prop 传下去(textColor={…} / labelColor={…} 等),最终写进 <Text> 的 color。
  for (const prop of source.matchAll(/\b(text|label|title|subtitle|value|foreground)Color=\{([^}]*)\}/g)) {
    for (const token of resolve(prop[2], prop.index!)) found.push({ where: `${prop[1]}Color prop`, token });
  }
  // SwiftUI 的 foregroundStyle 也给形状、渐变、图标上色,这些所有者排除;文字控件与可复用修饰器都统计。
  for (const call of source.matchAll(/foregroundStyle\(([^)]*)\)/g)) {
    const owner = enclosingTag(source, call.index!);
    if (owner && SWIFTUI_NON_TEXT.has(owner)) continue;
    for (const token of resolve(call[1], call.index!)) found.push({ where: 'foregroundStyle', token });
  }
  return found;
}
const scanPlaceholderColors = (source: string): string[] => {
  const resolve = makeColorResolver(source);
  return [...source.matchAll(/placeholderTextColor=\{([^}]*)\}/g)].flatMap((m) => resolve(m[1], m.index!));
};

/** 计数并对照存量名单;返回违规与「可收紧」提示。 */
function reconcile(found: Map<string, number>, debt: Map<string, number>, fix: string) {
  const violations: string[] = [];
  for (const [id, count] of found) {
    const allowed = debt.get(id) ?? 0;
    if (count > allowed) violations.push(`${id} (x${count}${allowed ? `, registered x${allowed}` : ''}) -> ${fix}`);
  }
  const stale = [...debt]
    .filter(([id, allowed]) => (found.get(id) ?? 0) < allowed)
    .map(([id, allowed]) => `${id}: registered x${allowed}, found x${found.get(id) ?? 0}`);
  return { violations, stale };
}

describe('text color discipline', () => {
  it('scans style arrays, conditional branches, bare theme paths and named styles used on <Text>', () => {
    const tokens = (src: string) => scanTextColors(src).map((f) => f.token);
    expect(tokens('<Text style={[styles.label, { color: colors.border }]} />')).toEqual(['border']);
    expect(tokens('<Text style={{ color: active ? colors.textPrimary : colors.border }} />')).toEqual(['textPrimary', 'border']);
    expect(tokens('<Text style={[a, cond && { color: theme.colors.statusDone }]} />')).toEqual(['statusDone']);
    expect(tokens('const x = { fontSize: typeScale.body, color: c.inputCaret }')).toEqual(['inputCaret']);
    expect(tokens('<Text modifiers={[foregroundStyle(ok ? colors.textSecondary : colors.cta)]} />')).toEqual(['textSecondary', 'cta']);
    expect(tokens('<Circle modifiers={[foregroundStyle(colors.statusReady)]} />')).toEqual([]);
    expect(tokens('<Row textColor={colors.border} />')).toEqual(['border']);
    expect(tokens('<Row textColor={on ? colors.textPrimary : colors.border} labelColor={colors.textSecondary} />')).toEqual(['textPrimary', 'border', 'textSecondary']);
    expect(tokens('const fg = on ? colors.ctaText : colors.border;\n<Text modifiers={[foregroundStyle(fg)]} />')).toEqual(['ctaText', 'border']);
    expect(scanPlaceholderColors('<TextInput placeholderTextColor={colors.textPlaceholder} />')).toEqual(['textPlaceholder']);
    expect(tokens('<TextField modifiers={[foregroundStyle(colors.border)]} />')).toEqual(['border']);
    // 局部别名与对象简写:颜色先存进变量再写进样式,也要追到最终 token。
    expect(tokens('const color = on ? colors.destructive : colors.border;\n<Text style={{ color }} />')).toEqual(['destructive', 'border']);
    expect(tokens('const phaseColor = colors.border;\nconst x = { fontSize: typeScale.body, color: phaseColor }')).toEqual(['border']);
    expect(tokens('const base = colors.border;\nconst tone = base;\n<Text style={[a, { color: tone }]} />')).toEqual(['border']);
    // 同名别名在不同组件里互不覆盖(词法作用域 + 使用位置)。
    expect(tokens('function A() { const color = colors.border; return <Text style={{ color }} />; }\nfunction B() { const color = colors.textPrimary; return <Text style={{ color }} />; }')).toEqual(['border', 'textPrimary']);
    expect(tokens('function B() { const color = colors.textPrimary; return <Text style={{ color }} />; }\nfunction A() { const color = colors.border; return <Text style={{ color }} />; }')).toEqual(['textPrimary', 'border']);
    expect(tokens('const color = colors.textPrimary;\nfunction A() { const color = colors.border; return <Text style={{ color }} />; }')).toEqual(['border']);
    expect(scanPlaceholderColors('const placeholderColor = colors.textTertiary;\n<TextInput placeholderTextColor={placeholderColor} />')).toEqual(['textTertiary']);
    expect(scanPlaceholderColors('function A() { const p = colors.textTertiary; return <TextInput placeholderTextColor={p} />; }\nfunction B() { const p = colors.textPlaceholder; return <TextInput placeholderTextColor={p} />; }')).toEqual(['textTertiary', 'textPlaceholder']);
    expect(tokens('const other = 1;\n<Text style={{ color: other }} />')).toEqual([]);
    expect(tokens('<Image modifiers={[foregroundStyle(colors.border)]} />')).toEqual([]);
    expect(tokens('export const glass = (colors) => [foregroundStyle(colors.border)];')).toEqual(['border']);
    expect(tokens('<NativeText textStyle={{ color: colors.border }} />')).toEqual(['border']);
    expect(scanTextColors('<NativeText textStyle={styles.row}>x</NativeText>\nconst styles = { row: { color: c.border } }').map((f) => f.token)).toEqual(['border']);
    // 只覆盖 color、名字也不像文字的命名样式:被 <Text> 引用就算,不被引用(如 View 背景)不算。
    expect(scanTextColors('<Text style={styles.danger}>x</Text>\nconst styles = { danger: { color: c.border } }').map((f) => f.token)).toEqual(['border']);
    expect(scanTextColors('<Text style={[styles.base, styles.danger]}>x</Text>\nconst styles = { danger: { color: c.border } }').map((f) => f.token)).toEqual(['border']);
    expect(scanTextColors('<View style={styles.box} />\nconst styles = { box: { color: c.border } }').map((f) => f.token)).toEqual([]);
    expect(tokens('<Animated.Text style={styles.x} />\nconst styles = { x: { color: c.border } }')).toEqual(['border']);
    expect(scanPlaceholderColors('<TextInput placeholderTextColor={disabled ? colors.textTertiary : colors.textPlaceholder} />')).toEqual(['textTertiary', 'textPlaceholder']);
    expect(scanPlaceholderColors('<TextInput placeholderTextColor={theme.colors.textTertiary} />')).toEqual(['textTertiary']);
    expect(isAllowedTextColor('src/session/Other.tsx', 'login.controlText')).toBe(false);
    expect(isAllowedTextColor('src/components/LoginSkinControls.tsx', 'login.controlText')).toBe(true);
  });

  it('keeps text colors on the five neutral tiers or registered semantic text tokens', () => {
    const found = new Map<string, number>();
    for (const rel of files) {
      const source = readFileSync(join(ROOT, rel), 'utf8');
      for (const { where, token } of scanTextColors(source)) {
        if (isAllowedTextColor(rel, token)) continue;
        const id = `${rel} ${where} ${token}`;
        found.set(id, (found.get(id) ?? 0) + 1);
      }
    }
    const { violations, stale } = reconcile(found, KNOWN_TEXT_COLOR_DEBT, `use one of ${NEUTRAL_TEXT_COLORS.join(' / ')} or a registered semantic text token`);
    expect(violations).toEqual([]);
    expect(stale, '已修复的存量请从 KNOWN_TEXT_COLOR_DEBT 删除或调低次数').toEqual([]);
  });

  it('uses textPlaceholder for input placeholders (DESIGN.md §4 Inputs)', () => {
    const found = new Map<string, number>();
    for (const rel of files) {
      if (!rel.endsWith('.tsx')) continue;
      const source = readFileSync(join(ROOT, rel), 'utf8');
      for (const token of scanPlaceholderColors(source)) {
        if (token === 'textPlaceholder' || (token === 'login.controlPlaceholder' && LOGIN_CANVAS_FILES.some((re) => re.test(rel)))) continue;
        const id = `${rel} ${token}`;
        found.set(id, (found.get(id) ?? 0) + 1);
      }
    }
    const { violations, stale } = reconcile(found, KNOWN_PLACEHOLDER_DEBT, 'placeholderTextColor must be colors.textPlaceholder');
    expect(violations).toEqual([]);
    expect(stale, '已修复的存量请从 KNOWN_PLACEHOLDER_DEBT 删除或调低次数').toEqual([]);
  });
});
