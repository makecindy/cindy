#!/usr/bin/env node
/**
 * 生成 iOS 备选应用图标（wordmark）。
 *
 * 为什么需要它：iOS 备选图标必须是 1024×1024 满幅、不带 alpha 的 PNG。桌面 Dock 用的
 * `apps/desktop/resources/app-icons/wordmark-*.png` 是 512、四周 47px 透明边距、圆角已烘进
 * 文件的成图（见 `apps/desktop/scripts/generate-mac-icns.mjs`），直接复用会出现透明角与
 * 双重圆角。
 *
 * 做法：用仓库内官方字标 SVG（`.github/assets/cindy-wordmark-*.svg`）在采样自桌面成图的
 * 渐变底上重排。字标宽度与垂直位置沿用桌面成图的比例（宽 67.8%、中心 y 50.2%）。
 *
 * 依赖本机 ImageMagick（`magick`），不新增 npm 依赖；产物入库，构建期不需要它。
 *
 * 用法：node scripts/generate-mobile-app-icons.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'apps/mobile/assets/app-icons');

const CANVAS = 1024;
// 桌面 wordmark 成图：字标墨迹宽 347/512，中心 y 257/512。
const WORDMARK_WIDTH = Math.round(CANVAS * (347 / 512));
const WORDMARK_Y_OFFSET = Math.round(CANVAS * (257 / 512) - CANVAS / 2);

const VARIANTS = [
  {
    file: 'wordmark-light.png',
    svg: '.github/assets/cindy-wordmark-light.svg',
    // 采样自 apps/desktop/resources/app-icons/wordmark-light.png 的上/下边缘。
    background: ['#FFFFFA', '#EDEDE8'],
  },
  {
    file: 'wordmark-dark.png',
    svg: '.github/assets/cindy-wordmark-dark.svg',
    // 采样自 apps/desktop/resources/app-icons/wordmark-dark.png 的上/下边缘。
    background: ['#322C2C', '#121010'],
  },
];

function magick(args) {
  execFileSync('magick', args, { stdio: 'inherit' });
}

function inspect(file) {
  const out = execFileSync(
    'magick',
    ['identify', '-format', '%w %h %[channels]', file],
    { encoding: 'utf8' },
  ).trim();
  const [width, height, channels] = out.split(' ');
  return { width: Number(width), height: Number(height), channels };
}

fs.mkdirSync(outDir, { recursive: true });

for (const variant of VARIANTS) {
  const svgPath = path.join(repoRoot, variant.svg);
  if (!fs.existsSync(svgPath)) {
    throw new Error(`missing wordmark svg: ${variant.svg}`);
  }
  const target = path.join(outDir, variant.file);
  const [top, bottom] = variant.background;
  magick([
    '-size',
    `${CANVAS}x${CANVAS}`,
    `gradient:${top}-${bottom}`,
    '(',
    '-background',
    'none',
    '-density',
    '120',
    svgPath,
    '-resize',
    `${WORDMARK_WIDTH}x`,
    ')',
    '-gravity',
    'center',
    '-geometry',
    `+0+${WORDMARK_Y_OFFSET}`,
    '-composite',
    '-alpha',
    'off',
    '-colorspace',
    'sRGB',
    '-strip',
    target,
  ]);

  const { width, height, channels } = inspect(target);
  if (width !== CANVAS || height !== CANVAS || channels.endsWith('a')) {
    throw new Error(`${variant.file}: expected ${CANVAS}x${CANVAS} without alpha, got ${width}x${height} ${channels}`);
  }
  console.log(`${path.relative(repoRoot, target)}  ${width}x${height}  ${channels}`);
}
