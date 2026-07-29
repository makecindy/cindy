/**
 * 手机登录页「字标↔面板」间距对比图的真值提取器。
 *
 * 真值来源(禁手抄):
 *  - 当前 PR 值 = 直接 import apps/mobile/src/auth/loginSkinLayout.ts(纯数据零 RN);
 *  - main 值 = git show origin/main 同文件后 import,同一把尺子量两次。
 * 资产 = apps/mobile/assets/login/ 真图(demo 内 assets/ 为其 @2x 副本),不用占位图。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const REPO = process.argv[2];
const SRC = 'apps/mobile/src/auth/loginSkinLayout.ts';

/**
 * TS 源码文本 → 已加载的 ES module(沿用 login-deletion-bubble/extract.mjs 的既有范式)。
 *
 * 两处刻意为之:
 *  - `pathToFileURL(...).href` 而不是裸路径 —— Windows 上 `import('C:\\...')` 会被当成
 *    包名解析而失败,动态 import 必须给 file:// URL(跨平台,AGENTS.md 规则 15);
 *  - `finally` 里 `rmSync` 删临时目录 —— 否则每跑一次就在 os.tmpdir() 留一个
 *    `mobile-gap-*` 目录慢慢堆积。
 */
async function loadFrom(tsText, tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `mobile-gap-${tag}-`));
  try {
    const out = path.join(dir, 'layout.mjs');
    writeFileSync(out, transformSync(tsText, { loader: 'ts', format: 'esm' }).code, 'utf8');
    return await import(pathToFileURL(out).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const currentTs = readFileSync(path.join(REPO, SRC), 'utf8');
const mainTs = execFileSync('git', ['show', `origin/main:${SRC}`], { cwd: REPO, encoding: 'utf8' });

const cur = await loadFrom(currentTs, 'cur');
const base = await loadFrom(mainTs, 'main');

/** 面板内几何一律取当前实现(手机端面板已回 main 等价,两侧同源)。 */
const panel = {
  group: cur.LOGIN_GROUP,
  title: cur.LOGIN_TITLE,
  subtitle: cur.LOGIN_SUBTITLE,
  control: cur.LOGIN_CONTROL,
  social: cur.LOGIN_SOCIAL,
  consent: cur.LOGIN_CONSENT_ROW,
  errorText: cur.LOGIN_ERROR_TEXT,
};

function variant(mod, label) {
  const rows = {};
  for (const [key, stage] of [['short', mod.LOGIN_STAGE_SHORT], ['long', mod.LOGIN_STAGE_LONG]]) {
    const wordBottom = stage.word.y + stage.word.h;
    rows[key] = {
      designHeight: stage.designHeight,
      cindy: stage.cindy,
      slogan: stage.slogan,
      word: stage.word,
      loginY: stage.loginY,
      wordBottom,
      gap: Number((stage.loginY - wordBottom).toFixed(2)),
    };
  }
  return { label, ...rows };
}

/** figma 新稿配套的功能区落位(figma-component-spec.md §12 表 wave6 逐值记录)。 */
const FIGMA_LOGIN_Y = { short: 622, long: 827 };

/**
 * 稿内两个明确意图(figma-component-spec §12 表 wave6):主容器 680x882
 * (字标 180 + Log_in 620 @y200 + 服务条款 40 @y842) → 短屏 @(35,422) 底 1304 底距 30、
 * Log_in y=622;长屏 @(35,627) 底 1509 底距 115、Log_in y=827。
 * 手机端剥离跳过登录栏后组高 620→560,内容底 = loginY + 622(协议行溢出 62)。
 * 两种吸收方式:
 *  B = 面板留稿位(顶部同稿,多出的 60 全给底部留白);
 *  A = 品牌簇整体下移 60(字标↔面板 + 底距 双双同稿,顶部留白多 60-避脸上移量)。
 */
const FIG_BOTTOM_GAP = { short: 30, long: 115 };
const CONTENT_BELOW_LOGIN_Y = 622;
function planA(mod) {
  const r = {};
  for (const [k, stage] of [['short', mod.LOGIN_STAGE_SHORT], ['long', mod.LOGIN_STAGE_LONG]]) {
    const loginY = stage.designHeight - FIG_BOTTOM_GAP[k] - CONTENT_BELOW_LOGIN_Y;
    const figGap = FIGMA_LOGIN_Y[k] - (stage.word.y + stage.word.h);
    const wordY = loginY - figGap - stage.word.h;
    const shift = Number((wordY - stage.word.y).toFixed(2));
    const mv = (b) => ({ ...b, y: Number((b.y + shift).toFixed(2)) });
    r[k] = {
      designHeight: stage.designHeight,
      cindy: mv(stage.cindy), slogan: mv(stage.slogan), word: mv(stage.word),
      loginY, wordBottom: Number((wordY + stage.word.h).toFixed(2)),
      gap: Number(figGap.toFixed(2)), shift,
    };
  }
  return { label: '方案A 品牌簇整体下移', ...r };
}

const out = {
  generatedFrom: { src: SRC, mainRef: 'origin/main' },
  current: variant(cur, '本 PR 修复后'),
  main: variant(base, 'origin/main 现状（已含 #697）'),
  figmaLoginY: FIGMA_LOGIN_Y,
  figmaGap: {
    short: Number((FIGMA_LOGIN_Y.short - (cur.LOGIN_STAGE_SHORT.word.y + cur.LOGIN_STAGE_SHORT.word.h)).toFixed(2)),
    long: Number((FIGMA_LOGIN_Y.long - (cur.LOGIN_STAGE_LONG.word.y + cur.LOGIN_STAGE_LONG.word.h)).toFixed(2)),
  },
  panel,
  planA: planA(cur),
  contentBelowLoginY: CONTENT_BELOW_LOGIN_Y,
  figBottomGap: FIG_BOTTOM_GAP,
};
console.log(JSON.stringify(out, null, 2));
