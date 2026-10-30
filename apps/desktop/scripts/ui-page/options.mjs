import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const localeSource = readFileSync(
  fileURLToPath(new URL('../../src/shared/locale.ts', import.meta.url)),
  'utf8',
);
/** The product's own locale list; the runner never keeps a second copy. */
export const LOCALES = [
  ...localeSource.match(/SUPPORTED_LOCALES\s*=\s*\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g),
].map((match) => match[1]);
export const THEMES = ['light', 'dark'];
export const PLATFORMS = ['darwin', 'win32', 'linux'];

const VALUE_OPTIONS = new Set([
  'page',
  'case',
  'theme',
  'locale',
  'viewport',
  'width',
  'height',
  'platform',
  'engine',
  'timeout',
  'browser',
  'output',
  'entry',
  'compare',
  'focus',
]);
const FLAGS = new Set(['preview', 'list', 'help', 'json']);

function list(value, all, name) {
  const items = value === 'all' ? all : value.split(',').map((item) => item.trim());
  for (const item of items)
    if (!all.includes(item)) throw new Error(`--${name}: ${all.join(' | ')} | all`);
  return [...new Set(items)];
}

function viewports(value) {
  return value.split(',').map((item) => {
    const match = /^(\d+)x(\d+)$/.exec(item.trim());
    if (!match) throw new Error('--viewport: <width>x<height>[,<width>x<height>]');
    const [width, height] = [Number(match[1]), Number(match[2])];
    if (width < 360 || width > 3840 || height < 320 || height > 2160)
      throw new Error('--viewport: width 360–3840, height 320–2160');
    return { width, height };
  });
}

export function parseOptions(argv) {
  const raw = {};
  const options = { mode: 'check' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const [, name, inline] = match;
    if (name === 'changed') {
      // `--changed` alone compares with the upstream merge-base; `--changed=<ref>` picks a ref.
      options.changed = inline ?? true;
      continue;
    }
    if (
      name === 'compare' &&
      inline === undefined &&
      (!argv[i + 1] || argv[i + 1].startsWith('--'))
    ) {
      // `--compare` alone renders the branch's merge-base as "before".
      raw.compare = true;
      continue;
    }
    if (FLAGS.has(name)) {
      if (name === 'preview') options.mode = 'preview';
      else options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: ${arg}`);
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: --${name}`);
    raw[name] = value;
  }
  options.page = raw.page;
  options.cases = raw.case ?? 'default';
  options.themes = list(raw.theme ?? 'light', THEMES, 'theme');
  options.locales = list(raw.locale ?? 'zh-CN', LOCALES, 'locale');
  // Same platform as the machine taking the screenshots unless one is simulated explicitly.
  const host = PLATFORMS.includes(process.platform) ? process.platform : 'linux';
  options.platform = list(raw.platform ?? host, PLATFORMS, 'platform')[0];
  if (raw.viewport && (raw.width || raw.height))
    throw new Error('Use either --viewport or --width/--height');
  options.viewports = raw.viewport
    ? viewports(raw.viewport)
    : raw.width || raw.height
      ? viewports(`${raw.width ?? 1040}x${raw.height ?? 760}`)
      : undefined;
  // Electron is the default: same Chromium build as Cindy, no browser install, fastest locally.
  options.engine = raw.engine ?? 'electron';
  if (!['chromium', 'electron'].includes(options.engine))
    throw new Error('--engine: chromium | electron');
  options.timeout = Number(raw.timeout ?? 20000);
  if (!Number.isInteger(options.timeout) || options.timeout < 1000 || options.timeout > 120000)
    throw new Error('--timeout: 1000–120000 (per variant, ms)');
  options.browser = raw.browser;
  options.output = raw.output && path.resolve(raw.output);
  options.entry = raw.entry && path.resolve(raw.entry);
  options.compare = raw.compare;
  options.focus = raw.focus;
  const selectors = [options.page, options.entry, options.changed].filter(Boolean).length;
  if (selectors > 1) throw new Error('Choose one of --page, --entry or --changed');
  if (options.mode === 'preview' && (options.changed || options.compare))
    throw new Error(
      '--preview runs one explicit page; it cannot be combined with --changed/--compare',
    );
  return options;
}

/** Expand the requested matrix for one page definition. */
export function variantsFor(definition, options) {
  const names = Object.keys(definition.cases);
  const cases =
    options.cases === 'all' ? names : options.cases.split(',').map((name) => name.trim());
  for (const name of cases) {
    // Ad-hoc entries declare their cases in mountPage(); the page itself rejects unknown names.
    if (definition.adhoc) definition.cases[name] ??= { about: name };
    if (!definition.cases[name])
      throw new Error(`--case for ${definition.name}: ${names.join(' | ')} | all`);
  }
  const variants = [];
  for (const name of cases)
    for (const viewport of options.viewports ?? [
      definition.cases[name].viewport ?? definition.viewport,
    ])
      for (const theme of options.themes)
        for (const locale of options.locales)
          variants.push({
            page: definition.name,
            case: name,
            theme,
            locale,
            platform: options.platform,
            viewport,
            id: `${definition.name}.${name}.${theme}.${locale}.${viewport.width}x${viewport.height}`,
          });
  if (options.mode === 'preview' && variants.length > 1)
    throw new Error('--preview keeps one window: pick a single case, theme, locale and viewport');
  return variants;
}
