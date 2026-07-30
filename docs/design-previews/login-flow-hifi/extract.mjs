#!/usr/bin/env node
// extract.mjs — cindy 桌面登录链路 QA demo 真值提取器。
// 机械提取,不手抄:布局常量/缩放公式经 esbuild 编译产品 TS 后 import;
// 颜色 token 正则解析 themes/colors.ts;文案 JSON.parse 四语 common.json;
// 协议链接/窗口最小尺寸/内联 SVG path 正则定位源码;adaptive.samples 用
// 产品 loginScale.ts 的真公式预计算。stdout 输出 truth JSON。

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, '..', '..', '..');
const R = (p) => resolve(repoRoot, p); // 绝对路径
const rel = (p) => `../../../${p}`; // provenance 用的 demoDir 相对路径(docs/design-previews/<name>/ → 仓库根)

const hashes = new Map();
function fileHash(absPath) {
  if (!hashes.has(absPath)) {
    hashes.set(absPath, createHash('sha256').update(readFileSync(absPath)).digest('hex'));
  }
  return hashes.get(absPath);
}

/** 包一个 truth 叶子:value + provenance(source 相对 demoDir,hash=源文件 sha256)。 */
function leaf(value, srcRelRepo, locator) {
  return {
    value,
    provenance: { source: rel(srcRelRepo), locator, hash: `sha256:${fileHash(R(srcRelRepo))}` },
  };
}

/* ── 1. 布局常量 + 缩放公式:esbuild 编译产品 TS 后 import ── */
const require2 = createRequire(join(repoRoot, 'package.json'));
const esbuild = require2('esbuild');
const tmp = mkdtempSync(join(tmpdir(), 'login-hifi-extract-'));
const TOKENS_TS = 'apps/desktop/src/renderer/components/login/loginDesignTokens.ts';
const SCALE_TS = 'apps/desktop/src/renderer/components/login/loginScale.ts';
const METHOD_TS = 'apps/desktop/src/shared/loginIdentifierMethod.ts';
let tokens, scaleMod, methodMod;
try {
  for (const [src, out, transform] of [
    [TOKENS_TS, 'tokens.mjs'],
    // loginScale.ts 自 2026-07-27 改版起 import LOGIN_GROUP(组高单一来源):
    // 临时目录里文件名被扁平化,把相对 import 重定向到同批编译的 tokens.mjs
    [
      SCALE_TS,
      'scale.mjs',
      (code) => code.replace(/from\s*['"]\.\/loginDesignTokens['"]/g, "from './tokens.mjs'"),
    ],
    [METHOD_TS, 'method.mjs'],
  ]) {
    let code = esbuild.transformSync(readFileSync(R(src), 'utf8'), {
      loader: 'ts',
      format: 'esm',
    }).code;
    if (transform) code = transform(code);
    writeFileSync(join(tmp, out), code);
  }
  tokens = await import(pathToFileURL(join(tmp, 'tokens.mjs')).href);
  scaleMod = await import(pathToFileURL(join(tmp, 'scale.mjs')).href);
  methodMod = await import(pathToFileURL(join(tmp, 'method.mjs')).href);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/** 把编译 import 得到的对象逐叶包 provenance(locator = export 路径)。 */
function wrapObj(obj, srcRelRepo, prefix) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] =
      v !== null && typeof v === 'object'
        ? wrapObj(v, srcRelRepo, `${prefix}.${k}`)
        : leaf(v, srcRelRepo, `${prefix}.${k}`);
  }
  return out;
}

const geometry = {
  stage: wrapObj({ width: scaleMod.LOGIN_STAGE_WIDTH, height: scaleMod.LOGIN_STAGE_HEIGHT }, SCALE_TS, 'LOGIN_STAGE_*'),
  hero: wrapObj(tokens.HERO, TOKENS_TS, 'HERO'),
  wordmark: wrapObj(tokens.WORDMARK, TOKENS_TS, 'WORDMARK'),
  slogan: wrapObj(tokens.SLOGAN, TOKENS_TS, 'SLOGAN'),
  loginGroup: wrapObj(tokens.LOGIN_GROUP, TOKENS_TS, 'LOGIN_GROUP'),
  localMode: wrapObj(tokens.LOGIN_LOCAL_MODE, TOKENS_TS, 'LOGIN_LOCAL_MODE'),
  panel: wrapObj(tokens.PANEL, TOKENS_TS, 'PANEL'),
  title: wrapObj(tokens.TITLE, TOKENS_TS, 'TITLE'),
  subtitle: wrapObj(tokens.SUBTITLE, TOKENS_TS, 'SUBTITLE'),
  regionPill: wrapObj(tokens.REGION_PILL, TOKENS_TS, 'REGION_PILL'),
  control: wrapObj(tokens.CONTROL, TOKENS_TS, 'CONTROL'),
  spinner: wrapObj(tokens.SPINNER, TOKENS_TS, 'SPINNER'),
  social: wrapObj(tokens.SOCIAL, TOKENS_TS, 'SOCIAL'),
  back: wrapObj(tokens.BACK, TOKENS_TS, 'BACK'),
  errorText: wrapObj(tokens.ERROR_TEXT, TOKENS_TS, 'ERROR_TEXT'),
  methodRow: wrapObj(tokens.METHOD_ROW, TOKENS_TS, 'METHOD_ROW'),
  loadingRing: wrapObj(tokens.LOADING_RING, TOKENS_TS, 'LOADING_RING'),
  textLink: wrapObj(tokens.TEXT_LINK, TOKENS_TS, 'TEXT_LINK'),
  ssoOrgHint: wrapObj(tokens.SSO_ORG_HINT, TOKENS_TS, 'SSO_ORG_HINT'),
  consentRow: wrapObj(tokens.CONSENT_ROW, TOKENS_TS, 'CONSENT_ROW'),
  consentDialog: wrapObj(tokens.CONSENT_DIALOG, TOKENS_TS, 'CONSENT_DIALOG'),
  dragBarHeight: leaf(tokens.DRAG_BAR_HEIGHT, TOKENS_TS, 'DRAG_BAR_HEIGHT'),
};

/* ── 2. 颜色 token:正则解析 registerColor('login-*', {light, dark}) ── */
const COLORS_TS = 'apps/desktop/src/renderer/themes/colors.ts';
const colorsSrc = readFileSync(R(COLORS_TS), 'utf8');
function tokenPair(name) {
  const re = new RegExp(
    `registerColor\\('${name}',\\s*\\{\\s*light:\\s*'([^']+)',\\s*dark:\\s*'([^']+)',?\\s*\\}`,
  );
  const m = colorsSrc.match(re);
  if (!m) throw new Error(`colors.ts 未找到 token ${name}`);
  return {
    light: leaf(m[1], COLORS_TS, `registerColor('${name}').light`),
    dark: leaf(m[2], COLORS_TS, `registerColor('${name}').dark`),
  };
}
const colorNames = {
  bgBase: 'login-bg-base',
  panelBg: 'login-panel-bg',
  panelBorder: 'login-panel-border',
  brandAccent: 'login-brand-accent',
  controlBg: 'login-control-bg',
  actionControlBg: 'login-action-control-bg',
  backBorder: 'login-back-border',
  controlBorder: 'login-control-border',
  controlBorderActive: 'login-control-border-active',
  controlBorderDisabled: 'login-control-border-disabled',
  controlText: 'login-control-text',
  controlPlaceholder: 'login-control-placeholder',
  titleText: 'login-title-text',
  secondaryText: 'login-secondary-text',
  primaryButtonBg: 'login-primary-button-bg',
  primaryButtonBorder: 'login-primary-button-border',
  primaryButtonText: 'login-primary-button-text',
  disabledButtonBg: 'login-disabled-button-bg',
  disabledButtonText: 'login-disabled-button-text',
  invertedButtonBorder: 'login-inverted-button-border',
  linkText: 'login-link-text',
  linkHover: 'login-link-hover',
  linkPressed: 'login-link-pressed',
  errorFg: 'login-error-fg',
  appleCircleBg: 'login-apple-circle-bg',
  consentRadioBg: 'login-consent-radio-bg',
  consentRadioBorder: 'login-consent-radio-border',
  consentRadioCheckedBg: 'login-consent-radio-checked-bg',
  consentRadioCheck: 'login-consent-radio-check',
  consentOverlay: 'login-consent-overlay',
  secondaryButtonBg: 'login-secondary-button-bg',
  secondaryButtonBorder: 'login-secondary-button-border',
  secondaryButtonText: 'login-secondary-button-text',
  loadingRingTrack: 'login-loading-ring-track',
  overlayButtonHover: 'login-overlay-button-hover',
  overlayButtonPressed: 'login-overlay-button-pressed',
  overlayBackHover: 'login-overlay-back-hover',
  overlayBackPressed: 'login-overlay-back-pressed',
  overlayRowHover: 'login-overlay-row-hover',
  overlayRowPressed: 'login-overlay-row-pressed',
  overlayInputHover: 'login-overlay-input-hover',
  overlaySecondaryHover: 'login-overlay-secondary-hover',
  overlaySecondaryPressed: 'login-overlay-secondary-pressed',
};
const colors = {};
for (const [key, name] of Object.entries(colorNames)) colors[key] = tokenPair(name);

/* ── 3. 四语文案:JSON.parse common.json,取 demo 用到的 login 键 ── */
const LANGS = ['zh-CN', 'en', 'ja', 'ko'];
const COPY_KEYS = [
  'title', 'subtitle', 'phonePlaceholder', 'emailPlaceholder', 'invalidEmail', 'invalidPhone',
  'working', 'continue', 'back', 'cancel', 'chooseMethod', 'orgDetected', 'enterpriseLogin',
  'enterpriseVia', 'personalLogin', 'personalDesc', 'ssoRequired', 'ssoEntry', 'localModeEntry',
  'localModeDescription', 'consentStatement',
  'consentDialog.title', 'consentDialog.body', 'consentDialog.agree', 'consentDialog.disagree',
  'ssoOrgTitle', 'ssoOrgSubtitle', 'ssoOrgPlaceholder', 'ssoOrgHint', 'ssoOrgDetected',
  'ssoVerificationTitle', 'ssoVerificationSubtitle', 'enterCode', 'codeSentTo', 'codePlaceholder',
  'verifying', 'signIn', 'resendCode', 'resendCountdown', 'chooseAccount', 'chooseAccountSubtitle',
  'personalAccount', 'binding.phoneTitle', 'binding.phoneSubtitle', 'binding.emailTitle',
  'binding.emailSubtitle', 'sendCode', 'completeSignIn', 'preparing', 'preparingSubtitle',
  'unavailable', 'retry', 'browserWaiting', 'regionPill.cn', 'regionPill.dev',
  'errors.fallback', 'errors.INVALID_CODE', 'errors.AUTH_SERVICE_UNAVAILABLE',
  'social.apple', 'social.google', 'social.wechat',
];
const copy = {};
for (const lang of LANGS) {
  const src = `apps/desktop/src/renderer/i18n/locales/${lang}/common.json`;
  const json = JSON.parse(readFileSync(R(src), 'utf8'));
  const bag = {};
  for (const key of COPY_KEYS) {
    const val = key.split('.').reduce((o, k) => o?.[k], json.login);
    if (typeof val !== 'string') throw new Error(`${src} 缺 login.${key}`);
    bag[key] = leaf(val, src, `login.${key}`);
  }
  copy[lang] = bag;
}

/* ── 4. 协议链接(legalLinks.ts 两区常量) ── */
const LEGAL_TS = 'apps/desktop/src/shared/legalLinks.ts';
const legalSrc = readFileSync(R(LEGAL_TS), 'utf8');
function legalOf(constName, key) {
  const block = legalSrc.match(new RegExp(`const ${constName}[\\s\\S]*?\\};`))?.[0];
  const m = block?.match(new RegExp(`${key}:\\s*'([^']+)'`));
  if (!m) throw new Error(`legalLinks.ts 未找到 ${constName}.${key}`);
  return leaf(m[1], LEGAL_TS, `${constName}.${key}`);
}
const urls = {
  cn: { terms: legalOf('CN_LEGAL_LINKS', 'termsOfService'), privacy: legalOf('CN_LEGAL_LINKS', 'privacyPolicy') },
  global: { terms: legalOf('GLOBAL_LEGAL_LINKS', 'termsOfService'), privacy: legalOf('GLOBAL_LEGAL_LINKS', 'privacyPolicy') },
};

/* ── 5. 常量:倒计时/面板恒定缩放/窗口最小尺寸/区域 identifier 形态 ── */
const BOOT_TS = 'apps/desktop/src/main/bootstrap-electron.ts';
const bootSrc = readFileSync(R(BOOT_TS), 'utf8');
const minW = bootSrc.match(/minWidth:\s*(\d+)/);
const minH = bootSrc.match(/minHeight:\s*(\d+)/);
if (!minW || !minH) throw new Error('bootstrap-electron.ts 未找到主窗口 minWidth/minHeight');
const bothProviders = { email: true, phone: true };
const constants = {
  resendCountdownMs: leaf(tokens.RESEND_COUNTDOWN_MS, TOKENS_TS, 'RESEND_COUNTDOWN_MS'),
  panelFixedScale: leaf(scaleMod.PANEL_FIXED_SCALE, SCALE_TS, 'PANEL_FIXED_SCALE'),
  minWindow: {
    w: leaf(Number(minW[1]), BOOT_TS, 'mainWindow BrowserWindow minWidth'),
    h: leaf(Number(minH[1]), BOOT_TS, 'mainWindow BrowserWindow minHeight'),
  },
  identifierMethod: {
    cn: leaf(methodMod.resolveIdentifierMethod('cn', bothProviders), METHOD_TS, 'resolveIdentifierMethod(cn)'),
    global: leaf(methodMod.resolveIdentifierMethod('global', bothProviders), METHOD_TS, 'resolveIdentifierMethod(global)'),
  },
};

/* ── 6. 图标:SVG 资产全文 + LoginControls 内联矢量 path ── */
const ICON_DIR = 'apps/desktop/src/renderer/assets/login/icons';
function svgAsset(name) {
  const src = `${ICON_DIR}/${name}.svg`;
  return leaf(readFileSync(R(src), 'utf8'), src, 'svg 文件全文');
}
const CONTROLS_TSX = 'apps/desktop/src/renderer/components/login/LoginControls.tsx';
const controlsSrc = readFileSync(R(CONTROLS_TSX), 'utf8');
function fnBlock(fnName) {
  const start = controlsSrc.indexOf(`function ${fnName}`);
  if (start === -1) throw new Error(`LoginControls.tsx 未找到 function ${fnName}`);
  const next = controlsSrc.indexOf('\nfunction ', start + 1);
  const nextExport = controlsSrc.indexOf('\nexport ', start + 1);
  const ends = [next, nextExport].filter((i) => i !== -1);
  return controlsSrc.slice(start, ends.length ? Math.min(...ends) : undefined);
}
function pathsOf(fnName) {
  const ds = [...fnBlock(fnName).matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
  if (!ds.length) throw new Error(`${fnName} 内未找到 svg path`);
  return ds.map((d, i) => leaf(d, CONTROLS_TSX, `function ${fnName} path[${i}].d`));
}
const backChevronD = (() => {
  const block = fnBlock('LoginBackButton');
  const m = block.match(/d="([^"]+)"/);
  if (!m) throw new Error('LoginBackButton 内未找到 chevron path');
  return leaf(m[1], CONTROLS_TSX, 'LoginBackButton chevron path.d');
})();
const icons = {
  apple: { light: svgAsset('apple'), dark: svgAsset('apple-dark') },
  google: { light: svgAsset('google'), dark: svgAsset('google') },
  wechat: { light: svgAsset('wechat'), dark: svgAsset('wechat') },
  sso: { light: svgAsset('sso'), dark: svgAsset('sso-dark') },
  // guest 圆钮入口已退役(游客入口改为文本链接),对应 icons/guest{,-dark}.svg 已从产品删除,
  // 故此处不再提取 guest 叶子。本 demo 的 index.html 仍按其内嵌 truth 快照渲染历史 UI。
  paths: {
    backChevron: backChevronD,
    consentCheck: pathsOf('ConsentCheckGlyph')[0],
    person: pathsOf('PersonIcon'),
    enterprise: pathsOf('EnterpriseIcon'),
    share: pathsOf('ShareIcon'),
    spinnerArc: pathsOf('LoginSpinnerGlyph')[0],
  },
};

/* ── 7. adaptive.samples:产品 loginScale 真公式预计算(oracle = 源码本身) ── */
// bottomReserve = identifier 步的面板底部预留(LOGIN_LOCAL_MODE.reservedHeight,
// LoginPage panelBottomReserve 逻辑);groupY = identifier 默认 1229。
const SAMPLE_SIZES = [
  [800, 600], [800, 601], [900, 620], [1024, 640], [1280, 720],
  [1280, 800], [1280, 801], [1440, 900], [1680, 1050], [800, 1200],
];
const r2 = (v) => Math.round(v * 100) / 100;
const samples = SAMPLE_SIZES.map(([w, h]) => {
  const reserve = tokens.LOGIN_LOCAL_MODE.reservedHeight;
  const pp = scaleMod.panelPlacement(w, h, tokens.LOGIN_GROUP.yDefault, reserve);
  const bp = scaleMod.brandPlacement(w, h, reserve);
  const midX = scaleMod.LOGIN_STAGE_WIDTH / 2;
  const midY = scaleMod.LOGIN_STAGE_HEIGHT / 2;
  const bx = (designX) => w / 2 + (designX - midX) * bp.scale;
  const by = (designY) => h / 2 + (designY - midY) * bp.scale + bp.translateY;
  const shift = scaleMod.sloganShiftX(w, bp.scale);
  const panelW = tokens.LOGIN_GROUP.width * pp.scale;
  return {
    w, h,
    probes: {
      panel: {
        x: r2(pp.centerX - panelW / 2),
        y: r2(pp.topY),
        w: r2(panelW),
        h: r2(tokens.LOGIN_GROUP.height * pp.scale),
      },
      hero: {
        x: r2(bx(tokens.HERO.x)),
        y: r2(by(tokens.HERO.y)),
        w: r2(tokens.HERO.size * bp.scale),
        h: r2(tokens.HERO.size * bp.scale),
      },
      slogan: {
        x: r2(bx(tokens.SLOGAN.x + shift)),
        y: r2(by(tokens.SLOGAN.y)),
        w: r2(tokens.SLOGAN.width * bp.scale),
        h: r2(tokens.SLOGAN.height * bp.scale),
      },
    },
  };
});

process.stdout.write(
  JSON.stringify({ geometry, colors, copy, urls, constants, icons, adaptive: { samples } }, null, 2),
);
