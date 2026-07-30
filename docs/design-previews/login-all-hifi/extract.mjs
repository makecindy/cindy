#!/usr/bin/env node
// extract.mjs — cindy 登录链路「全端」QA demo 真值提取器(desk + phone + pad)。
// 机械提取,不手抄:
//  - desk:布局常量/缩放公式经 esbuild 编译产品 TS 后 import;颜色 token 正则解析
//    themes/colors.ts;文案 JSON.parse 四语 common.json;协议链接/窗口最小尺寸/内联
//    SVG path 正则定位;adaptive.samples 用产品 loginScale.ts 真公式预计算(= 桌面基线
//    docs/design-previews/login-flow-hifi/extract.mjs 同构,truth 命名空间迁入 desk.*)。
//  - mobile(phone/pad 共用):loginSkinLayout.ts / theme/tokens.ts / loginMessages.ts
//    经 esbuild 编译后 import(loginMessages 的两处 RN 依赖以确定桩替换,桩见下);
//    legalLinks.ts 正则两区 URL;LoginSkinControls.tsx 逐函数提取 SVG path/fill;
//    nativeSocial.ts 提取「apple = iOS only」分叉规则;fixtures loginScenarios.ts
//    提取默认 providers.social(cn ['apple'] / global ['apple','google']);
//    frames = resolveLoginSurface(产品真公式)对 demo 四个帧预设预计算期望几何。
//  - 品牌位图:产品 PNG 逐字节拷贝进 demo assets/(byte-identical),truth 记录
//    sha256 + IHDR 尺寸;asset-sha 门 D 绑定按 sha 比对。
// stdout 输出 truth JSON。

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const demoDir = dirname(fileURLToPath(import.meta.url));
// demo 位于 <repo>/docs/design-previews/<name>/ → 上三级即仓库根(同 login-flow-hifi)。
// 加一条根校验:demo 目录若被移动,这里立刻报清楚,而不是等到 compileModules 里 ENOENT。
const repoRoot = resolve(demoDir, '..', '..', '..');
if (!existsSync(resolve(repoRoot, 'pnpm-workspace.yaml')))
  throw new Error(`推导出的仓库根不是本仓(缺 pnpm-workspace.yaml):${repoRoot}\n` +
    `本提取器假定 demo 位于 <repo>/docs/design-previews/<name>/;若已移动目录,请同步改 repoRoot 的层数。`);
const R = (p) => resolve(repoRoot, p); // 绝对路径
import { relative } from 'node:path';
// provenance 的 source 写成「相对 demo 目录」的路径,由 repoRoot 反推,
// 不写死层数 —— 换目录时跟着 repoRoot 一起变,不会再出现存在性校验红。
const REL_PREFIX = relative(demoDir, repoRoot).split(sep).join('/');
const rel = (p) => `${REL_PREFIX}/${p}`;

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

/** 把编译 import 得到的对象逐叶包 provenance(locator = export 路径前缀)。 */
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

/* ── esbuild 编译产品 TS → 临时 .mjs → import(与桌面基线同法) ── */
const require2 = createRequire(join(repoRoot, 'package.json'));
const esbuild = require2('esbuild');

/**
 * 编译一组 TS 文件并 import。transform 可选:对编译后 JS 做文本替换——
 * loginMessages.ts 依赖 expo-localization / @/i18n/appLanguage(RN 侧),
 * 提取只需要 messages/authErrorMessages 常量,用确定桩替换 import 行(不执行任何 RN 代码)。
 */
async function compileModules(entries) {
  const tmp = mkdtempSync(join(tmpdir(), 'login-all-hifi-extract-'));
  const mods = {};
  try {
    for (const [src, out, transform] of entries) {
      let code = esbuild.transformSync(readFileSync(R(src), 'utf8'), {
        loader: 'ts',
        format: 'esm',
      }).code;
      if (transform) code = transform(code);
      writeFileSync(join(tmp, out), code);
      mods[out] = await import(pathToFileURL(join(tmp, out)).href);
    }
    return mods;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 拷贝产品资产到 demo assets/ 并产出 { file, sha256, width?, height? } 叶子组。 */
const ASSET_DIR = join(demoDir, 'assets');
mkdirSync(ASSET_DIR, { recursive: true });
function pngDims(absPath) {
  const buf = readFileSync(absPath);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`非 PNG:${absPath}`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function assetLeaf(srcRelRepo, destName, { dims = true } = {}) {
  const abs = R(srcRelRepo);
  copyFileSync(abs, join(ASSET_DIR, destName));
  const out = {
    file: leaf(`assets/${destName}`, srcRelRepo, '产品资产逐字节拷贝(cp → demo assets/)'),
    sha256: leaf(fileHash(abs), srcRelRepo, '源文件 sha256(asset-sha 绑定期望值)'),
  };
  if (dims) {
    const { width, height } = pngDims(abs);
    out.width = leaf(width, srcRelRepo, 'PNG IHDR width');
    out.height = leaf(height, srcRelRepo, 'PNG IHDR height');
  }
  return out;
}

/* ════════════════════════ desk(桌面,= 基线提取器同构) ════════════════════════ */
let deskSamples; // 顶层 adaptive.samples 用(见文件尾)
const desk = await (async () => {
  const TOKENS_TS = 'apps/desktop/src/renderer/components/login/loginDesignTokens.ts';
  const SCALE_TS = 'apps/desktop/src/renderer/components/login/loginScale.ts';
  const METHOD_TS = 'apps/desktop/src/shared/loginIdentifierMethod.ts';
  const mods = await compileModules([
    [TOKENS_TS, 'desk-tokens.mjs'],
    // loginScale.ts 自 2026-07-27 改版起 import LOGIN_GROUP(组高 620 单一来源):
    // 临时目录里文件名被扁平化,把相对 import 重定向到同批编译的 desk-tokens.mjs
    [
      SCALE_TS,
      'desk-scale.mjs',
      (code) => code.replace(/from\s*['"]\.\/loginDesignTokens['"]/g, "from './desk-tokens.mjs'"),
    ],
    [METHOD_TS, 'desk-method.mjs'],
  ]);
  const tokens = mods['desk-tokens.mjs'];
  const scaleMod = mods['desk-scale.mjs'];
  const methodMod = mods['desk-method.mjs'];

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
    /* 2026-07-XX #554:徽标翻转为「global 不标、cn/dev 才标」,宽度由 paddingX 撑开(无 width) */
    regionPill: wrapObj(tokens.REGION_PILL, TOKENS_TS, 'REGION_PILL'),
    control: wrapObj(tokens.CONTROL, TOKENS_TS, 'CONTROL'),
    spinner: wrapObj(tokens.SPINNER, TOKENS_TS, 'SPINNER'),
    social: wrapObj(tokens.SOCIAL, TOKENS_TS, 'SOCIAL'),
    back: wrapObj(tokens.BACK, TOKENS_TS, 'BACK'),
    errorText: wrapObj(tokens.ERROR_TEXT, TOKENS_TS, 'ERROR_TEXT'),
    /* 2026-07-27 登录改版:面板内「跳过登录」文字按钮槽(680×60 @y430,字号 24,热区左右各 30) */
    skipEntry: wrapObj(tokens.SKIP_ENTRY, TOKENS_TS, 'SKIP_ENTRY'),
    /* Splash 面板高 440:不跟随登录面板 500(SPLASH_PANEL 注释;demo 不渲染 splash,留证 */
    splashPanelHeight: leaf(tokens.SPLASH_PANEL.height, TOKENS_TS, 'SPLASH_PANEL.height'),
    methodRow: wrapObj(tokens.METHOD_ROW, TOKENS_TS, 'METHOD_ROW'),
    loadingRing: wrapObj(tokens.LOADING_RING, TOKENS_TS, 'LOADING_RING'),
    textLink: wrapObj(tokens.TEXT_LINK, TOKENS_TS, 'TEXT_LINK'),
    ssoOrgHint: wrapObj(tokens.SSO_ORG_HINT, TOKENS_TS, 'SSO_ORG_HINT'),
    consentRow: wrapObj(tokens.CONSENT_ROW, TOKENS_TS, 'CONSENT_ROW'),
    consentDialog: wrapObj(tokens.CONSENT_DIALOG, TOKENS_TS, 'CONSENT_DIALOG'),
    dragBarHeight: leaf(tokens.DRAG_BAR_HEIGHT, TOKENS_TS, 'DRAG_BAR_HEIGHT'),
  };

  /* 颜色 token:正则解析 registerColor('login-*', {light, dark}) */
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
    // 通用主题色(非 login-* 族):账号注销状态横幅使用(LoginPage AccountDeletionStatusPanel)
    genericBorder: 'border-default',
    genericSurfaceChip: 'surface-chip',
    genericTextPrimary: 'text-primary',
    genericTextSecondary: 'text-secondary',
  };
  const colors = {};
  for (const [key, name] of Object.entries(colorNames)) colors[key] = tokenPair(name);

  /* 四语文案:JSON.parse common.json */
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
    // 账号注销状态横幅文案(common.json 根部 accountDeletion.status.*,不在 login 下)
    const DEL_KEYS = ['pendingTitle', 'processingTitle', 'completedTitle', 'pendingCopy', 'processingCopy', 'completedCopy', 'dismissButton'];
    for (const key of DEL_KEYS) {
      const val = json.accountDeletion?.status?.[key];
      if (typeof val !== 'string') throw new Error(`${src} 缺 accountDeletion.status.${key}`);
      bag[`deletion.${key}`] = leaf(val, src, `accountDeletion.status.${key}`);
    }
    copy[lang] = bag;
  }

  /* 协议链接 */
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

  /* 常量:倒计时/面板恒定缩放/窗口最小尺寸/区域 identifier 形态 */
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

  /* 图标:SVG 资产全文 + LoginControls 内联矢量 path */
  const ICON_DIR = 'apps/desktop/src/renderer/assets/login/icons';
  function svgAsset(name) {
    const src = `${ICON_DIR}/${name}.svg`;
    return leaf(readFileSync(R(src), 'utf8'), src, 'svg 文件全文');
  }
  const CONTROLS_TSX = 'apps/desktop/src/renderer/components/login/LoginControls.tsx';
  const controlsSrc = readFileSync(R(CONTROLS_TSX), 'utf8');
  function fnBlock(src, fnName) {
    const start = src.indexOf(`function ${fnName}`);
    if (start === -1) throw new Error(`${fnName} 未找到`);
    const next = src.indexOf('\nfunction ', start + 1);
    const nextExport = src.indexOf('\nexport ', start + 1);
    const ends = [next, nextExport].filter((i) => i !== -1);
    return src.slice(start, ends.length ? Math.min(...ends) : undefined);
  }
  function pathsOf(src, fnName, tsx) {
    const ds = [...fnBlock(src, fnName).matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
    if (!ds.length) throw new Error(`${fnName} 内未找到 svg path`);
    return ds.map((d, i) => leaf(d, tsx, `function ${fnName} path[${i}].d`));
  }
  const backChevronD = (() => {
    const block = fnBlock(controlsSrc, 'LoginBackButton');
    const m = block.match(/d="([^"]+)"/);
    if (!m) throw new Error('LoginBackButton 内未找到 chevron path');
    return leaf(m[1], CONTROLS_TSX, 'LoginBackButton chevron path.d');
  })();
  const icons = {
    apple: { light: svgAsset('apple'), dark: svgAsset('apple-dark') },
    google: { light: svgAsset('google'), dark: svgAsset('google') },
    wechat: { light: svgAsset('wechat'), dark: svgAsset('wechat') },
    sso: { light: svgAsset('sso'), dark: svgAsset('sso-dark') },
    // guest 图标已随「跳过登录」文字入口取代游客圆钮删除(2026-07-27 改版;
    // guest.svg / guest-dark.svg 在本次改动里已从产品仓移除,故不再提取)
    paths: {
      backChevron: backChevronD,
      consentCheck: pathsOf(controlsSrc, 'ConsentCheckGlyph', CONTROLS_TSX)[0],
      person: pathsOf(controlsSrc, 'PersonIcon', CONTROLS_TSX),
      enterprise: pathsOf(controlsSrc, 'EnterpriseIcon', CONTROLS_TSX),
      share: pathsOf(controlsSrc, 'ShareIcon', CONTROLS_TSX),
      spinnerArc: pathsOf(controlsSrc, 'LoginSpinnerGlyph', CONTROLS_TSX)[0],
    },
  };

  /* 「跳过登录」热区语义(2026-07-27 改版):槽 pointerEvents:none = 680×60 布局容器死区,
     内层 button pointerEvents:auto = 真正可点区(文字宽 + 左右 hitPaddingX)。
     由 LoginSkipEntry 源码正则提取,并派生出 demo 侧可机械核对的命中判据(门 D kind:text)。 */
  const skipBlock = fnBlock(controlsSrc, 'LoginSkipEntry');
  const slotPe = skipBlock.match(/pointerEvents: '(none)'/)?.[1];
  const btnPe = skipBlock.match(/pointerEvents: '(auto)'/)?.[1];
  if (!slotPe || !btnPe)
    throw new Error("LoginSkipEntry 未找到 pointerEvents 分层(槽 'none' / 内层 button 'auto')");
  if (!/color: LOGIN_COLORS\.secondaryText/.test(skipBlock))
    throw new Error('LoginSkipEntry 未使用 LOGIN_COLORS.secondaryText 作文字色');
  constants.skipEntry = {
    slotPointerEvents: leaf(slotPe, CONTROLS_TSX, 'LoginSkipEntry 槽 style.pointerEvents'),
    buttonPointerEvents: leaf(btnPe, CONTROLS_TSX, 'LoginSkipEntry button style.pointerEvents'),
    colorToken: leaf('secondaryText', CONTROLS_TSX, 'LoginSkipEntry style.color = LOGIN_COLORS.secondaryText'),
    hitDeadZone: leaf(
      slotPe === 'none' ? 'not-button' : 'button',
      CONTROLS_TSX,
      "由槽 pointerEvents:'none' 派生的期望命中语义:680×60 容器死区点击不落跳过按钮",
    ),
    hitTextZone: leaf(
      btnPe === 'auto' ? 'button' : 'not-button',
      CONTROLS_TSX,
      "由 button pointerEvents:'auto' 派生的期望命中语义:文字 + 左右扩展区命中跳过按钮",
    ),
  };

  /* adaptive.samples:产品 loginScale 真公式预计算(oracle = 源码本身) */
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
  deskSamples = samples;

  /* 品牌位图资产(逐字节拷贝;hero-mask.svg 是 alpha mask 资产) */
  const ASSETS = 'apps/desktop/src/renderer/assets/login';
  const assets = {
    hero: assetLeaf(`${ASSETS}/hero.png`, 'desk-hero.png'),
    heroMask: assetLeaf(`${ASSETS}/hero-mask.svg`, 'desk-hero-mask.svg', { dims: false }),
    sloganLight: assetLeaf(`${ASSETS}/slogan.png`, 'desk-slogan-light.png'),
    sloganDark: assetLeaf(`${ASSETS}/slogan-dark.png`, 'desk-slogan-dark.png'),
    wordmarkLight: assetLeaf(`${ASSETS}/wordmark.png`, 'desk-wordmark-light.png'),
    wordmarkDark: assetLeaf(`${ASSETS}/wordmark-dark.png`, 'desk-wordmark-dark.png'),
  };

  return { geometry, colors, copy, urls, constants, icons, assets };
})();

/* ════════════════════════ mobile(phone + pad 共用渲染器) ════════════════════════ */
const mobile = await (async () => {
  const LAYOUT_TS = 'apps/mobile/src/auth/loginSkinLayout.ts';
  const TOKENS_TS = 'apps/mobile/src/theme/tokens.ts';
  const MESSAGES_TS = 'apps/mobile/src/auth/loginMessages.ts';
  const METHOD_TS = 'apps/mobile/src/auth/loginIdentifierMethod.ts';
  const CNPHONE_TS = 'apps/mobile/src/auth/cnPhone.ts';
  const KB_TS = 'apps/mobile/src/auth/loginKeyboardAvoidance.ts';
  const mods = await compileModules([
    [LAYOUT_TS, 'mob-layout.mjs'],
    [TOKENS_TS, 'mob-tokens.mjs'],
    [METHOD_TS, 'mob-method.mjs'],
    [CNPHONE_TS, 'mob-cnphone.mjs'],
    [KB_TS, 'mob-kb.mjs'],
    [
      MESSAGES_TS,
      'mob-messages.mjs',
      // loginMessages.ts 的两处 RN 侧 import 换确定桩:提取只消费 messages/
      // authErrorMessages 常量,不执行 getLocales/getManualLocaleOverride。
      (code) =>
        code
          .replace(
            /import\s*\{\s*getLocales\s*\}\s*from\s*['"]expo-localization['"];?/,
            'const getLocales = () => [{ languageTag: "zh-CN" }];',
          )
          .replace(
            /import\s*\{\s*getManualLocaleOverride\s*\}\s*from\s*['"]@\/i18n\/appLanguage['"];?/,
            'const getManualLocaleOverride = () => null;',
          ),
    ],
  ]);
  const layout = mods['mob-layout.mjs'];
  const tokens = mods['mob-tokens.mjs'];
  const methodMod = mods['mob-method.mjs'];
  const cnPhone = mods['mob-cnphone.mjs'];
  const messages = mods['mob-messages.mjs'];
  const kbEngine = mods['mob-kb.mjs'];

  /* 几何:loginSkinLayout 常量 + loginSizes(面板/流高) */
  const geometry = {
    stage: {
      width: leaf(layout.LOGIN_STAGE_WIDTH, LAYOUT_TS, 'LOGIN_STAGE_WIDTH'),
      minDesignHeight: leaf(layout.LOGIN_STAGE_MIN_DESIGN_HEIGHT, LAYOUT_TS, 'LOGIN_STAGE_MIN_DESIGN_HEIGHT'),
      maxDesignHeight: leaf(layout.LOGIN_STAGE_MAX_DESIGN_HEIGHT, LAYOUT_TS, 'LOGIN_STAGE_MAX_DESIGN_HEIGHT'),
    },
    short: wrapObj(layout.LOGIN_STAGE_SHORT, LAYOUT_TS, 'LOGIN_STAGE_SHORT'),
    long: wrapObj(layout.LOGIN_STAGE_LONG, LAYOUT_TS, 'LOGIN_STAGE_LONG'),
    padPortrait: wrapObj(layout.LOGIN_PAD_PORTRAIT_STAGE, LAYOUT_TS, 'LOGIN_PAD_PORTRAIT_STAGE'),
    padLandscape: wrapObj(layout.LOGIN_PAD_LANDSCAPE_STAGE, LAYOUT_TS, 'LOGIN_PAD_LANDSCAPE_STAGE'),
    padLandscapeMinScale: leaf(layout.PAD_LANDSCAPE_MIN_SCALE, LAYOUT_TS, 'PAD_LANDSCAPE_MIN_SCALE'),
    padLandscapeMinWidth: leaf(layout.PAD_LANDSCAPE_MIN_WIDTH, LAYOUT_TS, 'PAD_LANDSCAPE_MIN_WIDTH'),
    padLandscapeMinHeight: leaf(layout.PAD_LANDSCAPE_MIN_HEIGHT, LAYOUT_TS, 'PAD_LANDSCAPE_MIN_HEIGHT'),
    padPortraitMinWidth: leaf(layout.PAD_PORTRAIT_MIN_WIDTH, LAYOUT_TS, 'PAD_PORTRAIT_MIN_WIDTH'),
    group: wrapObj(layout.LOGIN_GROUP, LAYOUT_TS, 'LOGIN_GROUP'),
    title: wrapObj(layout.LOGIN_TITLE, LAYOUT_TS, 'LOGIN_TITLE'),
    // 注:移动端 Global 徽标(LOGIN_GLOBAL_PILL)不在本 checkout(main + 登录改版)里——
    // 它属于另一条未合入 main 的分支(feat/mobile-login-global-badge)。demo 只镜像本
    // checkout 的产品源码,故移动侧不再渲染徽标(桌面 GLOBAL_PILL 在 main 上,保留)。
    copyLineHeight: leaf(layout.LOGIN_COPY_LINE_HEIGHT, LAYOUT_TS, 'LOGIN_COPY_LINE_HEIGHT'),
    subtitle: wrapObj(layout.LOGIN_SUBTITLE, LAYOUT_TS, 'LOGIN_SUBTITLE'),
    control: wrapObj(layout.LOGIN_CONTROL, LAYOUT_TS, 'LOGIN_CONTROL'),
    spinner: wrapObj(layout.LOGIN_SPINNER, LAYOUT_TS, 'LOGIN_SPINNER'),
    social: wrapObj(layout.LOGIN_SOCIAL, LAYOUT_TS, 'LOGIN_SOCIAL'),
    back: wrapObj(layout.LOGIN_BACK, LAYOUT_TS, 'LOGIN_BACK'),
    errorText: wrapObj(layout.LOGIN_ERROR_TEXT, LAYOUT_TS, 'LOGIN_ERROR_TEXT'),
    /* 注:移动端无「跳过登录」入口(产品决定:远程连接客户端必须有账号)。桌面 SKIP_ENTRY
       仍在,见 desk.geometry.skipEntry —— 两端不对称是产品事实,不是 demo 漏做。
       键盘停靠锚也随之回到「面板底」(见 keyboardSim:loginSizes.panelHeight),
       LOGIN_KEYBOARD_DOCK_ANCHOR_Y 这个常量在产品里不存在。 */
    methodRow: wrapObj(layout.LOGIN_METHOD_ROW, LAYOUT_TS, 'LOGIN_METHOD_ROW'),
    loadingRing: wrapObj(layout.LOGIN_LOADING_RING, LAYOUT_TS, 'LOGIN_LOADING_RING'),
    textLink: wrapObj(layout.LOGIN_TEXT_LINK, LAYOUT_TS, 'LOGIN_TEXT_LINK'),
    ssoOrgHintTop: leaf(layout.LOGIN_SSO_ORG_HINT_TOP, LAYOUT_TS, 'LOGIN_SSO_ORG_HINT_TOP'),
    consentRow: wrapObj(layout.LOGIN_CONSENT_ROW, LAYOUT_TS, 'LOGIN_CONSENT_ROW'),
    consentDialog: wrapObj(layout.LOGIN_CONSENT_DIALOG, LAYOUT_TS, 'LOGIN_CONSENT_DIALOG'),
    disabledTextOpacity: leaf(layout.LOGIN_DISABLED_TEXT_OPACITY, LAYOUT_TS, 'LOGIN_DISABLED_TEXT_OPACITY'),
    resendSeconds: leaf(layout.RESEND_COUNTDOWN_SECONDS, LAYOUT_TS, 'RESEND_COUNTDOWN_SECONDS'),
    resendTickMs: leaf(layout.RESEND_COUNTDOWN_TICK_MS, LAYOUT_TS, 'RESEND_COUNTDOWN_TICK_MS'),
    phoneSplashSpinnerSize: leaf(layout.LOGIN_PHONE_SPLASH_SPINNER_SIZE, LAYOUT_TS, 'LOGIN_PHONE_SPLASH_SPINNER_SIZE'),
    loginSizes: wrapObj(tokens.loginSizes, TOKENS_TS, 'loginSizes'),
  };

  /* 颜色:loginPalettes(light/dark 双态色板,与桌面 --login-* 同源) */
  const colors = {};
  for (const key of Object.keys(tokens.loginPalettes.light)) {
    colors[key] = {
      light: leaf(tokens.loginPalettes.light[key], TOKENS_TS, `loginPalettes.light.${key}`),
      dark: leaf(tokens.loginPalettes.dark[key], TOKENS_TS, `loginPalettes.dark.${key}`),
    };
  }
  /* 通用主题色(非 login 族):账号注销横幅卡片使用(makeStyles.deletionStatus;
     textPrimary/textSecondary/borderStrong/cta/ctaText/surface,lightColors/darkColors) */
  const theme = {};
  for (const key of ['textPrimary', 'textSecondary', 'borderStrong', 'cta', 'ctaText', 'surface']) {
    theme[key] = {
      light: leaf(tokens.lightColors[key], TOKENS_TS, `lightColors.${key}`),
      dark: leaf(tokens.darkColors[key], TOKENS_TS, `darkColors.${key}`),
    };
  }

  /* 文案:loginMessages 4 语 catalog(demo 用到的登录键子集 + 错误码子集) */
  const LANGS = ['zh-CN', 'en', 'ja', 'ko'];
  const COPY_KEYS = [
    // 移动侧无 skipLogin / globalRegion 文案键(前者随跳过登录入口一并移除,后者属未合入分支)
    'title', 'phonePlaceholder', 'emailPlaceholder', 'invalidEmail', 'invalidPhone', 'continue',
    'apple', 'google', 'wechat', 'chooseMethod', 'orgDetected', 'enterpriseLogin', 'personalLogin',
    'emailCode', 'ssoRequired', 'ssoEntry', 'consentStatement', 'consentDialogTitle',
    'consentDialogBody', 'consentAgree', 'consentDisagree', 'ssoOrgTitle', 'ssoOrgSubtitle',
    'ssoOrgPlaceholder', 'ssoOrgHint', 'ssoOrgDetected', 'ssoVerificationTitle',
    'ssoVerificationSubtitle', 'enterCode', 'codeSentTo', 'codePlaceholder', 'signIn',
    'resendCode', 'resendCountdown', 'chooseAccount', 'chooseAccountSubtitle', 'personalAccount',
    'bindPhoneTitle', 'bindPhoneSubtitle', 'bindEmailTitle', 'bindEmailSubtitle', 'sendCode',
    'back', 'cancel', 'browserTitle', 'browserSubtitle', 'working', 'configTitle',
    'errorFallback', 'retry', 'configIssueAuthBaseUrl',
    // 账号注销状态横幅(login.tsx AccountDeletionStatusPanel)
    'accountDeletionPendingTitle', 'accountDeletionProcessingTitle', 'accountDeletionCompletedTitle',
    'accountDeletionPendingCopy', 'accountDeletionProcessingCopy', 'accountDeletionCompletedCopy',
    'accountDeletionDismiss',
  ];
  // 移动侧 authErrorMessages 无 AUTH_SERVICE_UNAVAILABLE(那是桌面错误码);
  // 移动「服务不可用」= AUTH_REQUEST_FAILED(见 loginMessages.ts authErrorMessages)。
  const ERROR_KEYS = ['INVALID_CODE', 'AUTH_REQUEST_FAILED', 'NETWORK_ERROR'];
  const copy = {};
  for (const lang of LANGS) {
    const bag = {};
    for (const key of COPY_KEYS) {
      const val = messages.loginMessages[lang][key];
      if (typeof val !== 'string') throw new Error(`loginMessages ${lang} 缺 ${key}`);
      bag[key] = leaf(val, MESSAGES_TS, `messages.${lang}.${key}`);
    }
    for (const code of ERROR_KEYS) {
      const val = messages.authErrorMessages[code]?.[lang];
      if (typeof val !== 'string') throw new Error(`authErrorMessages.${code} 缺 ${lang}`);
      bag[`errors.${code}`] = leaf(val, MESSAGES_TS, `authErrorMessages.${code}.${lang}`);
    }
    copy[lang] = bag;
  }

  /* 协议链接(与桌面同 URL 权威源,移动侧 config/legalLinks.ts) */
  const LEGAL_TS = 'apps/mobile/src/config/legalLinks.ts';
  const legalSrc = readFileSync(R(LEGAL_TS), 'utf8');
  function legalOf(constName, key) {
    const block = legalSrc.match(new RegExp(`const ${constName}[\\s\\S]*?\\};`))?.[0];
    const m = block?.match(new RegExp(`${key}:\\s*'([^']+)'`));
    if (!m) throw new Error(`mobile legalLinks.ts 未找到 ${constName}.${key}`);
    return leaf(m[1], LEGAL_TS, `${constName}.${key}`);
  }
  const urls = {
    cn: { terms: legalOf('CN_LEGAL_LINKS', 'termsOfService'), privacy: legalOf('CN_LEGAL_LINKS', 'privacyPolicy') },
    global: { terms: legalOf('GLOBAL_LEGAL_LINKS', 'termsOfService'), privacy: legalOf('GLOBAL_LEGAL_LINKS', 'privacyPolicy') },
  };

  /* 常量:手机号前缀/倒计时/disabled 不透明度/区域 identifier 形态/默认社交 providers/apple iOS-only */
  const bothProviders = { email: true, phone: true };
  const FIXTURES_TS = 'packages/auth-client/fixtures/loginScenarios.ts';
  const fixturesSrc = readFileSync(R(FIXTURES_TS), 'utf8');
  const providersBlock = fixturesSrc.match(/const defaults = \{[\s\S]*?\};/)?.[0];
  const socialMatch = providersBlock?.match(/social:\s*region === "cn" \? \[(.*?)\] : \[(.*?)\]/);
  if (!socialMatch) throw new Error('loginScenarios.ts 未找到 providers.social 默认值');
  const parseSocial = (s) => s.split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean);
  const NATIVESOCIAL_TS = 'apps/mobile/src/auth/nativeSocial.ts';
  const nativeSocialSrc = readFileSync(R(NATIVESOCIAL_TS), 'utf8');
  if (!/if \(provider === 'apple'\) return Platform\.OS === 'ios';/.test(nativeSocialSrc))
    throw new Error('nativeSocial.ts 未找到 apple = iOS only 规则');
  const constants = {
    cnPhonePrefix: leaf(cnPhone.CN_PHONE_PREFIX, CNPHONE_TS, 'CN_PHONE_PREFIX'),
    resendSeconds: leaf(layout.RESEND_COUNTDOWN_SECONDS, LAYOUT_TS, 'RESEND_COUNTDOWN_SECONDS'),
    resendTickMs: leaf(layout.RESEND_COUNTDOWN_TICK_MS, LAYOUT_TS, 'RESEND_COUNTDOWN_TICK_MS'),
    disabledTextOpacity: leaf(layout.LOGIN_DISABLED_TEXT_OPACITY, LAYOUT_TS, 'LOGIN_DISABLED_TEXT_OPACITY'),
    identifierMethod: {
      cn: leaf(methodMod.resolveIdentifierMethod('cn', bothProviders), METHOD_TS, 'resolveIdentifierMethod(cn)'),
      global: leaf(methodMod.resolveIdentifierMethod('global', bothProviders), METHOD_TS, 'resolveIdentifierMethod(global)'),
    },
    socialProviders: {
      cn: leaf(parseSocial(socialMatch[1]), FIXTURES_TS, 'providersFor defaults social(cn)'),
      global: leaf(parseSocial(socialMatch[2]), FIXTURES_TS, 'providersFor defaults social(global)'),
    },
    appleIosOnly: leaf(true, NATIVESOCIAL_TS, "isNativeSocialProviderSupported: provider === 'apple' → Platform.OS === 'ios'"),
    /* 键盘停靠避让引擎常量 + demo 仿真输入(仿真值只在此处声明一次,demo 从 truth 读,
       不在 index.html 里复抄——保证 demo 侧位移与 extract 侧 oracle 吃同一组输入) */
    keyboard: {
      panelGap: leaf(kbEngine.LOGIN_KEYBOARD_PANEL_GAP, KB_TS, 'LOGIN_KEYBOARD_PANEL_GAP(停靠 10px 贴附)'),
      dockedWidthRatio: leaf(kbEngine.DOCKED_KEYBOARD_WIDTH_RATIO, KB_TS, 'DOCKED_KEYBOARD_WIDTH_RATIO'),
      resizeThreshold: leaf(kbEngine.LOGIN_KEYBOARD_RESIZE_THRESHOLD, KB_TS, 'LOGIN_KEYBOARD_RESIZE_THRESHOLD'),
      simKeyboardHeight: leaf(336, KB_TS, 'demo 仿真输入(非产品常量):常规停靠键盘高 336 物理px,喂 computeLoginKeyboardShift 预计算期望位移'),
      simSafeTop: leaf(44, KB_TS, 'demo 仿真输入(非产品常量):顶部安全区下边界(insets.top)44 物理px'),
      simPlatform: leaf('ios', KB_TS, 'demo 仿真输入(非产品常量):常规停靠场景取 iOS 路径(screenY 可靠)'),
      simSystemBarBottom: leaf(48, KB_TS, 'demo 仿真输入(非产品常量):Android 系统栏底 inset 48 物理px,只用于「未缩窗兜底」场景的键盘顶公式'),
    },
  };

  /* 图标:LoginSkinControls.tsx 逐函数提取 SVG path/fill(厂商品牌色为字面值) */
  const CONTROLS_TSX = 'apps/mobile/src/components/LoginSkinControls.tsx';
  const controlsSrc = readFileSync(R(CONTROLS_TSX), 'utf8');
  function fnBlock(fnName) {
    const start = controlsSrc.indexOf(`function ${fnName}`);
    if (start === -1) throw new Error(`LoginSkinControls.tsx 未找到 function ${fnName}`);
    const next = controlsSrc.indexOf('\nfunction ', start + 1);
    const nextExport = controlsSrc.indexOf('\nexport ', start + 1);
    const ends = [next, nextExport].filter((i) => i !== -1);
    return controlsSrc.slice(start, ends.length ? Math.min(...ends) : undefined);
  }
  /** 提取函数块内全部 <Path …>:d + 字面 fill/strokeWidth/opacity。 */
  function pathsOf(fnName) {
    const block = fnBlock(fnName);
    const tags = [...block.matchAll(/<Path\s+([\s\S]*?)\/>/g)].map((m) => m[1]);
    if (!tags.length) throw new Error(`${fnName} 内未找到 <Path>`);
    return tags.map((attrs, i) => {
      const d = attrs.match(/d="([^"]+)"/)?.[1];
      if (!d) throw new Error(`${fnName} path[${i}] 缺 d`);
      const out = { d: leaf(d, CONTROLS_TSX, `function ${fnName} path[${i}].d`) };
      const fill = attrs.match(/fill="([^"]+)"/)?.[1];
      if (fill) out.fill = leaf(fill, CONTROLS_TSX, `function ${fnName} path[${i}].fill`);
      const strokeW = attrs.match(/strokeWidth="([^"]+)"/)?.[1];
      if (strokeW) out.strokeWidth = leaf(Number(strokeW), CONTROLS_TSX, `function ${fnName} path[${i}].strokeWidth`);
      const opacity = attrs.match(/opacity=\{([\d.]+)\}/)?.[1];
      if (opacity) out.opacity = leaf(Number(opacity), CONTROLS_TSX, `function ${fnName} path[${i}].opacity`);
      return out;
    });
  }
  // SSO 单色图标 fill 随模式反相(亮 #EEEEEE / 暗 #2A2828,源码三元字面量)
  const ssoFillMatch = controlsSrc.match(/const fill = mode === 'dark' \? '([^']+)' : '([^']+)';/);
  if (!ssoFillMatch) throw new Error('SsoIcon 未找到 fill 三元');
  const icons = {
    google: { viewBox: leaf('0 0 48 48', CONTROLS_TSX, 'GoogleIcon Svg viewBox'), paths: pathsOf('GoogleIcon') },
    sso: {
      viewBox: leaf('0 0 48 48', CONTROLS_TSX, 'SsoIcon Svg viewBox'),
      paths: pathsOf('SsoIcon'),
      fillLight: leaf(ssoFillMatch[2], CONTROLS_TSX, "SsoIcon fill = mode === 'dark' ? … : '<light>'"),
      fillDark: leaf(ssoFillMatch[1], CONTROLS_TSX, "SsoIcon fill = mode === 'dark' ? '<dark>' : …"),
    },
    apple: { viewBox: leaf('15.7 13.2 24.6 24.6', CONTROLS_TSX, 'AppleLogoGlyph Svg viewBox'), paths: pathsOf('AppleLogoGlyph') },
    enterprise: { viewBox: leaf('0 0 24 24', CONTROLS_TSX, 'EnterpriseIcon Svg viewBox'), paths: pathsOf('EnterpriseIcon') },
    person: { viewBox: leaf('0 0 18 20', CONTROLS_TSX, 'PersonIcon Svg viewBox'), paths: pathsOf('PersonIcon') },
    share: { viewBox: leaf('0 0 20 20', CONTROLS_TSX, 'ShareIcon Svg viewBox'), paths: pathsOf('ShareIcon') },
    backChevron: pathsOf('LoginBackButton')[0],
    consentCheck: pathsOf('ConsentCheckGlyph')[0],
    ringArc: pathsOf('LoginLoadingRing').find((p) => p.d.value.startsWith('M61')),
    spinnerArc: pathsOf('LoginSpinnerGlyph').find((p) => p.d.value.startsWith('M22')),
  };

  /* 注:移动侧无「跳过登录」入口,故无对应热区语义常量(桌面 constants.skipEntry 仍在)。 */

  /* 品牌位图(@2x 手机资产 + 平板专属立绘;逐字节拷贝) */
  const ASSETS = 'apps/mobile/assets/login';
  const assets = {
    hero: assetLeaf(`${ASSETS}/login-hero@2x.png`, 'mob-hero.png'),
    sloganLight: assetLeaf(`${ASSETS}/login-slogan@2x.png`, 'mob-slogan-light.png'),
    sloganDark: assetLeaf(`${ASSETS}/login-slogan-dark@2x.png`, 'mob-slogan-dark.png'),
    wordmarkLight: assetLeaf(`${ASSETS}/login-wordmark@2x.png`, 'mob-wordmark-light.png'),
    wordmarkDark: assetLeaf(`${ASSETS}/login-wordmark-dark@2x.png`, 'mob-wordmark-dark.png'),
    heroPadPortrait: assetLeaf(`${ASSETS}/login-hero-pad-portrait.png`, 'mob-hero-pad-portrait.png'),
    heroPadLandscape: assetLeaf(`${ASSETS}/login-hero-pad-landscape.png`, 'mob-hero-pad-landscape.png'),
  };

  /* 帧预设期望几何:resolveLoginSurface(产品真公式)预计算(oracle = 源码本身)。
     门 D 渲染绑定按这些叶子核对 demo 固定帧的布局(未配 adaptive 的端用绑定覆盖几何)。 */
  const FRAME_PRESETS = {
    'phone-std': [390, 844], // iPhone 14 类:scale 0.52,designHeight≈1623(长屏档锚)
    'phone-se': [375, 667], // iPhone SE 类:scale 0.5,designHeight=1334(短屏档锚)
    'pad-portrait': [834, 1112], // iPad 11" 竖屏:pad-portrait 构图(744×1133 stage 等比居中)
    'pad-landscape': [1112, 834], // iPad 11" 横屏:pad-landscape 构图(1180×820 stage 等比居中)
  };
  const frames = {};
  for (const [key, [w, h]] of Object.entries(FRAME_PRESETS)) {
    const s = layout.resolveLoginSurface(w, h);
    const locator = `resolveLoginSurface(${w}, ${h})`;
    frames[key] = {
      viewport: {
        w: leaf(w, LAYOUT_TS, `${locator} viewport`),
        h: leaf(h, LAYOUT_TS, `${locator} viewport`),
      },
      mode: leaf(s.mode, LAYOUT_TS, `${locator} .mode`),
      scale: leaf(s.scale, LAYOUT_TS, `${locator} .scale`),
      stageWidth: leaf(s.stageWidth, LAYOUT_TS, `${locator} .stageWidth`),
      stageHeight: leaf(s.stageHeight, LAYOUT_TS, `${locator} .stageHeight`),
      offsetX: leaf(s.offsetX, LAYOUT_TS, `${locator} .offsetX`),
      offsetY: leaf(s.offsetY, LAYOUT_TS, `${locator} .offsetY`),
      loginX: leaf(s.loginX, LAYOUT_TS, `${locator} .loginX`),
      loginY: leaf(s.loginY, LAYOUT_TS, `${locator} .loginY`),
      loginGroupScale: leaf(s.loginGroupScale, LAYOUT_TS, `${locator} .loginGroupScale`),
      splashOffset: leaf(s.splashOffset, LAYOUT_TS, `${locator} .splashOffset`),
      spinner: wrapObj(s.spinner, LAYOUT_TS, `${locator} .spinner`),
      cindy: wrapObj(s.cindy, LAYOUT_TS, `${locator} .cindy`),
      slogan: wrapObj(s.slogan, LAYOUT_TS, `${locator} .slogan`),
      word: wrapObj(s.word, LAYOUT_TS, `${locator} .word`),
      designHeight: leaf(s.phone?.designHeight ?? null, LAYOUT_TS, `${locator} .phone.designHeight`),
      /* 物理 px 期望几何(门 D 未缩放绑定直接比对 computed style):
         group = Log_in 组外层(offset + loginX/Y × scale;宽 680×gs,高 560×gs 流高);
         panel = 面板本体(680×440 ×gs);hero/slogan/word = 品牌三要素物理框。 */
      physical: (() => {
        const gs = s.scale * s.loginGroupScale;
        // 面板/组高一律取产品常量(2026-07-27 改版:面板 440→500、组 560→620),不写死字面量
        const PANEL_W = tokens.loginSizes.panelWidth;
        const PANEL_H = tokens.loginSizes.panelHeight;
        const GROUP_H = tokens.loginSizes.flowHeight;
        const phys = {
          groupX: s.offsetX + s.loginX * s.scale,
          groupY: s.offsetY + s.loginY * s.scale,
          groupW: PANEL_W * gs,
          groupH: GROUP_H * gs,
          panelW: PANEL_W * gs,
          panelH: PANEL_H * gs,
          hero: {
            x: s.offsetX + s.cindy.x * s.scale,
            y: s.offsetY + s.cindy.y * s.scale,
            w: s.cindy.w * s.scale,
            h: s.cindy.h * s.scale,
          },
          slogan: {
            x: s.offsetX + s.slogan.x * s.scale,
            y: s.offsetY + s.slogan.y * s.scale,
            w: s.slogan.w * s.scale,
            h: s.slogan.h * s.scale,
          },
          word: {
            x: s.offsetX + s.word.x * s.scale,
            y: s.offsetY + s.word.y * s.scale,
            w: s.word.w * s.scale,
            h: s.word.h * s.scale,
          },
        };
        return wrapObj(
          JSON.parse(JSON.stringify(phys, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))),
          LAYOUT_TS,
          `${locator} 派生物理几何`,
        );
      })(),
    };
  }

  /* ── 键盘停靠避让期望值(oracle = 产品 computeLoginKeyboardShift 本体) ──
     2026-07-27 拍板:停靠贴附锚从「面板底」改到「error 槽底」(设计 y=430),
     位移量因此与面板 440→500 前保持一致。demo 侧用镜像公式算,门 D 拿这里的
     预计算值核对渲染结果(两次独立计算,杜绝 demo 与验收抄同一个错公式)。
     手机两档帧各算一次:phone-std(长屏)/ phone-se(短屏,可能触发 clamped-fallback)。 */
  const r2m = (v) => Math.round(v * 100) / 100;
  const KB_H = constants.keyboard.simKeyboardHeight.value;
  const KB_SAFE_TOP = constants.keyboard.simSafeTop.value;
  const KB_BAR_BOTTOM = constants.keyboard.simSystemBarBottom.value;
  const GAP = constants.keyboard.panelGap.value;
  /**
   * 停靠场景矩阵:四个移动形态(phone 短/长 + pad 竖/横,groupScale 各不同:
   * 手机 = 屏宽/750 × 1、pad 竖 = ×0.794117、pad 横 = ×0.655357)
   * × 停靠引擎三个分支:
   *  - docked        iOS 常规停靠(screenY 可靠路径,键盘顶 = h - kbH);
   *  - clamped       极端键盘高触发 safe-top 上限 → clamped-fallback(面板优先,
   *                  品牌/标题被挤出帧顶,产品定义为「不满足 U-8b 断言」的兜底);
   *  - androidNoResize  Android edge-to-edge 未缩窗:endCoordinates.screenY 退化为
   *                  viewportHeight(误判无遮挡),引擎改走「全高 - 键盘高 - 系统栏底」
   *                  兜底公式 → 键盘顶比 iOS 路径再高 systemBarBottom。
   * 每个组合的期望位移都由产品函数 computeLoginKeyboardShift 本体算出(oracle),
   * demo 侧用镜像公式独立算一遍,门 D 比对——两次独立计算的约定不变。
   */
  const keyboardSim = {};
  for (const [key, [w, h]] of Object.entries(FRAME_PRESETS)) {
    const s = layout.resolveLoginSurface(w, h);
    const gs = s.scale * s.loginGroupScale;
    const groupX = s.offsetX + s.loginX * s.scale;
    const groupY = s.offsetY + s.loginY * s.scale;
    // 停靠贴附锚 = 面板底(产品 login.tsx:panelBottomY = groupBaseline.y + loginSizes.panelHeight × groupScale)
    const anchorY = groupY + tokens.loginSizes.panelHeight * gs;
    const unionY = groupY + layout.LOGIN_CONTROL.inputY * gs;
    const unionBottom = groupY + (layout.LOGIN_CONTROL.buttonY + layout.LOGIN_CONTROL.height) * gs;
    const controlsUnion = {
      x: groupX + layout.LOGIN_CONTROL.x * gs,
      y: unionY,
      width: layout.LOGIN_CONTROL.width * gs,
      height: unionBottom - unionY,
    };
    // clamped 分支的最小触发键盘高:required > maxShift ⟺
    // anchorY + GAP - (h - kbH) > unionY - safeTop ⟹ kbH > unionY - safeTop - anchorY - GAP + h
    // 取 ceil + 8px 余量 = 「刚好越过上限」的最小现实值(不用占满屏的荒谬值)
    const kbClamped = Math.ceil(unionY - KB_SAFE_TOP - anchorY - GAP + h) + 8;
    const scenarios = {
      docked: { platform: 'ios', kbHeight: KB_H, systemBarBottom: 0 },
      clamped: { platform: 'ios', kbHeight: kbClamped, systemBarBottom: 0 },
      androidNoResize: { platform: 'android', kbHeight: KB_H, systemBarBottom: KB_BAR_BOTTOM },
    };
    const bag = {};
    for (const [name, sc] of Object.entries(scenarios)) {
      // Android 未缩窗:endCoordinates.screenY 退化为 viewportHeight(故 keyboard.y = h)
      const kbRectY = sc.platform === 'android' ? h : h - sc.kbHeight;
      const keyboard = { x: 0, y: kbRectY, width: w, height: sc.kbHeight };
      const res = kbEngine.computeLoginKeyboardShift({
        platform: sc.platform,
        visible: true,
        keyboard,
        panelBottomY: anchorY,
        controlsUnion,
        viewportWidth: w,
        viewportHeight: h,
        safeTop: KB_SAFE_TOP,
        fullViewportHeight: h, // = viewportHeight ⟹ 未缩窗(Android 走 height 兜底)
        systemBarBottom: sc.systemBarBottom,
      });
      // 引擎认定的键盘顶(demo 画的键盘矩形与仪表都按它,和位移公式同一口径)
      const keyboardTopY =
        sc.platform === 'android'
          ? Math.max(0, h - sc.kbHeight - sc.systemBarBottom)
          : Math.min(kbRectY, h);
      bag[name] = wrapObj(
        {
          // ── 输入(demo 从这里读,不复抄字面量) ──
          platform: sc.platform,
          kbHeight: sc.kbHeight,
          systemBarBottom: sc.systemBarBottom,
          viewportW: w,
          viewportH: h,
          // ── 产品函数算出的期望输出(demo 侧独立算,门 D 比对) ──
          keyboardTopY: r2m(keyboardTopY),
          anchorY: r2m(anchorY),
          shift: r2m(res.shift),
          mode: res.mode,
          groupTopShifted: r2m(groupY - res.shift),
        },
        KB_TS,
        `computeLoginKeyboardShift(${key} ${w}×${h} · ${name}:${sc.platform} 键盘 ${sc.kbHeight}px,锚=error 槽底)`,
      );
    }
    keyboardSim[key] = bag;
  }

  return { geometry, colors, theme, copy, urls, constants, icons, assets, frames, keyboardSim };
})();

/* desk 的 adaptive.samples 单独挂到 truth 根(verify.mjs 门 F 硬编码读 adaptive.samples;
   provenance 豁免路径也是 adaptive.samples——故不放 desk.* 下)。 */
process.stdout.write(
  JSON.stringify({ desk, mobile, adaptive: { samples: deskSamples } }, null, 2),
);
