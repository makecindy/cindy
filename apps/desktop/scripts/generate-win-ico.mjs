#!/usr/bin/env node
/**
 * generate-win-ico.mjs — 从 1024x1024 母版生成带圆角的 Windows icon.ico。
 *
 * Windows 的 BrowserWindow / 任务栏不会替 PNG/ICO 自动套圆角，圆角必须画进
 * 资源本身；但 Windows 任务栏已经提供固定图标槽，不应再复用 macOS Big Sur+
 * 的 100px 安全区。这里让内容占满 1024x1024 画布，只在四角套圆角遮罩，避免
 * 24px 任务栏档位里的主体被二次缩小。
 *
 * 条目结构与现行 icon.ico 逐项对齐，**不要改动尺寸档位或顺序**：
 *   16 / 24 / 32 / 48 / 64 / 128 / 256，全部 32bpp 未压缩 BMP(XOR 位图 + AND 掩码)。
 *   - 不用 PNG 压缩条目：老版 Windows 资源查看器与部分第三方壳对 PNG 条目支持不佳，
 *     现行 ico 全 BMP，保持一致最稳。
 *   - 顺序/数量影响 exe 图标资源索引：resources/installer.nsh 的 customInit 注释
 *     说明了旧 .lnk 的 IconLocation 索引会因此漂移，保持结构不变可避免新一轮漂移。
 *
 * 用法（仓库根或 apps/desktop 下执行均可）：
 *   node apps/desktop/scripts/generate-win-ico.mjs [master.png] [out.ico]
 *   默认：master = apps/desktop/resources/icon-master-1024.png
 *         out    = apps/desktop/resources/icon.ico
 *   使用默认 out 时还会同步生成 resources/icon.png，以及 cindy-updater 的
 *   src-tauri/icons/icon.ico 与 icon.png，避免主应用和更新器图标漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resourcesDir = path.join(__dirname, '..', 'resources');
const defaultOutPath = path.join(resourcesDir, 'icon.ico');
const defaultPngPath = path.join(resourcesDir, 'icon.png');
const updaterIconsDir = path.join(__dirname, '..', 'cindy-updater', 'src-tauri', 'icons');

const masterPath = process.argv[2] ?? path.join(resourcesDir, 'icon-master-1024.png');
const outPath = process.argv[3] ?? defaultOutPath;

const CANVAS = 1024;
// 保留 macOS 模板的圆角比例（185.4 / 824），但不保留 macOS 外边距。
const RADIUS = 230.4;

// 与现行 icon.ico 一致的尺寸档位（小 → 大）。
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * 把 RGBA 像素编码成 ico 内嵌 BMP 条目：
 *   BITMAPINFOHEADER(biHeight = 高度 x2，含 AND 掩码)
 *   + XOR 位图（BGRA，行序自下而上）
 *   + AND 掩码（1bpp，每行按 32bit 对齐；透明角同时写入 alpha 与 AND 掩码）
 */
function encodeBmpEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  // biCompression / biSizeImage / 其余字段保持 0。

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y; // 自下而上。
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  // alpha 供现代 Windows 使用；AND 掩码让旧 GDI 路径也能正确显示透明角。
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskRowBytes * size);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y; // AND 位图同样是自下而上。
    for (let x = 0; x < size; x++) {
      const alpha = rgba[(srcRow * size + x) * 4 + 3];
      if (alpha < 128) {
        and[y * maskRowBytes + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
      }
    }
  }

  return Buffer.concat([header, xor, and]);
}

/** 把满幅母版处理成 Windows 专用的满画布透明圆角图标。 */
async function createRoundedMaster() {
  const roundedMask = Buffer.from(
    `<svg width="${CANVAS}" height="${CANVAS}"><rect width="${CANVAS}" height="${CANVAS}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`,
  );
  return sharp(masterPath)
    .resize(CANVAS, CANVAS, { fit: 'cover' })
    .ensureAlpha()
    .composite([{ input: roundedMask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * 默认生成时同步主应用 PNG 与 updater 的 PNG/ICO 资源。
 * cindy-updater 属于高风险模块，合入涉及其资源的 PR 前必须保留 owner 确认。
 */
async function syncDefaultCompanionIcons(roundedMaster) {
  const png = await sharp(roundedMaster).resize(512, 512).png().toBuffer();
  const updaterIcoPath = path.join(updaterIconsDir, 'icon.ico');
  const updaterPngPath = path.join(updaterIconsDir, 'icon.png');

  fs.mkdirSync(updaterIconsDir, { recursive: true });
  fs.writeFileSync(defaultPngPath, png);
  fs.copyFileSync(outPath, updaterIcoPath);
  fs.writeFileSync(updaterPngPath, png);

  console.log(`[generate-win-ico] wrote ${defaultPngPath}`);
  console.log(`[generate-win-ico] wrote ${updaterIcoPath}`);
  console.log(`[generate-win-ico] wrote ${updaterPngPath}`);
}

async function main() {
  if (!fs.existsSync(masterPath)) {
    console.error(`[generate-win-ico] master image missing: ${masterPath}`);
    process.exit(1);
  }

  const roundedMaster = await createRoundedMaster();
  const entries = [];
  for (const size of SIZES) {
    const rgba = await sharp(roundedMaster)
      .resize(size, size, { fit: 'cover' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    entries.push({ size, data: encodeBmpEntry(rgba, size) });
  }

  // ICONDIR(6B) + ICONDIRENTRY(16B x N) + 各条目数据。
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);

  const dirEntries = [];
  let offset = 6 + entries.length * 16;
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size; // 0 表示 256。
    e[1] = size === 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    dirEntries.push(e);
    offset += data.length;
  }

  fs.writeFileSync(outPath, Buffer.concat([dir, ...dirEntries, ...entries.map((e) => e.data)]));

  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`[generate-win-ico] wrote ${outPath} (${sizeKb} KB, ${entries.length} entries)`);

  if (path.resolve(outPath) === path.resolve(defaultOutPath)) {
    await syncDefaultCompanionIcons(roundedMaster);
  }
}

main().catch((err) => {
  console.error('[generate-win-ico] failed:', err);
  process.exit(1);
});
