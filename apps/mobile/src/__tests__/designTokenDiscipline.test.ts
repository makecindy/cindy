import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { iconSize, iconStroke, radius } from '@/theme/tokens';

/**
 * 设计 token 纪律守护测试 —— 排版之外的另外三类视觉不变量:图标尺寸、图标描边、圆角。
 * (排版类见 typographyTokenDiscipline.test.ts,两者共用同一套「先扩档、再引用」的纪律。)
 *
 * 背景:2026-07 收敛前,仓库里有 151 处字面 icon size(21 种值,其中 9 种阶梯外幽灵档)、
 * ~200 处字面 strokeWidth(14 种碎片值,1.5~3 之间视觉意图不可辨)、
 * ~20 处漂移 borderRadius(0/1/2/3/4/5/8/10/16/18/24/30)。收敛后靠本测试防回潮:
 * 新档位必须先扩 tokens.ts,再在组件里引用 token;确有组件几何专用值时,
 * 在下方 ALLOWLIST 登记(file + 行内容片段 + 原因),并在代码处留行内注释。
 *
 * 同时守护颜色纪律:.tsx 组件里禁止字面 hex / rgba 色(必须走 useTheme().colors 或 token);
 * WebView HTML 生成器(*Html.ts,CSS-in-template,theme 由调用方注入、fallback 引 lightColors)
 * 与 ImageLightbox(常黑沉浸语境的黑白系豁免,对齐桌面 docs/design-rules/cindy-design-system.md overlay/lightbox 豁免)除外。
 */

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'app'];
/** 不扫描:token 定义与主题实现本体、测试自身、DEV-only 性能测量脚手架(listperf harness + src/debug,
 * __DEV__ 门控、不进生产;调试样式故意不走生产 token)。 */
const EXEMPT = [
  /__tests__/,
  /\.test\./,
  /^src\/theme\//,
  /^app\/listperf\.tsx$/,
  /^src\/debug\//,
  /richContentAssets\.generated\.ts$/,
];
/** 颜色规则额外豁免:WebView HTML 生成器(CSS 模板)与 lightbox 黑白语境。 */
const COLOR_EXEMPT = [/Html\.ts$/i, /src\/session\/ImageLightbox\.tsx$/];

/** 组件几何 / 特殊语义的登记豁免:file 后缀匹配 + 行内容包含 snippet 即放行。 */
const ALLOWLIST: Array<{ file: string; snippet: string; reason: string }> = [
  {
    file: 'src/session/MobileComposerInputRow.tsx',
    snippet: 'borderRadius: 30',
    reason: 'composer 多行形态组件几何(desktop-first 测试钉死)',
  },
  {
    file: 'app/devices/index.tsx',
    snippet: 'size={9}',
    reason: 'Pencil 微徽标,徽标容器几何依赖 9px',
  },
  {
    file: 'app/devices/index.tsx',
    snippet: '? 19 : iconSize.lg',
    reason: 'Claude logo 视觉重量偏小的 +1px 光学补偿',
  },
  {
    file: 'app/sessions/[sessionId].tsx',
    snippet: 'size={10}',
    reason: '停止按钮实心 Square(填充块语义,非阶梯图标)',
  },
  {
    file: 'app/sessions/[sessionId].tsx',
    snippet: 'strokeWidth={0}',
    reason: '实心填充图标,零描边为语义本身',
  },
  {
    file: 'app/files/[sessionId].tsx',
    snippet: 'borderRadius: 2',
    reason: '文档缩略图卡刻意 2px 锐角(iOS Files 风格)',
  },
  {
    file: 'src/session/ComposerAttachmentTray.tsx',
    snippet: 'size={10} strokeWidth={2.5}',
    reason: '标注角标微徽标几何(红底 12px 徽标内画笔,阶梯档过大)',
  },
  {
    file: 'app/devices/index.tsx',
    snippet: 'borderRadius: 0',
    reason: '显式方角覆盖,非漂移(通栏布局回退恢复,用户改稿 2026-07-21)',
  },
];

function collectFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) {
        // Windows 上 path.relative 产出反斜杠分隔,先归一化为 POSIX 再跑豁免正则。
        const rel = relative(ROOT, p).split(sep).join('/');
        if (!EXEMPT.some((re) => re.test(rel))) files.push(rel);
      }
    }
  };
  SCAN_DIRS.forEach((d) => walk(join(ROOT, d)));
  return files;
}

/** 命中计数:除了放行,还用于「陈旧条目」检测(0 命中的登记项必须清理,防 allowlist 腐化)。 */
const allowlistHits = new Map<(typeof ALLOWLIST)[number], number>(
  ALLOWLIST.map((entry) => [entry, 0]),
);

function allowlisted(rel: string, line: string): boolean {
  let hit = false;
  for (const entry of ALLOWLIST) {
    if (rel.endsWith(entry.file) && line.includes(entry.snippet)) {
      allowlistHits.set(entry, (allowlistHits.get(entry) ?? 0) + 1);
      hit = true;
    }
  }
  return hit;
}

const files = collectFiles();

describe('design token discipline (iconSize / iconStroke / radius / colors)', () => {
  it('forbids literal icon size / strokeWidth / borderRadius in components', () => {
    const violations: string[] = [];
    for (const rel of files) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      src.split('\n').forEach((raw, i) => {
        const line = raw;
        if (allowlisted(rel, line)) return;
        // size={16} / size={compact ? 22 : 24} 等 JSX 花括号内含数字字面量。
        // 数字必须紧跟 `{` 或非 [标识符字符/`.`] 之后:token 引用(size={iconSize.md})
        // 与含数字的标识符(size={size2x})不命中,size={19} / size={x ? 19 : y} 仍命中。
        if (/\bsize=\{(?:[^}]*[^\w.])?\d/.test(line)) {
          violations.push(
            `${rel}:${i + 1} literal icon size -> use iconSize token`,
          );
        }
        if (/strokeWidth=\{[^}]*\d/.test(line)) {
          violations.push(
            `${rel}:${i + 1} literal strokeWidth -> use iconStroke token`,
          );
        }
        if (/borderRadius:\s*\d/.test(line)) {
          violations.push(
            `${rel}:${i + 1} literal borderRadius -> use radius token`,
          );
        }
        // token 算术逃逸(typeScale.title - 1 / radius.control + 2 等):产出阶梯外幽灵值,
        // 等同字面量。需要新档位回 tokens.ts 扩档(17 已有 bodyLarge)。
        // spacing 刻意不入列:它有大量合法布局算式(列宽均分、多段 padding 求和)。
        if (
          /(?:typeScale|lineHeight|iconSize|iconStroke|radius)\.\w+\s*[-+*]\s*\d/.test(
            line,
          )
        ) {
          violations.push(
            `${rel}:${i + 1} token arithmetic -> use an existing ladder step or extend tokens.ts`,
          );
        }
      });
    }
    expect(violations).toEqual([]);

    // ALLOWLIST 陈旧检测:上面整仓扫描后仍 0 命中的登记项已随代码演进失效,必须同步删除,
    // 否则残留条目会静默放行未来同名违规。
    const stale = ALLOWLIST.filter(
      (entry) => (allowlistHits.get(entry) ?? 0) === 0,
    ).map(
      (entry) => `stale allowlist entry: ${entry.file} :: ${entry.snippet}`,
    );
    expect(stale).toEqual([]);
  });

  it('forbids literal hex / rgba colors in components (use theme colors)', () => {
    const violations: string[] = [];
    for (const rel of files) {
      if (COLOR_EXEMPT.some((re) => re.test(rel))) continue;
      const src = readFileSync(join(ROOT, rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        // 命中 color/backgroundColor/borderColor/shadowColor/tintColor 等
        // 样式键或 JSX color= prop 上的字面 hex / rgba。
        if (/olor(:\s*|=\{?\s*)['"`](#[0-9a-fA-F]|rgba?\()/.test(line)) {
          violations.push(
            `${rel}:${i + 1} literal color -> use useTheme().colors / token`,
          );
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('token ladders stay sorted and collision-free', () => {
    // 阶梯值必须严格递增(pill 哨兵值除外),防止未来扩档时插出重复值/乱序档。
    const sizes = Object.values(iconSize);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    expect(new Set(sizes).size).toBe(sizes.length);

    const strokes = Object.values(iconStroke);
    expect([...strokes].sort((a, b) => a - b)).toEqual(strokes);
    expect(new Set(strokes).size).toBe(strokes.length);

    const radii = Object.values(radius);
    expect([...radii].sort((a, b) => a - b)).toEqual(radii);
    expect(new Set(radii).size).toBe(radii.length);
  });
});
