#!/usr/bin/env node
/**
 * 生成 iOS 备选应用图标（default 之外的 cat / mark / wordmark）。
 *
 * 为什么需要它：iOS 备选图标必须是 1024×1024 满幅、不带 alpha 的 PNG。桌面 Dock 用的
 * `apps/desktop/resources/app-icons/*.png` 是 512、四周 47px 透明边距、圆角已烘进文件的
 * 成图（见 `apps/desktop/scripts/generate-mac-icns.mjs`），直接复用会出现透明角与双重圆角。
 *
 * 做法：
 * - wordmark：用仓库内官方字标 SVG（`.github/assets/cindy-wordmark-*.svg`）在采样自桌面成图
 *   的渐变底上重排，字标宽 67.8%、中心 y 50.2%。
 * - mark：从桌面成图里按“红色主导度”提取箭头与圆点（保留原形状与抗锯齿），放到同一渐变底上。
 * - cat：把桌面成图放到渐变底上，用圆角蒙版去掉烘进去的圆角边，并把边缘的 1px 描边做轻微
 *   模糊回填；插图超出原圆角的部分由蒙版羽化收口。
 *
 * 依赖 workspace 内已有的 `sharp`（`apps/desktop` 的依赖），不新增 npm 依赖。产物入库，
 * 构建期不需要它。用法：node scripts/generate-mobile-app-icons.mjs
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromDesktop = createRequire(path.join(repoRoot, 'apps/desktop/package.json'));
const sharp = requireFromDesktop('sharp');

const SIZE = 1024;
const RESOURCES = path.join(repoRoot, 'apps/desktop/resources/app-icons');
const OUT_DIR = path.join(repoRoot, 'apps/mobile/assets/app-icons');

const WORDMARK_WIDTH = Math.round(SIZE * (347 / 512));
const WORDMARK_TOP = Math.round(SIZE * (257 / 512) - SIZE / 2);

const VARIANTS = [
  {
    file: 'wordmark-light.png',
    svg: '.github/assets/cindy-wordmark-light.svg',
    background: ['#FFFFFA', '#EDEDE8'],
  },
  {
    file: 'wordmark-dark.png',
    svg: '.github/assets/cindy-wordmark-dark.svg',
    background: ['#322C2C', '#121010'],
  },
  {
    file: 'mark-light.png',
    extractRed: path.join(RESOURCES, 'mark-light.png'),
    background: ['#FFFFFA', '#EDEDE8'],
  },
  {
    file: 'mark-dark.png',
    extractRed: path.join(RESOURCES, 'mark-dark.png'),
    background: ['#322C2C', '#121010'],
  },
  {
    file: 'cat.png',
    roundedTile: path.join(RESOURCES, 'cat.png'),
    background: ['#F80121', '#E10D28'],
  },
];

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function gradientRaw(topHex, bottomHex) {
  const top = hexToRgb(topHex);
  const bottom = hexToRgb(bottomHex);
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y += 1) {
    const t = y / (SIZE - 1);
    const color = top.map((channel, index) => Math.round(channel + (bottom[index] - channel) * t));
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 3;
      rgb[offset] = color[0];
      rgb[offset + 1] = color[1];
      rgb[offset + 2] = color[2];
    }
  }
  return rgb;
}

function roundedRectSvg({ inset, radius, fill, stroke, strokeWidth }) {
  const size = SIZE - inset * 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
      `<rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${radius}" ` +
      (fill ? `fill="${fill}"` : 'fill="none"') +
      (stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : '') +
      '/></svg>',
  );
}

async function greyscaleRaw(svg, blur) {
  let image = sharp(svg).greyscale();
  if (blur) image = image.blur(blur);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { data, channels: info.channels };
}

function normalizeRgb(raw, channels) {
  if (channels === 3) return raw;
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0, j = 0; i < raw.length; i += channels, j += 3) {
    rgb[j] = raw[i];
    rgb[j + 1] = raw[i + 1];
    rgb[j + 2] = raw[i + 2];
  }
  return rgb;
}

async function fromRgb(raw) {
  return sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
}

async function writePng(buffer, file) {
  const target = path.join(OUT_DIR, file);
  const { width, height } = await sharp(buffer).metadata();
  if (width !== SIZE || height !== SIZE) throw new Error(`${file}: expected ${SIZE}x${SIZE}, got ${width}x${height}`);
  await sharp(buffer).removeAlpha().png({ compressionLevel: 9 }).toFile(target);
  console.log(`${path.relative(repoRoot, target)}  ${width}x${height}`);
}

async function wordmark(variant) {
  const svgPath = path.join(repoRoot, variant.svg);
  const wordmark = await sharp(svgPath, { density: 120, limitInputPixels: false })
    .resize({ width: WORDMARK_WIDTH })
    .png()
    .toBuffer();
  const meta = await sharp(wordmark).metadata();
  const background = await fromRgb(gradientRaw(...variant.background));
  const composed = await sharp(background)
    .composite([
      {
        input: wordmark,
        left: Math.round((SIZE - meta.width) / 2),
        top: Math.round((SIZE - meta.height) / 2) + WORDMARK_TOP,
      },
    ])
    .png()
    .toBuffer();
  await writePng(composed, variant.file);
}

async function mark(variant) {
  const { data, info } = await sharp(variant.extractRed)
    .resize(SIZE, SIZE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const foreground = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0, j = 0; i < data.length; i += info.channels, j += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    // 红色主导度：红远高于绿/蓝的位置就是 mark，保留原抗锯齿边缘。
    const alpha = Math.max(0, Math.min(255, Math.round((r - Math.max(g, b)) * 3)));
    foreground[j] = 247;
    foreground[j + 1] = 1;
    foreground[j + 2] = 33;
    foreground[j + 3] = alpha;
  }
  const foregroundPng = await sharp(foreground, {
    raw: { width: SIZE, height: SIZE, channels: 4 },
  })
    .png()
    .toBuffer();
  const background = await fromRgb(gradientRaw(...variant.background));
  const composed = await sharp(background)
    .composite([{ input: foregroundPng }])
    .png()
    .toBuffer();
  await writePng(composed, variant.file);
}

async function cat(variant) {
  const backgroundRaw = gradientRaw(...variant.background);
  const background = await fromRgb(backgroundRaw);

  const tile = await sharp(variant.roundedTile).resize(SIZE, SIZE).png().toBuffer();
  const tileOnBackground = await sharp(background)
    .composite([{ input: tile }])
    .png()
    .toBuffer();
  const tileRawInfo = await sharp(tileOnBackground).raw().toBuffer({ resolveWithObject: true });
  const tileRaw = normalizeRgb(tileRawInfo.data, tileRawInfo.info.channels);
  const blurredInfo = await sharp(tileOnBackground).blur(10).raw().toBuffer({ resolveWithObject: true });
  const blurredRaw = normalizeRgb(blurredInfo.data, blurredInfo.info.channels);

  // 桌面成图自带的 1px 圆角描边：沿原圆角边界做一次轻微模糊回填，避免留下内圈。
  const ring = await greyscaleRaw(
    roundedRectSvg({ inset: 94, radius: 184, fill: null, stroke: '#FFFFFF', strokeWidth: 12 }),
    3,
  );
  const featherMask = await greyscaleRaw(
    roundedRectSvg({ inset: 30, radius: 184, fill: '#FFFFFF' }),
    26,
  );

  const output = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0, j = 0; i < SIZE * SIZE; i += 1, j += 3) {
    const ringMix = ring.data[i * ring.channels] / 255;
    const maskMix = featherMask.data[i * featherMask.channels] / 255;
    for (let c = 0; c < 3; c += 1) {
      const cleaned = tileRaw[j + c] * (1 - ringMix) + blurredRaw[j + c] * ringMix;
      output[j + c] = Math.round(backgroundRaw[j + c] * (1 - maskMix) + cleaned * maskMix);
    }
  }
  await writePng(await fromRgb(output), variant.file);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const variant of VARIANTS) {
  if (variant.svg) await wordmark(variant);
  else if (variant.extractRed) await mark(variant);
  else await cat(variant);
}
