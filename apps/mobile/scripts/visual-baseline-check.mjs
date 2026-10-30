#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMobileE2eProfile } from './mobile-e2e-profile.mjs';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');
const acceptedScreenshotNames = [
  'visual-devices',
  'visual-device-detail',
  'visual-device-detail-filters',
  'visual-device-detail-automation-group',
  'visual-device-detail-selection',
  'visual-session',
  'visual-session-controls',
  'visual-session-controls-session',
  'visual-session-controls-usage',
  'visual-session-idle',
  'visual-session-running',
  'visual-session-pending',
  'visual-session-permission',
  'visual-session-ask',
  'visual-session-queue',
  'visual-session-offline',
  'visual-session-revoked',
  'visual-settings',
  'visual-session-payload',
  'visual-new-session',
  'visual-files',
  'visual-files-preview',
];
const pendingBaselineScreenshotNames = [];
const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const skippedDirs = new Set([
  '.expo',
  '.git',
  'android',
  'ios',
  'node_modules',
  'visual-baselines',
]);
let sharpModule = null;

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const requestedProfile = options.profile
  ?? process.env.XDT_MOBILE_VISUAL_PROFILE
  ?? process.env.XDT_MOBILE_E2E_PROFILE
  ?? 'ios-iphone-17-pro-expo-go';
const profileConfig = resolveMobileE2eProfile(requestedProfile, { allowUnknown: true });
const profile = profileConfig?.visualProfile
  ?? requestedProfile;
const actualDir = resolveFromMobile(
  options.actualDir ?? process.env.XDT_MOBILE_VISUAL_ACTUAL_DIR ?? '.',
);
const baselineDir = resolveFromMobile(
  options.baselineDir
    ?? process.env.XDT_MOBILE_VISUAL_BASELINE_DIR
    ?? join('e2e', 'visual-baselines', profile),
);
const currentManifest = readManifest(baselineDir);
const screenshotNames = options.screenshots.length > 0
  ? unique(options.screenshots)
  : defaultScreenshotNames({
    includePending: options.update,
    manifest: currentManifest,
  });
const ignoreTopPx = options.ignoreTopPx
  ?? Number(process.env.XDT_MOBILE_VISUAL_IGNORE_TOP_PX ?? profileConfig?.visualIgnoreTopPx ?? (profile.startsWith('ios-') ? 120 : 0));
const visualMasks = normalizeVisualMasks(profileConfig?.visualMasks);
const pixelTolerance = Number(process.env.XDT_MOBILE_VISUAL_PIXEL_TOLERANCE ?? profileConfig?.visualPixelTolerance ?? 0);

if (options.dryRun) {
  console.log(formatLines([
    'visual baseline dry run',
    `profile: ${profile}`,
    `profileConfig: ${profileConfig?.name ?? '<custom>'}`,
    `actualDir: ${actualDir}`,
    `baselineDir: ${baselineDir}`,
    `ignoreTopPx: ${ignoreTopPx}`,
    `pixelTolerance: ${pixelTolerance}`,
    `maskedScreenshots: ${Object.keys(visualMasks).join(', ') || '<none>'}`,
    `screenshots: ${screenshotNames.join(', ')}`,
  ]));
  process.exit(0);
}

const result = options.update
  ? updateBaselines({ actualDir, baselineDir, profile, screenshotNames, allowMissing: options.allowMissing })
  : await checkBaselines({
    actualDir,
    baselineDir,
    screenshotNames,
    allowMissing: options.allowMissing,
    ignoreTopPx,
    pixelTolerance,
    visualMasks,
});

console.log(result.message);
if (!result.ok) process.exit(1);

function updateBaselines({ actualDir, baselineDir, profile, screenshotNames, allowMissing }) {
  mkdirSync(baselineDir, { recursive: true });

  const manifest = {
    version: 1,
    profile,
    updatedAt: new Date().toISOString(),
    screenshots: {
      ...(currentManifest?.screenshots ?? {}),
    },
  };
  const failures = [];
  const updated = [];

  for (const name of screenshotNames) {
    const actual = findScreenshot(actualDir, name);
    if (!actual) {
      failures.push(`missing actual screenshot: ${name}`);
      continue;
    }

    const ext = normalizeImageExt(extname(actual.path));
    const file = `${name}${ext}`;
    const target = join(baselineDir, file);
    copyFileSync(actual.path, target);
    const metadata = fileMetadata(target);
    manifest.screenshots[name] = {
      file,
      bytes: metadata.bytes,
      sha256: metadata.sha256,
      updatedAt: manifest.updatedAt,
    };
    updated.push(`${name} <- ${relative(mobileRoot, actual.path)}`);
  }

  if (updated.length > 0) {
    writeFileSync(join(baselineDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const ok = failures.length === 0 || allowMissing;
  return {
    ok,
    message: formatLines([
      `visual baseline update ${ok ? 'passed' : 'failed'}: ${updated.length} updated`,
      ...updated.map((item) => `updated ${item}`),
      ...failures.map((item) => (allowMissing ? `warning ${item}` : `error ${item}`)),
      `baselineDir: ${relative(mobileRoot, baselineDir) || '.'}`,
    ]),
  };
}

function defaultScreenshotNames({ includePending, manifest }) {
  const accepted = [...acceptedScreenshotNames];
  const manifestScreenshots = manifest?.screenshots && typeof manifest.screenshots === 'object'
    ? manifest.screenshots
    : {};
  const pending = pendingBaselineScreenshotNames.filter((name) =>
    includePending || Object.prototype.hasOwnProperty.call(manifestScreenshots, name),
  );
  return unique([...accepted, ...pending]);
}

async function checkBaselines({
  actualDir,
  baselineDir,
  screenshotNames,
  allowMissing,
  ignoreTopPx,
  pixelTolerance,
  visualMasks,
}) {
  const manifest = readManifest(baselineDir);
  const failures = [];
  const warnings = [];
  const checked = [];

  for (const name of screenshotNames) {
    const actual = findScreenshot(actualDir, name);
    const baseline = findBaselineScreenshot(baselineDir, name, manifest);

    if (!actual) {
      failures.push(`missing actual screenshot: ${name}`);
      continue;
    }
    if (!baseline) {
      failures.push(`missing baseline screenshot: ${name}`);
      continue;
    }

    const masks = visualMasks[name] ?? [];
    const actualMeta = await comparableFileMetadata(actual.path, ignoreTopPx, masks);
    const baselineMeta = await comparableFileMetadata(baseline.path, ignoreTopPx, masks);
    if (actualMeta.sha256 !== baselineMeta.sha256 || actualMeta.bytes !== baselineMeta.bytes) {
      const diff = compareRawPixels(actualMeta, baselineMeta, pixelTolerance);
      if (diff?.changedPixels === 0) {
        checked.push(name);
        continue;
      }
      failures.push([
        `changed screenshot: ${name}`,
        `  actual: ${relative(mobileRoot, actual.path)} ${actualMeta.bytes}b ${actualMeta.sha256}${actualMeta.mode ? ` (${actualMeta.mode})` : ''}`,
        `  baseline: ${relative(mobileRoot, baseline.path)} ${baselineMeta.bytes}b ${baselineMeta.sha256}${baselineMeta.mode ? ` (${baselineMeta.mode})` : ''}`,
        diff
          ? `  diff: ${diff.changedPixels}/${diff.totalPixels} px > tolerance ${pixelTolerance} (${diff.changedRatio.toFixed(4)}), maxDelta ${diff.maxDelta}`
          : `  diff: unavailable; sizes or comparison modes differ`,
      ].join('\n'));
      continue;
    }

    if (
      (!ignoreTopPx || ignoreTopPx <= 0)
      && manifest?.screenshots?.[name]?.sha256
      && manifest.screenshots[name].sha256 !== baselineMeta.sha256
    ) {
      warnings.push(`manifest hash is stale for ${name}; run with --update after accepting the baseline`);
    }
    checked.push(name);
  }

  const ok = failures.length === 0 || allowMissing;
  return {
    ok,
    message: formatLines([
      `visual baseline check ${ok ? 'passed' : 'failed'}: ${checked.length} checked`,
      ...checked.map((name) => `checked ${name}`),
      ...warnings.map((item) => `warning ${item}`),
      ...failures.map((item) => (allowMissing ? `warning ${item}` : `error ${item}`)),
      ignoreTopPx > 0 ? `comparison: cropped top ${ignoreTopPx}px before hashing` : 'comparison: full image hash',
      Object.keys(visualMasks).length > 0
        ? `comparison: masked dynamic regions in ${Object.keys(visualMasks).join(', ')}`
        : null,
      pixelTolerance > 0 ? `comparison: tolerated per-channel pixel delta <= ${pixelTolerance}` : null,
      `actualDir: ${relative(mobileRoot, actualDir) || '.'}`,
      `baselineDir: ${relative(mobileRoot, baselineDir) || '.'}`,
    ]),
  };
}

function findBaselineScreenshot(baselineDir, name, manifest) {
  const file = manifest?.screenshots?.[name]?.file;
  if (file) {
    const manifestPath = join(baselineDir, file);
    if (existsSync(manifestPath)) return { path: manifestPath };
  }
  return findScreenshot(baselineDir, name);
}

function findScreenshot(dir, name) {
  if (!existsSync(dir)) return null;

  const matches = [];
  walk(dir, (file) => {
    const ext = extname(file).toLowerCase();
    const baseName = basename(file, ext);
    const fileName = basename(file);
    if (baseName !== name && fileName !== name) return;
    if (ext && !imageExts.has(ext)) return;
    matches.push(file);
  });

  matches.sort((left, right) => {
    const leftRel = relative(dir, left);
    const rightRel = relative(dir, right);
    const leftDepth = leftRel.split(/[\\/]/).length;
    const rightDepth = rightRel.split(/[\\/]/).length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return leftRel.localeCompare(rightRel);
  });
  return matches[0] ? { path: matches[0] } : null;
}

function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    if (skippedDirs.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, onFile);
      continue;
    }
    if (stat.isFile()) onFile(fullPath);
  }
}

function fileMetadata(file) {
  const data = readFileSync(file);
  return {
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

async function comparableFileMetadata(file, ignoreTopPx, masks = []) {
  const hasCrop = ignoreTopPx && ignoreTopPx > 0;
  const hasMasks = masks.length > 0;
  if (!hasCrop && !hasMasks) return fileMetadata(file);
  const sharp = await loadSharp();
  const image = sharp(file);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const top = hasCrop ? Math.min(Math.max(0, ignoreTopPx), Math.max(0, height - 1)) : 0;
  if (!width || !height || (top <= 0 && !hasMasks)) return fileMetadata(file);
  const croppedHeight = top > 0 ? height - top : height;
  const overlays = await Promise.all(
    masks
      .map((mask) => normalizeVisualMaskForViewport(mask, width, croppedHeight, top))
      .filter(Boolean)
      .map(async (mask) => ({
        input: await sharp({
          create: {
            width: mask.width,
            height: mask.height,
            channels: 4,
            background: '#ffffff',
          },
        }).png().toBuffer(),
        left: mask.left,
        top: mask.top,
      })),
  );
  let pipeline = sharp(file).ensureAlpha();
  if (top > 0) pipeline = pipeline.extract({ left: 0, top, width, height: height - top });
  if (overlays.length > 0) pipeline = pipeline.composite(overlays);
  const { data } = await pipeline
    .raw()
    .toBuffer({ resolveWithObject: true });
  const modes = [];
  if (top > 0) modes.push(`crop-top:${top}px`);
  if (overlays.length > 0) modes.push(`mask:${overlays.length}`);
  modes.push('raw-rgba');
  return {
    bytes: data.byteLength,
    data,
    sha256: createHash('sha256').update(data).digest('hex'),
    mode: modes.join(','),
  };
}

function compareRawPixels(actual, baseline, tolerance) {
  if (!actual.data || !baseline.data || actual.data.byteLength !== baseline.data.byteLength) return null;
  const totalPixels = actual.data.byteLength / 4;
  let changedPixels = 0;
  let maxDelta = 0;
  for (let index = 0; index < actual.data.byteLength; index += 4) {
    const delta = Math.max(
      Math.abs(actual.data[index] - baseline.data[index]),
      Math.abs(actual.data[index + 1] - baseline.data[index + 1]),
      Math.abs(actual.data[index + 2] - baseline.data[index + 2]),
      Math.abs(actual.data[index + 3] - baseline.data[index + 3]),
    );
    maxDelta = Math.max(maxDelta, delta);
    if (delta > tolerance) changedPixels += 1;
  }
  return {
    changedPixels,
    changedRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
    maxDelta,
    totalPixels,
  };
}

function normalizeVisualMasks(value) {
  if (!value || typeof value !== 'object') return {};
  const normalized = {};
  for (const [name, masks] of Object.entries(value)) {
    if (!Array.isArray(masks)) continue;
    normalized[name] = masks
      .map((mask) => normalizeVisualMaskShape(mask))
      .filter(Boolean);
  }
  return normalized;
}

function normalizeVisualMaskShape(mask) {
  if (!mask || typeof mask !== 'object') return null;
  const left = Math.max(0, Math.round(Number(mask.left)));
  const top = Math.max(0, Math.round(Number(mask.top)));
  const width = Math.round(Number(mask.width));
  const height = Math.round(Number(mask.height));
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

function normalizeVisualMaskForViewport(mask, imageWidth, imageHeight, cropTop) {
  const shape = normalizeVisualMaskShape(mask);
  if (!shape) return null;
  const left = Math.min(shape.left, Math.max(0, imageWidth - 1));
  const topInViewport = shape.top - cropTop;
  const bottomInViewport = topInViewport + shape.height;
  const top = Math.min(Math.max(0, topInViewport), Math.max(0, imageHeight - 1));
  const width = Math.min(shape.width, imageWidth - left);
  const height = Math.min(bottomInViewport, imageHeight) - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

async function loadSharp() {
  if (!sharpModule) {
    sharpModule = (await import('sharp')).default;
  }
  return sharpModule;
}

function readManifest(baselineDir) {
  const manifestPath = join(baselineDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function normalizeImageExt(ext) {
  const normalized = ext.toLowerCase();
  return imageExts.has(normalized) ? normalized : '.png';
}

function resolveFromMobile(value) {
  return resolve(mobileRoot, value);
}

function formatLines(lines) {
  return lines.filter(Boolean).join('\n');
}

function unique(values) {
  return [...new Set(values)];
}

function parseArgs(args) {
  const parsed = {
    actualDir: undefined,
    allowMissing: false,
    baselineDir: undefined,
    dryRun: false,
    help: false,
    ignoreTopPx: undefined,
    profile: undefined,
    screenshots: [],
    update: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--allow-missing') {
      parsed.allowMissing = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--update') {
      parsed.update = true;
      continue;
    }
    if (arg === '--actual-dir') {
      parsed.actualDir = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--baseline-dir') {
      parsed.baselineDir = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--profile') {
      parsed.profile = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--ignore-top-px') {
      const value = Number(readValue(args, index, arg));
      if (!Number.isFinite(value) || value < 0) throw new Error('--ignore-top-px requires a non-negative number');
      parsed.ignoreTopPx = value;
      index += 1;
      continue;
    }
    if (arg === '--screenshots') {
      parsed.screenshots.push(...readValue(args, index, arg).split(',').map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }
    parsed.screenshots.push(arg);
  }

  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/visual-baseline-check.mjs [options]

Options:
  --actual-dir <path>     Directory containing Maestro takeScreenshot artifacts. Defaults to apps/mobile.
  --baseline-dir <path>   Baseline directory. Defaults to e2e/visual-baselines/<profile>.
  --profile <name>        Baseline profile name. Defaults to ios-iphone-17-pro-expo-go.
                          Known E2E profiles also set the correct visual comparison defaults.
  --ignore-top-px <px>    Crop this many top pixels before comparison. Defaults to 120 for ios-* profiles and 0 for android-* profiles.
  --screenshots <names>   Comma-separated screenshot names. Defaults to the visual_smoke.yaml set.
  --update                Copy actual screenshots into the baseline directory and refresh manifest.json.
  --allow-missing         Report missing files as warnings.
  --dry-run               Print resolved configuration without reading files.
  --help                  Show this help.
`);
}
