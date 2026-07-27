#!/usr/bin/env node
// overlap-gate.mjs — 自定义重叠门(门 A-D 之外的业务断言):
// 帧1(现状):横幅与面板重叠率 ≥98%、elementFromPoint(横幅中心)命中面板、面板底色不透明;
// 帧2(意图对照):同探针命中横幅自身(方法论自证——探针能区分覆盖/未覆盖);
// 另输出三状态数值表实测(横幅高/意图面板底/撞社交行 y=480/冲出组高 560)作 evidence。
// 用法:node overlap-gate.mjs(--demo <dir>,默认脚本所在目录)。exit 2 = 门 FAIL。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const demoDir = process.argv.includes('--demo')
  ? resolve(process.argv[process.argv.indexOf('--demo') + 1])
  : dirname(fileURLToPath(import.meta.url));

// Playwright 解析(可移植,不含任何本机绝对路径):
//  1) 正常 Node resolution(createRequire,沿 demo 目录向上找 node_modules)
//  2) 仓库根 node_modules(demo 目录向上三级 ../../..)
//  3) QA_HIFI_MODULE_ROOT 环境变量显式指定(兜底;skill 标准入口)
const require_ = createRequire(join(demoDir, 'noop.js'));
const candidates = [
  () => require_('playwright'),
  () => require_(join(demoDir, '..', '..', '..', 'node_modules', 'playwright')),
];
if (process.env.QA_HIFI_MODULE_ROOT) {
  candidates.push(() => require_(join(process.env.QA_HIFI_MODULE_ROOT, 'node_modules', 'playwright')));
  candidates.push(() => require_(join(process.env.QA_HIFI_MODULE_ROOT, 'playwright')));
}
let chromium;
for (const load of candidates) {
  try { ({ chromium } = load()); break; } catch {}
}
if (!chromium) {
  console.error('playwright 未解析到(尝试过: node resolution / 仓库根 node_modules / QA_HIFI_MODULE_ROOT)');
  process.exit(2);
}

const CASES = [
  { id: 'desk-cn-light-zh', prefs: { plat: 'desk', region: 'cn', os: 'mac', mode: 'light', lang: 'zh-CN' } },
  { id: 'desk-global-dark-en', prefs: { plat: 'desk', region: 'global', os: 'mac', mode: 'dark', lang: 'en' } },
  { id: 'phone-cn-light-zh', prefs: { plat: 'phone', region: 'cn', os: 'ios', mode: 'light', lang: 'zh-CN' } },
  { id: 'phone-global-dark-en', prefs: { plat: 'phone', region: 'global', os: 'ios', mode: 'dark', lang: 'en' } },
];
const STATES = ['deletion-pending', 'deletion-processing', 'deletion-completed'];

const results = [];
let failures = 0;

// 收尾落盘抽成函数 + 顶层异常兜底(Copilot 审查):任一 page.evaluate 里的 selector
// (#frameBug / .db-banner / .lp-panel 及意图帧等价物)缺失都会抛异常,直接崩掉就
// 既没有结构化 FAIL、也不落 evidence。这里统一「记 harness 失败 + 照常落盘 + exit 2」。
let evidenceWritten = false;
function writeEvidence() {
  if (evidenceWritten) return;
  evidenceWritten = true;
  const evidenceDir = join(demoDir, 'evidence');
  if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });
  const out = {
    gate: 'overlap',
    pass: failures === 0,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failures,
    generatedAt: new Date().toISOString(),
    results,
  };
  writeFileSync(join(evidenceDir, 'overlap-gate.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`\n重叠门: ${out.passed}/${out.total} pass,evidence → evidence/overlap-gate.json`);
}
function bail(err) {
  failures++;
  results.push({
    case: 'harness',
    state: '-',
    pass: false,
    checks: { harness_ok: false },
    metrics: { error: err && err.message ? err.message : String(err) },
  });
  console.log(`FAIL harness 门执行中断:${err && err.message ? err.message : String(err)}(DOM 结构变了?selector 未命中?)`);
  writeEvidence();
  process.exit(2);
}
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 960 } })).newPage();
const base = pathToFileURL(join(demoDir, 'index.html')).href;

for (const tc of CASES) {
  for (const st of STATES) {
    await page.goto(base);
    await page.waitForFunction(() => window.__qa && window.__qa.current() != null, null, { timeout: 8000 });
    for (const [k, v] of Object.entries(tc.prefs)) {
      const el = await page.$(`[data-qa-pref="${k}:${v}"]`);
      if (el) await el.click();
    }
    await page.click(`[data-qa-state-btn="${st}"]`);
    await page.waitForFunction((id) => window.__qa.current() === id, st, { timeout: 5000 });
    const m = await page.evaluate(() => {
      const bug = document.getElementById('frameBug');
      const banner = bug.querySelector('.db-banner');
      const panel = bug.querySelector('.lp-panel');
      const rel = (el) => {
        const r = el.getBoundingClientRect(), f = bug.getBoundingClientRect();
        return { x: r.left - f.left, y: r.top - f.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      };
      const b = rel(banner), p = rel(panel);
      const ix = Math.max(0, Math.min(b.x + b.w, p.x + p.w) - Math.max(b.x, p.x));
      const iy = Math.max(0, Math.min(b.y + b.h, p.y + p.h) - Math.max(b.y, p.y));
      const ratio = (ix * iy) / (b.w * b.h);
      const hit = document.elementFromPoint(b.cx, b.cy);
      const hitIsPanel = hit === panel || panel.contains(hit);
      const bg = getComputedStyle(panel).backgroundColor;
      const aM = bg.match(/rgba?\(([^)]+)\)/);
      const alpha = aM ? (aM[1].split(',')[3] === undefined ? 1 : parseFloat(aM[1].split(',')[3])) : 1;
      const intent = document.getElementById('frameIntent');
      const iBanner = intent.querySelector('.db-banner');
      const iPanel = intent.querySelector('.lp-panel');
      const ir = iBanner.getBoundingClientRect();
      const iHit = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2);
      const iHitSelf = iHit && (iBanner === iHit || iBanner.contains(iHit));
      const k = window.__qa.scale();
      const ip = iPanel.getBoundingClientRect(), ifr = intent.getBoundingClientRect();
      const panelTopDesign = (ip.top - ifr.top) / k;
      return {
        ratio, hitIsPanel, bg, alpha, iHitSelf,
        bannerDesignH: Math.round((b.h / k) * 10) / 10,
        panelTopDesign: Math.round(panelTopDesign * 10) / 10,
        bannerPos: getComputedStyle(banner).position,
        panelPos: getComputedStyle(panel).position,
      };
    });
    const checks = {
      overlap_ge_98: m.ratio >= 0.98,
      hit_panel: m.hitIsPanel,
      panel_opaque: m.alpha === 1,
      intent_hits_banner: m.iHitSelf,
    };
    const pass = Object.values(checks).every(Boolean);
    if (!pass) failures++;
    results.push({ case: tc.id, state: st, pass, checks, metrics: m });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${tc.id} ${st} 重叠率=${(m.ratio * 100).toFixed(1)}% 命中面板=${m.hitIsPanel} α=${m.alpha} 意图帧命中横幅=${m.iHitSelf} 横幅高=${m.bannerDesignH} 意图面板顶=${m.panelTopDesign}`);
  }
}
await browser.close();

writeEvidence();
process.exit(failures === 0 ? 0 : 2);
