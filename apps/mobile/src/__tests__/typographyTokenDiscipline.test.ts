import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fontWeight, lineHeight, textStyles, typeScale } from '@/theme/tokens';

/**
 * 排版纪律守护测试 —— 保证 src/ + app/ 的排版属性全部走 @/theme token,不再出现字面量漂移。
 *
 * 背景:2026-07 排版收敛前,仓库里有 26 处字面 fontSize、124 处字面 lineHeight、
 * ~180 处字面 fontWeight,包括阶梯外的幽灵字号(10/14/17/30)。收敛后靠本测试防回潮:
 * 新增字号 / 行高 / 字重必须先扩 tokens.ts 的档位,再在组件里引用 token。
 *
 * 同时守护 AppText 纪律:业务代码不许直接从 react-native 值导入 Text / TextInput
 * (会绕过全局 maxFontSizeMultiplier 限幅),必须走 @/components/AppText。
 */

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'app'];
/** 不扫描:token 定义本体、测试自身、DEV-only 性能测量脚手架(listperf harness + src/debug,
 * 用 __DEV__ 门控、不进生产;其调试样式如琥珀色统计文字/tabular-nums 本就不走生产 token)。
 * WebView HTML 生成器用的是 CSS 语法(font-size:),天然不命中。 */
const EXEMPT = [
  /__tests__/,
  /\.test\./,
  /src\/theme\/tokens\.ts$/,
  /^app\/listperf\.tsx$/,
  /^src\/debug\//,
  // loginSkinLayout 是登录皮肤设计 px 常量本体(750 稿坐标系,渲染时 ×groupScale,与物理
  // pt 排版阶梯不同域,不该也不能映射 typeScale/lineHeight 档位)。地位等同 tokens.ts:
  // 只许常量定义,消费端(组件)仍被本守护全量扫描——字面量只能进这里,不能进组件。
  /^src\/auth\/loginSkinLayout\.ts$/,
  /richContentAssets\.generated\.ts$/,
];
/** AppText 是 RN Text / TextInput 的唯一合法包装点。 */
const APP_TEXT_WRAPPER = /src\/components\/AppText\.tsx$/;

function collectFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) {
        // Windows 上 path.relative 产出反斜杠分隔,先归一化为 POSIX 再跑豁免正则,
        // 否则 AppText / tokens.ts 豁免在 Windows 失配,守护测试会误扫包装器自身。
        const rel = relative(ROOT, p).split(sep).join('/');
        if (!EXEMPT.some((re) => re.test(rel))) files.push(rel);
      }
    }
  };
  SCAN_DIRS.forEach((d) => walk(join(ROOT, d)));
  return files;
}

const files = collectFiles();

describe('typography token discipline', () => {
  it('forbids literal fontSize / lineHeight / fontWeight in styles', () => {
    const violations: string[] = [];
    for (const rel of files) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/fontSize:\s*\d/.test(line))
          violations.push(`${rel}:${i + 1} literal fontSize -> use typeScale`);
        if (/lineHeight:\s*\d/.test(line))
          violations.push(
            `${rel}:${i + 1} literal lineHeight -> use lineHeight token`,
          );
        if (/fontSize=\{\d/.test(line))
          violations.push(
            `${rel}:${i + 1} literal fontSize JSX prop -> use typeScale`,
          );
        if (/lineHeight=\{\d/.test(line))
          violations.push(
            `${rel}:${i + 1} literal lineHeight JSX prop -> use lineHeight token`,
          );
        if (/fontWeight:\s*(['"]|\d)/.test(line))
          violations.push(
            `${rel}:${i + 1} literal fontWeight -> use fontWeight token`,
          );
        if (/letterSpacing:\s*0[,\s}]/.test(line))
          violations.push(
            `${rel}:${i + 1} letterSpacing: 0 is a no-op, remove it`,
          );
      });
    }
    expect(violations).toEqual([]);
  });

  it('forbids importing Text / TextInput values directly from react-native (use @/components/AppText)', () => {
    const violations: string[] = [];
    for (const rel of files) {
      if (APP_TEXT_WRAPPER.test(rel)) continue;
      const src = readFileSync(join(ROOT, rel), 'utf8');
      for (const m of src.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*['"]react-native['"]/gs,
      )) {
        const names = m[1]
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n && !n.startsWith('type '));
        for (const n of names) {
          const base = n.split(/\s+as\s+/)[0].trim();
          if (base === 'Text' || base === 'TextInput') {
            violations.push(
              `${rel}: imports ${base} from react-native, use @/components/AppText`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('defaults all AppText TextInput carets and selections to the Cindy input caret token', () => {
    const source = readFileSync(
      join(ROOT, 'src/components/AppText.tsx'),
      'utf8',
    );

    expect(source).toContain(
      "import { useTheme } from '@/theme/ThemeProvider';",
    );
    expect(source).toContain('const { colors } = useTheme();');
    expect(source).toContain('cursorColor={colors.inputCaret}');
    expect(source).toContain('selectionColor={colors.inputCaret}');
  });

  it('forbids red literal cursor / selection colors in mobile inputs', () => {
    const redCaretLiteral =
      /(?:cursorColor|selectionColor)=\{?['"](?:#DF0C27|#A61629|#D91F37|#f43d3f)['"]\}?/i;
    const violations: string[] = [];

    for (const rel of files) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (redCaretLiteral.test(line)) {
          violations.push(
            `${rel}:${i + 1} red cursor / selection literal -> use colors.inputCaret (#417CDD)`,
          );
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('keeps textStyles presets composed from the typeScale / lineHeight ladders', () => {
    const sizes = new Set<number>(Object.values(typeScale));
    const heights = new Set<number>(Object.values(lineHeight));
    for (const [name, preset] of Object.entries(textStyles)) {
      expect(
        sizes.has(preset.fontSize),
        `textStyles.${name}.fontSize 必须来自 typeScale`,
      ).toBe(true);
      expect(
        heights.has(preset.lineHeight),
        `textStyles.${name}.lineHeight 必须来自 lineHeight 表`,
      ).toBe(true);
      expect(
        preset.lineHeight,
        `textStyles.${name} 行高必须大于字号`,
      ).toBeGreaterThan(preset.fontSize);
    }
  });

  it('keeps the fontWeight ladder restrained (4 tiers, bold reserved)', () => {
    expect(Object.keys(fontWeight)).toEqual([
      'regular',
      'medium',
      'semibold',
      'bold',
    ]);
  });
});
